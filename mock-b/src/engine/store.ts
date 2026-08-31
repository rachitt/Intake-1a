import { fieldType, type FieldType } from '../shared/study';
import {
  EMPTY_DOCUMENT_DRAFT,
  EMPTY_TIMEPOINT_DRAFT,
  emptyDesign,
  type BuiltDocument,
  type BuiltElement,
  type BuiltTimepoint,
  type MockBState,
  type Stage,
} from './state';

let counter = 0;
const nextId = (prefix: string): string => `${prefix}-${++counter}`;

type Listener = () => void;

/**
 * Mock B's store.
 *
 * Behaviourally it enforces the same four things a real form designer does,
 * because those are what make building a study hard rather than tedious:
 *
 *   1. Nothing persists until it is committed, and the commit affordance is
 *      not on the toolbar.
 *   2. Leaving the design stage discards the working copy without asking.
 *   3. Changing an element's kind DROPS whatever the new kind cannot hold —
 *      coded values, range, expression — silently.
 *   4. Bulk-loading coded values REPLACES the list rather than appending.
 */
export class MockBStore {
  private state: MockBState;
  private listeners = new Set<Listener>();

  constructor(studyCode: string) {
    this.state = MockBStore.blank(studyCode);
  }

  private static blank(studyCode: string): MockBState {
    return {
      study: { code: studyCode, timepoints: [] },
      ui: {
        stage: 'schedule',
        activeTimepointId: null,
        activeDocumentId: null,
        timepointFormOpen: false,
        timepointDraft: { ...EMPTY_TIMEPOINT_DRAFT },
        documentFormOpen: false,
        documentDraft: { ...EMPTY_DOCUMENT_DRAFT },
        design: emptyDesign(),
      },
    };
  }

