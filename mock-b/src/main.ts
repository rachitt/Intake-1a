import { MockBStore } from './engine/store';
import { readState } from './engine/read-state';
import { installMockHarness } from './shared/read-state';
import { PLATFORM_ID, PLATFORM_LABEL, SPEC_VERSION } from './spec/surface';
import { mount } from './ui/render';

/**
 * Entry point.
 *
 * Starts empty, exactly as Mock A does: the study exists as a protocol code and
 * nothing else. Everything in the input file has to be built through this
 * platform's own UI, in this platform's own words.
 */
const root = document.getElementById('app');
if (!root) throw new Error('app element is missing');

const store = new MockBStore('ABC-101');

installMockHarness({
  platform: PLATFORM_ID,
  specVersion: SPEC_VERSION,
  read: () => readState(store),
  reset: () => store.reset(),
});

mount(store, root);
document.title = PLATFORM_LABEL;
