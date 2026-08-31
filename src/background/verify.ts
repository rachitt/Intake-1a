/**
 * The end-of-run reconciliation sweep.
 *
 * Everything else in the agent verifies as it goes. This walks the finished
 * study back through the UI one more time, field by field, and produces a row
 * per specification entry saying what is actually there.
 *
 * It reads the platform the same way a person would — by opening each form and
 * selecting each field — and never through a debug hook. `__readState()` exists
 * on the practice mock so a human can check results by hand; an agent that
 * calls it has answered a different question than the one that was asked, and
 * it will not be there on the systems that matter.
 *
 * The output is the honest answer to "did this work", including the parts that
 * did not.
 */

import { INTENTS } from './intents';
import { Navigator } from './navigate';
import { SIGNATURES } from '../shared/types';
import { irPointer } from '../shared/ir';
import type { Designer, OptionRow } from './designer';
import type { Grounder } from './grounder';
import type { IrField, IrForm } from '../shared/ir';
import type { PageLike } from './page';
import type { Snapshot, SnapshotNode } from '../shared/snapshot';
import type { Store } from './store';
import type { CoverageRow } from '../shared/protocol';

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export async function runCoverageSweep(
  page: PageLike,
  grounder: Grounder,
  designer: Designer,
  store: Store,
  log: Log,
): Promise<CoverageRow[]> {
  const ir = store.ir;
  if (!ir) return [];

  // The same navigation the builder used. The sweep used to carry its own
  // copy, which judged "am I on a visit?" by whether SOMETHING creatable was on
  // screen — a test the visit schedule itself passes. It therefore believed it
  // had opened every visit while never leaving the list of them, found no forms
  // under any of them, and reported a correctly built study as 0/188.
  const nav = new Navigator(
    page,
    grounder,
    designer,
    log,
    () => ir.visits.map((v) => v.name),
    () => ir.study?.protocol_id ?? '',
  );

  const rows: CoverageRow[] = [];

  for (let vi = 0; vi < ir.visits.length; vi++) {
    const visit = ir.visits[vi]!;
    if (store.aborted) break;

    const visitOpen = await nav.openVisit(visit.name);
    if (!visitOpen) {
      const where = await page.capture();
      log(
        `Could not open visit "${visit.name}" to read it back; stopped on "${where.screenTitle || where.title}".`,
        'error',
      );
      rows.push(missingVisit(vi, visit.name, visit.forms));
      for (let fi = 0; fi < visit.forms.length; fi++) {
        rows.push(...missingForm(vi, fi, visit.name, visit.forms[fi]!, 'the visit could not be opened'));
      }
      continue;
    }

    for (let fi = 0; fi < visit.forms.length; fi++) {
      if (store.aborted) break;
      const form = visit.forms[fi]!;

      // Make sure we are still looking at this visit. Reading a form back ends
      // inside a designer, and the way out does not always land where it
      // started, so each form re-establishes its own starting point.
      if (!nav.onVisitDetail(await page.capture(), visit.name) && !(await nav.openVisit(visit.name))) {
        rows.push(...missingForm(vi, fi, visit.name, form, 'the visit could not be reopened to look for this form'));
        log(`Lost the way back to "${visit.name}" while reading it back.`, 'error');
        continue;
      }

      const snapshot = await page.capture();
      const formNode = findNamed(snapshot, form.name);
      if (!formNode) {
        rows.push(...missingForm(vi, fi, visit.name, form, 'the form is not under this visit'));
        log(`"${form.name}" is missing from "${visit.name}".`, 'error');
        continue;
      }

      const opened = (await nav.openDesigner(form.name)).ok;
      if (!opened) {
        log(`Could not open the designer for "${form.name}" to read it back.`, 'warn');
        // The form is there — it was found under the visit a moment ago — but
        // its fields were never looked at. They are reported as unverified,
        // one row each, because dropping them instead would take them out of
        // the denominator as well as the numerator and turn a form nobody
        // could read into a perfect score.
        rows.push({
          ...blankRow(irPointer.form(vi, fi), visit.name, form.name),
          present: true,
          notes: ['the form exists but its designer could not be opened to read the fields back'],
        });
        form.fields.forEach((field, xi) => {
          rows.push({
            ...blankRow(irPointer.field(vi, fi, xi), visit.name, form.name),
            field: field.label,
            present: false,
            notes: ['not read back: the form exists but its designer could not be opened'],
          });
        });
        continue;
      }

      rows.push(await readFormRow(page, grounder, vi, fi, visit.name, form));
      rows.push(...(await readFieldRows(page, grounder, designer, store, vi, fi, visit.name, form)));

      await nav.leaveDesignerIfOpen([visit.name, ...ir.visits.map((v) => v.name)]);
    }
  }

  // Whatever happened above — a visit that would not open, a designer that
  // would not open, the run being stopped part way — every field in the
  // specification gets a row. A sweep that reports on what it managed to look
  // at, rather than on what it was asked to check, answers "did everything I
  // saw look right" while sounding like it answered "is the study complete".
  const reported = new Set(rows.map((r) => r.pointer));
  for (let vi = 0; vi < ir.visits.length; vi++) {
    const visit = ir.visits[vi]!;
    for (let fi = 0; fi < visit.forms.length; fi++) {
      const form = visit.forms[fi]!;
      form.fields.forEach((field, xi) => {
        const pointer = irPointer.field(vi, fi, xi);
        if (reported.has(pointer)) return;
        rows.push({
          ...blankRow(pointer, visit.name, form.name),
          field: field.label,
          present: false,
          notes: [store.aborted ? 'not read back: the run was stopped' : 'not read back: the sweep never reached it'],
        });
      });
    }
  }

  const fields = rows.filter((r) => r.field);
  const missing = fields.filter((r) => !r.present);
  log(
    `Reconciliation: ${fields.length - missing.length}/${fields.length} fields present` +
      (missing.length ? `; missing: ${missing.slice(0, 8).map((r) => `${r.form}/${r.field}`).join(', ')}${missing.length > 8 ? '…' : ''}` : ''),
    missing.length ? 'warn' : 'info',
  );
  return rows;
}

