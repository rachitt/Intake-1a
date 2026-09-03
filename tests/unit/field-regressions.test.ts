/**
 * The five ways a field goes missing, staged end to end.
 *
 * Each case builds a Semantic Snapshot of a designer that does not exist —
 * generic roles, generic accessible names, a palette, a canvas and a property
 * editor — and pushes it through the SAME code the extension runs: the real
 * `Designer` reading the screen, the real assessment rules turning those
 * readings into evidence, and the real classifier naming the cause.
 *
 * Nothing here is a re-implementation of the logic under test, and nothing here
 * knows any product's vocabulary. The words in these snapshots are invented for
 * the test and could be any platform's.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Designer } from '../../src/background/designer';
import { Gemini } from '../../src/background/gemini';
import { Grounder } from '../../src/background/grounder';
import { Store, emptyProfile } from '../../src/background/store';
import {
  assessAppearance,
  assessDisplacement,
  assessLabelOnCanvas,
  assessSelection,
  assessType,
  classifyFieldFailure,
  confirmLabelBeforeCommit,
  emptyFieldEvidence,
  mergeReadBackEvidence,
  type FieldAttemptEvidence,
} from '../../src/background/diagnose';
import type { PageLike } from '../../src/background/page';
import type { Role, Snapshot, SnapshotNode, SnapshotRegion } from '../../src/shared/snapshot';

// ── a designer that does not exist ────────────────────────────────────────────

/** An invented palette. Any platform's words would do; these are nobody's. */
const PALETTE = ['Plain Entry', 'Whole Number Entry', 'Calendar Entry', 'Pick One Of'];

interface NodeSpec {
  role: Role;
  name: string;
  value?: string;
  selected?: boolean;
}

let nextRef = 1;

function makeSnapshot(spec: {
  palette?: string[];
  /** Named previews standing on the canvas. */
  canvas?: NodeSpec[];
  /** Text the canvas renders that carries no accessible name. */
  canvasText?: string[];
  /** The property editor's controls. */
  editor?: NodeSpec[];
}): Snapshot {
  const nodes: SnapshotNode[] = [];
  const regions: SnapshotRegion[] = [];

  const addRegion = (
    id: number,
    kind: SnapshotRegion['kind'],
    name: string,
    specs: NodeSpec[],
    texts: string[] = [],
  ) => {
    const members: number[] = [];
    specs.forEach((s, i) => {
      const ref = nextRef++;
      members.push(ref);
      nodes.push({
        ref,
        role: s.role,
        name: s.name,
        ...(s.value === undefined ? {} : { value: s.value }),
        state: { visible: true, ...(s.selected === undefined ? {} : { selected: s.selected }) },
        parent: -1,
        depth: 2,
        region: id,
        box: { x: id * 400, y: i * 40, w: 300, h: 32 },
      });
    });
    regions.push({
      id,
      name,
      kind,
      confidence: 0.9,
      members,
      box: { x: id * 400, y: 0, w: 300, h: 600 },
      texts: [...specs.map((s) => s.name), ...texts],
      evidence: ['staged for a test'],
    });
  };

  addRegion(
    1,
    'palette',
    'element library',
    (spec.palette ?? PALETTE).map((name) => ({ role: 'listitem' as Role, name })),
  );
  addRegion(2, 'canvas', 'form under construction', spec.canvas ?? [], spec.canvasText ?? []);
  addRegion(3, 'editor', 'properties', spec.editor ?? []);

  return {
    id: nextRef++,
    url: 'https://an-esource.invalid/designer',
    title: 'designer',
    screenTitle: 'designer',
    nodes,
    regions,
    liveText: [],
    modalOpen: false,
    at: Date.now(),
  };
}

/** A preview of a field as a designer draws one: an inert input carrying its label. */
function preview(label: string): NodeSpec {
  return { role: 'textbox', name: label, value: '' };
}

/** The property editor showing the label and type of whatever is selected. */
function editorFor(label: string, type?: string): NodeSpec[] {
  const controls: NodeSpec[] = [{ role: 'textbox', name: 'Label', value: label }];
  if (type !== undefined) controls.push({ role: 'combobox', name: 'Field Type', value: type });
  return controls;
}

