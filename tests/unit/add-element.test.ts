/**
 * Getting a field onto the canvas when clicking the palette does nothing.
 *
 * A drag-only palette and a broken palette entry fail identically from the
 * outside: the click is accepted, and nothing appears. The only way to tell
 * them apart is to actually attempt the drag — so "clicking did nothing" is
 * not, on its own, grounds for reporting that the element could not be created.
 *
 * The case that matters most, and the one a naive drag fallback cannot handle,
 * is the FIRST field of a form. An empty canvas contains no control to aim at,
 * so there is no ref to drop onto; the drop has to be addressed to the region.
 */

import assert from 'node:assert/strict';
import test from 'node:test';

import { Designer } from '../../src/background/designer';
import { Gemini } from '../../src/background/gemini';
import { Grounder } from '../../src/background/grounder';
import { Store, emptyProfile } from '../../src/background/store';
import { diffSnapshots } from '../../src/shared/diff';
import type { Observation, PageLike } from '../../src/background/page';
import type { ContentCommand } from '../../src/shared/protocol';
import type { Role, Snapshot, SnapshotNode, SnapshotRegion } from '../../src/shared/snapshot';

// A palette is recognised by shape — a cluster of several similar activatable
// items — so a realistic one needs more than a couple of entries.
const PALETTE = [
  'Measured Number',
  'Count Number',
  'Binary Choice',
  'Plain Entry',
  'Long Entry',
  'Calendar Entry',
];

let nextRef = 1;

/** A designer with a palette and a canvas holding `built` named previews. */
function screen(built: string[]): Snapshot {
  const nodes: SnapshotNode[] = [];
  const regions: SnapshotRegion[] = [];

  const add = (id: number, kind: SnapshotRegion['kind'], name: string, specs: { role: Role; name: string }[]) => {
    const members: number[] = [];
    specs.forEach((spec, i) => {
      const ref = nextRef++;
      members.push(ref);
      nodes.push({
        ref,
        role: spec.role,
        name: spec.name,
        state: { visible: true },
        parent: -1,
        depth: 2,
        region: id,
        box: { x: id * 400, y: i * 40, w: 320, h: 32 },
      });
    });
    regions.push({
      id,
      name,
      kind,
      confidence: 0.9,
      members,
      // The canvas is the roomiest thing on screen, which is how an empty one
      // is still recognisable as somewhere to drop a field.
      box: { x: id * 400, y: 0, w: kind === 'canvas' ? 900 : 300, h: 700 },
      texts: specs.map((spec) => spec.name),
      evidence: ['staged for a test'],
    });
  };

  add(1, 'palette', 'element library', PALETTE.map((name) => ({ role: 'listitem' as Role, name })));
  add(2, 'canvas', 'form under construction', built.map((name) => ({ role: 'textbox' as Role, name })));
  add(3, 'editor', 'properties', [{ role: 'textbox' as Role, name: 'Label' }]);

  return {
    id: nextRef++,
    url: 'https://an-esource.invalid/designer',
    title: 'designer',
    screenTitle: 'designer',
    nodes,
    regions,
    liveText: [],
    modalOpen: false,
    at: Date.now(),
  };
}

/**
 * A designer that only accepts fields one particular way.
 *
 * `accepts` says which interaction actually works; everything else is received
 * politely and changes nothing, exactly as a real palette does.
 */
