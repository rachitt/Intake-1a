/**
 * Why a field did not get built.
 *
 * "The field is missing" is not a diagnosis, and a retry driven by it is a coin
 * toss. There are only a handful of ways a field can fail to appear on a form,
 * and they need completely different repairs: an element that was never added
 * has to be added; an element whose label landed in a neighbour's editor has to
 * be deleted before anything else, or the retry adds a second broken copy
 * beside the first; a field the save discarded needs a different save; a field
 * that is genuinely there but cannot be read back needs the reader fixed, not
 * the field rebuilt — rebuilding it produces a duplicate.
 *
 * So the agent gathers EVIDENCE while it builds — what the canvas held before
 * and after, which element the editor was editing, whether the label read back,
 * whether the type the editor shows matches the one that was asked for — and
 * classifies from that. Everything here is tri-state: `null` means "could not
 * be observed on this platform", and it is never treated as "no". Conflating
 * those is how an agent reports a correctly built field as broken.
 *
 * The classifier is deterministic and is the source of truth. The model is
 * asked only when the deterministic rules come back `unknown`, it must answer
 * in the same vocabulary, and its answer is discarded when the evidence
 * contradicts it. A diagnosis nobody can check is worse than none, because it
 * gets acted on.
 *
 * Nothing in this file knows what any particular eSource looks like. It reads
 * accessible names the agent has already collected; those are runtime data.
 */

import { nameSimilarity } from './grounder';
import { LlmUnavailable, type Gemini, type LlmSchema } from './gemini';

/** Every way a field can fail, in the order the build pipeline can hit them. */
export const FIELD_FAILURE_CAUSES = [
  'element_not_added',
  'label_set_on_wrong_element',
  'label_not_set',
  'added_wrong_type',
  'save_lost_it',
  'verifier_cannot_see_it',
  'unknown',
] as const;

export type FieldFailureCause = (typeof FIELD_FAILURE_CAUSES)[number];

/**
 * What was observed while one attempt at one field was made.
 *
 * Every boolean is tri-state. `null` is the normal, safe answer for anything a
 * given platform gives the agent no way to see.
 */
export interface FieldAttemptEvidence {
  /** What the specification asked for. */
  expectedLabel: string;
  /** The canonical type, in the agent's own vocabulary. */
  expectedType: string;
  /** The palette entry used, in the platform's words. Runtime data. */
  libraryName: string | null;
  /** Which try this was, counting from 1. */
  attempt: number;

  // ── adding ────────────────────────────────────────────────────────────────
  /** Did anything appear as a result of using the palette? */
  elementAppeared: boolean | null;
  /** Identifiable canvas entries before the add, and after it. */
  canvasBefore: string[];
  canvasAfterAdd: string[];
  /**
   * Every way the agent tried to get the element onto the canvas, in plain
   * words. A palette that answers to a drag and not to a click is common
   * enough that "clicking did nothing" is not, on its own, a diagnosis.
   */
  addAttempts: string[];

  // ── selection ─────────────────────────────────────────────────────────────
  /**
   * Is the property editor editing the element that was just added, rather than
   * one that was already there?
   */
  labelEditorOnSelection: boolean | null;
  /** What the label control held before anything was written into it. */
  labelEditorValueBefore: string | null;

  // ── labelling ─────────────────────────────────────────────────────────────
  /** Did the label control hold the value when it was read straight back? */
  labelWriteAccepted: boolean | null;
  /** Does the canvas show the exact expected label afterwards? */
  addedElementShowsLabel: boolean | null;
  /** A field built earlier that stopped being visible when this label was written. */
  labelDisplacedFrom: string | null;
  /** Peer fields expected to be visible while labelling, and how many were. */
  peerLabelsExpected: number | null;
  peerLabelsVisible: number | null;

  // ── type ──────────────────────────────────────────────────────────────────
  /** What the editor says the selected element is, in the platform's words. */
  displayedType: string | null;
  typeMatches: boolean | null;

