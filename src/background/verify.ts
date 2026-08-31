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
import { SIGNATURES } from '../shared/types';
import { irPointer } from '../shared/ir';
import type { Designer } from './designer';
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

  const rows: CoverageRow[] = [];

  for (let vi = 0; vi < ir.visits.length; vi++) {
    const visit = ir.visits[vi]!;
    if (store.aborted) break;

    const visitOpen = await openVisit(page, grounder, designer, visit.name);
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

      const snapshot = await page.capture();
      const formNode = findNamed(snapshot, form.name);
      if (!formNode) {
        rows.push(...missingForm(vi, fi, visit.name, form, 'the form is not under this visit'));
        log(`"${form.name}" is missing from "${visit.name}".`, 'error');
        continue;
      }

      const opened = await openDesigner(page, grounder, designer, form.name);
      if (!opened) {
        log(`Could not open the designer for "${form.name}" to read it back.`, 'warn');
        rows.push({
          ...blankRow(irPointer.form(vi, fi), visit.name, form.name),
          present: true,
          notes: ['the form exists but its designer could not be opened to read the fields back'],
        });
        continue;
      }

      rows.push(await readFormRow(page, grounder, vi, fi, visit.name, form));
      rows.push(...(await readFieldRows(page, grounder, designer, vi, fi, visit.name, form)));

      await leaveDesigner(page, grounder, designer, [visit.name]);
      await openVisit(page, grounder, designer, visit.name);
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

// ── navigation ────────────────────────────────────────────────────────────────

/**
 * Open a visit by name, from wherever we happen to be.
 *
 * Every step is judged by whether it achieved the goal rather than by whether
 * the page moved, and any control that did not is ruled out for the rest of the
 * attempt. Applications are full of controls that navigate somewhere — just not
 * where you asked.
 */
async function openVisit(page: PageLike, grounder: Grounder, designer: Designer, name: string): Promise<boolean> {
  const wrongTurns: string[] = [];

  const onVisit = (snapshot: Snapshot): boolean => {
    const ranked = grounder.rank(snapshot, { ...INTENTS.formCreate(), ignoreMemory: true })[0];
    return Boolean(ranked && ranked.score >= 0.5);
  };

  /**
   * Already looking at this visit?
   *
   * The screen's own heading is the evidence. A visit's detail screen names the
   * visit and offers somewhere to add a document to it. Without this check the
   * agent navigates away from the very screen it wanted in order to come back
   * to it — and on a platform where that round trip does not land where it
   * expects, it never arrives at all.
   */
  const alreadyHere = (snapshot: Snapshot): boolean =>
    onVisit(snapshot) && snapshot.screenTitle.includes(name);

  for (let attempt = 0; attempt < 8; attempt++) {
    const snapshot = await page.capture();
    if (alreadyHere(snapshot)) return true;


    const row = snapshot.nodes.find((n) => n.role === 'row' && n.name.includes(name));
    if (row) {
      const observation = await page.click(row.ref);
      if (onVisit(observation.after)) return true;
      continue;
    }

    // Not on a screen listing this visit. Climb out: first out of any designer,
    // then towards the schedule.
    if ((await designer.paletteEntries(snapshot)).length) {
      const leave = await grounder.ground(snapshot, {
        ...INTENTS.leaveDesigner([name]),
        excludeNames: wrongTurns,
        ignoreMemory: wrongTurns.length > 0,
      });
      if (!leave.ok) return false;
      const moved = await page.click(leave.ref);
      if ((await designer.paletteEntries(moved.after)).length) {
        wrongTurns.push(leave.node.name);
        grounder.forget(INTENTS.leaveDesigner().id);
      }
      continue;
    }

    const back = await grounder.ground(snapshot, {
      ...INTENTS.gotoVisitSchedule(),
      excludeNames: wrongTurns,
      ignoreMemory: wrongTurns.length > 0,
    });
    if (!back.ok) return false;

    const moved = await page.click(back.ref);
    const reached = moved.after.nodes.some((n) => n.role === 'row' && n.name.includes(name));
    if (!reached) {
      wrongTurns.push(back.node.name);
      grounder.forget(INTENTS.gotoVisitSchedule().id);
    }
  }
  return false;
}

async function openDesigner(page: PageLike, grounder: Grounder, designer: Designer, formName: string): Promise<boolean> {
  const snapshot = await page.capture();
  const rows = snapshot.nodes.filter((n) => n.role === 'row' && n.name.includes(formName));
  const row = rows.sort((a, b) => a.name.length - b.name.length)[0] ?? findNamed(snapshot, formName);
  const result = await grounder.ground(snapshot, {
    ...INTENTS.formOpenDesigner(),
    nearName: row?.name ?? formName,
    ...(row?.box ? { withinBox: row.box } : {}),
  });
  if (!result.ok) return false;
  await page.click(result.ref);
  const entries = await designer.paletteEntries(await page.capture());
  return entries.length > 0;
}

async function leaveDesigner(page: PageLike, grounder: Grounder, designer: Designer, context: string[] = []): Promise<void> {
  const inert: string[] = [];
  for (let attempt = 0; attempt < 4; attempt++) {
    const snapshot = await page.capture();
    if (!(await designer.paletteEntries(snapshot)).length) return;
    const result = await grounder.ground(snapshot, {
      ...INTENTS.leaveDesigner(context),
      excludeNames: inert,
      ignoreMemory: inert.length > 0,
    });
    if (!result.ok) return;
    const observation = await page.click(result.ref);
    if (observation.diff.magnitude === 0) {
      inert.push(result.node.name);
      grounder.forget(INTENTS.leaveDesigner().id);
    }
  }
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

    checkLabel(grounder, editor, field, row);
    checkRequired(grounder, editor, field, row);
    checkRange(grounder, editor, field, row);
    checkFormula(grounder, editor, field, row);
    checkOptions(grounder, editor, field, row);
    checkSkipLogic(grounder, editor, field, row);

    rows.push(row);
  }

  return rows;
}