function makeDesigner(): Designer {
  const store = new Store();
  store.profile = emptyProfile('https://an-esource.invalid');
  const llm = new Gemini(
    () => '',
    () => 'none',
    () => {},
  );
  const grounder = new Grounder(() => store.profile!, llm, () => {});
  const page = {} as unknown as PageLike;
  return new Designer(page, grounder, store, () => {});
}

const designer = makeDesigner();

/**
 * Everything the build pipeline records for one attempt, assembled from two
 * readings of the screen exactly as `attemptField` assembles it.
 */
function evidenceForAttempt(input: {
  label: string;
  type: string;
  libraryName: string;
  peers: string[];
  before: Snapshot;
  afterAdd: Snapshot;
  afterLabel: Snapshot;
  /**
   * The canvas as it stands on the way into the save, where the build got that
   * far. This is where a name that never reached its element is caught — see
   * `confirmLabelBeforeCommit` for why the check cannot be made any earlier.
   */
  preCommit?: Snapshot;
  addReportedOk?: boolean;
  labelWriteAccepted?: boolean;
}): FieldAttemptEvidence {
  const e = emptyFieldEvidence(input.label, input.type, input.libraryName);

  e.canvasBefore = designer.canvasEntries(input.before);
  const peersVisibleBefore = designer.visibleLabels(input.before, input.peers);
  e.peerLabelsExpected = input.peers.length;

  e.canvasAfterAdd = designer.canvasEntries(input.afterAdd);
  const appeared = e.canvasAfterAdd.filter((n) => !e.canvasBefore.includes(n));
  e.elementAppeared = assessAppearance({ addedReportedOk: input.addReportedOk ?? true, appeared });
  if (!e.elementAppeared) return e;

  const editor = designer.labelEditor(input.afterAdd);
  e.labelEditorValueBefore = editor ? editor.value : null;
  e.labelEditorOnSelection = assessSelection({
    hasLabelEditor: Boolean(editor),
    labelEditorValue: e.labelEditorValueBefore,
    selectedEntry: designer.selectedCanvasEntry(input.afterAdd),
    appeared,
    peers: input.peers,
  });
  if (e.labelEditorOnSelection === false) return e;

  e.labelWriteAccepted = input.labelWriteAccepted ?? true;

  const peersVisibleAfter = designer.visibleLabels(input.afterLabel, input.peers);
  e.peerLabelsVisible = peersVisibleAfter.length;
  const labelVisibleNow = designer.fieldPresentOnCanvas(input.afterLabel, input.label);
  e.labelDisplacedFrom = assessDisplacement({ peersVisibleBefore, peersVisibleAfter, labelVisibleAfter: labelVisibleNow });
  // Only ever a confirmation at this point; a negative is deferred.
  const onCanvasNow = assessLabelOnCanvas({ labelVisible: labelVisibleNow, peersVisibleBefore });
  e.addedElementShowsLabel = onCanvasNow === true ? true : null;
  if (!e.labelWriteAccepted || e.labelDisplacedFrom) return e;

  e.displayedType = designer.displayedType(input.afterLabel);
  e.typeMatches = assessType({ displayed: e.displayedType, libraryName: input.libraryName, paletteNames: PALETTE });

  if (input.preCommit) {
    const all = [...input.peers, input.label];
    const shows = confirmLabelBeforeCommit({
      label: input.label,
      visibleLabels: designer.visibleLabels(input.preCommit, all),
    });
    if (shows !== null) e.addedElementShowsLabel = shows;
  }
  return e;
}

// ── the perception layer itself ───────────────────────────────────────────────

test('the canvas is read without the palette or the property editor bleeding into it', () => {
  const snapshot = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Temperature')],
    editor: editorFor('Temperature', 'Whole Number Entry'),
  });
  const entries = designer.canvasEntries(snapshot);
  assert.deepEqual(entries.sort(), ['Heart Rate', 'Temperature']);
  assert.ok(!entries.includes('Label'), 'the property editor is not part of the canvas');
  assert.ok(!entries.includes('Plain Entry'), 'the palette is not part of the canvas');
});

test('the label control is found in the editor and not among the canvas previews', () => {
  const snapshot = makeSnapshot({
    canvas: [preview('Heart Rate')],
    editor: editorFor('Heart Rate', 'Whole Number Entry'),
  });
  assert.equal(designer.labelEditor(snapshot)?.value, 'Heart Rate');
  assert.equal(designer.displayedType(snapshot), 'Whole Number Entry');
});