  // ── persistence and read-back ─────────────────────────────────────────────
  presentBeforeCommit: boolean | null;
  presentAfterCommit: boolean | null;
  /** Other fields of this form expected, and actually seen, after the commit. */
  siblingsExpectedAfterCommit: number | null;
  siblingsSeenAfterCommit: number | null;
  /** Did the canvas show anything identifiable at all after the commit? */
  canvasReadableAfterCommit: boolean | null;
  /** Positive evidence the field is in the saved study although it cannot be read. */
  knownInSavedState: boolean | null;

  notes: string[];
}

export interface Diagnosis {
  cause: FieldFailureCause;
  confidence: number;
  /** One line a person can act on. */
  why: string;
  source: 'deterministic' | 'model' | 'none';
  /** Kept even when the code rejected it, so the audit log shows the whole story. */
  modelProposal?: { cause: string; why: string; rejectedBecause?: string };
}

export function emptyFieldEvidence(
  expectedLabel: string,
  expectedType: string,
  libraryName: string | null,
  attempt = 1,
): FieldAttemptEvidence {
  return {
    expectedLabel,
    expectedType,
    libraryName,
    attempt,
    elementAppeared: null,
    canvasBefore: [],
    canvasAfterAdd: [],
    addAttempts: [],
    labelEditorOnSelection: null,
    labelEditorValueBefore: null,
    labelWriteAccepted: null,
    addedElementShowsLabel: null,
    labelDisplacedFrom: null,
    peerLabelsExpected: null,
    peerLabelsVisible: null,
    displayedType: null,
    typeMatches: null,
    presentBeforeCommit: null,
    presentAfterCommit: null,
    siblingsExpectedAfterCommit: null,
    siblingsSeenAfterCommit: null,
    canvasReadableAfterCommit: null,
    knownInSavedState: null,
    notes: [],
  };
}

/**
 * Does the type the editor shows agree with the palette entry that was used?
 *
 * Compared loosely and symmetrically, because a platform is entitled to word
 * the same thing two ways — a palette entry and the type selector's rendering
 * of it are frequently a long form and a short form of each other. Only a clear
 * disagreement counts, since a false positive here deletes and rebuilds a field
 * that was perfectly good.
 */
export function typesAgree(displayed: string | null, libraryName: string | null): boolean | null {
  if (!displayed || !libraryName) return null;
  const a = normalise(displayed);
  const b = normalise(libraryName);
  if (!a || !b) return null;
  if (a === b || a.includes(b) || b.includes(a)) return true;
  return nameSimilarity(displayed, libraryName) >= 0.6;
}

function normalise(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
}

// ── turning what is on screen into evidence ───────────────────────────────────
//
// These are the individual judgements the build pipeline makes as it goes, kept
// here as pure functions of what was read off the page. They are pure because
// they are the part worth testing: each one is a place where "could not tell"
// has to stay distinct from "no", and getting that wrong produces a confident,
// uniform, wholly wrong diagnosis on any platform whose designer happens not to
// expose the thing being looked for.

/** Did the palette actually put something on the canvas? */
export function assessAppearance(input: { addedReportedOk: boolean; appeared: readonly string[] }): boolean {
  return input.addedReportedOk || input.appeared.length > 0;
}

/**
 * Is the property editor attached to the element that was just added?
 *
 * The failure this exists for is quiet and expensive: a platform that does not
 * select a newly added element leaves the editor pointing at the previous
 * field, so the next name overwrites it. The tell is that the label control is
 * already holding the name of a field built earlier in this form.
 *
 * Only a positive sign of the WRONG element is a failure. Everything else the
 * platform declines to tell us is `null`.
 */
