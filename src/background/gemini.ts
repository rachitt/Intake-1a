/**
 * The reasoning fallback.
 *
 * The agent is deliberately NOT a "screenshot in, click out" loop. Deterministic
 * grounding handles the overwhelming majority of steps, and the model is asked
 * only where meaning is genuinely ambiguous: which library entry realises a
 * canonical type, which of several plausible controls satisfies an intent on a
 * screen never seen before, what an unfamiliar screen is for.
 *
 * That split is what makes a 195-field run finish in minutes instead of hours,
 * cost cents instead of dollars, and stay inside a free tier — and it is also
 * what makes the run reproducible, since a cached answer is reused rather than
 * re-asked.
 *
 * Everything is requested as structured JSON against an explicit schema, so a
 * malformed answer is a parse error the agent can retry rather than a
 * hallucinated click.
 */

const ENDPOINT = 'https://generativelanguage.googleapis.com/v1beta/models';

/**
 * The models this tool offers, best first.
 *
 * A model id is the one piece of vendor vocabulary the agent cannot discover
 * from the page, so it is the one thing here that goes stale on its own — and
 * it goes stale silently, as an HTTP 404 on every call, which reads as "the
 * model is broken" rather than "that name was retired". Two things follow from
 * that, and both matter more than the list itself:
 *
 *   - the list is a PREFERENCE, not a constant the code depends on. What the
 *     key can actually reach is asked of the service (`availableModels`), and
 *     a name that has been retired is repaired against that answer rather than
 *     ending the run;
 *   - a stored setting naming a model no longer offered is migrated on load,
 *     because otherwise changing this list fixes nothing for anyone who has
 *     already used the tool once.
 *
 * Flash-class models are preferred throughout. The agent asks the model only
 * where meaning is genuinely ambiguous — a few dozen calls in a 195-field run —
 * so latency per call matters more than depth, and every one of those questions
 * is checked against the page afterwards regardless of who answered it.
 */
export const MODEL_CHOICES: readonly { id: string; label: string }[] = [
  { id: 'gemini-3-flash', label: 'Gemini 3 Flash — the best all-rounder for this' },
  { id: 'gemini-3.5-flash-lite', label: 'Gemini 3.5 Flash Lite — newest, cheapest' },
  { id: 'gemini-3.1-flash-lite', label: 'Gemini 3.1 Flash Lite — cheapest, widely available' },
];

export const DEFAULT_MODEL = MODEL_CHOICES[0]!.id;

/** Is this a model this build knows how to offer? Used to migrate a stored setting. */
export function isOfferedModel(id: string): boolean {
  return MODEL_CHOICES.some((m) => m.id === id);
}

export interface LlmSchema {
  type: 'OBJECT' | 'ARRAY' | 'STRING' | 'NUMBER' | 'INTEGER' | 'BOOLEAN';
  properties?: Record<string, LlmSchema>;
  items?: LlmSchema;
  required?: string[];
  enum?: string[];
  description?: string;
  nullable?: boolean;
  propertyOrdering?: string[];
}

export interface AskOptions {
  system?: string;
  schema: LlmSchema;
  /** Override the configured model for a harder question. */
  model?: string;
  maxRetries?: number;
  /** Reasoning budget. 0 keeps latency down for routine grounding calls. */
  thinkingBudget?: number;
}

export class LlmUnavailable extends Error {}

export class Gemini {
  calls = 0;
  private lastError = '';

  /**
   * A model name that turned out not to exist, and what was used instead.
   *
   * Resolved once per run and then reused: the repair costs one extra request,
   * and paying it on every call for the rest of a 195-field run would be worse
   * than the problem.
   */
  private substitute: string | null = null;
  private substitutionFailed = false;

  constructor(
    private getKey: () => string,
    private getModel: () => string,
    private onCall: () => void,
    /** Anything worth telling a person about. */
    private notify: (message: string, level?: 'info' | 'warn' | 'error') => void = () => {},
  ) {}

