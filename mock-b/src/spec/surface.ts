import type { FieldType } from '../shared/study';

/** Stamped into readState so a score can never be separated from the surface that produced it. */
export const SPEC_VERSION = 'esource-mock-b/1.0.0';

export const PLATFORM_ID = 'esource-mock-b';
export const PLATFORM_LABEL = 'Trialworks Study Designer — Mock B';

export interface ElementKindDef {
  canonical: FieldType;
  label: string;
}

/**
 * The element library, in the words THIS vendor uses.
 *
 * Nothing here shares a word with Mock A's library. Mock A says "Dropdown",
 * "Check List", "Yes/No Toggle", "Single Line Textbox", "Number (Whole)". A
 * builder that learned those names learned nothing transferable, which is the
 * point of having a second platform at all.
 *
 * Ordered by how often a study builder reaches for each one — not
 * alphabetically, as Mock A orders it — because screen order is one of the
 * things an agent must not depend on.
 *
 * The adjacencies are hazards on purpose, and they are DIFFERENT hazards from
 * Mock A's:
 *
 *   - "Free Text" and "Free Text (Long)" differ by one parenthesised word, and
 *     are a single-line box and a multi-line box respectively.
 *   - "Number" and "Number (Precise)" differ the same way, and are whole
 *     numbers and decimals.
 *   - "Pick One", "Pick Many" and "Option Buttons" are all lists of choices.
 *     The first two differ by one word; the third shares no word with either
 *     and is nonetheless the closest relative of "Pick One" — both let a
 *     coordinator choose exactly one answer, and they differ only in how they
 *     draw it. Nothing about the spelling says so.
 *   - "Tick Box" is a single tick, not a list, and sits directly under
 *     "Pick Many". A fuzzy match on "tick"/"pick" gets this wrong; only
 *     looking at what the built control renders as gets it right.
 */
export const ELEMENT_KINDS: readonly ElementKindDef[] = [
  { canonical: 'text', label: 'Free Text' },
  { canonical: 'textarea', label: 'Free Text (Long)' },
  { canonical: 'integer', label: 'Number' },
  { canonical: 'decimal', label: 'Number (Precise)' },
  { canonical: 'single_select', label: 'Pick One' },
  { canonical: 'multi_select', label: 'Pick Many' },
  { canonical: 'checkbox', label: 'Tick Box' },
  { canonical: 'radio', label: 'Option Buttons' },
  { canonical: 'boolean', label: 'Yes / No Switch' },
  { canonical: 'date', label: 'Calendar Date' },
  { canonical: 'time', label: 'Clock Time' },
  { canonical: 'datetime', label: 'Calendar Date + Clock Time' },
  { canonical: 'calculated', label: 'Derived Value' },
];

export function elementKindByCanonical(canonical: FieldType): ElementKindDef {
  const found = ELEMENT_KINDS.find((k) => k.canonical === canonical);
  if (!found) throw new Error(`mock-b has no element kind for canonical "${canonical}"`);
  return found;
}

export function canonicalByKindLabel(label: string): FieldType | null {
  return ELEMENT_KINDS.find((k) => k.label === label)?.canonical ?? null;
}
