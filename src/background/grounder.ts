/**
 * Grounding: turning an INTENT ("commit this form", "set the field's label")
 * into a control on a page the agent has never seen.
 *
 * Three tiers, in cost order:
 *
 *   1. MEMORY — the platform profile remembers, per intent, the role and
 *      accessible name that worked last time. On a 195-field run this is what
 *      answers almost every question, and it costs nothing.
 *   2. DETERMINISTIC — score every visible control against the intent's
 *      canonical-domain vocabulary, expected role, and the kind of region it
 *      sits in. Acts only on a clear winner: a high score AND a clear margin
 *      over the runner-up. Ambiguity is not resolved by picking the top of a
 *      close list, because that is exactly how an agent ends up choosing "Save
 *      as Template" over "Save".
 *   3. THE MODEL — asked only when the deterministic tier is genuinely
 *      undecided, and the answer is written back into memory so the same
 *      question is never paid for twice.
 *
 * If all three fail, the caller escalates. Nothing here ever guesses.
 *
 * The vocabulary in `lexicon` is canonical-domain English ("save", "commit",
 * "apply"), never any platform's words. It is a prior for ranking, not a
 * selector: a platform that calls its commit button "Publish" is found by
 * tiers 2 and 3 on meaning, and is remembered by tier 1 thereafter.
 */

import { Gemini, LlmUnavailable, REF_CHOICE_SCHEMA } from './gemini';
import { renderSnapshot } from '../shared/snapshot';
import type { LearnedControl, PlatformProfile } from './store';
import type { Ref, Role, Snapshot, SnapshotNode, SnapshotRegion } from '../shared/snapshot';

export interface Intent {
  /** Stable key used to remember the answer. */
  id: string;
  /** Natural-language statement of what the agent is trying to do. */
  goal: string;
  /** Acceptable roles. Empty means any. */
  roles?: Role[];
  /** Canonical-domain words that would name this control on any platform. */
  lexicon: string[];
  /** Words that mark a look-alike doing something else. Strong negative signal. */
  avoid?: string[];
  /** Region kinds this control usually lives in. */
  regionKinds?: SnapshotRegion['kind'][];
  /** Prefer controls near a node with this accessible name. */
  nearName?: string;
  excludeRefs?: Ref[];
  /** Score a candidate must reach to be acted on without asking the model. */
  threshold?: number;
  /** How far ahead of the runner-up the winner must be. */
  margin?: number;
  /** Skip the memory tier — used when a remembered answer has just failed. */
  ignoreMemory?: boolean;
}

export interface Grounded {
  ref: Ref;
  node: SnapshotNode;
  confidence: number;
  rationale: string;
  source: LearnedControl['source'];
  /** Runner-up candidates, so an escalation can show what else was considered. */
  alternatives: { node: SnapshotNode; score: number }[];
}

export interface GroundFailure {
  ok: false;
  reason: string;
  /** What the agent did consider, best first — the evidence a reviewer needs. */
  candidates: { node: SnapshotNode; score: number }[];
}

export type GroundResult = ({ ok: true } & Grounded) | GroundFailure;

const DEFAULT_THRESHOLD = 0.55;
const DEFAULT_MARGIN = 0.12;

// ── text similarity ───────────────────────────────────────────────────────────

function tokens(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .split(' ')
    .filter(Boolean);
}

/**
 * How much does a control's name mean the same thing as a term?
 *
 * Word-level rather than character-level on purpose. Character similarity is
 * what makes "Check List" look like "Checkbox"; word overlap keeps them apart,
 * and the pair that actually needs separating is separated by behaviour anyway.
 */
export function nameSimilarity(name: string, term: string): number {
  const a = tokens(name);
  const b = tokens(term);
  if (!a.length || !b.length) return 0;

  const aj = a.join(' ');
  const bj = b.join(' ');
  if (aj === bj) return 1;
  if (aj.startsWith(bj) || aj.endsWith(bj)) return 0.9;
  if (aj.includes(bj)) return 0.8;

  const setA = new Set(a);
  const overlap = b.filter((w) => setA.has(w)).length;
  if (!overlap) {
    // Allow a prefix match on a single long word ("Calc" ~ "Calculated").
    const stem = b.some((w) => a.some((x) => w.length >= 4 && (x.startsWith(w) || w.startsWith(x))));
    return stem ? 0.45 : 0;
  }
  return 0.5 + 0.4 * (overlap / Math.max(a.length, b.length));
}

function bestLexical(name: string, lexicon: string[]): number {
  let best = 0;
  for (const term of lexicon) best = Math.max(best, nameSimilarity(name, term));
  return best;
}

// ── deterministic scoring ─────────────────────────────────────────────────────

