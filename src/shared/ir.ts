/**
 * The input contract: an IR describing a study specification.
 *
 * The thirteen canonical types are SEMANTIC. They are deliberately not the
 * names any particular platform gives its widgets — mapping them onto an
 * unknown element library is the agent's job, and that lives in `types.ts`.
 */

import { SIGNATURES } from './types';

export type CanonicalType =
  | 'text'
  | 'textarea'
  | 'integer'
  | 'decimal'
  | 'date'
  | 'time'
  | 'datetime'
  | 'boolean'
  | 'single_select'
  | 'multi_select'
  | 'radio'
  | 'checkbox'
  | 'calculated';

export const CANONICAL_TYPES: readonly CanonicalType[] = [
  'text', 'textarea', 'integer', 'decimal', 'date', 'time', 'datetime',
  'boolean', 'single_select', 'multi_select', 'radio', 'checkbox', 'calculated',
];

export interface IrOption {
  /** What the system stores. */
  code: string;
  /** What a human reads. */
  label: string;
}

export interface IrSkipLogic {
  /** A field in the SAME form, referenced by its label. */
  when_field_label: string;
  /** For coded fields this is the option CODE; for booleans, "Yes" or "No". */
  equals_value: string;
}

export interface IrField {
  label: string;
  type: CanonicalType;
  required: boolean;
  options?: IrOption[];
  min?: number;
  max?: number;
  units?: string;
  formula?: string;
  skip_logic?: IrSkipLogic;
}

export interface IrForm {
  name: string;
  /** true = a log holding many records per subject-visit. */
  repeating: boolean;
  fields: IrField[];
}

export interface IrVisit {
  name: string;
  window_start_day: number;
  window_end_day: number;
  forms: IrForm[];
}

export interface IrStudy {
  ir_version: string;
  study: { protocol_id: string; title: string };
  visits: IrVisit[];
}

/**
 * A JSON-Pointer-shaped address into the IR. Every action the agent takes
 * carries one, so any built element can be traced back to the line of the
 * specification that asked for it. In a regulated environment this is not
 * optional, so it is a required field on the audit record, not an extra.
 */
export type IrPointer = string;

export const irPointer = {
  visit: (v: number): IrPointer => `/visits/${v}`,
  form: (v: number, f: number): IrPointer => `/visits/${v}/forms/${f}`,
  field: (v: number, f: number, x: number): IrPointer => `/visits/${v}/forms/${f}/fields/${x}`,
};

/** Resolve an IR pointer back to the object it addresses, for audit rendering. */
export function resolvePointer(ir: IrStudy, pointer: IrPointer): unknown {
  if (!pointer || pointer === '/') return ir;
  let node: unknown = ir;
  for (const rawPart of pointer.split('/').slice(1)) {
    const part = rawPart.replace(/~1/g, '/').replace(/~0/g, '~');
    if (Array.isArray(node)) node = node[Number(part)];
    else if (node && typeof node === 'object') node = (node as Record<string, unknown>)[part];
    else return undefined;
  }
  return node;
}

// ── validation ────────────────────────────────────────────────────────────────

export interface IrProblem {
  pointer: IrPointer;
  message: string;
  severity: 'error' | 'warning';
}