test('a field whose preview carries no accessible name is still found by the text beside it', () => {
  const snapshot = makeSnapshot({
    canvas: [{ role: 'button', name: 'Yes' }, { role: 'button', name: 'No' }],
    canvasText: ['Study Drug Administered'],
    editor: editorFor('Study Drug Administered'),
  });
  assert.equal(designer.fieldPresentOnCanvas(snapshot, 'Study Drug Administered'), true);
});

// ── 1. the name landed in another field's editor ──────────────────────────────

test('regression: the label is set on the wrong element, caught before the write', () => {
  const before = makeSnapshot({
    canvas: [preview('Heart Rate')],
    editor: editorFor('Heart Rate', 'Whole Number Entry'),
  });
  // The element was added but the platform did not move the selection: the
  // label control is still showing the field built a moment ago.
  const afterAdd = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor('Heart Rate', 'Whole Number Entry'),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel: afterAdd,
  });

  assert.equal(e.labelEditorOnSelection, false);
  assert.equal(e.labelWriteAccepted, null, 'the write must be abandoned, not attempted');
  assert.equal(classifyFieldFailure(e).cause, 'label_set_on_wrong_element');
});

test('regression: the label is set on the wrong element, caught by the neighbour losing its name', () => {
  const before = makeSnapshot({ canvas: [preview('Heart Rate')], editor: editorFor('') });
  const afterAdd = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor(''),
  });
  // The write went somewhere: "Heart Rate" is gone from the canvas and the new
  // name has taken its place.
  const afterLabel = makeSnapshot({
    canvas: [preview('Systolic Blood Pressure'), preview('Plain Entry')],
    editor: editorFor('Systolic Blood Pressure'),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel,
  });

  assert.equal(e.labelDisplacedFrom, 'Heart Rate');
  const diagnosis = classifyFieldFailure(e);
  assert.equal(diagnosis.cause, 'label_set_on_wrong_element');
  assert.match(diagnosis.why, /Heart Rate/, 'the damaged neighbour is named, so a person knows where to look');
});

// ── 2. the element went in but never took a name ──────────────────────────────

test('regression: the element is added and the label control refuses the value', () => {
  const before = makeSnapshot({ canvas: [preview('Heart Rate')], editor: editorFor('Heart Rate') });
  const afterAdd = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor(''),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel: afterAdd,
    labelWriteAccepted: false,
  });

  assert.equal(e.elementAppeared, true);
  assert.equal(classifyFieldFailure(e).cause, 'label_not_set');
});

test('regression: the element is added, the write is accepted, and the name never reaches the canvas', () => {
  const before = makeSnapshot({ canvas: [preview('Heart Rate')], editor: editorFor('Heart Rate') });
  const afterAdd = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor(''),
  });
  // The editor holds the name; the canvas does not. On its own that proves
  // nothing — a designer may simply not have repainted the preview yet.
  const afterLabel = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor('Systolic Blood Pressure'),
  });
  // By the time the form is about to be saved, every field has been committed
  // by the act of building the one after it. The peer shows its name and this
  // one still does not, so the name genuinely never reached the element.
  const preCommit = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor(''),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel,
    preCommit,
  });

  assert.equal(e.addedElementShowsLabel, false);
  assert.equal(classifyFieldFailure(e).cause, 'label_not_set');
});

test('a canvas that has simply not repainted yet is not a labelling failure', () => {
  const before = makeSnapshot({ canvas: [preview('Heart Rate')], editor: editorFor('Heart Rate') });
  const afterAdd = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor(''),
  });
  // Not showing the new name yet...
  const afterLabel = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor('Systolic Blood Pressure'),
  });
  // ...but showing it by the time the form is saved.
  const preCommit = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Systolic Blood Pressure')],
    editor: editorFor(''),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel,
    preCommit,
  });

  assert.equal(e.addedElementShowsLabel, true);
  assert.equal(classifyFieldFailure(e).cause, 'unknown', 'nothing is wrong with this field');
});