interface Scored {
  node: SnapshotNode;
  score: number;
  why: string[];
}

function scoreCandidates(snapshot: Snapshot, intent: Intent): Scored[] {
  const regionKind = new Map<number, SnapshotRegion['kind']>();
  const regionConfidence = new Map<number, number>();
  for (const region of snapshot.regions) {
    regionKind.set(region.id, region.kind);
    regionConfidence.set(region.id, region.confidence);
  }

  const anchor = intent.nearName
    ? snapshot.nodes.find((n) => n.name === intent.nearName) ??
      snapshot.nodes.find((n) => nameSimilarity(n.name, intent.nearName!) > 0.8)
    : undefined;

  const excluded = new Set(intent.excludeRefs ?? []);
  const scored: Scored[] = [];

  for (const node of snapshot.nodes) {
    if (excluded.has(node.ref)) continue;
    if (!node.name && node.role !== 'row') continue;

    const why: string[] = [];
    let score = 0;

    // Role — a hard prior, since a textbox can never satisfy "press save".
    if (intent.roles?.length) {
      if (intent.roles.includes(node.role)) {
        score += 0.25;
        why.push(`role ${node.role} is expected`);
      } else {
        // Still allow it through at a heavy discount: some platforms render
        // buttons as links, tabs as buttons, and so on.
        score -= 0.3;
        why.push(`role ${node.role} is not one of the expected roles`);
      }
    }

    const lexical = bestLexical(node.name, intent.lexicon);
    score += lexical * 0.55;
    if (lexical > 0.5) why.push(`name "${node.name}" matches the intent's vocabulary (${lexical.toFixed(2)})`);

    if (intent.avoid?.length) {
      const bad = bestLexical(node.name, intent.avoid);
      if (bad > 0.55) {
        score -= bad * 0.7;
        why.push(`name resembles a look-alike control to avoid (${bad.toFixed(2)})`);
      }
    }

    const kind = regionKind.get(node.region);
    if (intent.regionKinds?.length && kind && intent.regionKinds.includes(kind)) {
      const bonus = 0.12 * (regionConfidence.get(node.region) ?? 0.5);
      score += bonus;
      why.push(`sits in a region that looks like a ${kind}`);
    }

    // A name the author wrote is more trustworthy than one we inferred.
    if (node.nameFrom === 'aria-label' || node.nameFrom === 'label' || node.nameFrom === 'legend') score += 0.05;
    else if (node.nameFrom === 'placeholder' || node.nameFrom === 'title') score -= 0.05;

    if (node.state.disabled) {
      score -= 0.5;
      why.push('is disabled');
    }
    if (node.state.inModal) {
      score += 0.08;
      why.push('is inside the dialog that currently owns the page');
    }

    if (anchor?.box && node.box) {
      const dx = node.box.x - anchor.box.x;
      const dy = node.box.y - anchor.box.y;
      const distance = Math.hypot(dx, dy);
      const proximity = Math.max(0, 1 - distance / 600);
      score += proximity * 0.12;
      if (proximity > 0.5) why.push(`is close to "${intent.nearName}"`);
    }

    if (score > 0) scored.push({ node, score: Math.min(1, score), why });
  }

  return scored.sort((a, b) => b.score - a.score);
}

// ── memory ────────────────────────────────────────────────────────────────────

function fromMemory(snapshot: Snapshot, learned: LearnedControl): SnapshotNode | undefined {
  const exact = snapshot.nodes.find(
    (n) => n.role === learned.role && n.name === learned.name && !n.state.disabled,
  );
  if (exact) return exact;
  // Tolerate cosmetic re-wording ("Save" → "Save form"), but not a different
  // control: the role still has to match and the name still has to mean the same.
  return snapshot.nodes.find(
    (n) => n.role === learned.role && !n.state.disabled && nameSimilarity(n.name, learned.name) >= 0.85,
  );
}

// ── the grounder ──────────────────────────────────────────────────────────────

export class Grounder {
  constructor(
    private profile: () => PlatformProfile,
    private llm: Gemini,
    private note: (message: string) => void,
  ) {}

  /** Every control that plausibly satisfies the intent, best first. */
  rank(snapshot: Snapshot, intent: Intent): { node: SnapshotNode; score: number; why: string[] }[] {
    return scoreCandidates(snapshot, intent);
  }

