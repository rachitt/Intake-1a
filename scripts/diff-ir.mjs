/**
 * By-hand verification: diff what a platform actually contains against the
 * study specification.
 *
 * This is a DEVELOPER tool, not part of the agent. It is the only place in the
 * repository allowed to consume a mock's debug dump, and it exists so the
 * numbers reported in the README are measured rather than asserted.
 *
 *   1. In the mock's tab, open DevTools and run:  copy(__exportState())
 *   2. Paste into a file, e.g. built.json
 *   3. node scripts/diff-ir.mjs built.json path/to/abc-101-study.ir.json
 *
 * It scores what the assignment says matters: every form present, every field
 * present, every type correct, every coded value list complete with BOTH codes
 * and labels, every range and unit, every display rule, the right forms marked
 * as repeating — with missing items reported separately, because a field that
 * never got built costs far more than a wrong one.
 */

import { readFile } from 'node:fs/promises';

const [statePath, irPath] = process.argv.slice(2);
if (!statePath || !irPath) {
  console.error('usage: node scripts/diff-ir.mjs <state-dump.json> <study.ir.json>');
  process.exit(2);
}

const dump = JSON.parse(await readFile(statePath, 'utf8'));
const ir = JSON.parse(await readFile(irPath, 'utf8'));
const built = dump.study ?? dump;

const problems = [];
const stats = {
  visits: { expected: 0, present: 0 },
  forms: { expected: 0, present: 0 },
  fields: { expected: 0, present: 0 },
  checks: { total: 0, passed: 0 },
};

const note = (kind, where, message) => problems.push({ kind, where, message });

function check(where, name, actual, expected) {
  stats.checks.total++;
  const ok = String(actual ?? '') === String(expected ?? '');
  if (ok) stats.checks.passed++;
  else note('wrong', where, `${name}: got ${JSON.stringify(actual ?? '')}, expected ${JSON.stringify(expected ?? '')}`);
  return ok;
}