export function assessSelection(input: {
  /** False where nothing on this screen reads as a label control at all. */
  hasLabelEditor: boolean;
  labelEditorValue: string | null;
  /** The canvas entry the platform reports as selected, where it reports one. */
  selectedEntry: string | null;
  /** Canvas entries that appeared with the add. */
  appeared: readonly string[];
  /** Labels of the fields already built into this form. */
  peers: readonly string[];
}): boolean | null {
  if (!input.hasLabelEditor) return null;
  const value = input.labelEditorValue ?? '';

  if (value && input.peers.includes(value)) return false;
  if (input.selectedEntry && input.peers.includes(input.selectedEntry)) return false;
  if (input.selectedEntry && input.appeared.includes(input.selectedEntry)) return true;

  // An empty label control, or one showing the palette entry the element was
  // made from, is a fresh element waiting to be named.
  if (!value || input.appeared.includes(value)) return true;
  return null;
}

/**
 * Does the canvas show this label?
 *
 * `null` unless the canvas has been SHOWN to report labels at all, by at least
 * one field built earlier being visible on it. Plenty of designers leave a
 * preview reading as the palette entry it was made from until the selection
 * moves on, and reporting every field on such a platform as unnamed would be
 * uniformly and confidently wrong.
 */
export function assessLabelOnCanvas(input: {
  labelVisible: boolean;
  peersVisibleBefore: readonly string[];
}): boolean | null {
  if (input.labelVisible) return true;
  if (input.peersVisibleBefore.length > 0) return false;
  return null;
}

/**
 * Did this write land on a field that was already built?
 *
 * The signature is a pair of facts that have to hold TOGETHER: a field built
 * earlier stopped showing its own name, and the name just written is now
 * visible on the canvas. Either one alone is not evidence.
 *
 * The corroboration is what makes this usable. A canvas reading is a
 * best-effort thing — a preview repaints, a region is reclassified, a label
 * that is only rendered text rather than an accessible name flickers out of one
 * snapshot and back into the next — so "a neighbour is no longer visible" on
 * its own produces false accusations, and the accusation is expensive: it
 * abandons the field, deletes what was built, and un-marks a neighbour that was
 * perfectly correct. Requiring that the written name actually surfaced
 * somewhere means the agent only ever claims a write landed somewhere when it
 * can see where.
 */
export function assessDisplacement(input: {
  peersVisibleBefore: readonly string[];
  peersVisibleAfter: readonly string[];
  /** Is the name that was just written visible on the canvas now? */
  labelVisibleAfter: boolean;
}): string | null {
  if (!input.labelVisibleAfter) return null;
  return input.peersVisibleBefore.find((peer) => !input.peersVisibleAfter.includes(peer)) ?? null;
}

/**
 * The deferred half of the post-add label check.
 *
 * Checking the canvas the instant a name is typed is not a fair test. A great
 * many designers leave a preview reading as the palette entry it was made from
 * until the selection moves on, so the field just named is precisely the one
 * whose name has not appeared yet — and treating that as a failure condemns
 * every field on such a platform, in a run where every field is in fact fine.
 *
 * So the immediate check is only ever allowed to CONFIRM, and the authoritative
 * one runs here, once the whole form is built and every field has been
 * committed by the act of building the one after it.
 */
export function confirmLabelBeforeCommit(input: { label: string; visibleLabels: readonly string[] }): boolean | null {
  return assessLabelOnCanvas({
    labelVisible: input.visibleLabels.includes(input.label),
    peersVisibleBefore: input.visibleLabels.filter((l) => l !== input.label),
  });
}

/**
 * Does the editor's idea of the field's type match the palette entry used?
 *
 * A disagreement is only believed when the control is demonstrably speaking the
 * PALETTE's vocabulary — that is, what it shows is itself one of the entries in
 * the element library. Any other control that happens to be named like a type
 * (a format, a display mode, a unit of measure) would otherwise condemn a
 * perfectly good field to being deleted and built again.
 */
export function assessType(input: {
  displayed: string | null;
  libraryName: string | null;
  paletteNames: readonly string[];
}): boolean | null {
  const agrees = typesAgree(input.displayed, input.libraryName);
  if (agrees !== false) return agrees;
  const speaksPalette = input.paletteNames.some((name) => typesAgree(input.displayed, name) === true);
  return speaksPalette ? false : null;
}

