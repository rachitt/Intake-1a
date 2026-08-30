/**
 * Mapping the thirteen canonical types onto an element library nobody has seen.
 *
 * This is the part of the assignment that decides whether a build looks
 * finished or is finished, so it is worth being explicit about the method.
 *
 * The naive approach — fuzzy-match the canonical type's name against the
 * library entry names — fails by construction, and platforms make it fail on
 * purpose by parking near-identical names next to each other. A list-of-choices
 * control and a single tick box sit one row apart with almost the same word in
 * them. Character similarity cannot separate those; nothing about the strings
 * can.
 *
 * So the mapping is established the other way round:
 *
 *   1. PROBE each library entry: build one, watch what the property editor
 *      then offers, watch what the field renders as, delete it.
 *   2. CLASSIFY each entry by scoring that observation against every canonical
 *      type's capability signature. An entry that reveals a coded-value editor
 *      and renders several tick boxes IS a multi-select, whatever it is called.
 *   3. INVERT the classification to get canonical → library entry, and accept
 *      only unambiguous assignments: one clear winner, no contradicting
 *      observations, and a clear margin over the runner-up.
 *   4. ESCALATE everything else to the human, once per type, with the evidence
 *      laid out — never per field, and never as a guess.
 *
 * Names are still used, but only to decide which entry to probe first, which
 * affects speed and nothing else.
 */

import { CANONICAL_TYPES, type CanonicalType } from '../shared/ir';
import { SIGNATURES, lexicalPrior, scoreSignature } from '../shared/types';
import { TYPE_RANKING_SCHEMA, LlmUnavailable, type Gemini } from './gemini';
import type { Designer } from './designer';
import type { Store } from './store';
import type { Escalation, EscalationOption, TypeMappingEntry } from '../shared/protocol';
import type { ObservedBehaviour, SignatureScore } from '../shared/types';

/** How well an entry has to match before the agent will build 195 fields on it. */
const ACCEPT_SCORE = 0.82;
/** How far ahead of the next-best entry the winner has to be. */
const ACCEPT_MARGIN = 0.15;
/** How much of the signature must actually have been observed to trust a score. */
const MIN_COVERAGE = 0.5;

export interface EntryClassification {
  entry: string;
  observation: ObservedBehaviour;
  /** Score against every canonical type, best first. */
  ranked: { type: CanonicalType; result: SignatureScore }[];
  notes: string[];
}

export interface TypeMapOutcome {
  resolved: Map<CanonicalType, TypeMappingEntry>;
  escalations: Escalation[];
}

export class TypeMapper {
  constructor(
    private designer: Designer,
    private store: Store,
    private llm: Gemini,
    private log: (message: string, level?: 'info' | 'warn' | 'error') => void,
  ) {}

  private get profile() {
    return this.store.profile!;
  }

  /**
   * Resolve every canonical type the study actually uses.
   *
   * Only the types in the input are resolved, so a study that never uses a
   * calculated field never pays for probing one.
   */
  async resolve(needed: CanonicalType[]): Promise<TypeMapOutcome> {
    const resolved = new Map<CanonicalType, TypeMappingEntry>();
    const escalations: Escalation[] = [];

    for (const type of needed) {
      const remembered = this.profile.typeMap[type];
      if (remembered) resolved.set(type, remembered);
    }
    const outstanding = needed.filter((t) => !resolved.has(t));
    if (!outstanding.length) return { resolved, escalations };

    const entries = (await this.designer.paletteEntries()).map((e) => e.name);
    if (!entries.length) {
      escalations.push(this.noLibraryEscalation(outstanding));
      return { resolved, escalations };
    }

    // A single model call ranks the whole library against all outstanding
    // types at once. It is a prior on probe order, never the answer.
    const prior = await this.modelPrior(entries, outstanding);

    const classifications = new Map<string, EntryClassification>();
    const probeOrder = this.probeOrder(entries, outstanding, prior);

    for (const entry of probeOrder) {
      if (this.store.aborted) break;
      if (this.everythingCovered(outstanding, classifications, resolved)) break;

      this.log(`Probing element library entry "${entry}" to find out what it actually is…`);
      const probe = await this.designer.probeEntry(entry);
      for (const note of probe.notes) this.log(`  ${entry}: ${note}`, probe.cleanedUp ? 'info' : 'warn');

      const ranked = CANONICAL_TYPES.map((type) => ({ type, result: scoreSignature(type, probe.observation) })).sort(
        (a, b) => b.result.score - a.result.score,
      );
      classifications.set(entry, { entry, observation: probe.observation, ranked, notes: probe.notes });

      const best = ranked[0];
      if (best) {
        this.log(
          `  "${entry}" behaves like ${best.type} (${best.result.score.toFixed(2)}, coverage ${best.result.coverage.toFixed(2)})` +
            (best.result.agreements.length ? ` — ${best.result.agreements.slice(0, 2).join('; ')}` : ''),
        );
      }
    }

    for (const type of outstanding) {
      const decision = this.decide(type, classifications, prior);
      if (decision.entry) {
        const mapping: TypeMappingEntry = {
          canonical: type,
          libraryName: decision.entry,
          confidence: decision.confidence,
          source: 'probed',
          observation: classifications.get(decision.entry)?.observation,
          agreements: decision.agreements,
          conflicts: decision.conflicts,
        };
        resolved.set(type, mapping);
        this.store.recordTypeMapping(mapping);
        this.log(`${type} → "${decision.entry}" (${decision.confidence.toFixed(2)}) — ${decision.why}`);
      } else {
        escalations.push(this.ambiguityEscalation(type, classifications, decision.why));
        this.log(`${type} could not be mapped safely: ${decision.why}`, 'warn');
      }
    }

    await this.store.saveProfile();
    return { resolved, escalations };
  }

