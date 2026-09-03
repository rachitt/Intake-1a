/**
 * The failure classifier.
 *
 * The property under test throughout is that "could not be observed" never
 * becomes "no". Almost every rule here has a paired case: one where the agent
 * saw the failure and must name it, and one where the platform simply does not
 * expose the thing being looked for and the agent must decline to name it. The
 * second half is the half that keeps this from condemning correctly built
 * fields on a designer nobody has seen.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import {
  FIELD_FAILURE_CAUSES,
  adoptModelDiagnosis,
  assessAppearance,
  assessLabelOnCanvas,
  assessSelection,
  assessType,
  classifyFieldFailure,
  describeCause,
  emptyFieldEvidence,
  refuteCause,
  remedyForCause,
  retryIsWorthwhile,
  retryShouldRemoveElement,
  shouldOfferRebuild,
  typesAgree,
  type FieldAttemptEvidence,
} from '../../src/background/diagnose';

function evidence(overrides: Partial<FieldAttemptEvidence> = {}): FieldAttemptEvidence {
  return { ...emptyFieldEvidence('Systolic Blood Pressure', 'integer', 'Whole Number'), ...overrides };
}

// ── the causes, one by one ────────────────────────────────────────────────────

test('nothing appeared on the canvas -> element_not_added', () => {
  const d = classifyFieldFailure(evidence({ elementAppeared: false }));
  assert.equal(d.cause, 'element_not_added');
  assert.equal(d.source, 'deterministic');
  assert.match(d.why, /Whole Number/);
});

test('a neighbour losing its label -> label_set_on_wrong_element', () => {
  const d = classifyFieldFailure(
    evidence({ elementAppeared: true, labelWriteAccepted: true, labelDisplacedFrom: 'Heart Rate' }),
  );
  assert.equal(d.cause, 'label_set_on_wrong_element');
  assert.match(d.why, /Heart Rate/);
});

test('the label control already holding a built field -> label_set_on_wrong_element', () => {
  const d = classifyFieldFailure(
    evidence({ elementAppeared: true, labelEditorOnSelection: false, labelEditorValueBefore: 'Heart Rate' }),
  );
  assert.equal(d.cause, 'label_set_on_wrong_element');
  assert.match(d.why, /Heart Rate/);
});

test('the label not reading back -> label_not_set', () => {
  const d = classifyFieldFailure(
    evidence({ elementAppeared: true, labelEditorOnSelection: true, labelWriteAccepted: false }),
  );
  assert.equal(d.cause, 'label_not_set');
});

test('the canvas never showing the label -> label_not_set', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      labelEditorOnSelection: true,
      labelWriteAccepted: true,
      addedElementShowsLabel: false,
    }),
  );
  assert.equal(d.cause, 'label_not_set');
});

test('the editor reporting a different palette entry -> added_wrong_type', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      labelWriteAccepted: true,
      addedElementShowsLabel: true,
      displayedType: 'Free Text',
      typeMatches: false,
    }),
  );
  assert.equal(d.cause, 'added_wrong_type');
  assert.match(d.why, /Free Text/);
});

test('present before the save and gone after -> save_lost_it', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      labelWriteAccepted: true,
      addedElementShowsLabel: true,
      presentBeforeCommit: true,
      presentAfterCommit: false,
      canvasReadableAfterCommit: true,
      siblingsExpectedAfterCommit: 4,
      siblingsSeenAfterCommit: 4,
    }),
  );
  assert.equal(d.cause, 'save_lost_it');
  assert.match(d.why, /4 of its 4 neighbour/);
});

test('nothing lost across the save -> verifier_cannot_see_it', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      labelWriteAccepted: true,
      presentBeforeCommit: true,
      presentAfterCommit: false,
      knownInSavedState: true,
      canvasReadableAfterCommit: true,
      siblingsExpectedAfterCommit: 4,
      siblingsSeenAfterCommit: 4,
    }),
  );
  assert.equal(d.cause, 'verifier_cannot_see_it');
});

test('no sibling readable either -> verifier_cannot_see_it, not save_lost_it', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      presentBeforeCommit: true,
      presentAfterCommit: false,
      canvasReadableAfterCommit: true,
      siblingsExpectedAfterCommit: 6,
      siblingsSeenAfterCommit: 0,
    }),
  );
  assert.equal(d.cause, 'verifier_cannot_see_it');
});

test('an unreadable canvas -> verifier_cannot_see_it', () => {
  const d = classifyFieldFailure(
    evidence({ elementAppeared: true, presentAfterCommit: false, canvasReadableAfterCommit: false }),
  );
  assert.equal(d.cause, 'verifier_cannot_see_it');
});

test('nothing observed -> unknown, and it says so rather than guessing', () => {
  const d = classifyFieldFailure(evidence());
  assert.equal(d.cause, 'unknown');
  assert.equal(d.source, 'none');
  assert.equal(d.confidence, 0);
});

// ── "could not tell" is never "no" ────────────────────────────────────────────

test('a canvas that does not report labels is not a labelling failure', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      labelEditorOnSelection: true,
      labelWriteAccepted: true,
      addedElementShowsLabel: null,
      typeMatches: null,
    }),
  );
  assert.equal(d.cause, 'unknown');
});

test('a designer with no type control is not a wrong-type failure', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      labelWriteAccepted: true,
      addedElementShowsLabel: true,
      displayedType: null,
      typeMatches: null,
    }),
  );
  assert.equal(d.cause, 'unknown');
});

test('a field that was never on the canvas before the save is not blamed on the save', () => {
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      presentBeforeCommit: false,
      presentAfterCommit: false,
      canvasReadableAfterCommit: true,
      siblingsExpectedAfterCommit: 3,
      siblingsSeenAfterCommit: 3,
    }),
  );
  assert.equal(d.cause, 'unknown');
});

// ── the pipeline order ────────────────────────────────────────────────────────

test('the FIRST thing that broke is reported, not the last symptom', () => {
  // A field whose name never took is also missing at read-back. Telling a
  // person the save lost it would send them to fix the wrong thing.
  const d = classifyFieldFailure(
    evidence({
      elementAppeared: true,
      labelWriteAccepted: false,
      presentBeforeCommit: true,
      presentAfterCommit: false,
    }),
  );
  assert.equal(d.cause, 'label_not_set');
});

test('an element that was never added outranks everything downstream of it', () => {
  const d = classifyFieldFailure(
    evidence({ elementAppeared: false, labelWriteAccepted: false, typeMatches: false, presentAfterCommit: false }),
  );
  assert.equal(d.cause, 'element_not_added');
});

// ── what a cause implies for the repair ───────────────────────────────────────

test('every cause has wording and a remedy for a person', () => {
  for (const cause of FIELD_FAILURE_CAUSES) {
    assert.ok(describeCause(cause).length > 0, cause);
    assert.ok(remedyForCause(cause).length > 20, cause);
  }
});

test('a field that is there but unreadable is never rebuilt, because that would duplicate it', () => {
  assert.equal(retryIsWorthwhile('verifier_cannot_see_it'), false);
  assert.equal(retryIsWorthwhile('save_lost_it'), true);
  assert.equal(retryIsWorthwhile('element_not_added'), true);
});

test('the gate does not offer to rebuild a field it knows is already there', () => {
  // The option is withheld, not merely scored low: a reviewer reads the
  // options, and an option that is present is one the tool will carry out.
  assert.equal(shouldOfferRebuild(['verifier_cannot_see_it']), false);
  assert.equal(shouldOfferRebuild(['save_lost_it']), true);
  // A mixed batch still offers it — for the ones it can actually repair.
  assert.equal(shouldOfferRebuild(['verifier_cannot_see_it', 'element_not_added']), true);
  assert.equal(shouldOfferRebuild([]), false);
});

test('a half-built element is removed before a retry; a missing one is not', () => {
  assert.equal(retryShouldRemoveElement('added_wrong_type'), true);
  assert.equal(retryShouldRemoveElement('label_set_on_wrong_element'), true);
  assert.equal(retryShouldRemoveElement('label_not_set'), true);
  assert.equal(retryShouldRemoveElement('element_not_added'), false);
});

// ── the model is a second opinion, never the source of truth ──────────────────

const unknown = classifyFieldFailure(evidence());

test('a proposal the evidence refutes is thrown away, and the reason is kept', () => {
  const e = evidence({ elementAppeared: true });
  const d = adoptModelDiagnosis({ cause: 'element_not_added', why: 'nothing was added', confidence: 0.99 }, e, unknown);
  assert.equal(d.cause, 'unknown');
  assert.equal(d.modelProposal?.cause, 'element_not_added');
  assert.match(d.modelProposal?.rejectedBecause ?? '', /did appear/);
});

test('a cause outside the vocabulary is thrown away', () => {
  const d = adoptModelDiagnosis({ cause: 'the network was slow', why: 'it looked slow', confidence: 1 }, evidence(), unknown);
  assert.equal(d.cause, 'unknown');
  assert.match(d.modelProposal?.rejectedBecause ?? '', /not one of the causes/);
});

test('a proposal of unknown adds nothing and changes nothing', () => {
  const d = adoptModelDiagnosis({ cause: 'unknown', why: 'cannot say', confidence: 0.9 }, evidence(), unknown);
  assert.equal(d.cause, 'unknown');
  assert.equal(d.source, 'none');
});

test('an unrefuted proposal is adopted as a hypothesis, capped below the deterministic rules', () => {
  const e = evidence({ elementAppeared: true, presentBeforeCommit: true, presentAfterCommit: false });
  const d = adoptModelDiagnosis(
    { cause: 'save_lost_it', why: 'the toolbar control reported success and changed nothing', confidence: 0.99, changedControl: 'Save' },
    e,
    unknown,
  );
  assert.equal(d.cause, 'save_lost_it');
  assert.equal(d.source, 'model');
  assert.ok(d.confidence <= 0.6, `confidence was ${d.confidence}`);
});

test('a nonsense confidence does not become NaN', () => {
  const e = evidence({ elementAppeared: true, presentAfterCommit: false, presentBeforeCommit: true });
  const d = adoptModelDiagnosis({ cause: 'save_lost_it', why: 'x', confidence: Number.NaN }, e, unknown);
  assert.ok(Number.isFinite(d.confidence));
});

test('refutation is one-sided: it never confirms, only contradicts', () => {
  // No evidence at all refutes nothing — an absence of observation must not
  // read as an observation of absence.
  for (const cause of FIELD_FAILURE_CAUSES) {
    assert.equal(refuteCause(cause, evidence()), null, cause);
  }
});

// ── the individual judgements the build pipeline makes ────────────────────────

test('an add is believed when the canvas gained an entry, even if the click reported nothing', () => {
  assert.equal(assessAppearance({ addedReportedOk: false, appeared: ['Text Field'] }), true);
  assert.equal(assessAppearance({ addedReportedOk: true, appeared: [] }), true);
  assert.equal(assessAppearance({ addedReportedOk: false, appeared: [] }), false);
});

test('a label control holding a previously built field means the editor is on the wrong element', () => {
  const verdict = assessSelection({
    hasLabelEditor: true,
    labelEditorValue: 'Heart Rate',
    selectedEntry: null,
    appeared: ['Text Field'],
    peers: ['Heart Rate', 'Temperature'],
  });
  assert.equal(verdict, false);
});

test('an empty label control is a fresh element waiting to be named', () => {
  const verdict = assessSelection({
    hasLabelEditor: true,
    labelEditorValue: '',
    selectedEntry: null,
    appeared: ['Text Field'],
    peers: ['Heart Rate'],
  });
  assert.equal(verdict, true);
});

test('a platform with no label control at all yields no verdict', () => {
  const verdict = assessSelection({
    hasLabelEditor: false,
    labelEditorValue: null,
    selectedEntry: null,
    appeared: ['Text Field'],
    peers: ['Heart Rate'],
  });
  assert.equal(verdict, null);
});

test('a reported selection outranks the label control either way', () => {
  assert.equal(
    assessSelection({
      hasLabelEditor: true,
      labelEditorValue: 'Something Else',
      selectedEntry: 'Heart Rate',
      appeared: ['Text Field'],
      peers: ['Heart Rate'],
    }),
    false,
  );
  assert.equal(
    assessSelection({
      hasLabelEditor: true,
      labelEditorValue: 'Something Else',
      selectedEntry: 'Text Field',
      appeared: ['Text Field'],
      peers: ['Heart Rate'],
    }),
    true,
  );
});

test('a label is only reported missing on a canvas shown to display labels', () => {
  assert.equal(assessLabelOnCanvas({ labelVisible: true, peersVisibleBefore: [] }), true);
  assert.equal(assessLabelOnCanvas({ labelVisible: false, peersVisibleBefore: ['Heart Rate'] }), false);
  // No peer was visible either, so this canvas does not report labels at all.
  assert.equal(assessLabelOnCanvas({ labelVisible: false, peersVisibleBefore: [] }), null);
});

test('a type disagreement is only believed when the control speaks the palette vocabulary', () => {
  const palette = ['Whole Number', 'Free Text', 'Calendar Date'];
  assert.equal(assessType({ displayed: 'Free Text', libraryName: 'Whole Number', paletteNames: palette }), false);
  // Named like a type, but showing something that is not a palette entry: this
  // is some other control and must not condemn the field.
  assert.equal(assessType({ displayed: 'kilograms', libraryName: 'Whole Number', paletteNames: palette }), null);
  assert.equal(assessType({ displayed: 'Whole Number', libraryName: 'Whole Number', paletteNames: palette }), true);
  assert.equal(assessType({ displayed: null, libraryName: 'Whole Number', paletteNames: palette }), null);
});

test('a long form and a short form of the same type agree', () => {
  assert.equal(typesAgree('Number', 'Number (Whole)'), true);
  assert.equal(typesAgree('date / time', 'Date Time'), true);
  assert.equal(typesAgree('Free Text', 'Whole Number'), false);
});