/**
 * Fold what the read-back saw into what the build saw.
 *
 * The attempt that built a field is the start of its story — what the canvas
 * held, who the editor was attached to, whether the label read back — and the
 * read-back adds the only two things it can know: whether the field survived
 * the save, and whether anything else did. The result is the whole life of the
 * field in one record, which is what lets the classifier name the FIRST thing
 * that went wrong instead of the last thing that looked odd.
 *
 * The subtle judgement is the last one. A canvas that came back holding every
 * entry it had before the save did not LOSE anything, so a field that cannot be
 * found on it is a field the reader cannot name rather than a field the save
 * dropped — and those need opposite repairs, one of which is to do nothing.
 */
export function mergeReadBackEvidence(
  prior: FieldAttemptEvidence,
  input: {
    label: string;
    /** Every label this form is meant to hold. */
    allLabels: readonly string[];
    /** The canvas immediately before the commit, where it was read. */
    beforeCommit: { canvasEntries: readonly string[]; visible: readonly string[] } | null;
    afterCommit: { canvasEntries: readonly string[]; visible: readonly string[] };
  },
): FieldAttemptEvidence {
  const evidence: FieldAttemptEvidence = { ...prior, notes: [...prior.notes] };

  if (input.beforeCommit) evidence.presentBeforeCommit = input.beforeCommit.visible.includes(input.label);
  evidence.presentAfterCommit = input.afterCommit.visible.includes(input.label);

  const siblings = input.allLabels.filter((l) => l !== input.label);
  evidence.siblingsExpectedAfterCommit = siblings.length;
  evidence.siblingsSeenAfterCommit = input.afterCommit.visible.filter((l) => l !== input.label).length;
  evidence.canvasReadableAfterCommit = input.afterCommit.canvasEntries.length > 0;

  if (evidence.presentBeforeCommit === true && evidence.presentAfterCommit === false && input.beforeCommit) {
    const lost = input.beforeCommit.canvasEntries.filter((e) => !input.afterCommit.canvasEntries.includes(e));
    if (!lost.length) {
      evidence.knownInSavedState = true;
      evidence.notes.push('the canvas kept every entry it had before the save, so nothing was dropped by it');
    }
  }

  return evidence;
}

/**
 * Work out what went wrong, from the evidence alone.
 *
 * The order is the order of the build pipeline, so the FIRST thing that broke is
 * what gets reported rather than the last thing that looked odd. A field whose
 * label never took is also missing at read-back, and telling a person "the save
 * lost it" when the label was the problem sends them to fix the wrong thing.
 */