// ── reading back ──────────────────────────────────────────────────────────────

async function readFormRow(
  page: PageLike,
  grounder: Grounder,
  vi: number,
  fi: number,
  visitName: string,
  form: IrForm,
): Promise<CoverageRow> {
  const snapshot = await page.capture();
  const row: CoverageRow = { ...blankRow(irPointer.form(vi, fi), visitName, form.name), present: true };

  // A repeating flag is usually set at creation and shown read-only afterwards,
  // so this is best-effort: absence of the control is "unknown", not "wrong".
  const repeating = bestNode(grounder, snapshot, INTENTS.formRepeating());
  if (repeating) {
    const actual = Boolean(repeating.state.checked);
    row.repeatingOk = actual === form.repeating;
    if (!row.repeatingOk) row.notes.push(`repeating is ${actual}, specification says ${form.repeating}`);
  } else {
    row.notes.push('no control reports whether this document repeats; not checked');
  }
  return row;
}

async function readFieldRows(
  page: PageLike,
  grounder: Grounder,
  designer: Designer,
  store: Store,
  vi: number,
  fi: number,
  visitName: string,
  form: IrForm,
): Promise<CoverageRow[]> {
  const rows: CoverageRow[] = [];

  for (let xi = 0; xi < form.fields.length; xi++) {
    const field = form.fields[xi]!;
    const row: CoverageRow = { ...blankRow(irPointer.field(vi, fi, xi), visitName, form.name), field: field.label };

    const snapshot = await page.capture();
    const node = designer.fieldOnCanvas(snapshot, field.label);
    if (!node) {
      // The field may still be there while rendering as something unnamed.
      if (designer.fieldPresentOnCanvas(snapshot, field.label)) {
        row.present = true;
        row.notes.push('present, but its preview carries no accessible name, so its properties could not be read back');
        rows.push(row);
        continue;
      }
      row.present = false;
      row.notes.push('not found on the form');
      rows.push(row);
      continue;
    }

    row.present = true;

    // Select it so the property editor shows this field, then read one snapshot
    // and take every property out of it.
    const observation = await page.click(node.ref);
    const editor = observation.after;

    // Worked out once and shared: the label check needs to know which boxes
    // belong to a coded value so it can ignore them, and the option check needs
    // the same rows to read the pairs off.
    // Every property is read from the property editor, never from the canvas
    // preview of the field itself.
    const scope = offCanvas(designer, editor, field.label);
    const pairs = designer.optionRows(editor, scope);

    checkType(grounder, store, editor, field, row, scope);
    checkLabel(grounder, designer, editor, field, row, scope);
    checkRequired(grounder, editor, field, row, scope);
    checkRange(grounder, editor, field, row, scope);
    checkFormula(grounder, editor, field, row, scope);
    checkOptions(grounder, editor, field, row, pairs, scope);
    checkSkipLogic(grounder, editor, field, row, scope);

    rows.push(row);
  }

  return rows;
}

