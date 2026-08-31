/**
 * Capability signatures — the heart of platform-independent type mapping.
 *
 * The assignment's central trap is that a canonical type and a platform's
 * element-library entry are related by MEANING, not spelling, and that
 * platforms park near-identical names next to each other ("Check List" beside
 * "Checkbox", "Number (Decimal)" beside "Number (Whole)"). Any agent that
 * ranks library entries by string similarity picks the wrong neighbour.
 *
 * So names are only a PRIOR here. The evidence is behaviour: instantiate a
 * candidate control in the designer and observe what the platform then offers
 * you — does a coded-value editor appear? a min/max? a formula box? — and what
 * the resulting control actually renders as. Those observations are scored
 * against the signature below. Behaviour is the same on every platform;
 * vocabulary is not.
 */

import type { CanonicalType } from './ir';

/** How a control presents its choices, when it has any. */
export type Presentation =
  /** Choices hidden until opened — a dropdown/picklist/combo. */
  | 'collapsed'
  /** All choices visible at once — a radio group or a tick list. */
  | 'expanded'
  /** No choices at all. */
  | 'none';

/** The value domain a control holds. Orthogonal to how it looks. */
export type ValueKind = 'text' | 'number' | 'date' | 'time' | 'datetime' | 'binary' | 'coded' | 'derived';

export interface CapabilitySignature {
  readonly id: CanonicalType;
  /** Human-readable meaning, shown to the reviewer at the human gate. */
  readonly meaning: string;
  /** Does the type carry a coded value list the builder must populate? */
  readonly hasOptions: boolean;
  /** Can a subject select more than one choice at once? `null` = not applicable. */
  readonly multiSelect: boolean | null;
  /** Do min / max / units apply? */
  readonly hasRange: boolean;
  /** Is the value derived from a formula rather than entered? */
  readonly hasFormula: boolean;
  /** Multi-line free text. */
  readonly multiline: boolean;
  readonly valueKind: ValueKind;
  readonly presentation: Presentation;
  /**
   * Holds a point in time, so a platform may offer calendar/clock-specific
   * settings for it (allowed date ranges, pickers, formats).
   */
  readonly temporal: boolean;
  /**
   * How a two-state control presents itself, for the types that have one.
   *
   * `tick` is a single box that is on or off. `named-pair` offers two named
   * states — Yes and No. Their capability signatures are otherwise identical,
   * so without this the agent cannot tell a checkbox from a yes/no field, and
   * that is one of the pairs the brief singles out as routinely confused.
   */
  readonly binaryShape: 'tick' | 'named-pair' | null;
  /**
   * Vocabulary hints used ONLY as a weak prior when ranking candidates before
   * probing. These are canonical-domain words, not any platform's words — the
   * agent must still work when a library calls a dropdown a "Combo".
   */
  readonly lexicon: readonly string[];
  /**
   * Types this one is routinely confused with. When the top two candidates
   * belong to a confusable pair and probing does not separate them, the item
   * goes to the human gate rather than being guessed.
   */
  readonly confusableWith: readonly CanonicalType[];
}

function sig(s: CapabilitySignature): CapabilitySignature {
  return s;
}

function isTemporal(kind: ValueKind): boolean {
  return kind === 'date' || kind === 'time' || kind === 'datetime';
}