export function classifyFieldFailure(evidence: FieldAttemptEvidence): Diagnosis {
  const e = evidence;
  const label = e.expectedLabel;

  if (e.elementAppeared === false) {
    const how = e.addAttempts.length ? ` Tried ${e.addAttempts.join(', ')}.` : '';
    return det(
      'element_not_added',
      0.9,
      `${quoteEntry(e)} put nothing on the canvas, so no element for "${label}" was ever created.${how}`,
    );
  }

  // A displaced neighbour is the definitive signature: the text went in
  // somewhere, and somewhere else lost its name at the same moment.
  if (e.labelDisplacedFrom) {
    return det(
      'label_set_on_wrong_element',
      0.9,
      `Writing "${label}" made the already-built field "${e.labelDisplacedFrom}" stop showing its own label, ` +
        'so the editor was attached to that element and not to the new one.',
    );
  }
  if (e.labelEditorOnSelection === false) {
    const held = e.labelEditorValueBefore ? ` It was already holding "${e.labelEditorValueBefore}".` : '';
    return det(
      'label_set_on_wrong_element',
      0.8,
      `The label control was not attached to the element that had just been added.${held}`,
    );
  }

  if (e.labelWriteAccepted === false) {
    return det(
      'label_not_set',
      0.9,
      `The label control did not hold "${label}" when it was read straight back, so the element exists unnamed.`,
    );
  }
  if (e.addedElementShowsLabel === false) {
    return det(
      'label_not_set',
      0.7,
      `The element was added and the label control accepted "${label}", but the canvas never showed it — ` +
        'the name did not reach the element.',
    );
  }

  if (e.typeMatches === false) {
    return det(
      'added_wrong_type',
      0.85,
      `"${label}" was meant to be ${e.expectedType}, built from ${quoteEntry(e)}, ` +
        `but the editor reports its type as "${e.displayedType}".`,
    );
  }

  if (e.presentAfterCommit === false) {
    if (e.knownInSavedState === true) {
      return det(
        'verifier_cannot_see_it',
        0.85,
        `"${label}" is in the saved form, but reading the form back cannot find it — ` +
          'the field is fine and the read-back is blind to it.',
      );
    }
    if (e.canvasReadableAfterCommit === false) {
      return det(
        'verifier_cannot_see_it',
        0.7,
        `Nothing at all could be identified on the canvas after saving, so "${label}" being unfindable ` +
          'says more about the read-back than about the field.',
      );
    }
    if (
      e.siblingsExpectedAfterCommit !== null &&
      e.siblingsSeenAfterCommit !== null &&
      e.siblingsExpectedAfterCommit > 0 &&
      e.siblingsSeenAfterCommit === 0
    ) {
      return det(
        'verifier_cannot_see_it',
        0.7,
        `None of the ${e.siblingsExpectedAfterCommit} other field(s) of this form could be read back either, ` +
          `so the read-back is not seeing the canvas rather than "${label}" being absent.`,
      );
    }
    if (e.presentBeforeCommit === true) {
      const survived =
        e.siblingsSeenAfterCommit !== null && e.siblingsExpectedAfterCommit !== null
          ? ` ${e.siblingsSeenAfterCommit} of its ${e.siblingsExpectedAfterCommit} neighbour(s) did survive.`
          : '';
      return det(
        'save_lost_it',
        0.85,
        `"${label}" was on the canvas before the form was saved and is not there after.${survived}`,
      );
    }
  }

  return {
    cause: 'unknown',
    confidence: 0,
    why: `"${label}" is missing and none of the observations taken during the build explain why.`,
    source: 'none',
  };
}

function quoteEntry(e: FieldAttemptEvidence): string {
  return e.libraryName ? `"${e.libraryName}"` : `the palette entry mapped to ${e.expectedType}`;
}

function det(cause: FieldFailureCause, confidence: number, why: string): Diagnosis {
  return { cause, confidence, why, source: 'deterministic' };
}

/**
 * Does the evidence positively contradict this cause?
 *
 * Used to police the model. It is deliberately one-sided: it only ever rejects a
 * claim the agent has already seen to be false, and never confirms one. A
 * proposal that merely lacks support is still let through as a hypothesis, at a
 * capped confidence; a proposal that is refuted is thrown away.
 */
export function refuteCause(cause: FieldFailureCause, e: FieldAttemptEvidence): string | null {
  switch (cause) {
    case 'element_not_added':
      return e.elementAppeared === true ? 'an element did appear on the canvas when it was added' : null;

    case 'label_set_on_wrong_element':
      if (e.elementAppeared === false) return 'no element was added at all, so nothing could be labelled';
      if (e.labelDisplacedFrom === null && e.labelEditorOnSelection === true && e.addedElementShowsLabel === true) {
        return 'the label control was on the new element and the canvas shows the expected label';
      }
      return null;

    case 'label_not_set':
      if (e.elementAppeared === false) return 'no element was added at all, so nothing could be labelled';
      if (e.labelWriteAccepted === true && e.addedElementShowsLabel === true) {
        return 'the label read back correctly and the canvas shows it';
      }
      return null;

    case 'added_wrong_type':
      if (e.elementAppeared === false) return 'no element was added at all, so it has no type';
      return e.typeMatches === true ? 'the type the editor reports matches the palette entry that was used' : null;

    case 'save_lost_it':
      if (e.presentAfterCommit === true) return 'the field is there when the saved form is read back';
      if (e.presentBeforeCommit === false) return 'the field was not on the canvas before the save either';
      if (e.knownInSavedState === true) return 'the field is known to be in the saved study';
      return null;

    case 'verifier_cannot_see_it':
      if (e.elementAppeared === false) return 'no element was added at all, so there is nothing for a reader to miss';
      return e.presentAfterCommit === true ? 'the read-back can see the field' : null;

    case 'unknown':
      return null;
  }
}