function fakePage(accepts: 'click' | 'drag' | 'dropOnRegion' | 'nothing', initial: string[] = []) {
  const built: string[] = [...initial];
  const seen: string[] = [];
  let current = screen(built);

  const page: PageLike = {
    attach: async () => {},
    current: async () => current,
    capture: async () => {
      current = screen(built);
      return current;
    },
    async act(action: ContentCommand): Promise<Observation> {
      seen.push(action.kind);
      const before = current;
      if (action.kind === accepts) built.push(`Field ${built.length + 1}`);
      const after = screen(built);
      current = after;
      return { ok: true, detail: action.kind, before, after, diff: diffSnapshots(before, after) };
    },
    read: async () => null,
    click(ref) {
      return this.act({ kind: 'click', ref });
    },
    setText(ref, value) {
      return this.act({ kind: 'setText', ref, value });
    },
    chooseOption(ref, value) {
      return this.act({ kind: 'chooseOption', ref, value });
    },
    setToggle(ref, desired) {
      return this.act({ kind: 'setToggle', ref, desired });
    },
    pressKey(ref, key) {
      return this.act({ kind: 'pressKey', ref, key });
    },
    url: async () => 'https://an-esource.invalid/designer',
  };

  const store = new Store();
  store.profile = emptyProfile('https://an-esource.invalid');
  const llm = new Gemini(
    () => '',
    () => 'none',
    () => {},
  );
  const grounder = new Grounder(() => store.profile!, llm, () => {});
  return { designer: new Designer(page, grounder, store, () => {}), store, seen, built };
}

test('a palette that answers to a click is used with a click, and nothing is dragged', async () => {
  const { designer, store, seen } = fakePage('click');

  const result = await designer.addElement('Measured Number');

  assert.equal(result.ok, true);
  assert.equal(result.via, 'click');
  assert.ok(!seen.includes('drag'), 'no needless drag on a platform where clicking works');
  assert.equal(store.profile!.paletteInteraction, 'click');
});

test('a drag-only palette is not reported as an entry that does nothing', async () => {
  // A form with one field already on it, so there is a control to drop onto.
  const { designer, seen } = fakePage('drag', ['Heart Rate']);

  const result = await designer.addElement('Count Number');

  assert.equal(result.ok, true, 'the alternate interaction is tried before giving up');
  assert.equal(result.via, 'drag');
  assert.ok(seen.includes('click'), 'the cheaper interaction is still tried first');
  assert.ok(seen.includes('drag'));
});

test('the first field of an empty form can still be dropped, with no control to aim at', async () => {
  // The canvas is empty, so there is no member ref to drop onto. Without a way
  // to address the region itself, every first field on a drag-only designer —
  // and therefore every field, since none is ever built — reads as an entry
  // that creates nothing.
  const { designer, seen } = fakePage('dropOnRegion');

  const result = await designer.addElement('Binary Choice');

  assert.equal(result.ok, true);
  assert.equal(result.via, 'drag');
  assert.ok(seen.includes('dropOnRegion'), 'the region itself is used as the drop target');
});

test('how this platform takes a field is learned, and used first next time', async () => {
  const { designer, store, seen } = fakePage('drag', ['Heart Rate']);

  await designer.addElement('Count Number');
  assert.equal(store.profile!.paletteInteraction, 'drag');

  seen.length = 0;
  await designer.addElement('Count Number');
  assert.equal(seen[0], 'drag', 'the interaction known to work is tried first, not the one known not to');
  assert.ok(!seen.includes('click'), 'and the useless click is not repeated 195 times');
});

test('an entry that genuinely creates nothing says what was tried', async () => {
  const { designer, store } = fakePage('nothing');

  const result = await designer.addElement('Measured Number');

  assert.equal(result.ok, false);
  assert.equal(result.via, null);
  assert.ok(result.tried.some((t) => t.includes('clicking')), result.tried.join('; '));
  assert.ok(result.tried.some((t) => t.includes('drag') || t.includes('drop')), result.tried.join('; '));
  assert.match(result.detail, /Tried /);
  assert.equal(store.profile!.paletteInteraction, undefined, 'nothing is learned from a failure');
});

test('an entry that is not in the palette is reported as such, not dragged around', async () => {
  const { designer, seen } = fakePage('click');

  const result = await designer.addElement('Not In This Library');

  assert.equal(result.ok, false);
  assert.match(result.detail, /no entry named/);
  assert.deepEqual(seen, [], 'nothing is attempted against a control that is not there');
});