export const SIGNATURES: Record<CanonicalType, CapabilitySignature> = {
  text: sig({
    id: 'text',
    meaning: 'Free text, one line.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'text', presentation: 'none',
    temporal: false, binaryShape: null,
    lexicon: ['text', 'single line', 'one line', 'string', 'short answer', 'textbox', 'free text', 'input'],
    confusableWith: ['textarea'],
  }),
  textarea: sig({
    id: 'textarea',
    meaning: 'Free text, multiple lines.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: false,
    multiline: true, valueKind: 'text', presentation: 'none',
    temporal: false, binaryShape: null,
    lexicon: ['multi line', 'multiline', 'paragraph', 'long text', 'text area', 'comment', 'notes', 'memo'],
    confusableWith: ['text'],
  }),
  integer: sig({
    id: 'integer',
    meaning: 'Whole number; may carry a min/max range and units.',
    hasOptions: false, multiSelect: null, hasRange: true, hasFormula: false,
    multiline: false, valueKind: 'number', presentation: 'none',
    temporal: false, binaryShape: null,
    lexicon: ['integer', 'whole', 'number', 'numeric', 'count'],
    confusableWith: ['decimal'],
  }),
  decimal: sig({
    id: 'decimal',
    meaning: 'Number with a fractional part; may carry a min/max range and units.',
    hasOptions: false, multiSelect: null, hasRange: true, hasFormula: false,
    multiline: false, valueKind: 'number', presentation: 'none',
    temporal: false, binaryShape: null,
    lexicon: ['decimal', 'float', 'fractional', 'real', 'number', 'numeric', 'precision'],
    confusableWith: ['integer'],
  }),
  date: sig({
    id: 'date',
    meaning: 'Calendar date, no time of day.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'date', presentation: 'none',
    temporal: true, binaryShape: null,
    lexicon: ['date', 'calendar', 'day'],
    confusableWith: ['datetime'],
  }),
  time: sig({
    id: 'time',
    meaning: 'Time of day, no date.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'time', presentation: 'none',
    temporal: true, binaryShape: null,
    lexicon: ['time', 'clock', 'hour', 'time of day'],
    confusableWith: ['datetime'],
  }),
  datetime: sig({
    id: 'datetime',
    meaning: 'Date and time of day together.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'datetime', presentation: 'none',
    temporal: true, binaryShape: null,
    lexicon: ['date time', 'datetime', 'timestamp', 'date and time'],
    confusableWith: ['date', 'time'],
  }),
  boolean: sig({
    id: 'boolean',
    meaning: 'Yes / No. Two named states, not a list and not a single tick.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'binary', presentation: 'none',
    temporal: false, binaryShape: 'named-pair',
    lexicon: ['yes no', 'yes/no', 'boolean', 'toggle', 'switch', 'true false'],
    confusableWith: ['checkbox', 'radio'],
  }),
  single_select: sig({
    id: 'single_select',
    meaning: 'Choose exactly one from a coded list; choices are hidden until opened.',
    hasOptions: true, multiSelect: false, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'coded', presentation: 'collapsed',
    temporal: false, binaryShape: null,
    lexicon: ['dropdown', 'drop down', 'select', 'picklist', 'pick list', 'combo', 'combobox', 'choice', 'select one', 'list'],
    confusableWith: ['radio', 'multi_select'],
  }),
  multi_select: sig({
    id: 'multi_select',
    meaning: 'Choose zero or more from a coded list. A LIST of ticks, not one tick.',
    hasOptions: true, multiSelect: true, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'coded', presentation: 'expanded',
    temporal: false, binaryShape: null,
    lexicon: ['multi select', 'multiple', 'check list', 'checklist', 'select many', 'select all that apply', 'multi'],
    confusableWith: ['checkbox', 'single_select'],
  }),
  radio: sig({
    id: 'radio',
    meaning: 'Choose exactly one from a coded list, with all choices visible at once.',
    hasOptions: true, multiSelect: false, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'coded', presentation: 'expanded',
    temporal: false, binaryShape: null,
    lexicon: ['radio', 'option button', 'radio group', 'single choice', 'one of'],
    confusableWith: ['single_select', 'multi_select'],
  }),
  checkbox: sig({
    id: 'checkbox',
    meaning: 'A single tick — on or off. NOT a list of choices.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: false,
    multiline: false, valueKind: 'binary', presentation: 'none',
    temporal: false, binaryShape: 'tick',
    lexicon: ['checkbox', 'check box', 'tick', 'tick box', 'single check', 'flag'],
    confusableWith: ['multi_select', 'boolean'],
  }),
  calculated: sig({
    id: 'calculated',
    meaning: 'Derived from other fields by a formula; never entered by hand.',
    hasOptions: false, multiSelect: null, hasRange: false, hasFormula: true,
    multiline: false, valueKind: 'derived', presentation: 'none',
    temporal: false, binaryShape: null,
    lexicon: ['calculated', 'computed', 'derived', 'formula', 'expression', 'auto'],
    confusableWith: [],
  }),
};

/**
 * What the agent observed after instantiating one library entry. Every field is
 * tri-state: `null` means "could not tell", which is different from `false` and
 * must never be scored as agreement.
 */
export interface ObservedBehaviour {
  /** The editor revealed a place to enter coded values. */
  offersOptionEditor: boolean | null;
  /** The editor revealed min / max (and usually units). */
  offersRange: boolean | null;
  /** The editor revealed a formula / expression input. */
  offersFormula: boolean | null;
  /** The editor revealed a decimal-places / precision input. */
  offersPrecision: boolean | null;
  /** The editor revealed calendar/clock settings — allowed dates, pickers, formats. */
  offersTemporalOptions: boolean | null;
  /** The rendered control lets more than one choice be held at once. */
  rendersMultiSelect: boolean | null;
  /** The rendered control shows all its choices at once. */
  rendersExpandedChoices: boolean | null;
  /** The rendered control is a single two-state widget with no choice list. */
  rendersBinary: boolean | null;
  /** The rendered control accepts multiple lines of text. */
  rendersMultiline: boolean | null;
  /** The rendered control is read-only / not user-enterable. */
  rendersReadOnly: boolean | null;
  /** Shape of a two-state control, when the rendering is one. */
  rendersBinaryShape: 'tick' | 'named-pair' | null;
  /** Best guess at the value domain from the rendered control, when detectable. */
  rendersValueKind: ValueKind | null;
}