/** How a cause reads to a study builder, not to an engineer. */
export function describeCause(cause: FieldFailureCause): string {
  switch (cause) {
    case 'element_not_added':
      return 'the element was never created';
    case 'added_wrong_type':
      return 'the element was created as the wrong kind of field';
    case 'label_not_set':
      return 'the element was created but never took its name';
    case 'label_set_on_wrong_element':
      return "the name was written into another field's editor";
    case 'save_lost_it':
      return 'the field was built and the save discarded it';
    case 'verifier_cannot_see_it':
      return 'the field appears to be saved but cannot be read back';
    case 'unknown':
      return 'the cause could not be established';
  }
}

/** What a person would have to do about it. Shown at the human gate. */
export function remedyForCause(cause: FieldFailureCause): string {
  switch (cause) {
    case 'element_not_added':
      return (
        'Clicking the entry and dragging it onto the canvas were both tried, so this is not the palette wanting a ' +
        'different gesture. Either the entry mapped to this type does not create a field here, or the canvas was not ' +
        'ready to take one. Naming the right entry, or adding one field by hand, settles it for every field of this type.'
      );
    case 'added_wrong_type':
      return (
        'The palette entry mapped to this type builds something else here. Re-mapping the type is the fix; changing ' +
        'the type after the fact is not, because that discards whatever the new type cannot hold.'
      );
    case 'label_not_set':
      return (
        "The control the agent takes for the field's label does not name the field on this platform. Naming the right " +
        'one repairs every field, not just this one.'
      );
    case 'label_set_on_wrong_element':
      return (
        'A newly added element is not being selected automatically here, so names are landing on the previous field. ' +
        'Check the field named just before this one — it may have been overwritten.'
      );
    case 'save_lost_it':
      return (
        'The control being used to save does not persist this field. A different save affordance, or saving after ' +
        'each field rather than once at the end, is the usual repair.'
      );
    case 'verifier_cannot_see_it':
      return (
        'The field is likely present and correct. Confirm it by eye before rebuilding it, because rebuilding will ' +
        'produce a duplicate.'
      );
    case 'unknown':
      return 'Look at the form as it stands and say what is actually there.';
  }
}

/**
 * Should the retry delete what the last attempt made before trying again?
 *
 * Only where an element really was created and is wrong. Retrying over the top
 * of a half-built element is how one missing field becomes two broken ones.
 */
export function retryShouldRemoveElement(cause: FieldFailureCause): boolean {
  return cause === 'added_wrong_type' || cause === 'label_set_on_wrong_element' || cause === 'label_not_set';
}

/**
 * Should the human gate OFFER to build these again?
 *
 * Not "would it be a good idea" — whether the option appears at all. A reviewer
 * clearing a queue reads the options, not the confidence scores attached to
 * them, and an option that is present is one the tool is prepared to carry out.
 * Where every failure is a field the read-back merely cannot see, the agent
 * already knows rebuilding would duplicate it, so offering it anyway invites
 * exactly the mistake the diagnosis exists to prevent.
 */
export function shouldOfferRebuild(causes: readonly FieldFailureCause[]): boolean {
  return causes.some((cause) => retryIsWorthwhile(cause));
}

/** Is building it again worth a round trip? */
export function retryIsWorthwhile(cause: FieldFailureCause): boolean {
  // Reading the form back is what is broken, not the form — a rebuild would add
  // a duplicate of a field that is already there.
  return cause !== 'verifier_cannot_see_it';
}