/**
 * The field's type — the property that was never actually checked.
 *
 * `CoverageRow` has carried a `typeOk` column since the beginning and nothing
 * ever wrote to it, so a study whose dates were all built as free text read
 * back as fully verified: every label matched, every required flag matched,
 * and the one property that decides what the field can hold was not consulted.
 *
 * It is checked without knowing anything about this platform. The specification
 * says a canonical type; the profile records which of THIS designer's library
 * entries was found to realise that type, by probing, earlier in the run. The
 * type control in the property editor should now be reading that entry back.
 * Where the profile learned nothing, the answer is "not checked" rather than a
 * guess — an unknown reported as a pass is the failure this whole sweep exists
 * to prevent.
 */
function checkType(
  grounder: Grounder,
  store: Store,
  editor: Snapshot,
  field: IrField,
  row: CoverageRow,
  scope: Scope,
): void {
  const mapping = store.profile?.typeMap[field.type];
  if (!mapping) {
    row.notes.push(`type not checked: nothing was learned about how this platform spells ${field.type}`);
    return;
  }

  const node = bestNode(grounder, editor, INTENTS.fieldType(), scope);
  const actual = (node?.value ?? '').trim();
  if (!node || !actual) {
    row.notes.push('could not read the field type back');
    return;
  }

  if (actual.toLowerCase() !== mapping.libraryName.toLowerCase()) {
    row.typeOk = false;
    row.notes.push(`type reads "${actual}", specification says ${field.type}, built here as "${mapping.libraryName}"`);
    return;
  }

  // The field is what the run meant it to be. Whether what the run meant was
  // RIGHT is a different question, and only probing answers it: a mapping that
  // was assumed makes this check circular — it confirms the agent did what it
  // decided to do, which it would also report for a study built entirely out of
  // the wrong element. So a match against an unproven mapping is reported as
  // not verified, with the reason, rather than as a pass.
  if (mapping.source === 'assumed') {
    row.notes.push(
      `type reads "${actual}", but nothing established that this platform's "${actual}" really is ` +
        `${field.type} — the mapping was assumed rather than probed, so the type is not verified`,
    );
    return;
  }

  row.typeOk = true;
  if (mapping.conflicts?.length) {
    row.notes.push(`type reads "${actual}"; probing it also noted: ${mapping.conflicts.slice(0, 2).join('; ')}`);
  }
}

function checkLabel(
  grounder: Grounder,
  designer: Designer,
  editor: Snapshot,
  field: IrField,
  row: CoverageRow,
  scope: Scope,
): void {
  const node = designer.fieldLabelBox(editor, scope);
  if (!node) {
    row.notes.push('could not read the label back');
    return;
  }
  row.labelOk = (node.value ?? '') === field.label;
  if (!row.labelOk) {
    row.notes.push(`label reads "${node.value ?? ''}", specification says "${field.label}"`);
    // Say what else was on the table. A read-back that disagrees with the build
    // is either a real defect or a misread, and the only way to tell them apart
    // later is to know which control was consulted.
    const considered = grounder
      .rank(editor, { ...INTENTS.fieldLabel(), ignoreMemory: true })
      .slice(0, 3)
      .map((c) => `"${c.node.name}"=${JSON.stringify(c.node.value ?? '')}@${c.score.toFixed(2)}${scope(c.node) ? '' : ' [on the canvas]'}`)
      .join(', ');
    row.notes.push(`label read from "${node.name}"; considered ${considered}`);
  }
}

function checkRequired(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow, scope: Scope): void {
  const node = bestNode(grounder, editor, INTENTS.fieldRequired(), scope);
  if (!node || node.state.checked === undefined) {
    row.notes.push('could not read the required flag back');
    return;
  }
  row.requiredOk = node.state.checked === field.required;
  if (!row.requiredOk) row.notes.push(`required is ${node.state.checked}, specification says ${field.required}`);
}