export function emptyObservation(): ObservedBehaviour {
  return {
    offersOptionEditor: null,
    offersRange: null,
    offersFormula: null,
    offersPrecision: null,
    offersTemporalOptions: null,
    rendersMultiSelect: null,
    rendersExpandedChoices: null,
    rendersBinary: null,
    rendersMultiline: null,
    rendersReadOnly: null,
    rendersBinaryShape: null,
    rendersValueKind: null,
  };
}

export interface SignatureScore {
  /** 0..1 — how well the observation matches the signature. */
  score: number;
  /** Observations that agreed, phrased for a human reviewer. */
  agreements: string[];
  /** Observations that contradicted the signature. Any of these is disqualifying-ish. */
  conflicts: string[];
  /** How much of the signature we were actually able to observe, 0..1. */
  coverage: number;
}

interface Check {
  /** What the signature predicts. `null` = this check does not apply to this type. */
  expected: boolean | null;
  observed: boolean | null;
  weight: number;
  agreeText: string;
  conflictText: string;
}

/**
 * Score an observation against a canonical type's signature.
 *
 * The weights encode which distinctions are load-bearing. Whether an option
 * editor appeared is worth far more than whether the control looked multiline,
 * because "has a coded list" is precisely the axis on which checkbox and
 * multi_select differ — and that pair is the single most expensive confusion
 * in the assignment.
 */
/**
 * Which distinctions this platform is capable of expressing at all.
 *
 * Absence of an affordance only means something once the platform has been
 * shown to have the concept. If no entry anywhere revealed a decimal-places
 * setting, then "this one has no decimal-places setting" is not evidence
 * against it being the decimal type — it is evidence about the platform. Making
 * that distinction is what keeps the agent from escalating every numeric field
 * on a product that simply does not model precision.
 */
export interface PlatformCapabilities {
  expressesPrecision: boolean;
  expressesTemporalOptions: boolean;
}