// ── the model as a second opinion ─────────────────────────────────────────────

/** A compact, platform-neutral reading of the screen, for the model. */
export interface CanvasReading {
  /** Entries identifiable on the canvas, by accessible name or rendered text. */
  canvasEntries: string[];
  /** The element the editor appears to be editing, if the platform says so. */
  selectedEntry: string | null;
  /** The property editor's controls, as name/role/value. */
  editorControls: { name: string; role: string; value: string }[];
  /** Anything the application said out loud — a toast, a validation message. */
  appSaid: string[];
}

export interface DiagnosisContext {
  before: CanvasReading;
  after: CanvasReading;
  /** What the specification asked for, in the agent's own vocabulary. */
  spec: Record<string, string>;
}

export const FIELD_DIAGNOSIS_SCHEMA: LlmSchema = {
  type: 'OBJECT',
  properties: {
    cause: {
      type: 'STRING',
      enum: [...FIELD_FAILURE_CAUSES],
      description: 'The single best explanation, or unknown if the readings do not support one.',
    },
    changedControl: {
      type: 'STRING',
      description: 'Accessible name of the control whose value changed between before and after, or an empty string.',
    },
    selectedElement: {
      type: 'STRING',
      description: 'The canvas entry the property editor appears to be editing, or an empty string.',
    },
    why: { type: 'STRING', description: 'One sentence: what the before/after difference shows.' },
    confidence: { type: 'NUMBER', description: '0 to 1.' },
  },
  required: ['cause', 'why', 'confidence'],
  propertyOrdering: ['cause', 'changedControl', 'selectedElement', 'why', 'confidence'],
};

export interface ModelDiagnosis {
  cause?: string;
  changedControl?: string;
  selectedElement?: string;
  why?: string;
  confidence?: number;
}

/**
 * Turn a model's answer into a diagnosis, or refuse to.
 *
 * Pure, so the policy is testable without a network. Three ways to be rejected:
 * the cause is not one of ours, the evidence refutes it, or it is `unknown`
 * anyway. In every one of those the deterministic verdict stands and the
 * model's words are kept only as a note.
 */
export function adoptModelDiagnosis(
  answer: ModelDiagnosis,
  evidence: FieldAttemptEvidence,
  fallback: Diagnosis,
): Diagnosis {
  const proposed = String(answer.cause ?? '').trim() as FieldFailureCause;
  const why = String(answer.why ?? '').trim();

  if (!FIELD_FAILURE_CAUSES.includes(proposed) || proposed === 'unknown') {
    return {
      ...fallback,
      modelProposal: {
        cause: String(answer.cause ?? ''),
        why,
        rejectedBecause: 'it is not one of the causes the agent knows how to act on',
      },
    };
  }

  const refuted = refuteCause(proposed, evidence);
  if (refuted) {
    return { ...fallback, modelProposal: { cause: proposed, why, rejectedBecause: refuted } };
  }

  // Accepted as a hypothesis, never as a fact: capped below anything the
  // deterministic rules produce, and labelled as the model's.
  const offered = Number(answer.confidence);
  const confidence = Math.min(0.6, Math.max(0, Number.isFinite(offered) ? offered : 0.5));
  const observed = [
    answer.selectedElement ? `the editor looks attached to "${answer.selectedElement}"` : '',
    answer.changedControl ? `"${answer.changedControl}" is what changed` : '',
  ]
    .filter(Boolean)
    .join('; ');

  return {
    cause: proposed,
    confidence,
    why: why || describeCause(proposed),
    source: 'model',
    modelProposal: { cause: proposed, why: observed || why },
  };
}

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

/** Deterministic first, model second, evidence always in charge. */
export class FieldDiagnostician {
  constructor(private llm: Gemini, private log: Log) {}