/**
 * Range and units.
 *
 * This is the check that catches the silent discard: a platform that drops
 * min/max when the type changes says nothing at the time, and the only way to
 * know is to come back and look.
 */
function checkRange(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow, scope: Scope): void {
  if (!SIGNATURES[field.type].hasRange) return;
  const wantsRange = field.min !== undefined || field.max !== undefined || field.units !== undefined;
  if (!wantsRange) return;

  const min = bestNode(grounder, editor, INTENTS.fieldMin(), scope);
  const max = bestNode(grounder, editor, INTENTS.fieldMax(), scope);
  const units = bestNode(grounder, editor, INTENTS.fieldUnits(), scope);

  const problems: string[] = [];
  if (field.min !== undefined) {
    const actual = min?.value ?? '';
    if (String(field.min) !== actual) problems.push(`minimum reads "${actual}", expected "${field.min}"`);
  }
  if (field.max !== undefined) {
    const actual = max?.value ?? '';
    if (String(field.max) !== actual) problems.push(`maximum reads "${actual}", expected "${field.max}"`);
  }
  if (field.units !== undefined) {
    const actual = units?.value ?? '';
    if (field.units !== actual) problems.push(`units read "${actual}", expected "${field.units}"`);
  }

  row.rangeOk = problems.length === 0;
  row.notes.push(...problems);
}

function checkFormula(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow, scope: Scope): void {
  if (!field.formula) return;
  const node = bestNode(grounder, editor, INTENTS.fieldFormula(), scope);
  const actual = node?.value ?? '';
  row.formulaOk = actual.replace(/\s+/g, '') === field.formula.replace(/\s+/g, '');
  if (!row.formulaOk) row.notes.push(`formula reads "${actual}", expected "${field.formula}"`);
}

/**
 * Coded values, checked as PAIRS.
 *
 * Counting rows is not enough: a list entered label-only looks complete and
 * stores nothing useful, and a bulk paste that replaced rather than appended
 * looks complete too. So codes and labels are read separately and matched.
 */
function checkOptions(
  grounder: Grounder,
  editor: Snapshot,
  field: IrField,
  row: CoverageRow,
  pairs: OptionRow[],
  scope: Scope,
): void {
  const expected = field.options ?? [];
  if (!expected.length) return;

  let codes: string[];
  let labels: string[];

  if (pairs.length) {
    codes = pairs.map((p) => p.code.value ?? '');
    labels = pairs.map((p) => p.label?.value ?? '');
  } else {
    // No box on this platform reads as a "code". Fall back to label-only
    // ranking, which is the best that can be done, and say so — an unpaired
    // read cannot prove the codes are right, and claiming otherwise would be
    // exactly the false confidence this sweep exists to prevent.
    const fieldLabelBox = bestNode(grounder, editor, INTENTS.fieldLabel(), scope);
    labels = allNodes(grounder, editor, INTENTS.optionLabel(), scope)
      .filter((n) => n.ref !== fieldLabelBox?.ref)
      .map((n) => n.value ?? '');
    codes = [];
    if (!labels.length) {
      row.notes.push('could not read the coded value list back');
      return;
    }
    row.notes.push('no control on this platform identifies a coded value’s CODE; only the labels could be read back');
  }

  const problems: string[] = [];
  const present = pairs.length ? codes.length : labels.length;
  if (present !== expected.length) problems.push(`${present} coded value(s) present, expected ${expected.length}`);

  expected.forEach((option, i) => {
    if (codes[i] !== undefined && codes[i] !== option.code) problems.push(`value ${i + 1} code reads "${codes[i]}", expected "${option.code}"`);
    if (labels[i] !== undefined && labels[i] !== option.label) problems.push(`value ${i + 1} label reads "${labels[i]}", expected "${option.label}"`);
  });

  row.optionsOk = problems.length === 0;
  row.notes.push(...problems.slice(0, 4));
}

