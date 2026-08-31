/**
 * The intent catalogue.
 *
 * Every intent is stated in CANONICAL DOMAIN vocabulary — the words a clinical
 * study builder or a form designer would use anywhere: visit, source document,
 * label, required, minimum, coded value, condition, save. None of it is any
 * particular product's wording.
 *
 * That distinction is the whole ballgame. "save" here is not a button label to
 * match; it is a statement of what the agent wants to accomplish. A platform
 * that words its commit affordance "Publish", "Commit changes" or "Persist
 * draft" is found by meaning — by the model when the vocabulary is unfamiliar,
 * by region shape and role when it is not — and once found, it is remembered
 * for the rest of the run as a fact about THAT platform.
 *
 * `avoid` lists are as important as `lexicon` lists. Form designers are full of
 * controls that sit next to the one you want and do something else, and several
 * of them are near-misses by design: something that looks like Save but saves a
 * template, something that looks like Save but only validates. Naming those
 * hazards in domain terms is what stops the agent walking into them.
 */

import type { Intent } from './grounder';

/** Words that mark a control as destructive or as a dead end, on any platform. */
const DESTRUCTIVE = ['cancel', 'discard', 'delete', 'remove', 'reset', 'clear', 'abandon', 'close without saving'];

/**
 * Near-misses for a commit affordance. Every one of these is a real pattern in
 * production form designers: saving a reusable template rather than the form,
 * previewing rather than committing, validating rather than persisting.
 */
const COMMIT_LOOKALIKES = [
  'template', 'preview', 'validate', 'check', 'test', 'export', 'print',
  'duplicate', 'copy', 'draft copy', 'save as template', 'download', 'share',
];