  async diagnose(evidence: FieldAttemptEvidence, context?: DiagnosisContext): Promise<Diagnosis> {
    const deterministic = classifyFieldFailure(evidence);
    if (deterministic.cause !== 'unknown') return deterministic;
    if (!context || !this.llm.configured) return deterministic;

    try {
      const answer = await this.llm.ask<ModelDiagnosis>(this.prompt(evidence, context), {
        system:
          'You diagnose why one field failed to be created in a form designer you have never seen. You reason only ' +
          'from the before and after readings you are given. You never name a cause the readings do not support; ' +
          'when they do not distinguish between causes you answer unknown.',
        schema: FIELD_DIAGNOSIS_SCHEMA,
        thinkingBudget: 0,
      });
      return adoptModelDiagnosis(answer, evidence, deterministic);
    } catch (err) {
      if (err instanceof LlmUnavailable) {
        this.log(`No second opinion available on why "${evidence.expectedLabel}" failed (${err.message}).`, 'warn');
        return deterministic;
      }
      throw err;
    }
  }

  private prompt(evidence: FieldAttemptEvidence, context: DiagnosisContext): string {
    const lines: string[] = [];
    lines.push('A form designer was asked to add one field and the field did not end up on the form.');
    lines.push('');
    lines.push('The field the specification asks for:');
    for (const [key, value] of Object.entries(context.spec)) lines.push(`  ${key}: ${value}`);
    if (evidence.libraryName) lines.push(`  built from the palette entry: ${evidence.libraryName}`);
    lines.push('');
    lines.push(renderReading('BEFORE the attempt', context.before));
    lines.push('');
    lines.push(renderReading('AFTER the attempt', context.after));
    lines.push('');
    lines.push('What the agent measured for itself (null means it had no way to tell):');
    for (const line of measurements(evidence)) lines.push(`  ${line}`);
    lines.push('');
    lines.push(
      'Say which control changed, which element the property editor was editing, and why the label, the type or the ' +
        'save did not persist.',
    );
    lines.push('Answer "unknown" unless the readings above actually tell one cause apart from the others.');
    return lines.join('\n');
  }
}

function renderReading(heading: string, r: CanvasReading): string {
  const lines = [`${heading}:`];
  lines.push(`  canvas entries (${r.canvasEntries.length}): ${r.canvasEntries.join(' | ') || '(none identifiable)'}`);
  lines.push(`  element the editor is on: ${r.selectedEntry ?? '(the platform does not say)'}`);
  lines.push('  property editor controls:');
  for (const c of r.editorControls.slice(0, 40)) {
    lines.push(`    ${c.role} "${c.name}" = ${JSON.stringify(c.value)}`);
  }
  if (!r.editorControls.length) lines.push('    (none)');
  if (r.appSaid.length) lines.push(`  the application said: ${r.appSaid.join(' | ')}`);
  return lines.join('\n');
}

function measurements(e: FieldAttemptEvidence): string[] {
  const show = (v: boolean | null) => (v === null ? 'null' : String(v));
  return [
    `attempt: ${e.attempt}`,
    `an element appeared: ${show(e.elementAppeared)}`,
    `the label control was on the new element: ${show(e.labelEditorOnSelection)}`,
    `the label control held, before writing: ${JSON.stringify(e.labelEditorValueBefore)}`,
    `the label read back after writing: ${show(e.labelWriteAccepted)}`,
    `the canvas shows the expected label: ${show(e.addedElementShowsLabel)}`,
    `a previously built field lost its label: ${JSON.stringify(e.labelDisplacedFrom)}`,
    `the type the editor reports: ${JSON.stringify(e.displayedType)} (matches: ${show(e.typeMatches)})`,
    `present on the canvas before saving: ${show(e.presentBeforeCommit)}`,
    `present when the saved form was read back: ${show(e.presentAfterCommit)}`,
    `other fields of this form seen after saving: ${e.siblingsSeenAfterCommit ?? 'null'} of ${
      e.siblingsExpectedAfterCommit ?? 'null'
    }`,
    ...e.notes.map((n) => `note: ${n}`),
  ];
}