function checkLabel(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow): void {
  const node = bestNode(grounder, editor, INTENTS.fieldLabel());
  if (!node) {
    row.notes.push('could not read the label back');
    return;
  }
  row.labelOk = (node.value ?? '') === field.label;
  if (!row.labelOk) row.notes.push(`label reads "${node.value ?? ''}", specification says "${field.label}"`);
}

function checkRequired(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow): void {
  const node = bestNode(grounder, editor, INTENTS.fieldRequired());
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
function checkRange(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow): void {
  if (!SIGNATURES[field.type].hasRange) return;
  const wantsRange = field.min !== undefined || field.max !== undefined || field.units !== undefined;
  if (!wantsRange) return;

  const min = bestNode(grounder, editor, INTENTS.fieldMin());
  const max = bestNode(grounder, editor, INTENTS.fieldMax());
  const units = bestNode(grounder, editor, INTENTS.fieldUnits());

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

function checkFormula(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow): void {
  if (!field.formula) return;
  const node = bestNode(grounder, editor, INTENTS.fieldFormula());
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
function checkOptions(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow): void {
  const expected = field.options ?? [];
  if (!expected.length) return;

  const codes = allNodes(grounder, editor, INTENTS.optionCode()).map((n) => n.value ?? '');
  const labels = allNodes(grounder, editor, INTENTS.optionLabel()).map((n) => n.value ?? '');

  if (!codes.length && !labels.length) {
    row.notes.push('could not read the coded value list back');
    return;
  }

  const problems: string[] = [];
  if (codes.length !== expected.length) problems.push(`${codes.length} coded value(s) present, expected ${expected.length}`);

  expected.forEach((option, i) => {
    if (codes[i] !== undefined && codes[i] !== option.code) problems.push(`value ${i + 1} code reads "${codes[i]}", expected "${option.code}"`);
    if (labels[i] !== undefined && labels[i] !== option.label) problems.push(`value ${i + 1} label reads "${labels[i]}", expected "${option.label}"`);
  });

  row.optionsOk = problems.length === 0;
  row.notes.push(...problems.slice(0, 4));
}

function checkSkipLogic(grounder: Grounder, editor: Snapshot, field: IrField, row: CoverageRow): void {
  if (!field.skip_logic) return;
  const when = bestNode(grounder, editor, INTENTS.visibilityWhenField());
  const value = bestNode(grounder, editor, INTENTS.visibilityValue());

  const actualWhen = when?.value ?? '';
  const actualValue = value?.value ?? '';
  const whenOk = actualWhen.includes(field.skip_logic.when_field_label);
  const valueOk = actualValue === field.skip_logic.equals_value;

  row.skipOk = whenOk && valueOk;
  if (!whenOk) row.notes.push(`condition field reads "${actualWhen}", expected "${field.skip_logic.when_field_label}"`);
  if (!valueOk) row.notes.push(`condition value reads "${actualValue}", expected "${field.skip_logic.equals_value}"`);
}

// ── helpers ───────────────────────────────────────────────────────────────────

function bestNode(grounder: Grounder, snapshot: Snapshot, intent: Parameters<Grounder['rank']>[1]): SnapshotNode | undefined {
  const ranked = grounder.rank(snapshot, { ...intent, ignoreMemory: true });
  const top = ranked[0];
  return top && top.score >= 0.5 ? top.node : undefined;
}

function allNodes(grounder: Grounder, snapshot: Snapshot, intent: Parameters<Grounder['rank']>[1]): SnapshotNode[] {
  return grounder
    .rank(snapshot, { ...intent, ignoreMemory: true })
    .filter((c) => c.score >= 0.45)
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