  /**
   * The models this key can actually reach, newest-looking first.
   *
   * Asked of the service rather than assumed, because the answer depends on the
   * key as well as on the calendar.
   */
  async availableModels(): Promise<string[]> {
    const key = this.getKey();
    if (!key) return [];
    const response = await fetch(`${ENDPOINT}?key=${encodeURIComponent(key)}&pageSize=200`);
    if (!response.ok) return [];
    const json = (await response.json()) as ListModelsResponse;
    return (json.models ?? [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(Boolean);
  }

  /**
   * Find something to use when the configured model does not exist.
   *
   * Preference order is this build's own list, then anything flash-class, then
   * whatever the key can reach at all. Deliberately loud: a run that quietly
   * used a different model than the one on screen would be reproducible only by
   * accident, and the audit log is supposed to be the record of what happened.
   */
  private async resolveSubstitute(wanted: string): Promise<string | null> {
    if (this.substitute) return this.substitute;
    if (this.substitutionFailed) return null;

    let available: string[] = [];
    try {
      available = await this.availableModels();
    } catch {
      available = [];
    }
    if (!available.length) {
      this.substitutionFailed = true;
      return null;
    }

    const pick =
      available.find((m) => m === wanted) ??
      MODEL_CHOICES.map((c) => c.id).find((id) => available.includes(id)) ??
      available.find((m) => m.includes('flash') && !m.includes('thinking')) ??
      available[0] ??
      null;

    if (!pick || pick === wanted) {
      this.substitutionFailed = true;
      return null;
    }

    this.substitute = pick;
    this.notify(
      `"${wanted}" is not a model this API key can reach; using "${pick}" instead for the rest of the run. ` +
        'Pick a model in the panel to settle it permanently.',
      'warn',
    );
    return pick;
  }

  get configured(): boolean {
    return Boolean(this.getKey());
  }

  get lastFailure(): string {
    return this.lastError;
  }

  /**
   * Ask a question and get back a value matching `schema`.
   *
   * Throws `LlmUnavailable` when there is no key or the service will not answer.
   * Callers must treat that as "escalate to the human", never as "guess" — a
   * tool that quietly guesses is worse than useless here, because a wrong field
   * type surfaces only after go-live.
   */
  async ask<T>(prompt: string, options: AskOptions): Promise<T> {
    const key = this.getKey();
    if (!key) throw new LlmUnavailable('No Gemini API key has been set.');

    // A model name settled earlier in this run wins: the configured one has
    // already been shown not to exist, and re-proving that on every call would
    // double the request count for nothing.
    let model = this.substitute ?? options.model ?? this.getModel();
    const maxRetries = options.maxRetries ?? 3;

    const body: Record<string, unknown> = {
      contents: [{ role: 'user', parts: [{ text: prompt }] }],
      generationConfig: {
        temperature: 0,
        responseMimeType: 'application/json',
        responseSchema: options.schema,
        ...(options.thinkingBudget !== undefined
          ? { thinkingConfig: { thinkingBudget: options.thinkingBudget } }
          : {}),
      },
    };
    if (options.system) body['systemInstruction'] = { parts: [{ text: options.system }] };

    let lastMessage = '';
    // One spare attempt beyond the retry budget, so repairing a retired model
    // name does not consume one of the retries meant for a flaky network.
    for (let attempt = 0; attempt <= maxRetries + 1; attempt++) {
      if (attempt > 0 && lastMessage) await delay(Math.min(8000, 500 * 2 ** attempt));
      try {
        this.calls++;
        this.onCall();
        const response = await fetch(
          `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`,
          {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body),
          },
        );

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          lastMessage = `HTTP ${response.status} for model "${model}": ${text.slice(0, 300)}`;

          // A 404 is not a failure of the request, it is a retired name. Every
          // call in the run would fail the same way, so the name is repaired
          // once against what the key can actually reach, and this attempt is
          // taken again rather than counted as a loss.
          if (response.status === 404) {
            const substitute = await this.resolveSubstitute(model);
            if (substitute) {
              model = substitute;
              lastMessage = '';
              continue;
            }
            lastMessage =
              `"${model}" does not exist or is not available to this API key, and no usable model could be ` +
              'found to put in its place. Choose a different model in the panel.';
            break;
          }

          // Other 4xx will not fix themselves.
          if (response.status !== 429 && response.status < 500) break;
          continue;
        }

        const json = (await response.json()) as GenerateContentResponse;
        const blocked = json.promptFeedback?.blockReason;
        if (blocked) {
          lastMessage = `The request was blocked (${blocked}).`;
          break;
        }

        const text = json.candidates?.[0]?.content?.parts?.map((p) => p.text ?? '').join('') ?? '';
        if (!text.trim()) {
          lastMessage = 'The model returned an empty response.';
          continue;
        }

        try {
          return JSON.parse(text) as T;
        } catch {
          // Occasionally a model fences JSON despite the mime type; salvage it
          // once rather than burning a whole retry on a formatting slip.
          const salvaged = text.match(/\{[\s\S]*\}|\[[\s\S]*\]/)?.[0];
          if (salvaged) {
            try {
              return JSON.parse(salvaged) as T;
            } catch {
              /* fall through */
            }
          }
          lastMessage = `The model returned text that is not valid JSON: ${text.slice(0, 200)}`;
        }
      } catch (err) {
        lastMessage = err instanceof Error ? err.message : String(err);
      }
    }

    this.lastError = lastMessage;
    throw new LlmUnavailable(lastMessage || 'The model could not be reached.');
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

interface GenerateContentResponse {
  candidates?: { content?: { parts?: { text?: string }[] } }[];
  promptFeedback?: { blockReason?: string };
}

// ── schemas used across the orchestrator ──────────────────────────────────────

export const REF_CHOICE_SCHEMA: LlmSchema = {
  type: 'OBJECT',
  properties: {
    ref: { type: 'INTEGER', description: 'The ref of the chosen control, or -1 if none is suitable.' },
    confidence: { type: 'NUMBER', description: 'How sure you are, from 0 to 1.' },
    rationale: { type: 'STRING', description: 'One sentence: why this control satisfies the intent.' },
    alternativeRefs: { type: 'ARRAY', items: { type: 'INTEGER' }, description: 'Other plausible refs, best first.' },
  },
  required: ['ref', 'confidence', 'rationale'],
  propertyOrdering: ['ref', 'confidence', 'rationale', 'alternativeRefs'],
};

export const TYPE_RANKING_SCHEMA: LlmSchema = {
  type: 'OBJECT',
  properties: {
    ranking: {
      type: 'ARRAY',
      description: 'Library entry names, most likely first.',
      items: {
        type: 'OBJECT',
        properties: {
          libraryName: { type: 'STRING' },
          confidence: { type: 'NUMBER' },
          reason: { type: 'STRING' },
        },
        required: ['libraryName', 'confidence', 'reason'],
      },
    },
  },
  required: ['ranking'],
};

export const SCREEN_READING_SCHEMA: LlmSchema = {
  type: 'OBJECT',
  properties: {
    summary: { type: 'STRING', description: 'One sentence describing what this screen is for.' },
    screenKind: {
      type: 'STRING',
      enum: ['study_overview', 'visit_list', 'visit_detail', 'form_list', 'form_designer', 'form_preview', 'dialog', 'other'],
    },
    confidence: { type: 'NUMBER' },
  },
  required: ['summary', 'screenKind', 'confidence'],
};

interface ListModelsResponse {
  models?: { name?: string; supportedGenerationMethods?: string[] }[];
}