export interface IrStats {
  visits: number;
  formInstances: number;
  distinctForms: number;
  fields: number;
  withOptions: number;
  withRange: number;
  withFormula: number;
  skipRules: number;
  repeatingForms: number;
  typeHistogram: Record<string, number>;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * Validate the IR structurally and semantically before a single click is made.
 *
 * The semantic checks matter more than the structural ones. A skip-logic rule
 * whose controlling field does not exist in the same form is unbuildable on
 * ANY platform, and it is far cheaper to say so now than to discover it after
 * twenty forms have been built.
 */
export function validateIr(raw: unknown): { ir: IrStudy | null; problems: IrProblem[] } {
  const problems: IrProblem[] = [];
  const err = (pointer: string, message: string) =>
    problems.push({ pointer, message, severity: 'error' });
  const warn = (pointer: string, message: string) =>
    problems.push({ pointer, message, severity: 'warning' });

  if (!isRecord(raw)) {
    err('', 'The input file is not a JSON object.');
    return { ir: null, problems };
  }
  if (!Array.isArray(raw['visits'])) {
    err('/visits', 'Missing a "visits" array.');
    return { ir: null, problems };
  }

  const visits = raw['visits'] as unknown[];
  visits.forEach((visitRaw, vi) => {
    const vp = irPointer.visit(vi);
    if (!isRecord(visitRaw)) return err(vp, 'Visit is not an object.');
    if (typeof visitRaw['name'] !== 'string' || !visitRaw['name'].trim()) err(vp, 'Visit has no name.');
    if (!Array.isArray(visitRaw['forms'])) return err(`${vp}/forms`, 'Visit has no "forms" array.');

    (visitRaw['forms'] as unknown[]).forEach((formRaw, fi) => {
      const fp = irPointer.form(vi, fi);
      if (!isRecord(formRaw)) return err(fp, 'Form is not an object.');
      if (typeof formRaw['name'] !== 'string' || !formRaw['name'].trim()) err(fp, 'Form has no name.');
      if (!Array.isArray(formRaw['fields'])) return err(`${fp}/fields`, 'Form has no "fields" array.');

      const fields = formRaw['fields'] as unknown[];
      const labels = new Set<string>();

      fields.forEach((fieldRaw, xi) => {
        const xp = irPointer.field(vi, fi, xi);
        if (!isRecord(fieldRaw)) return err(xp, 'Field is not an object.');

        const label = fieldRaw['label'];
        if (typeof label !== 'string' || !label.trim()) {
          err(xp, 'Field has no label.');
        } else {
          if (labels.has(label)) {
            // Labels are the only cross-platform identity the agent has. Two
            // fields sharing one inside a form make read-back ambiguous.
            warn(xp, `Duplicate field label "${label}" in this form — read-back cannot tell the two apart.`);
          }
          labels.add(label);
        }

        const type = fieldRaw['type'];
        if (typeof type !== 'string' || !CANONICAL_TYPES.includes(type as CanonicalType)) {
          err(xp, `Unknown canonical type "${String(type)}".`);
          return;
        }
        const t = type as CanonicalType;
        const s = SIGNATURES[t];

        const options = fieldRaw['options'];
        if (s.hasOptions) {
          if (!Array.isArray(options) || options.length === 0) {
            err(xp, `Type "${t}" needs a coded value list, but "options" is missing or empty.`);
          } else {
            options.forEach((o, oi) => {
              if (!isRecord(o) || typeof o['code'] !== 'string' || typeof o['label'] !== 'string') {
                err(`${xp}/options/${oi}`, 'Each option must be a { code, label } pair.');
              }
            });
          }
        } else if (Array.isArray(options) && options.length > 0) {
          warn(xp, `Type "${t}" holds no coded list, but "options" was supplied — it will be ignored.`);
        }

        const hasRangeValue =
          fieldRaw['min'] !== undefined || fieldRaw['max'] !== undefined || fieldRaw['units'] !== undefined;
        if (hasRangeValue && !s.hasRange) {
          warn(xp, `Type "${t}" holds no range check, but min/max/units were supplied — they will be ignored.`);
        }

        if (t === 'calculated' && typeof fieldRaw['formula'] !== 'string') {
          err(xp, 'A calculated field needs a "formula".');
        }

        const skip = fieldRaw['skip_logic'];
        if (skip !== undefined) {
          if (
            !isRecord(skip) ||
            typeof skip['when_field_label'] !== 'string' ||
            typeof skip['equals_value'] !== 'string'
          ) {
            err(`${xp}/skip_logic`, 'skip_logic must be { when_field_label, equals_value }.');
          }
        }
      });

      // Semantic pass: every skip-logic controller must exist in this form.
      fields.forEach((fieldRaw, xi) => {
        if (!isRecord(fieldRaw)) return;
        const skip = fieldRaw['skip_logic'];
        if (!isRecord(skip)) return;
        const controller = skip['when_field_label'];
        if (typeof controller !== 'string') return;

        const xp = `${irPointer.field(vi, fi, xi)}/skip_logic`;
        const controllerIndex = fields.findIndex((o) => isRecord(o) && o['label'] === controller);
        if (controllerIndex === -1) {
          err(xp, `Controlling field "${controller}" does not exist in this form.`);
          return;
        }

        // Cross-check the expected value against the controller's own domain.
        const controllerField = fields[controllerIndex];
        if (isRecord(controllerField)) {
          const ctype = controllerField['type'];
          const expected = skip['equals_value'];
          if (ctype === 'boolean' && expected !== 'Yes' && expected !== 'No') {
            warn(xp, `Controller "${controller}" is boolean, so the expected value should be "Yes" or "No", not "${String(expected)}".`);
          }
          const copts = controllerField['options'];
          if (Array.isArray(copts) && copts.length > 0) {
            const codes = copts.filter(isRecord).map((o) => o['code']);
            if (!codes.includes(expected)) {
              warn(xp, `Expected value "${String(expected)}" is not one of "${controller}"'s codes (${codes.join(', ')}).`);
            }
          }
        }

        if (controllerIndex > xi) {
          // Not fatal — skip logic is applied in a second pass — but worth knowing.
          warn(xp, `Controlling field "${controller}" appears after this field; skip logic is applied in a second pass.`);
        }
      });
    });
  });

  const fatal = problems.some((p) => p.severity === 'error');
  return { ir: fatal ? null : (raw as unknown as IrStudy), problems };
}

export function irStats(ir: IrStudy): IrStats {
  const stats: IrStats = {
    visits: ir.visits.length,
    formInstances: 0,
    distinctForms: 0,
    fields: 0,
    withOptions: 0,
    withRange: 0,
    withFormula: 0,
    skipRules: 0,
    repeatingForms: 0,
    typeHistogram: {},
  };
  const names = new Set<string>();
  for (const visit of ir.visits) {
    for (const form of visit.forms) {
      stats.formInstances++;
      names.add(form.name);
      if (form.repeating) stats.repeatingForms++;
      for (const field of form.fields) {
        stats.fields++;
        stats.typeHistogram[field.type] = (stats.typeHistogram[field.type] ?? 0) + 1;
        if (field.options?.length) stats.withOptions++;
        if (field.min !== undefined || field.max !== undefined || field.units !== undefined) stats.withRange++;
        if (field.formula) stats.withFormula++;
        if (field.skip_logic) stats.skipRules++;
      }
    }
  }
  stats.distinctForms = names.size;
  return stats;
}

/**
 * A stable fingerprint of a form definition, used to recognise the same form
 * appearing at several visits.
 *
 * Whether the platform lets a definition be reused or requires a rebuild under
 * each visit is discovered at runtime, not assumed — but either way the agent
 * has to know which appearances are the same definition, and this is how.
 */
export function formFingerprint(form: IrForm): string {
  const body = form.fields
    .map((f) => {
      const parts = [f.label, f.type, f.required ? 'req' : 'opt'];
      if (f.options?.length) parts.push(f.options.map((o) => `${o.code}=${o.label}`).join(','));
      if (f.min !== undefined) parts.push(`min:${f.min}`);
      if (f.max !== undefined) parts.push(`max:${f.max}`);
      if (f.units) parts.push(`u:${f.units}`);
      if (f.formula) parts.push(`fx:${f.formula}`);
      if (f.skip_logic) parts.push(`when:${f.skip_logic.when_field_label}=${f.skip_logic.equals_value}`);
      return parts.join('|');
    })
    .join('\n');
  return `${form.name}::${form.repeating ? 'rep' : 'single'}::${body}`;
}