  async ground(snapshot: Snapshot, intent: Intent): Promise<GroundResult> {
    const profile = this.profile();

    // Tier 1 — memory.
    if (!intent.ignoreMemory) {
      const learned = profile.controls[intent.id];
      if (learned) {
        const node = fromMemory(snapshot, learned);
        if (node) {
          return {
            ok: true,
            ref: node.ref,
            node,
            confidence: learned.confidence,
            rationale: `remembered from an earlier step on this platform: ${learned.rationale ?? learned.name}`,
            source: 'deterministic',
            alternatives: [],
          };
        }
      }
    }

    // Tier 2 — deterministic scoring.
    const scored = scoreCandidates(snapshot, intent);
    const threshold = intent.threshold ?? DEFAULT_THRESHOLD;
    const margin = intent.margin ?? DEFAULT_MARGIN;
    const best = scored[0];
    const second = scored[1];

    if (best && best.score >= threshold && (!second || best.score - second.score >= margin)) {
      this.remember(intent.id, best.node, best.score, 'deterministic', best.why.join('; '));
      return {
        ok: true,
        ref: best.node.ref,
        node: best.node,
        confidence: best.score,
        rationale: best.why.join('; '),
        source: 'deterministic',
        alternatives: scored.slice(1, 4).map((s) => ({ node: s.node, score: s.score })),
      };
    }

    // Tier 3 — the model, for genuine ambiguity only.
    if (this.llm.configured) {
      try {
        const choice = await this.askModel(snapshot, intent, scored);
        if (choice) {
          this.remember(intent.id, choice.node, choice.confidence, 'model', choice.rationale);
          return {
            ok: true,
            ...choice,
            source: 'model',
            alternatives: scored.slice(0, 4).map((s) => ({ node: s.node, score: s.score })),
          };
        }
      } catch (err) {
        if (err instanceof LlmUnavailable) {
          this.note(`The model could not be consulted (${err.message}); falling back to the human gate.`);
        } else {
          throw err;
        }
      }
    }

    const reason = best
      ? `No control clearly satisfies "${intent.goal}". The best candidate scored ${best.score.toFixed(2)}` +
        (second ? `, too close to the runner-up at ${second.score.toFixed(2)} to choose safely.` : ', below the confidence needed to act.')
      : `Nothing on this screen looks like it could satisfy "${intent.goal}".`;

    return { ok: false, reason, candidates: scored.slice(0, 5).map((s) => ({ node: s.node, score: s.score })) };
  }

  private async askModel(
    snapshot: Snapshot,
    intent: Intent,
    scored: Scored[],
  ): Promise<Omit<Grounded, 'source' | 'alternatives'> | null> {
    const shortlist = scored.slice(0, 12);
    const prompt = [
      `You are driving a web application you have never seen. You cannot see pixels; you see an accessibility-style listing of the controls that are on screen right now.`,
      ``,
      `INTENT: ${intent.goal}`,
      ``,
      `Choose the single control that carries out that intent.`,
      intent.avoid?.length
        ? `Be careful: controls whose names suggest ${intent.avoid.join(', ')} are look-alikes that do something else. Do not choose them.`
        : '',
      ``,
      `THE SCREEN:`,
      renderSnapshot(snapshot, { maxNodes: 220 }),
      ``,
      shortlist.length
        ? `A heuristic ranked these highest, which you may disregard:\n${shortlist
            .map((s) => `  ref=${s.node.ref} "${s.node.name}" (${s.node.role}) score=${s.score.toFixed(2)}`)
            .join('\n')}`
        : '',
      ``,
      `If nothing on this screen genuinely satisfies the intent, answer with ref = -1. Answering -1 is correct and useful; guessing is not, because a wrong choice here silently corrupts a clinical study build.`,
    ]
      .filter(Boolean)
      .join('\n');

    const answer = await this.llm.ask<{
      ref: number;
      confidence: number;
      rationale: string;
      alternativeRefs?: number[];
    }>(prompt, {
      system:
        'You ground intents onto controls in an unfamiliar web application. You are precise, you never invent a ref that is not listed, and you say -1 rather than guess.',
      schema: REF_CHOICE_SCHEMA,
      thinkingBudget: 0,
    });

    if (!answer || answer.ref < 0) return null;
    const node = snapshot.nodes.find((n) => n.ref === answer.ref);
    if (!node) {
      this.note(`The model chose ref=${answer.ref}, which is not on this screen; ignoring it.`);
      return null;
    }
    return {
      ref: node.ref,
      node,
      confidence: Math.max(0, Math.min(1, answer.confidence)),
      rationale: answer.rationale,
    };
  }

  /** Write a successful grounding into the profile so it is free next time. */
  remember(
    intentId: string,
    node: SnapshotNode,
    confidence: number,
    source: LearnedControl['source'],
    rationale: string,
  ): void {
    const profile = this.profile();
    profile.controls[intentId] = {
      role: node.role,
      name: node.name,
      confidence,
      source,
      rationale,
      learnedAt: Date.now(),
    };
  }

  /** Forget one remembered control, after it turned out to be the wrong one. */
  forget(intentId: string): void {
    delete this.profile().controls[intentId];
  }
}
