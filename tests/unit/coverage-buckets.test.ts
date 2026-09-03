/**
 * How the final report buckets a study.
 *
 * One "missing" number was actively misleading, because it covered three
 * situations whose right responses are different and in one case opposite:
 * a field that is not there should be built again, a field that is there but
 * could not be read must NOT be (that duplicates it), and a field that exists
 * with the wrong type needs that one property corrected rather than a rebuild.
 *
 * The property under test throughout is that the agent never claims to have
 * established something it did not look at.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { coverageStatus, coverageTally } from '../../src/background/verify';
import type { CoverageRow } from '../../src/shared/protocol';

function row(overrides: Partial<CoverageRow> = {}): CoverageRow {
  return {
    pointer: '/visits/0/forms/0/fields/0',
    visit: 'Screening',
    form: 'Vital Signs',
    field: 'Heart Rate',
    status: 'missing',
    readable: true,
    present: true,
    typeOk: null,
    labelOk: null,
    requiredOk: null,
    optionsOk: null,
    rangeOk: null,
    formulaOk: null,
    skipOk: null,
    repeatingOk: null,
    notes: [],
    ...overrides,
  };
}

test('a field that is there with nothing contradicting it is verified', () => {
  assert.equal(coverageStatus(row({ present: true, labelOk: true, typeOk: true })), 'verified');
});

test('a field that was looked for and is not there is missing', () => {
  assert.equal(coverageStatus(row({ present: false })), 'missing');
});

test('a field the build showed the save discarded is missing, not unverified', () => {
  assert.equal(coverageStatus(row({ present: false }), 'save_lost_it'), 'missing');
  assert.equal(coverageStatus(row({ present: false }), 'element_not_added'), 'missing');
  assert.equal(coverageStatus(row({ present: false }), 'label_not_set'), 'missing');
});

test('a field the build showed is present but unreadable is unverified, not missing', () => {
  // This is the case the whole split exists for: reporting it as missing sends
  // someone to build a field that is already on the form.
  assert.equal(coverageStatus(row({ present: false }), 'verifier_cannot_see_it'), 'unverified');
});

test('anything the sweep never managed to look at is unverified', () => {
  for (const cause of [undefined, 'save_lost_it', 'element_not_added']) {
    assert.equal(coverageStatus(row({ present: false, readable: false }), cause), 'unverified', String(cause));
  }
});

test('a field on screen whose properties could not be read is unverified, not verified', () => {
  // Present, but its preview carries no accessible name. Calling that verified
  // is how a study whose dates were all built as free text passes its own
  // reconciliation.
  assert.equal(coverageStatus(row({ present: true, readable: false })), 'unverified');
});

test('a field that exists with a property that does not match is its own bucket', () => {
  for (const key of ['typeOk', 'labelOk', 'requiredOk', 'optionsOk', 'rangeOk', 'formulaOk', 'skipOk'] as const) {
    assert.equal(coverageStatus(row({ present: true, [key]: false })), 'wrong_properties', key);
  }
});

test('a property that could not be checked is not a mismatch', () => {
  // null means "not checked". Reporting that as a mismatch would bury the real
  // ones under noise on any platform that does not expose a given property.
  assert.equal(coverageStatus(row({ present: true, typeOk: null, rangeOk: null })), 'verified');
});

test('a wrong property never hides a missing field', () => {
  // Absence outranks a mismatch: you cannot have the wrong type on a field that
  // is not there, and "missing" is the more urgent of the two.
  assert.equal(coverageStatus(row({ present: false, typeOk: false })), 'missing');
});

test('the tally counts fields only, and adds up', () => {
  const rows: CoverageRow[] = [
    row({ pointer: '/visits/0/forms/0', field: undefined, status: 'verified' }),
    row({ pointer: 'a', status: 'verified' }),
    row({ pointer: 'b', status: 'verified' }),
    row({ pointer: 'c', status: 'missing' }),
    row({ pointer: 'd', status: 'unverified' }),
    row({ pointer: 'e', status: 'wrong_properties' }),
  ];
  const tally = coverageTally(rows);

  assert.equal(tally.total, 5, 'the form row is not a field');
  assert.equal(tally.verified, 2);
  assert.equal(tally.missing, 1);
  assert.equal(tally.unverified, 1);
  assert.equal(tally.wrong_properties, 1);
  assert.equal(tally.verified + tally.missing + tally.unverified + tally.wrong_properties, tally.total);
});