  /** Have we probed enough entries to settle every outstanding type? */
  private everythingCovered(
    outstanding: CanonicalType[],
    classifications: Map<string, EntryClassification>,
    resolved: Map<CanonicalType, TypeMappingEntry>,
  ): boolean {
    return outstanding.every((type) => {
      if (resolved.has(type)) return true;
      const decision = this.decide(type, classifications, new Map());
      return Boolean(decision.entry);
    });
  }

  /**
   * Which entries to probe, and in what order.
   *
   * Purely an efficiency decision: probing the entry whose name most resembles
   * the type first tends to settle it in one go. Every entry is still probed if
   * the early ones do not produce an unambiguous answer.
   */
  private probeOrder(entries: string[], outstanding: CanonicalType[], prior: Map<string, number>): string[] {
    const score = new Map<string, number>();
    for (const entry of entries) {
      let best = prior.get(entry) ?? 0;
      for (const type of outstanding) best = Math.max(best, lexicalPrior(type, entry));
      score.set(entry, best);
    }
    return [...entries].sort((a, b) => (score.get(b) ?? 0) - (score.get(a) ?? 0));
  }

  /**
   * Ask the model, once, which library entries look like which canonical types.
   *
   * Deliberately advisory. It orders the probing; it never decides. If there is
   * no key, or the call fails, the run continues on lexical priors alone and
   * simply probes in a slightly worse order.
   */
  private async modelPrior(entries: string[], outstanding: CanonicalType[]): Promise<Map<string, number>> {
    const prior = new Map<string, number>();
    if (!this.llm.configured) return prior;

    const prompt = [
      'An eSource platform offers this palette of field types. These are the exact words the product uses:',
      ...entries.map((e) => `  - ${e}`),
      '',
      'A study specification needs these semantic types:',
      ...outstanding.map((t) => `  - ${t}: ${SIGNATURES[t].meaning}`),
      '',
      'For each semantic type, which palette entries might realise it? Rank the plausible ones.',
      'Be alert to near-identical names that mean different things — a list of choices and a single tick box are commonly named almost the same.',
      'This is a hint to decide what to test first, not a final answer; the agent will verify by building one of each and observing what it does.',
    ].join('\n');

    try {
      const answer = await this.llm.ask<{ ranking: { libraryName: string; confidence: number; reason: string }[] }>(prompt, {
        system: 'You map semantic field types onto an unfamiliar product vocabulary. You are cautious about names that look alike.',
        schema: TYPE_RANKING_SCHEMA,
        thinkingBudget: 0,
      });
      for (const row of answer.ranking ?? []) {
        const existing = prior.get(row.libraryName) ?? 0;
        prior.set(row.libraryName, Math.max(existing, row.confidence));
      }
    } catch (err) {
      if (err instanceof LlmUnavailable) {
        this.log(`Could not get a model hint for the element library (${err.message}); probing on name similarity instead.`, 'warn');
      } else {
        throw err;
      }
    }
    return prior;
  }

