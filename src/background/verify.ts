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
import type { Page } from './page';
import type { Snapshot, SnapshotNode } from '../shared/snapshot';
import type { Store } from './store';
import type { CoverageRow } from '../shared/protocol';

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export async function runCoverageSweep(
  page: Page,
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

    const visitOpen = await openVisit(page, grounder, visit.name);
    if (!visitOpen) {
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
        rows.push({
          ...blankRow(irPointer.form(vi, fi), visit.name, form.name),
          present: true,
          notes: ['the form exists but its designer could not be opened to read the fields back'],
        });
        continue;
      }

      rows.push(await readFormRow(page, grounder, vi, fi, visit.name, form));
      rows.push(...(await readFieldRows(page, grounder, vi, fi, visit.name, form)));

      await leaveDesigner(page, grounder);
      await openVisit(page, grounder, visit.name);
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

async function openVisit(page: Page, grounder: Grounder, name: string): Promise<boolean> {
  for (let attempt = 0; attempt < 3; attempt++) {
    let snapshot = await page.capture();
    let node = findNamed(snapshot, name);
    if (!node) {
      const back = await grounder.ground(snapshot, INTENTS.gotoVisitSchedule());
      if (!back.ok) return false;
      await page.click(back.ref);
      snapshot = await page.capture();
      node = findNamed(snapshot, name);
      if (!node) continue;
    }
    await page.click(node.ref);
    const after = await page.capture();
    const ranked = grounder.rank(after, { ...INTENTS.formCreate(), ignoreMemory: true });
    if (ranked[0] && ranked[0].score >= 0.5) return true;
  }
  return false;
}

async function openDesigner(page: Page, grounder: Grounder, designer: Designer, formName: string): Promise<boolean> {
  const snapshot = await page.capture();
  const row = findNamed(snapshot, formName);
  const result = await grounder.ground(snapshot, { ...INTENTS.formOpenDesigner(), nearName: row?.name ?? formName });
  if (!result.ok) return false;
  await page.click(result.ref);
  const entries = await designer.paletteEntries(await page.capture());
  return entries.length > 0;
}

async function leaveDesigner(page: Page, grounder: Grounder): Promise<void> {
  const snapshot = await page.capture();
  const result = await grounder.ground(snapshot, INTENTS.leaveDesigner());
  if (result.ok) await page.click(result.ref);
}

// ── reading back ──────────────────────────────────────────────────────────────

async function readFormRow(
  page: Page,
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
  page: Page,
  grounder: Grounder,
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
    const node = canvasNode(snapshot, field.label);
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

function canvasNode(snapshot: Snapshot, label: string): SnapshotNode | undefined {
  const excluded = new Set(['palette', 'toolbar', 'navigation', 'editor']);
  const excludedRegions = new Set(snapshot.regions.filter((r) => excluded.has(r.kind)).map((r) => r.id));
  return snapshot.nodes
    .filter((n) => !excludedRegions.has(n.region) && n.name.includes(label))
    .sort((a, b) => a.name.length - b.name.length)[0];
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