function checkSkipLogic(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow, scope: Scope): void {
  if (!field.skip_logic) return;
  const when = bestNode(grounder, editor, INTENTS.visibilityWhenField(), scope);
  const value = bestNode(grounder, editor, INTENTS.visibilityValue(), scope);

  const actualWhen = when?.value ?? '';
  const actualValue = value?.value ?? '';
  const whenOk = actualWhen.includes(field.skip_logic.when_field_label);
  const valueOk = actualValue === field.skip_logic.equals_value;

  row.skipOk = whenOk && valueOk;
  if (!whenOk) row.notes.push(`condition field reads "${actualWhen}", expected "${field.skip_logic.when_field_label}"`);
  if (!valueOk) row.notes.push(`condition value reads "${actualValue}", expected "${field.skip_logic.equals_value}"`);
}

// ── helpers ───────────────────────────────────────────────────────────────────

/**
 * Everything except the designer canvas.
 *
 * The canvas is full of inert PREVIEW inputs, and a preview is named after the
 * field it previews — so a form containing a field called "Medication Name"
 * puts an empty textbox called "Medication Name" on screen, which reads as an
 * excellent candidate for "the box holding this field's label" and is nothing
 * of the sort. Reading a property off it reports an empty label on a field that
 * was built correctly.
 *
 * The canvas is located positively rather than guessed at: it is whichever
 * region holds the preview of the field currently being read back. Both the
 * canvas and the property editor look like editors — clusters of labelled
 * inputs — so no amount of shape analysis separates them, but the field's own
 * preview can only be on one of them.
 *
 * If that leaves nothing to read (a platform that edits properties inline on
 * the canvas), the caller falls back to the unscoped snapshot: a slightly
 * suspect read beats no read, and recall matters more than precision here.
 */
function offCanvas(designer: Designer, editor: Snapshot, label: string): (node: SnapshotNode) => boolean {
  const preview = designer.fieldOnCanvas(editor, label);
  if (!preview) return () => true;
  return (node: SnapshotNode) => node.region !== preview.region;
}

type Scope = (node: SnapshotNode) => boolean;

const ANYWHERE: Scope = () => true;

function bestNode(
  grounder: Grounder,
  snapshot: Snapshot,
  intent: Parameters<Grounder['rank']>[1],
  scope: Scope = ANYWHERE,
): SnapshotNode | undefined {
  const ranked = grounder.rank(snapshot, { ...intent, ignoreMemory: true }).filter((c) => c.score >= 0.5);
  // Prefer a candidate inside the scope; fall back to the best one anywhere
  // rather than reporting "could not read it back" when something was found.
  return (ranked.find((c) => scope(c.node)) ?? ranked[0])?.node;
}

function allNodes(
  grounder: Grounder,
  snapshot: Snapshot,
  intent: Parameters<Grounder['rank']>[1],
  scope: Scope = ANYWHERE,
): SnapshotNode[] {
  return grounder
    .rank(snapshot, { ...intent, ignoreMemory: true })
    .filter((c) => c.score >= 0.45 && scope(c.node))
    .map((c) => c.node)
    // Preserve on-screen order, which is the order the values were entered in.
    .sort((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0));
}

function findNamed(snapshot: Snapshot, name: string): SnapshotNode | undefined {
  const exact = snapshot.nodes.find((n) => n.name === name);
  if (exact) return exact;
  return snapshot.nodes.filter((n) => n.name.includes(name)).sort((a, b) => a.name.length - b.name.length)[0];
}

function blankRow(pointer: string, visit: string, form: string): CoverageRow {
  return {
    pointer,
    visit,
    form,
    present: false,
    typeOk: null,
    labelOk: null,
    requiredOk: null,
    optionsOk: null,
    rangeOk: null,
    formulaOk: null,
    skipOk: null,
    repeatingOk: null,
    notes: [],
  };
}

function missingVisit(vi: number, name: string, _forms: IrForm[]): CoverageRow {
  return { ...blankRow(irPointer.visit(vi), name, ''), present: false, notes: ['the visit could not be found or opened'] };
}

function missingForm(vi: number, fi: number, visitName: string, form: IrForm, why: string): CoverageRow[] {
  const rows: CoverageRow[] = [{ ...blankRow(irPointer.form(vi, fi), visitName, form.name), present: false, notes: [why] }];
  form.fields.forEach((field, xi) => {
    rows.push({
      ...blankRow(irPointer.field(vi, fi, xi), visitName, form.name),
      field: field.label,
      present: false,
      notes: [why],
    });
  });
  return rows;
}