  /**
   * Decide which entry realises a canonical type — or refuse to.
   *
   * Three conditions, all of which must hold. The score must be high; the
   * observation must not contradict the signature anywhere; and the winner must
   * be clearly ahead of the runner-up. The margin condition is the one that
   * matters most: two entries scoring 0.88 and 0.86 is not a 0.88 answer, it is
   * a question for a human.
   */
  private decide(
    type: CanonicalType,
    classifications: Map<string, EntryClassification>,
    prior: Map<string, number>,
  ): { entry: string | null; confidence: number; why: string; agreements: string[]; conflicts: string[] } {
    const scored = [...classifications.values()]
      .map((c) => {
        const result = scoreSignature(type, c.observation);
        // An entry that behaves more like some OTHER type is not this type,
        // however well it happens to score here. This cross-check is what stops
        // a single tick box being accepted as a multi-select.
        const ownBest = c.ranked[0];
        const claimedElsewhere = Boolean(ownBest && ownBest.type !== type && ownBest.result.score > result.score + 0.05);
        return { entry: c.entry, result, claimedElsewhere, classification: c };
      })
      .filter((s) => s.result.coverage >= MIN_COVERAGE)
      .sort((a, b) => b.result.score - a.result.score);

    if (!scored.length) {
      return {
        entry: null,
        confidence: 0,
        why: 'No library entry could be observed well enough to judge it.',
        agreements: [],
        conflicts: [],
      };
    }

    const eligible = scored.filter((s) => !s.claimedElsewhere && s.result.conflicts.length === 0);
    const best = eligible[0];
    const runnerUp = eligible[1];

    if (!best) {
      const top = scored[0]!;
      return {
        entry: null,
        confidence: top.result.score,
        why: top.claimedElsewhere
          ? `The closest entry, "${top.entry}", behaves more like ${top.classification.ranked[0]?.type} than like ${type}.`
          : `The closest entry, "${top.entry}", contradicts this type: ${top.result.conflicts.join('; ')}.`,
        agreements: top.result.agreements,
        conflicts: top.result.conflicts,
      };
    }

    if (best.result.score < ACCEPT_SCORE) {
      return {
        entry: null,
        confidence: best.result.score,
        why: `The best candidate, "${best.entry}", only matches ${type} at ${best.result.score.toFixed(2)} — below the confidence needed to build 195 fields on it.`,
        agreements: best.result.agreements,
        conflicts: best.result.conflicts,
      };
    }

    if (runnerUp && best.result.score - runnerUp.result.score < ACCEPT_MARGIN) {
      return {
        entry: null,
        confidence: best.result.score,
        why: `"${best.entry}" (${best.result.score.toFixed(2)}) and "${runnerUp.entry}" (${runnerUp.result.score.toFixed(2)}) behave too much alike to choose between them safely.`,
        agreements: best.result.agreements,
        conflicts: best.result.conflicts,
      };
    }

    const nameAgreement = lexicalPrior(type, best.entry);
    const modelAgreement = prior.get(best.entry) ?? 0;
    const confidence = Math.min(0.99, best.result.score * 0.85 + nameAgreement * 0.08 + modelAgreement * 0.07);

    return {
      entry: best.entry,
      confidence,
      why: best.result.agreements.slice(0, 3).join('; ') || 'behaviour matched the signature',
      agreements: best.result.agreements,
      conflicts: best.result.conflicts,
    };
  }

  // ── escalations ─────────────────────────────────────────────────────────────

  /**
   * One question, asked once, that unblocks every field of this type.
   *
   * The reviewer is shown what the agent observed rather than what it guessed:
   * which entries were built and tested, what each one revealed, and how many
   * fields the answer decides. That is the difference between a gate a study
   * builder can clear in seconds and one that makes them re-verify the study.
   */
  private ambiguityEscalation(
    type: CanonicalType,
    classifications: Map<string, EntryClassification>,
    why: string,
  ): Escalation {
    const affected = this.pointersForType(type);
    const options: EscalationOption[] = [...classifications.values()]
      .map((c) => {
        const result = scoreSignature(type, c.observation);
        return {
          id: c.entry,
          label: c.entry,
          confidence: result.score,
          agreements: result.agreements,
          conflicts: result.conflicts,
          coverage: result.coverage,
        };
      })
      .sort((a, b) => b.confidence - a.confidence)
      .slice(0, 6);

    return {
      id: `type:${type}`,
      kind: 'type_mapping',
      question: `Which field type in this platform's palette means "${type}"?`,
      reason: `${SIGNATURES[type].meaning} ${why}`,
      consequence:
        `Every one of these ${affected.length} field(s) will be built with whichever type is chosen. ` +
        'A field built with the wrong type is a database column that has to be migrated after subjects are already enrolled in it, ' +
        'so this is worth ten seconds now.',
      affectedCount: affected.length,
      affected,
      options,
      allowsManual: true,
      createdAt: Date.now(),
    };
  }

  private noLibraryEscalation(outstanding: CanonicalType[]): Escalation {
    const affected = outstanding.flatMap((t) => this.pointersForType(t));
    return {
      id: 'type:no-library',
      kind: 'type_mapping',
      question: 'Where is the palette of field types in this form designer?',
      reason:
        'No cluster of selectable field types could be found on this screen. The agent looks for a group of similar, ' +
        'activatable items rather than for any particular layout, and nothing on this screen has that shape.',
      consequence: `No fields can be built until this is resolved — ${affected.length} field(s) are waiting.`,
      affectedCount: affected.length,
      affected,
      options: [],
      allowsManual: true,
      createdAt: Date.now(),
    };
  }

  /** Every field in the study that will be built with this type. */
  private pointersForType(type: CanonicalType): string[] {
    const ir = this.store.ir;
    if (!ir) return [];
    const pointers: string[] = [];
    ir.visits.forEach((visit, vi) => {
      visit.forms.forEach((form, fi) => {
        form.fields.forEach((field, xi) => {
          if (field.type === type) pointers.push(`/visits/${vi}/forms/${fi}/fields/${xi}`);
        });
      });
    });
    return pointers;
  }

  /** Apply a human's answer to a type-mapping question. */
  applyHumanChoice(type: CanonicalType, libraryName: string): TypeMappingEntry {
    const entry: TypeMappingEntry = {
      canonical: type,
      libraryName,
      confidence: 1,
      source: 'human',
      observation: this.profile.probes[libraryName],
    };
    this.store.recordTypeMapping(entry);
    void this.store.saveProfile();
    return entry;
  }
}