  getState(): MockBState {
    return this.state;
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  reset(): void {
    this.state = MockBStore.blank(this.state.study.code);
    this.emit();
  }

  // ── stages ──────────────────────────────────────────────────────────────────

  /**
   * Move to a stage.
   *
   * Leaving `design` throws the working copy away. That is not hostility; it is
   * what a designer holding an uncommitted copy does when you navigate off it,
   * and an agent that treats reaching a screen as building will lose an entire
   * document to it.
   */
  goToStage(stage: Stage): void {
    if (this.state.ui.stage === 'design' && stage !== 'design') {
      this.state.ui.design = emptyDesign();
      this.state.ui.activeDocumentId = null;
    }
    if (stage === 'documents' && !this.state.ui.activeTimepointId) return;
    if (stage === 'design' && !this.state.ui.activeDocumentId) return;
    this.state.ui.stage = stage;
    this.state.ui.timepointFormOpen = false;
    this.state.ui.documentFormOpen = false;
    this.emit();
  }

  openTimepoint(id: string): void {
    this.state.ui.activeTimepointId = id;
    this.state.ui.stage = 'documents';
    this.state.ui.documentFormOpen = false;
    this.emit();
  }

  // ── timepoints ──────────────────────────────────────────────────────────────

  toggleTimepointForm(open: boolean): void {
    this.state.ui.timepointFormOpen = open;
    if (!open) this.state.ui.timepointDraft = { ...EMPTY_TIMEPOINT_DRAFT };
    this.emit();
  }

  patchTimepointDraft(patch: Partial<MockBState['ui']['timepointDraft']>): void {
    Object.assign(this.state.ui.timepointDraft, patch);
    this.emit();
  }

  addTimepoint(): void {
    const draft = this.state.ui.timepointDraft;
    if (!draft.title.trim()) return;
    this.state.study.timepoints.push({
      id: nextId('tp'),
      title: draft.title.trim(),
      dayFrom: draft.dayFrom,
      dayTo: draft.dayTo,
      documents: [],
    });
    this.state.ui.timepointFormOpen = false;
    this.state.ui.timepointDraft = { ...EMPTY_TIMEPOINT_DRAFT };
    this.emit();
  }

  activeTimepoint(): BuiltTimepoint | null {
    const id = this.state.ui.activeTimepointId;
    return this.state.study.timepoints.find((t) => t.id === id) ?? null;
  }

  // ── documents ───────────────────────────────────────────────────────────────

  toggleDocumentForm(open: boolean): void {
    this.state.ui.documentFormOpen = open;
    if (!open) this.state.ui.documentDraft = { ...EMPTY_DOCUMENT_DRAFT };
    this.emit();
  }

  patchDocumentDraft(patch: Partial<MockBState['ui']['documentDraft']>): void {
    Object.assign(this.state.ui.documentDraft, patch);
    this.emit();
  }

  addDocument(): void {
    const timepoint = this.activeTimepoint();
    const draft = this.state.ui.documentDraft;
    if (!timepoint || !draft.title.trim()) return;
    timepoint.documents.push({
      id: nextId('doc'),
      title: draft.title.trim(),
      log: draft.log,
      status: 'draft',
      revision: 1,
      elements: [],
    });
    this.state.ui.documentFormOpen = false;
    this.state.ui.documentDraft = { ...EMPTY_DOCUMENT_DRAFT };
    this.emit();
  }

  /** Open a document in the designer, taking a working copy of it. */
  openDesigner(documentId: string): void {
    const timepoint = this.activeTimepoint();
    const doc = timepoint?.documents.find((d) => d.id === documentId);
    if (!doc) return;
    this.state.ui.activeDocumentId = documentId;
    this.state.ui.stage = 'design';
    this.state.ui.design = {
      ...emptyDesign(),
      working: JSON.parse(JSON.stringify(doc)) as BuiltDocument,
      selectedElementId: null,
    };
    this.emit();
  }

  activeDocument(): BuiltDocument | null {
    const id = this.state.ui.activeDocumentId;
    return this.activeTimepoint()?.documents.find((d) => d.id === id) ?? null;
  }

  // ── the designer ────────────────────────────────────────────────────────────

  setMenuOpen(open: boolean): void {
    this.state.ui.design.menuOpen = open;
    if (open) this.state.ui.design.openCombo = null;
    this.emit();
  }

  setOpenCombo(key: string | null): void {
    this.state.ui.design.openCombo = key;
    this.emit();
  }

  private working(): BuiltDocument | null {
    return this.state.ui.design.working;
  }

  private touch(): void {
    this.state.ui.design.dirty = true;
    this.state.ui.design.notice = null;
  }

  addElement(kind: FieldType): void {
    const working = this.working();
    if (!working) return;
    const element: BuiltElement = {
      id: nextId('el'),
      question: '',
      kind,
      mandatory: false,
      lowest: '',
      highest: '',
      unit: '',
      expression: '',
      values: [],
      rule: { mode: 'always' },
    };
    working.elements.push(element);
    this.state.ui.design.selectedElementId = element.id;
    this.touch();
    this.emit();
  }

  selectElement(id: string | null): void {
    this.state.ui.design.selectedElementId = id;
    this.state.ui.design.notice = null;
    this.emit();
  }

  selected(): BuiltElement | null {
    const working = this.working();
    const id = this.state.ui.design.selectedElementId;
    if (!working || !id) return null;
    return working.elements.find((e) => e.id === id) ?? null;
  }

  patchSelected(patch: Partial<BuiltElement>): void {
    const element = this.selected();
    if (!element) return;
    Object.assign(element, patch);
    this.touch();
    this.emit();
  }

  /**
   * Change an element's kind, dropping whatever the new kind cannot hold.
   *
   * Silent by design. A platform that clears a range when a decimal becomes a
   * dropdown does not tell you, and a builder that sets properties before the
   * kind finds them gone with no error to react to.
   */
  changeKind(kind: FieldType): void {
    const element = this.selected();
    if (!element || element.kind === kind) return;
    const def = fieldType(kind);
    element.kind = kind;
    if (!def.hasOptions) element.values = [];
    if (!def.hasRange) {
      element.lowest = '';
      element.highest = '';
      element.unit = '';
    }
    if (!def.hasFormula) element.expression = '';
    this.touch();
    this.emit();
  }

  deleteSelected(): void {
    const working = this.working();
    const id = this.state.ui.design.selectedElementId;
    if (!working || !id) return;
    working.elements = working.elements.filter((e) => e.id !== id);
    this.state.ui.design.selectedElementId = null;
    this.touch();
    this.emit();
  }

  // ── coded values ────────────────────────────────────────────────────────────

  addValue(): void {
    const element = this.selected();
    if (!element || !fieldType(element.kind).hasOptions) return;
    element.values.push({ code: '', text: '' });
    this.touch();
    this.emit();
  }

  setValueCode(index: number, code: string): void {
    const element = this.selected();
    const value = element?.values[index];
    if (!value) return;
    value.code = code;
    this.touch();
    this.emit();
  }

  setValueText(index: number, text: string): void {
    const element = this.selected();
    const value = element?.values[index];
    if (!value) return;
    value.text = text;
    this.touch();
    this.emit();
  }

  removeValue(index: number): void {
    const element = this.selected();
    if (!element) return;
    element.values.splice(index, 1);
    this.touch();
    this.emit();
  }

  setBulkText(text: string): void {
    this.state.ui.design.bulkText = text;
    this.emit();
  }

  /** OVERWRITES the value list. Named so on screen; still worth reading back. */
  applyBulk(): void {
    const element = this.selected();
    if (!element || !fieldType(element.kind).hasOptions) return;
    const parsed = this.state.ui.design.bulkText
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const at = line.indexOf('=');
        return at === -1
          ? { code: line, text: line }
          : { code: line.slice(0, at).trim(), text: line.slice(at + 1).trim() };
      });
    if (!parsed.length) return;
    element.values = parsed;
    this.state.ui.design.bulkText = '';
    this.touch();
    this.emit();
  }

  // ── display rules ───────────────────────────────────────────────────────────

  setRuleMode(mode: 'always' | 'conditional'): void {
    const element = this.selected();
    if (!element) return;
    element.rule =
      mode === 'always' ? { mode: 'always' } : { mode: 'conditional', whenElementId: '', requiredAnswer: '' };
    this.touch();
    this.emit();
  }

  setRuleController(elementId: string): void {
    const element = this.selected();
    if (!element || element.rule.mode !== 'conditional') return;
    element.rule.whenElementId = elementId;
    this.touch();
    this.emit();
  }

  setRuleAnswer(answer: string): void {
    const element = this.selected();
    if (!element || element.rule.mode !== 'conditional') return;
    element.rule.requiredAnswer = answer;
    this.touch();
    this.emit();
  }

  /** Everything else in this document, as candidate controlling questions. */
  controllerCandidates(): BuiltElement[] {
    const working = this.working();
    const selectedId = this.state.ui.design.selectedElementId;
    if (!working) return [];
    return working.elements.filter((e) => e.id !== selectedId && e.question.trim());
  }

  // ── committing ──────────────────────────────────────────────────────────────

  /**
   * The real commit. Writes the working copy back over the saved document.
   *
   * Reached only through the overflow menu — this platform has no Save button
   * on its toolbar, which is the whole point of it existing.
   */
  commit(): void {
    const working = this.working();
    const timepoint = this.activeTimepoint();
    if (!working || !timepoint) return;
    const at = timepoint.documents.findIndex((d) => d.id === working.id);
    if (at === -1) return;
    timepoint.documents[at] = {
      ...(JSON.parse(JSON.stringify(working)) as BuiltDocument),
      revision: timepoint.documents[at]!.revision + 1,
    };
    this.state.ui.design.dirty = false;
    this.state.ui.design.menuOpen = false;
    this.state.ui.design.notice = 'Changes committed.';
    this.emit();
  }

  /**
   * A decoy that persists nothing.
   *
   * Real designers are full of these — something that looks like saving,
   * reports success, and writes to somewhere else entirely. An agent that
   * trusts the word rather than reading back what happened stops here and
   * believes it is finished.
   */
  saveAsTemplate(): void {
    this.state.ui.design.menuOpen = false;
    this.state.ui.design.notice = 'Saved to the template gallery.';
    this.emit();
  }

  discard(): void {
    const doc = this.activeDocument();
    this.state.ui.design.working = doc ? (JSON.parse(JSON.stringify(doc)) as BuiltDocument) : null;
    this.state.ui.design.dirty = false;
    this.state.ui.design.menuOpen = false;
    this.state.ui.design.selectedElementId = null;
    this.state.ui.design.notice = 'Uncommitted changes discarded.';
    this.emit();
  }

  /**
   * Release the document, which LOCKS it.
   *
   * Editing a released document requires a new revision first — the same
   * lifecycle gate a regulated system imposes, arrived at by a different route
   * from Mock A's.
   */
  release(): void {
    const doc = this.activeDocument();
    if (!doc) return;
    if (this.state.ui.design.dirty) {
      this.state.ui.design.notice = 'Commit your changes before releasing.';
      this.state.ui.design.menuOpen = false;
      this.emit();
      return;
    }
    doc.status = 'released';
    this.state.ui.design.menuOpen = false;
    this.state.ui.design.notice = 'Document released.';
    this.emit();
  }

  /** Return a released document to an editable state. */
  newRevision(documentId: string): void {
    const timepoint = this.activeTimepoint();
    const doc = timepoint?.documents.find((d) => d.id === documentId);
    if (!doc) return;
    doc.status = 'draft';
    doc.revision += 1;
    this.emit();
  }

  setNotice(notice: string | null): void {
    this.state.ui.design.notice = notice;
    this.emit();
  }
}