test('a designer that never shows labels on its canvas is not accused of losing them', () => {
  // Same shape as the case above, except no field on this canvas shows its
  // label — so "the label is not on the canvas" says nothing about the field.
  const before = makeSnapshot({ canvas: [preview('Plain Entry')], editor: editorFor('') });
  const afterAdd = makeSnapshot({
    canvas: [preview('Plain Entry'), preview('Plain Entry 2')],
    editor: editorFor(''),
  });
  const afterLabel = makeSnapshot({
    canvas: [preview('Plain Entry'), preview('Plain Entry 2')],
    editor: editorFor('Systolic Blood Pressure'),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel,
  });

  assert.equal(e.addedElementShowsLabel, null);
  assert.notEqual(classifyFieldFailure(e).cause, 'label_not_set');
  assert.equal(
    confirmLabelBeforeCommit({ label: 'Systolic Blood Pressure', visibleLabels: [] }),
    null,
    'a canvas showing nobody a label cannot accuse one field of losing its own',
  );
});

// ── 3. the wrong kind of field ────────────────────────────────────────────────

test('regression: the palette entry built something else', () => {
  const before = makeSnapshot({ canvas: [preview('Heart Rate')], editor: editorFor('Heart Rate', 'Whole Number Entry') });
  const afterAdd = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Plain Entry')],
    editor: editorFor('', 'Plain Entry'),
  });
  const afterLabel = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Systolic Blood Pressure')],
    editor: editorFor('Systolic Blood Pressure', 'Plain Entry'),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel,
  });

  assert.equal(e.displayedType, 'Plain Entry');
  assert.equal(e.typeMatches, false);
  assert.equal(classifyFieldFailure(e).cause, 'added_wrong_type');
});

test('a designer that reports no type at all is not accused of building the wrong one', () => {
  const before = makeSnapshot({ canvas: [preview('Heart Rate')], editor: editorFor('Heart Rate') });
  const afterAdd = makeSnapshot({ canvas: [preview('Heart Rate'), preview('Plain Entry')], editor: editorFor('') });
  const afterLabel = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Systolic Blood Pressure')],
    editor: editorFor('Systolic Blood Pressure'),
  });

  const e = evidenceForAttempt({
    label: 'Systolic Blood Pressure',
    type: 'integer',
    libraryName: 'Whole Number Entry',
    peers: ['Heart Rate'],
    before,
    afterAdd,
    afterLabel,
  });

  assert.equal(e.displayedType, null);
  assert.equal(e.typeMatches, null);
  assert.equal(classifyFieldFailure(e).cause, 'unknown');
});

// ── 4 and 5. what the save did, and what the reader can see ───────────────────

/** A field that built cleanly, as the evidence stands on the way into a commit. */
function builtCleanly(label: string): FieldAttemptEvidence {
  const e = emptyFieldEvidence(label, 'integer', 'Whole Number Entry');
  e.elementAppeared = true;
  e.labelEditorOnSelection = true;
  e.labelWriteAccepted = true;
  e.addedElementShowsLabel = true;
  e.typeMatches = true;
  return e;
}

test('regression: the save drops a field that was on the canvas before it', () => {
  const beforeCommit = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Temperature'), preview('Systolic Blood Pressure')],
    editor: editorFor('Systolic Blood Pressure'),
  });
  const afterCommit = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Temperature')],
    editor: editorFor(''),
  });
  const labels = ['Heart Rate', 'Temperature', 'Systolic Blood Pressure'];

  const e = mergeReadBackEvidence(builtCleanly('Systolic Blood Pressure'), {
    label: 'Systolic Blood Pressure',
    allLabels: labels,
    beforeCommit: {
      canvasEntries: designer.canvasEntries(beforeCommit),
      visible: designer.visibleLabels(beforeCommit, labels),
    },
    afterCommit: {
      canvasEntries: designer.canvasEntries(afterCommit),
      visible: designer.visibleLabels(afterCommit, labels),
    },
  });

  assert.equal(e.presentBeforeCommit, true);
  assert.equal(e.presentAfterCommit, false);
  assert.equal(e.knownInSavedState, null, 'an entry did leave the canvas, so nothing licenses "it is still there"');
  const diagnosis = classifyFieldFailure(e);
  assert.equal(diagnosis.cause, 'save_lost_it');
  assert.match(diagnosis.why, /2 of its 2 neighbour/);
});