export function scoreSignature(
  type: CanonicalType,
  obs: ObservedBehaviour,
  capabilities: PlatformCapabilities = { expressesPrecision: true, expressesTemporalOptions: true },
): SignatureScore {
  const s = SIGNATURES[type];

  const checks: Check[] = [
    {
      expected: s.hasOptions,
      observed: obs.offersOptionEditor,
      weight: 3,
      agreeText: s.hasOptions ? 'offers a coded-value editor, as this type requires' : 'offers no coded-value editor, correct for a type that holds no list',
      conflictText: s.hasOptions ? 'offers NO coded-value editor, but this type needs one' : 'offers a coded-value editor, but this type holds no list',
    },
    {
      expected: s.hasRange,
      observed: obs.offersRange,
      weight: 2,
      agreeText: s.hasRange ? 'offers a min/max range, as numeric types do' : 'offers no range inputs, correct for a non-numeric type',
      conflictText: s.hasRange ? 'offers no min/max range, but this type carries one' : 'offers a min/max range, but this type is not numeric',
    },
    {
      expected: s.hasFormula,
      observed: obs.offersFormula,
      weight: 3,
      agreeText: s.hasFormula ? 'offers a formula input, as a derived field needs' : 'offers no formula input, correct',
      conflictText: s.hasFormula ? 'offers no formula input, but this type is derived' : 'offers a formula input, but this type is entered by hand',
    },
    {
      expected: s.multiSelect,
      observed: obs.rendersMultiSelect,
      weight: 3,
      agreeText: s.multiSelect ? 'holds more than one choice at once' : 'holds exactly one choice',
      conflictText: s.multiSelect ? 'holds only one choice, but this type is multi-select' : 'holds several choices at once, but this type takes exactly one',
    },
    {
      expected: s.presentation === 'none' ? null : s.presentation === 'expanded',
      observed: obs.rendersExpandedChoices,
      weight: 2,
      agreeText: s.presentation === 'expanded' ? 'shows all choices at once' : 'keeps choices collapsed until opened',
      conflictText: s.presentation === 'expanded' ? 'collapses its choices, but this type shows them all' : 'shows all choices at once, but this type collapses them',
    },
    {
      expected: s.valueKind === 'binary',
      observed: obs.rendersBinary,
      weight: 2,
      agreeText: s.valueKind === 'binary' ? 'is a two-state control' : 'is not a two-state control, as expected',
      conflictText: s.valueKind === 'binary' ? 'is not a two-state control, but this type is binary' : 'is a two-state control, but this type is not binary',
    },
    {
      expected: s.multiline,
      observed: obs.rendersMultiline,
      weight: 2,
      agreeText: s.multiline ? 'accepts multiple lines' : 'accepts a single line',
      conflictText: s.multiline ? 'accepts only one line, but this type is multi-line' : 'accepts multiple lines, but this type is single-line',
    },
    {
      expected: s.valueKind === 'derived',
      observed: obs.rendersReadOnly,
      weight: 1,
      agreeText: s.valueKind === 'derived' ? 'renders read-only, as a derived field should' : 'is user-enterable, as expected',
      conflictText: s.valueKind === 'derived' ? 'is user-enterable, but a derived field should not be' : 'renders read-only, but this type is entered by hand',
    },
    // Precision separates integer from decimal on platforms that expose it.
    {
      expected: !capabilities.expressesPrecision ? null : type === 'decimal' ? true : type === 'integer' ? false : null,
      observed: obs.offersPrecision,
      weight: 3,
      agreeText: type === 'decimal' ? 'offers a decimal-places setting' : 'offers no decimal-places setting, correct for whole numbers',
      conflictText: type === 'decimal' ? 'offers no decimal-places setting, but this type is fractional' : 'offers a decimal-places setting, but this type is whole-number only',
    },
    // Calendar/clock settings separate the temporal types from free text on
    // platforms that offer them.
    {
      expected: capabilities.expressesTemporalOptions ? s.temporal : null,
      observed: obs.offersTemporalOptions,
      weight: 3,
      agreeText: s.temporal
        ? 'offers calendar/clock settings, as a date or time field does'
        : 'offers no calendar/clock settings, correct for a non-temporal type',
      conflictText: s.temporal
        ? 'offers no calendar/clock settings, but this type holds a point in time'
        : 'offers calendar/clock settings, but this type does not hold a point in time',
    },
  ];

  let earned = 0;
  let possible = 0;
  let observedWeight = 0;
  let totalApplicable = 0;
  const agreements: string[] = [];
  const conflicts: string[] = [];

  for (const c of checks) {
    if (c.expected === null) continue;
    totalApplicable += c.weight;
    if (c.observed === null) continue;
    observedWeight += c.weight;
    possible += c.weight;
    if (c.observed === c.expected) {
      earned += c.weight;
      agreements.push(c.agreeText);
    } else {
      conflicts.push(c.conflictText);
    }
  }

  // Value-kind agreement is a strong POSITIVE signal but rarely a negative one:
  // many designers render every preview as a plain text box, and concluding
  // "not a date" from that would be reading absence as evidence. The exception
  // is between temporal kinds, which are mutually exclusive — something
  // advertising a clock format is not a calendar field.
  if (obs.rendersValueKind) {
    if (obs.rendersValueKind === s.valueKind) {
      earned += 3;
      possible += 3;
      agreements.push(`holds ${s.valueKind} values`);
    } else if (isTemporal(obs.rendersValueKind) && isTemporal(s.valueKind)) {
      possible += 3;
      conflicts.push(`holds ${obs.rendersValueKind} values, but this type holds ${s.valueKind}`);
    } else if (isTemporal(obs.rendersValueKind) !== isTemporal(s.valueKind)) {
      possible += 3;
      conflicts.push(`holds ${obs.rendersValueKind} values, but this type holds ${s.valueKind}`);
    }
  }

  // The shape of a two-state control: a single tick, or two named states.
  if (obs.rendersBinaryShape && s.binaryShape) {
    possible += 3;
    if (obs.rendersBinaryShape === s.binaryShape) {
      earned += 3;
      agreements.push(s.binaryShape === 'tick' ? 'is a single tick box' : 'offers two named states');
    } else {
      conflicts.push(
        s.binaryShape === 'tick'
          ? 'offers two named states, but this type is a single tick'
          : 'is a single tick, but this type offers two named states',
      );
    }
  } else if (obs.rendersBinaryShape === 'named-pair' && !s.binaryShape) {
    // Two named states is a strong claim to being a yes/no field specifically.
    possible += 2;
    conflicts.push('offers two named states, which this type does not');
  }

  return {
    score: possible === 0 ? 0 : earned / possible,
    agreements,
    conflicts,
    coverage: totalApplicable === 0 ? 0 : observedWeight / totalApplicable,
  };
}

/**
 * A weak lexical prior: how much a library entry's NAME looks like this type.
 *
 * Deliberately weak (and never decisive on its own), because the whole point is
 * that names lie. It exists to choose which candidate to PROBE first, which
 * only affects speed, not correctness.
 */
export function lexicalPrior(type: CanonicalType, candidateName: string): number {
  const name = candidateName.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
  if (!name) return 0;
  let best = 0;
  for (const term of SIGNATURES[type].lexicon) {
    if (name === term) best = Math.max(best, 1);
    else if (name.includes(term)) best = Math.max(best, 0.75);
    else {
      const words = term.split(' ');
      const hit = words.filter((w) => name.includes(w)).length;
      if (hit > 0) best = Math.max(best, 0.4 * (hit / words.length));
    }
  }
  return best;
}