export const INTENTS = {
  // ── getting around ──────────────────────────────────────────────────────────

  /**
   * Return to the screen listing the study's visits.
   *
   * Single-page applications frequently do not change their URL as they move
   * between screens, so the agent navigates the way a person does — by finding
   * the affordance that means "go back to the schedule" — rather than by
   * driving the address bar.
   */
  gotoVisitSchedule: (context: string[] = []): Intent => ({
    id: 'nav.visitSchedule',
    goal: "Go to the screen listing the study's visits.",
    roles: ['button', 'link', 'tab', 'menuitem'],
    lexicon: [
      'visit schedule', 'visits', 'visit list', 'schedule', 'study plan', 'study design',
      'timepoints', 'events', 'back to visits', 'study', 'plan', 'home', 'back', ...context,
    ],
    avoid: [...DESTRUCTIVE, 'subject', 'patient', 'report', 'user', 'settings', 'logout'],
    regionKinds: ['navigation', 'toolbar', 'unknown'],
    threshold: 0.5,
  }),

  // ── study structure ─────────────────────────────────────────────────────────

  visitCreate: (): Intent => ({
    id: 'visit.create',
    goal: 'Start creating a new visit (a scheduled study timepoint) in the visit schedule.',
    roles: ['button', 'link'],
    lexicon: ['add visit', 'new visit', 'create visit', 'add timepoint', 'add event', 'add row', 'new', 'add', 'create'],
    // The generic words above are what make this work on a platform whose
    // button is just "New". They are also what make it match "New Source
    // Document", so the nouns of every OTHER thing that can be created have to
    // be named as hazards — otherwise "am I on the visit schedule?" answers yes
    // on the screen listing one visit's documents, and the agent loops.
    avoid: [
      ...DESTRUCTIVE, 'source document', 'document', 'form', 'case report form', 'crf',
      'field', 'element', 'page', 'value', 'subject', 'patient',
    ],
    regionKinds: ['toolbar', 'table', 'unknown'],
    threshold: 0.5,
  }),

  visitName: (): Intent => ({
    id: 'visit.name',
    goal: "Enter the visit's name.",
    roles: ['textbox', 'searchbox'],
    lexicon: ['visit name', 'name', 'title', 'label', 'visit', 'description'],
    avoid: ['window', 'day', 'start', 'end', 'search', 'filter'],
    regionKinds: ['editor', 'dialog', 'unknown'],
  }),

  visitWindowStart: (): Intent => ({
    id: 'visit.windowStart',
    goal: 'Enter the first study day of the visit window.',
    roles: ['textbox', 'spinbutton'],
    lexicon: ['window start', 'start day', 'from day', 'day from', 'start', 'begin', 'earliest', 'lower', 'from'],
    avoid: ['end', 'to', 'latest', 'name', 'upper'],
    regionKinds: ['editor', 'dialog', 'unknown'],
  }),

  visitWindowEnd: (): Intent => ({
    id: 'visit.windowEnd',
    goal: 'Enter the last study day of the visit window.',
    roles: ['textbox', 'spinbutton'],
    lexicon: ['window end', 'end day', 'to day', 'day to', 'end', 'finish', 'latest', 'upper', 'through', 'to'],
    avoid: ['start', 'from', 'earliest', 'name', 'lower'],
    regionKinds: ['editor', 'dialog', 'unknown'],
  }),

  visitConfirm: (): Intent => ({
    id: 'visit.confirm',
    goal: 'Confirm and persist the new visit.',
    roles: ['button'],
    lexicon: ['save', 'create', 'add', 'submit', 'confirm', 'ok', 'done', 'apply', 'continue'],
    avoid: [...DESTRUCTIVE, ...COMMIT_LOOKALIKES],
    regionKinds: ['dialog', 'editor', 'toolbar', 'unknown'],
  }),

  // ── source documents (forms) ────────────────────────────────────────────────

  formCreate: (): Intent => ({
    id: 'form.create',
    goal: 'Start creating a new source document (a data-collection form) under the current visit.',
    roles: ['button', 'link'],
    lexicon: [
      'add form', 'new form', 'create form', 'add source document', 'new source document',
      'add document', 'new document', 'add case report form', 'add crf', 'new', 'add', 'create',
    ],
    avoid: [
      ...DESTRUCTIVE, 'visit', 'timepoint', 'event', 'field', 'element', 'page', 'value',
      'subject', 'patient',
    ],
    regionKinds: ['toolbar', 'table', 'unknown'],
    threshold: 0.5,
  }),

  formName: (): Intent => ({
    id: 'form.name',
    goal: "Enter the source document's name.",
    roles: ['textbox', 'searchbox'],
    lexicon: ['form name', 'document name', 'name', 'title', 'label', 'form', 'document'],
    avoid: ['search', 'filter', 'version', 'description'],
    regionKinds: ['editor', 'dialog', 'unknown'],
  }),

  formRepeating: (): Intent => ({
    id: 'form.repeating',
    goal:
      'Mark this source document as one that holds many records per subject-visit — a log, rather than a single record.',
    roles: ['checkbox', 'switch', 'radio', 'combobox'],
    lexicon: [
      'repeating', 'repeat', 'log', 'multiple records', 'many records', 'multi record',
      'recurring', 'allow multiple', 'multiple entries', 'grid', 'table form',
    ],
    avoid: ['required', 'active', 'hidden', 'version'],
    regionKinds: ['editor', 'dialog', 'unknown'],
    threshold: 0.5,
  }),

  formConfirm: (): Intent => ({
    id: 'form.confirm',
    goal: 'Confirm and persist the new source document.',
    roles: ['button'],
    lexicon: ['create', 'save', 'add', 'submit', 'confirm', 'ok', 'done', 'apply', 'continue'],
    avoid: [...DESTRUCTIVE, ...COMMIT_LOOKALIKES],
    regionKinds: ['dialog', 'editor', 'toolbar', 'unknown'],
  }),

  formOpenDesigner: (): Intent => ({
    id: 'form.openDesigner',
    goal: 'Open this source document in the form designer so its fields can be built.',
    roles: ['button', 'link'],
    lexicon: ['edit', 'design', 'build', 'configure', 'open', 'modify', 'author', 'fields', 'layout'],
    avoid: [...DESTRUCTIVE, 'preview', 'view only', 'export', 'activate', 'publish', 'version'],
    regionKinds: ['table', 'toolbar', 'unknown'],
  }),

  /**
   * Some platforms lock an approved/active document and require an explicit new
   * version before it can be edited again. Discovering that gate — rather than
   * assuming an edit affordance will always be present — is part of the job.
   */
  formNewVersion: (): Intent => ({
    id: 'form.newVersion',
    goal: 'Return a locked or approved source document to an editable state by creating a new version of it.',
    roles: ['button', 'link'],
    lexicon: ['new version', 'create version', 'revise', 'amend', 'new draft', 'unlock', 'reopen', 'version'],
    avoid: [...DESTRUCTIVE, 'preview', 'export'],
    regionKinds: ['table', 'toolbar', 'unknown'],
  }),

  // ── the form designer ───────────────────────────────────────────────────────

  librarySearch: (): Intent => ({
    id: 'library.search',
    goal: 'Filter the palette of available field types.',
    roles: ['textbox', 'searchbox'],
    lexicon: ['search', 'filter', 'find', 'look up'],
    avoid: ['label', 'name', 'value', 'formula'],
    regionKinds: ['palette'],
  }),

  /**
   * The affordance that persists the designer's work.
   *
   * Never trusted on its label. Whatever this resolves to is treated as a
   * CANDIDATE until an edit has been shown to survive leaving the designer and
   * coming back — see `profile.commit`.
   */
  commitWork: (): Intent => ({
    id: 'builder.commit',
    goal: 'Persist the work done in this form designer so it survives leaving the screen.',
    roles: ['button'],
    lexicon: ['save', 'commit', 'apply', 'persist', 'store', 'keep', 'save changes', 'submit', 'update', 'confirm'],
    avoid: [...DESTRUCTIVE, ...COMMIT_LOOKALIKES],
    regionKinds: ['toolbar', 'editor', 'unknown'],
    threshold: 0.5,
  }),

  /**
   * Leave the designer.
   *
   * `context` should carry the names of the things this screen was opened from
   * — the visit, the study — because the way back out of a nested editor is
   * very often a breadcrumb named after its parent rather than the word "back".
   * That name is data the agent already has, and no amount of generic
   * vocabulary substitutes for it: nothing about the words "Screening" or
   * "Cohort B" says "this returns you one level up".
   */
  leaveDesigner: (context: string[] = []): Intent => ({
    id: 'builder.leave',
    goal: 'Leave the form designer and return to the list it was opened from.',
    roles: ['button', 'link'],
    lexicon: ['back', 'return', 'close', 'exit', 'done', 'finish', 'up', 'breadcrumb', 'list', ...context],
    avoid: [...DESTRUCTIVE, 'save', 'delete', 'preview', 'activate', 'publish'],
    regionKinds: ['toolbar', 'navigation', 'unknown'],
  }),

  // ── field properties ────────────────────────────────────────────────────────

  fieldLabel: (): Intent => ({
    id: 'element.label',
    goal: "Set the field's label — the question text a coordinator will read.",
    roles: ['textbox'],
    lexicon: ['label', 'field label', 'question', 'caption', 'prompt', 'title', 'text', 'name', 'display name'],
    avoid: ['placeholder', 'hint', 'help', 'formula', 'units', 'code', 'search', 'filter', 'value'],
    regionKinds: ['editor'],
  }),

  fieldRequired: (): Intent => ({
    id: 'element.required',
    goal: 'Mark the field as mandatory.',
    roles: ['checkbox', 'switch', 'radio', 'combobox'],
    lexicon: ['required', 'mandatory', 'must be answered', 'obligatory', 'compulsory', 'not optional'],
    avoid: ['hidden', 'read only', 'repeating', 'active', 'optional'],
    regionKinds: ['editor'],
  }),

  fieldType: (): Intent => ({
    id: 'element.type',
    goal: "Change the field's type after it has been created.",
    roles: ['combobox', 'listbox'],
    lexicon: ['type', 'field type', 'element type', 'control type', 'kind', 'data type', 'widget'],
    avoid: ['visibility', 'condition', 'units', 'format'],
    regionKinds: ['editor'],
  }),

  fieldMin: (): Intent => ({
    id: 'element.min',
    goal: 'Set the lowest value the field will accept.',
    roles: ['textbox', 'spinbutton'],
    lexicon: ['minimum', 'min', 'lower limit', 'lowest', 'low', 'range from', 'from'],
    avoid: ['maximum', 'max', 'upper', 'highest', 'label', 'decimal'],
    regionKinds: ['editor'],
  }),

  fieldMax: (): Intent => ({
    id: 'element.max',
    goal: 'Set the highest value the field will accept.',
    roles: ['textbox', 'spinbutton'],
    lexicon: ['maximum', 'max', 'upper limit', 'highest', 'high', 'range to', 'to'],
    avoid: ['minimum', 'min', 'lower', 'lowest', 'label', 'decimal'],
    regionKinds: ['editor'],
  }),

  fieldUnits: (): Intent => ({
    id: 'element.units',
    goal: 'Set the unit of measure the field is recorded in.',
    roles: ['textbox', 'combobox'],
    lexicon: ['units', 'unit', 'unit of measure', 'uom', 'measure', 'measurement'],
    avoid: ['minimum', 'maximum', 'label', 'format'],
    regionKinds: ['editor'],
  }),

  fieldPrecision: (): Intent => ({
    id: 'element.precision',
    goal: 'Set how many digits the field keeps after the decimal point.',
    roles: ['textbox', 'spinbutton', 'combobox'],
    lexicon: ['decimal places', 'decimals', 'precision', 'scale', 'digits after', 'fraction digits'],
    avoid: ['minimum', 'maximum', 'units', 'label'],
    regionKinds: ['editor'],
  }),

  /**
   * Calendar or clock specific settings.
   *
   * Their presence is what separates a date, time or datetime field from free
   * text on a platform that renders every preview as a plain box — which is
   * most of them.
   */
  fieldTemporalOptions: (): Intent => ({
    id: 'element.temporalOptions',
    goal: 'Settings that only apply to a field holding a date or a time.',
    roles: ['checkbox', 'switch', 'combobox', 'textbox', 'radio'],
    lexicon: [
      'allow past', 'allow future', 'past dates', 'future dates', 'earliest date', 'latest date',
      'date format', 'time format', 'calendar', 'picker options', 'date options', 'time zone',
    ],
    avoid: ['required', 'hidden', 'label', 'units', 'minimum', 'maximum', 'formula'],
    regionKinds: ['editor'],
    threshold: 0.6,
  }),

  fieldFormula: (): Intent => ({
    id: 'element.formula',
    goal: 'Enter the expression that derives this field from other fields.',
    roles: ['textbox'],
    lexicon: ['formula', 'expression', 'calculation', 'equation', 'computed value', 'derivation', 'script'],
    avoid: ['label', 'units', 'condition', 'visibility'],
    regionKinds: ['editor'],
  }),

  fieldDelete: (): Intent => ({
    id: 'element.delete',
    goal: 'Delete the currently selected field from the form.',
    roles: ['button'],
    lexicon: ['delete element', 'remove element', 'delete field', 'remove field', 'delete', 'remove'],
    avoid: ['delete form', 'delete document', 'delete visit', 'delete page', 'cancel', 'clear values'],
    regionKinds: ['editor', 'toolbar'],
  }),

  // ── coded values ────────────────────────────────────────────────────────────

  optionAdd: (): Intent => ({
    id: 'option.add',
    goal: 'Add one more coded value (a code and its human-readable label) to this field.',
    roles: ['button'],
    lexicon: ['add value', 'add option', 'add choice', 'add item', 'add code', 'add row', 'new value', 'new option', 'add'],
    avoid: [...DESTRUCTIVE, 'add field', 'add element', 'add page', 'add form', 'paste', 'import', 'bulk'],
    regionKinds: ['editor'],
  }),

  optionCode: (): Intent => ({
    id: 'option.code',
    goal: 'Enter the code a coded value stores in the database.',
    roles: ['textbox'],
    lexicon: ['code', 'stored value', 'value', 'key', 'coded value', 'submission value', 'id'],
    avoid: ['label', 'display', 'text shown', 'caption'],
    regionKinds: ['editor'],
  }),

  optionLabel: (): Intent => ({
    id: 'option.label',
    goal: 'Enter the text a human reads for a coded value.',
    roles: ['textbox'],
    lexicon: ['label', 'display', 'display text', 'text', 'caption', 'shown', 'description', 'name'],
    avoid: ['code', 'stored value', 'key', 'formula'],
    regionKinds: ['editor'],
  }),

  /**
   * Bulk entry, where a platform offers it.
   *
   * Treated with suspicion by design: bulk shortcuts commonly REPLACE the list
   * rather than appending to it, so this is only ever used as the sole source
   * of a value list, and always read back afterwards.
   */
  optionBulkInput: (): Intent => ({
    id: 'option.bulkInput',
    goal: 'Paste a whole list of coded values at once.',
    roles: ['textbox'],
    lexicon: ['paste values', 'bulk', 'paste', 'import values', 'batch', 'multiple values', 'csv'],
    avoid: ['code', 'label', 'formula'],
    regionKinds: ['editor'],
  }),

  optionBulkApply: (): Intent => ({
    id: 'option.bulkApply',
    goal: 'Apply the pasted list of coded values.',
    roles: ['button'],
    lexicon: ['apply', 'import', 'parse', 'add values', 'set values', 'ok'],
    avoid: [...DESTRUCTIVE, 'add value'],
    regionKinds: ['editor'],
  }),

  // ── conditional display (skip logic) ────────────────────────────────────────

  visibilityMode: (): Intent => ({
    id: 'visibility.mode',
    goal: 'Make this field display conditionally rather than always.',
    roles: ['combobox', 'checkbox', 'switch', 'radio', 'listbox'],
    lexicon: [
      'visibility', 'conditional', 'condition', 'show when', 'display when', 'branching',
      'skip logic', 'display logic', 'shown if', 'rule',
    ],
    avoid: ['required', 'hidden', 'read only', 'type'],
    regionKinds: ['editor'],
  }),

  /**
   * The three conditional-display controls sit together and are worded from the
   * same handful of words, so each has to name the other two as hazards. A rule
   * editor that reads "Visibility / When Element / Equals Value" offers three
   * near-identical targets, and picking the wrong one writes the expected
   * ANSWER into the control that decides whether the rule exists at all.
   */
  visibilityWhenField: (): Intent => ({
    id: 'visibility.whenField',
    goal: 'Choose the field whose answer controls whether this field is shown.',
    roles: ['combobox', 'listbox'],
    lexicon: ['when', 'controlling field', 'depends on', 'condition field', 'source field', 'parent field', 'field', 'if'],
    avoid: ['value', 'equals', 'type', 'label', 'visibility', 'display mode', 'shown'],
    regionKinds: ['editor'],
  }),

  visibilityValue: (): Intent => ({
    id: 'visibility.value',
    goal: 'Enter the answer the controlling field must hold for this field to be shown.',
    roles: ['textbox', 'combobox'],
    lexicon: ['equals', 'value', 'is', 'matches', 'answer', 'expected value', 'condition value'],
    avoid: ['field', 'when', 'label', 'code list', 'visibility', 'display mode', 'shown', 'element'],
    regionKinds: ['editor'],
  }),
} as const;

export type IntentName = keyof typeof INTENTS;