test('regression: a field that is in the saved form but cannot be read back', () => {
  const labels = ['Heart Rate', 'Temperature', 'Systolic Blood Pressure'];
  const beforeCommit = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Temperature'), preview('Systolic Blood Pressure')],
    editor: editorFor('Systolic Blood Pressure'),
  });
  // Everything came back. The third field's preview simply stopped carrying an
  // accessible name once it was no longer selected, so the reader cannot name
  // it — but the canvas lost nothing.
  const afterCommit = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Temperature'), preview('Systolic Blood Pressure'), { role: 'textbox', name: '' }],
    editor: editorFor(''),
  });
  const afterCommitEntries = designer.canvasEntries(afterCommit).filter((n) => n !== 'Systolic Blood Pressure');

  const e = mergeReadBackEvidence(builtCleanly('Systolic Blood Pressure'), {
    label: 'Systolic Blood Pressure',
    allLabels: labels,
    beforeCommit: {
      canvasEntries: designer.canvasEntries(beforeCommit).filter((n) => n !== 'Systolic Blood Pressure'),
      visible: designer.visibleLabels(beforeCommit, labels),
    },
    afterCommit: {
      canvasEntries: afterCommitEntries,
      visible: designer.visibleLabels(afterCommit, labels).filter((l) => l !== 'Systolic Blood Pressure'),
    },
  });

  assert.equal(e.presentBeforeCommit, true);
  assert.equal(e.presentAfterCommit, false);
  assert.equal(e.knownInSavedState, true, 'the canvas kept every entry it had, so nothing was dropped');
  assert.equal(classifyFieldFailure(e).cause, 'verifier_cannot_see_it');
});

test('regression: a read-back that can see nothing blames itself, not the field', () => {
  const labels = ['Heart Rate', 'Temperature', 'Systolic Blood Pressure'];
  const beforeCommit = makeSnapshot({
    canvas: [preview('Heart Rate'), preview('Temperature'), preview('Systolic Blood Pressure')],
    editor: editorFor('Systolic Blood Pressure'),
  });
  const afterCommit = makeSnapshot({ canvas: [], editor: [] });

  const e = mergeReadBackEvidence(builtCleanly('Systolic Blood Pressure'), {
    label: 'Systolic Blood Pressure',
    allLabels: labels,
    beforeCommit: {
      canvasEntries: designer.canvasEntries(beforeCommit),
      visible: designer.visibleLabels(beforeCommit, labels),
    },
    afterCommit: {
      canvasEntries: designer.canvasEntries(afterCommit),
      visible: designer.visibleLabels(afterCommit, labels),
    },
  });

  assert.equal(e.siblingsSeenAfterCommit, 0);
  assert.equal(classifyFieldFailure(e).cause, 'verifier_cannot_see_it');
});

test('a field that read back fine is not diagnosed as anything', () => {
  const labels = ['Heart Rate', 'Systolic Blood Pressure'];
  const canvas = makeSnapshot({ canvas: [preview('Heart Rate'), preview('Systolic Blood Pressure')], editor: editorFor('') });
  const reading = {
    canvasEntries: designer.canvasEntries(canvas),
    visible: designer.visibleLabels(canvas, labels),
  };

  const e = mergeReadBackEvidence(builtCleanly('Systolic Blood Pressure'), {
    label: 'Systolic Blood Pressure',
    allLabels: labels,
    beforeCommit: reading,
    afterCommit: reading,
  });

  assert.equal(e.presentAfterCommit, true);
  assert.equal(classifyFieldFailure(e).cause, 'unknown');
});

test('a neighbour flickering out of one canvas reading is not an accusation', () => {
  // The peer is not visible in the second reading, but the name that was
  // written is not visible either — so there is no evidence the write landed
  // anywhere, and blaming the neighbour would abandon a good field.
  assert.equal(
    assessDisplacement({
      peersVisibleBefore: ['Heart Rate'],
      peersVisibleAfter: [],
      labelVisibleAfter: false,
    }),
    null,
  );
  assert.equal(
    assessDisplacement({
      peersVisibleBefore: ['Heart Rate'],
      peersVisibleAfter: [],
      labelVisibleAfter: true,
    }),
    'Heart Rate',
  );
  assert.equal(
    assessDisplacement({
      peersVisibleBefore: ['Heart Rate'],
      peersVisibleAfter: ['Heart Rate'],
      labelVisibleAfter: true,
    }),
    null,
  );
});