for (const visit of ir.visits) {
  stats.visits.expected++;
  const builtVisit = (built.visits ?? []).find((v) => v.name === visit.name);
  if (!builtVisit) {
    note('missing', visit.name, 'the visit is not in the platform');
    for (const form of visit.forms) {
      stats.forms.expected++;
      stats.fields.expected += form.fields.length;
    }
    continue;
  }
  stats.visits.present++;

  check(visit.name, 'window start', builtVisit.windowStart, visit.window_start_day);
  check(visit.name, 'window end', builtVisit.windowEnd, visit.window_end_day);

  for (const form of visit.forms) {
    stats.forms.expected++;
    const where = `${visit.name} / ${form.name}`;
    const builtForm = (builtVisit.forms ?? []).find((f) => f.name === form.name);
    if (!builtForm) {
      note('missing', where, 'the form is not under this visit');
      stats.fields.expected += form.fields.length;
      continue;
    }
    stats.forms.present++;

    check(where, 'repeating', builtForm.repeating, form.repeating);

    for (const field of form.fields) {
      stats.fields.expected++;
      const fieldWhere = `${where} / ${field.label}`;
      const builtField = (builtForm.fields ?? []).find((f) => f.label === field.label);
      if (!builtField) {
        note('missing', fieldWhere, 'the field is not on the form');
        continue;
      }
      stats.fields.present++;

      check(fieldWhere, 'type', builtField.type, field.type);
      check(fieldWhere, 'required', builtField.required, field.required);

      // Coded values are pairs. A list with the right labels and empty codes
      // looks correct on screen and stores nothing useful.
      const expectedOptions = field.options ?? [];
      const actualOptions = builtField.options ?? [];
      if (expectedOptions.length || actualOptions.length) {
        stats.checks.total++;
        const same =
          expectedOptions.length === actualOptions.length &&
          expectedOptions.every((o, i) => actualOptions[i]?.code === o.code && actualOptions[i]?.label === o.label);
        if (same) stats.checks.passed++;
        else {
          const detail =
            expectedOptions.length !== actualOptions.length
              ? `${actualOptions.length} value(s), expected ${expectedOptions.length}`
              : expectedOptions
                  .map((o, i) =>
                    actualOptions[i]?.code === o.code && actualOptions[i]?.label === o.label
                      ? null
                      : `#${i + 1} got ${JSON.stringify(actualOptions[i] ?? null)}, expected ${JSON.stringify(o)}`,
                  )
                  .filter(Boolean)
                  .slice(0, 3)
                  .join('; ');
          note('wrong', fieldWhere, `coded values: ${detail}`);
        }
      }

      if (field.min !== undefined) check(fieldWhere, 'min', builtField.min, field.min);
      if (field.max !== undefined) check(fieldWhere, 'max', builtField.max, field.max);
      if (field.units !== undefined) check(fieldWhere, 'units', builtField.units, field.units);
      if (field.formula !== undefined) {
        stats.checks.total++;
        const norm = (s) => String(s ?? '').replace(/\s+/g, '');
        if (norm(builtField.formula) === norm(field.formula)) stats.checks.passed++;
        else note('wrong', fieldWhere, `formula: got ${JSON.stringify(builtField.formula ?? '')}, expected ${JSON.stringify(field.formula)}`);
      }

      if (field.skip_logic) {
        stats.checks.total++;
        const actual = builtField.skipLogic;
        const ok =
          actual &&
          actual.whenFieldLabel === field.skip_logic.when_field_label &&
          actual.equalsValue === field.skip_logic.equals_value;
        if (ok) stats.checks.passed++;
        else note('wrong', fieldWhere, `display rule: got ${JSON.stringify(actual ?? null)}, expected ${JSON.stringify(field.skip_logic)}`);
      } else if (builtField.skipLogic) {
        note('extra', fieldWhere, `has a display rule the specification does not ask for: ${JSON.stringify(builtField.skipLogic)}`);
      }
    }

    // Things present that the specification never asked for.
    for (const builtField of builtForm.fields ?? []) {
      if (!form.fields.some((f) => f.label === builtField.label)) {
        note('extra', `${where} / ${builtField.label}`, 'field is not in the specification');
      }
    }
  }
}

// ── report ────────────────────────────────────────────────────────────────────

const missing = problems.filter((p) => p.kind === 'missing');
const wrong = problems.filter((p) => p.kind === 'wrong');
const extra = problems.filter((p) => p.kind === 'extra');

const pct = (a, b) => (b === 0 ? '100.0' : ((a / b) * 100).toFixed(1));

console.log(`\nPlatform: ${dump.platform ?? 'unknown'}${dump.specVersion ? ` (${dump.specVersion})` : ''}`);
console.log(`Study:    ${built.name ?? '?'}\n`);

console.log(`  visits   ${stats.visits.present}/${stats.visits.expected}  (${pct(stats.visits.present, stats.visits.expected)}%)`);
console.log(`  forms    ${stats.forms.present}/${stats.forms.expected}  (${pct(stats.forms.present, stats.forms.expected)}%)`);
console.log(`  fields   ${stats.fields.present}/${stats.fields.expected}  (${pct(stats.fields.present, stats.fields.expected)}%)`);
console.log(`  property checks ${stats.checks.passed}/${stats.checks.total}  (${pct(stats.checks.passed, stats.checks.total)}%)\n`);

const show = (title, list, limit = 40) => {
  if (!list.length) return;
  console.log(`${title} (${list.length}):`);
  for (const p of list.slice(0, limit)) console.log(`  - ${p.where} — ${p.message}`);
  if (list.length > limit) console.log(`  …and ${list.length - limit} more`);
  console.log('');
};

// Missing first: it is the failure that costs the most and is noticed last.
show('MISSING', missing);
show('WRONG', wrong);
show('EXTRA', extra);

if (!problems.length) console.log('Everything in the specification is present and correct.\n');

process.exit(missing.length || wrong.length ? 1 : 0);
