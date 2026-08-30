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

  constructor(
    private getKey: () => string,
    private getModel: () => string,
    private onCall: () => void,
  ) {}

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

    const model = options.model ?? this.getModel();
    const url = `${ENDPOINT}/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(key)}`;
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
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) await delay(Math.min(8000, 500 * 2 ** attempt));
      try {
        this.calls++;
        this.onCall();
        const response = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        });

        if (!response.ok) {
          const text = await response.text().catch(() => '');
          lastMessage = `HTTP ${response.status}: ${text.slice(0, 300)}`;
          // 4xx other than rate limiting will not fix themselves.
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
