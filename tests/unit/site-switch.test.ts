/**
 * What the panel shows after the site in front of it changes.
 *
 * The side panel outlives the tab a run was made against. It survives that tab
 * being closed and is reopened against whatever is in front of it now, so the
 * question "whose results are these?" has to be answered every time it is shown
 * — not once, when the run finished.
 *
 * Getting it wrong in either direction is bad in a way worth pinning:
 * keeping the results makes the tool report a study as built on a site where
 * nothing has been built, and clearing them too eagerly wipes a run someone is
 * in the middle of watching because they glanced at another tab.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { emptyRunState, runStateForSite } from '../../src/background/store';
import type { RunState } from '../../src/shared/protocol';

const SITE_A = 'https://one-esource.invalid';
const SITE_B = 'https://another-esource.invalid';

const STUDY = { loaded: true, protocolId: 'ABC-101' };
const NO_STUDY = { loaded: false };

/** A run that finished on SITE_A, with everything a finished run carries. */
function finishedOnA(): RunState {
  const state = emptyRunState();
  state.phase = 'done';
  state.origin = SITE_A;
  state.message = 'Finished. 195 of 195 fields verified.';
  state.startedAt = 1;
  state.finishedAt = 2;
  state.progress = [{ pointer: '/visits/0', label: 'Screening', status: 'verified' }];
  state.typeMap = [{ canonical: 'text', libraryName: 'Free Text', confidence: 1, source: 'probed' }];
  state.coverage = [
    {
      pointer: '/visits/0/forms/0/fields/0',
      visit: 'Screening',
      form: 'Demographics',
      field: 'Sex at Birth',
      present: true,
      typeOk: true,
      labelOk: true,
      requiredOk: true,
      optionsOk: true,
      rangeOk: null,
      formulaOk: null,
      skipOk: null,
      repeatingOk: null,
      notes: [],
    },
  ];
  state.counters = { ...state.counters, fieldsBuilt: 195, fieldsTotal: 195, verified: 195 };
  return state;
}

test('a finished run does not follow you to a different site', () => {
  const { changed, state } = runStateForSite(finishedOnA(), SITE_B, STUDY);

  assert.equal(changed, true);
  assert.equal(state.origin, SITE_B);
  assert.equal(state.phase, 'idle', 'the new site has had nothing done to it');
  assert.deepEqual(state.progress, [], 'the previous study is not left standing in the tree');
  assert.equal(state.coverage, undefined, 'nor is its reconciliation table');
  assert.deepEqual(state.typeMap, []);
  assert.equal(state.counters.fieldsBuilt, 0);
  assert.equal(state.counters.verified, 0);
  assert.equal(state.finishedAt, undefined);
});

test('the message says what happened, rather than leaving a blank panel', () => {
  const { state } = runStateForSite(finishedOnA(), SITE_B, STUDY);

  assert.match(state.message, /ABC-101/, 'it names the study that would be built');
  assert.ok(state.message.includes(SITE_B), 'and where it would be built');
  assert.ok(state.message.includes(SITE_A), 'and where the run they remember actually happened');
});

test('with no specification loaded it asks for one, and still explains itself', () => {
  const { state } = runStateForSite(finishedOnA(), SITE_B, NO_STUDY);
  assert.match(state.message, /Load an input file/);
  assert.ok(state.message.includes(SITE_A));
});

test('coming back to the same site keeps the results that belong to it', () => {
  const before = finishedOnA();
  const { changed, state } = runStateForSite(before, SITE_A, STUDY);

  assert.equal(changed, false);
  assert.equal(state, before, 'untouched, not rebuilt');
  assert.equal(state.coverage?.length, 1);
});

test('a run in flight is never disturbed by looking at another tab', () => {
  for (const phase of ['validating', 'reconnaissance', 'building', 'verifying', 'blocked', 'stopping'] as const) {
    const running = finishedOnA();
    running.phase = phase;
    const { changed, state } = runStateForSite(running, SITE_B, STUDY);

    assert.equal(changed, false, phase);
    assert.equal(state.origin, SITE_A, `${phase}: the run keeps its own site`);
    assert.equal(state.progress.length, 1, `${phase}: and its progress`);
  }
});

test('a failed run is set aside like a finished one — it also belongs to its site', () => {
  const failed = finishedOnA();
  failed.phase = 'failed';
  const { changed, state } = runStateForSite(failed, SITE_B, STUDY);

  assert.equal(changed, true);
  assert.equal(state.phase, 'idle');
  assert.equal(state.origin, SITE_B);
});

test('a fresh panel adopts the site in front of it, so Run says what it would act on', () => {
  const { changed, state } = runStateForSite(emptyRunState(), SITE_A, STUDY);

  assert.equal(changed, true);
  assert.equal(state.origin, SITE_A);
  assert.equal(state.phase, 'idle');
});

test('adopting a site is not reported as a change once it is already recorded', () => {
  const idle = { ...emptyRunState(), origin: SITE_A };
  const { changed } = runStateForSite(idle, SITE_A, STUDY);
  assert.equal(changed, false, 'no needless redraw on every tab switch within one site');
});

test('a panel merely pointed at a site, with no run behind it, re-points quietly', () => {
  // Nothing was built on SITE_A — the panel was only ever open next to it. There
  // is nothing to set aside, so there is nothing to explain either.
  const pointed = { ...emptyRunState(), origin: SITE_A };
  const { changed, state } = runStateForSite(pointed, SITE_B, STUDY);

  assert.equal(changed, true);
  assert.equal(state.origin, SITE_B);
  assert.ok(!state.message.includes(SITE_A), `no phantom run should be mentioned: ${state.message}`);
  assert.ok(!/last run/i.test(state.message), state.message);
});

test('switching sites twice ends up describing the last one, not accumulating', () => {
  const first = runStateForSite(finishedOnA(), SITE_B, STUDY).state;
  const second = runStateForSite(first, SITE_A, STUDY);

  // The second move is from an idle state, so it simply re-points.
  assert.equal(second.state.origin, SITE_A);
  assert.equal(second.state.phase, 'idle');
  assert.deepEqual(second.state.progress, []);
});
