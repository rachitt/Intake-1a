import type { ReadField, ReadStudy } from '../shared/read-state';
import { PLATFORM_ID, SPEC_VERSION } from '../spec/surface';
import type { BuiltDocument, BuiltElement } from './state';
import type { MockBStore } from './store';

/**
 * Mock B → the same canonical readState Mock A produces.
 *
 * This is the only thing the two platforms have in common, and it is not part
 * of either platform's surface: it is the grader's oracle, translating whatever
 * a vendor calls things back into the vocabulary the specification is written
 * in. A "question" becomes a label, a "log" becomes a repeating form, "shown
 * text" becomes a coded value's label.
 *
 * Saved state only. The designer's working copy never appears here.
 */

function readField(element: BuiltElement, doc: BuiltDocument): ReadField {
  let skipLogic: ReadField['skipLogic'] = null;
  const rule = element.rule;
  if (rule.mode === 'conditional' && rule.whenElementId) {
    const controller = doc.elements.find((e) => e.id === rule.whenElementId);
    if (controller) {
      skipLogic = { whenFieldLabel: controller.question, equalsValue: rule.requiredAnswer };
    }
  }
  return {
    label: element.question,
    type: element.kind,
    required: element.mandatory,
    options: element.values.map((v) => ({ code: v.code, label: v.text })),
    min: element.lowest,
    max: element.highest,
    units: element.unit,
    formula: element.expression,
    skipLogic,
  };
}

export function readState(store: MockBStore): ReadStudy {
  const { study } = store.getState();
  return {
    platform: PLATFORM_ID,
    specVersion: SPEC_VERSION,
    study: {
      name: study.code,
      visits: study.timepoints.map((timepoint) => ({
        name: timepoint.title,
        windowStart: timepoint.dayFrom,
        windowEnd: timepoint.dayTo,
        forms: timepoint.documents.map((doc) => ({
          name: doc.title,
          repeating: doc.log,
          status: doc.status === 'released' ? 'active' : 'draft',
          fields: doc.elements.map((el) => readField(el, doc)),
        })),
      })),
    },
  };
}
