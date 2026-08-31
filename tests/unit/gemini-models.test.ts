/**
 * What happens when a model name has been retired.
 *
 * A model id is the one piece of vendor vocabulary the agent cannot discover
 * from the page, so it is the one thing that goes stale on its own — and it
 * goes stale as an HTTP 404 on every single call, which looks like the tool
 * being broken rather than a name having been renamed. These tests pin the
 * recovery, because it is not something that can be checked by reading the
 * code: it only shows up against a live service, and by then it is a failed run.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { DEFAULT_MODEL, Gemini, LlmUnavailable, MODEL_CHOICES, isOfferedModel } from '../../src/background/gemini';

const SCHEMA = { type: 'OBJECT' as const, properties: { ok: { type: 'BOOLEAN' as const } }, required: ['ok'] };

interface Stub {
  /** Model ids the fake service will answer `generateContent` for. */
  serves: string[];
  /** Model ids the fake service lists, defaulting to what it serves. */
  lists?: string[];
  /** Every URL the stub was asked for, in order. */
  calls: string[];
}

/** A Gemini wired to a fake service, plus whatever it told a person. */
function stubbed(stub: Stub, configuredModel: string) {
  const notices: string[] = [];
  stub.calls = [];

  globalThis.fetch = (async (input: string | URL) => {
    const url = String(input);
    stub.calls.push(url);

    // ListModels: no path segment between /models and the query string.
    if (/\/models\?/.test(url)) {
      const models = (stub.lists ?? stub.serves).map((id) => ({
        name: `models/${id}`,
        supportedGenerationMethods: ['generateContent'],
      }));
      return new Response(JSON.stringify({ models }), { status: 200 });
    }

    const asked = decodeURIComponent(url.split('/models/')[1]!.split(':')[0]!);
    if (!stub.serves.includes(asked)) {
      return new Response(JSON.stringify({ error: { message: `models/${asked} is not found` } }), { status: 404 });
    }
    return new Response(
      JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({ ok: true, by: asked }) }] } }] }),
      { status: 200 },
    );
  }) as typeof fetch;

  const llm = new Gemini(
    () => 'a-key',
    () => configuredModel,
    () => {},
    (message) => notices.push(message),
  );
  return { llm, notices };
}

test('the offered models are the ones this build names, best first', () => {
  assert.ok(MODEL_CHOICES.length >= 3);
  assert.equal(DEFAULT_MODEL, MODEL_CHOICES[0]!.id);
  for (const choice of MODEL_CHOICES) {
    assert.ok(isOfferedModel(choice.id), choice.id);
    assert.ok(choice.label.length > 0, choice.id);
  }
});

test('a model this build no longer offers is recognised, so a stored setting can be migrated', () => {
  assert.equal(isOfferedModel('gemini-2.5-flash'), false);
  assert.equal(isOfferedModel(''), false);
  assert.equal(isOfferedModel(DEFAULT_MODEL), true);
});

test('a retired model name is repaired against what the key can actually reach', async () => {
  const alive = MODEL_CHOICES[1]!.id;
  const stub: Stub = { serves: [alive], calls: [] };
  const { llm, notices } = stubbed(stub, 'gemini-1.0-retired');

  const answer = await llm.ask<{ ok: boolean; by: string }>('anything', { schema: SCHEMA });

  assert.equal(answer.ok, true);
  assert.equal(answer.by, alive, 'the call went to a model that exists');
  assert.equal(notices.length, 1, 'a substitution is a run-level event and is said out loud');
  assert.match(notices[0]!, /gemini-1\.0-retired/);
  assert.match(notices[0]!, new RegExp(alive.replace(/\./g, '\\.')));
});

test('the repair is made once and reused, not re-proved on every call', async () => {
  const stub: Stub = { serves: [MODEL_CHOICES[1]!.id], calls: [] };
  const { llm, notices } = stubbed(stub, 'gemini-1.0-retired');

  await llm.ask('one', { schema: SCHEMA });
  await llm.ask('two', { schema: SCHEMA });
  await llm.ask('three', { schema: SCHEMA });

  const listings = stub.calls.filter((u) => /\/models\?/.test(u)).length;
  const retired = stub.calls.filter((u) => u.includes('gemini-1.0-retired')).length;
  assert.equal(listings, 1, 'the model list is fetched once for the whole run');
  assert.equal(retired, 1, 'the dead name is tried once, not once per call');
  assert.equal(notices.length, 1, 'and a person is told once, not three times');
});

test('a model that works is used as configured, and nothing is listed or substituted', async () => {
  const stub: Stub = { serves: [DEFAULT_MODEL], calls: [] };
  const { llm, notices } = stubbed(stub, DEFAULT_MODEL);

  const answer = await llm.ask<{ by: string }>('anything', { schema: SCHEMA });

  assert.equal(answer.by, DEFAULT_MODEL);
  assert.equal(notices.length, 0);
  assert.equal(stub.calls.filter((u) => /\/models\?/.test(u)).length, 0, 'no listing is needed when the name works');
});

test("this build's own preferences win over whatever else the key can reach", async () => {
  const preferred = MODEL_CHOICES[2]!.id;
  const stub: Stub = { serves: ['some-other-model', preferred, 'yet-another'], calls: [] };
  const { llm } = stubbed(stub, 'gemini-1.0-retired');

  const answer = await llm.ask<{ by: string }>('anything', { schema: SCHEMA });
  assert.equal(answer.by, preferred);
});

test('a key that can reach nothing usable gives an actionable message, not a bare 404', async () => {
  const stub: Stub = { serves: [], lists: [], calls: [] };
  const { llm } = stubbed(stub, 'gemini-1.0-retired');

  await assert.rejects(
    () => llm.ask('anything', { schema: SCHEMA, maxRetries: 0 }),
    (err: unknown) => {
      assert.ok(err instanceof LlmUnavailable);
      assert.match(err.message, /gemini-1\.0-retired/);
      assert.match(err.message, /Choose a different model/);
      return true;
    },
  );
});

test('a substitution never silently downgrades to a model that is also missing', async () => {
  // The service lists something it will not actually serve. The run must end
  // as unavailable rather than looping between two names that do not work.
  const stub: Stub = { serves: [], lists: ['gemini-listed-but-dead'], calls: [] };
  const { llm } = stubbed(stub, 'gemini-1.0-retired');

  await assert.rejects(() => llm.ask('anything', { schema: SCHEMA, maxRetries: 0 }), LlmUnavailable);
});
