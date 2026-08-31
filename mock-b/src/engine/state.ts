import type { FieldType } from '../shared/study';

/**
 * Mock B state.
 *
 * The domain is identical to Mock A's — it has to be, or the two would not be
 * two eSource platforms holding the same study. Everything ABOUT the domain
 * differs: what the screens are called, what order they come in, where saving
 * lives, and what the element library calls each kind of question.
 *
 * The saved/working split is kept, because it is the defining behaviour of a
 * form designer rather than a quirk of one vendor: the builder edits a copy,
 * and nothing persists until it is committed. `__readState()` reports the
 * SAVED side only.
 */

export interface BuiltValue {
  code: string;
  text: string;
}

export type DisplayRule =
  | { mode: 'always' }
  | { mode: 'conditional'; whenElementId: string; requiredAnswer: string };

export interface BuiltElement {
  id: string;
  /** This vendor calls a field's label its "question text". */
  question: string;
  kind: FieldType;
  mandatory: boolean;
  lowest: string;
  highest: string;
  unit: string;
  expression: string;
  values: BuiltValue[];
  rule: DisplayRule;
}

export type DocumentStatus = 'draft' | 'released';

export interface BuiltDocument {
  id: string;
  title: string;
  /** This vendor calls a repeating form a "log". */
  log: boolean;
  status: DocumentStatus;
  revision: number;
  elements: BuiltElement[];
}

export interface BuiltTimepoint {
  id: string;
  title: string;
  dayFrom: string;
  dayTo: string;
  documents: BuiltDocument[];
}

export interface BuiltStudy {
  code: string;
  timepoints: BuiltTimepoint[];
}

/**
 * The wizard's three steps.
 *
 * Mock A is a list that drills into a detail screen that drills into a
 * designer. Mock B is a stepper: the same three levels, reached by advancing
 * and retreating through numbered stages rather than by clicking into and
 * backing out of pages. An agent that learned "click the row, then click Edit"
 * has learned a shape, not a platform.
 */
export type Stage = 'schedule' | 'documents' | 'design';

export interface TimepointDraft {
  title: string;
  dayFrom: string;
  dayTo: string;
}

export interface DocumentDraft {
  title: string;
  log: boolean;
}

export interface DesignState {
  /** Deep copy of the released document; null when the designer is closed. */
  working: BuiltDocument | null;
  /** Uncommitted edits exist. Lost wholesale if the stage is left. */
  dirty: boolean;
  selectedElementId: string | null;
  /** The overflow menu that holds this platform's commit affordance. */
  menuOpen: boolean;
  /** Which custom combobox is expanded, if any. Its options exist only while open. */
  openCombo: string | null;
  /** The bulk-load box, applied by its own control and OVERWRITING the list. */
  bulkText: string;
  notice: string | null;
}

export interface UiState {
  stage: Stage;
  activeTimepointId: string | null;
  activeDocumentId: string | null;
  timepointFormOpen: boolean;
  timepointDraft: TimepointDraft;
  documentFormOpen: boolean;
  documentDraft: DocumentDraft;
  design: DesignState;
}

export interface MockBState {
  study: BuiltStudy;
  ui: UiState;
}

export const EMPTY_TIMEPOINT_DRAFT: TimepointDraft = { title: '', dayFrom: '', dayTo: '' };
export const EMPTY_DOCUMENT_DRAFT: DocumentDraft = { title: '', log: false };

export function emptyDesign(): DesignState {
  return {
    working: null,
    dirty: false,
    selectedElementId: null,
    menuOpen: false,
    openCombo: null,
    bulkText: '',
    notice: null,
  };
}
