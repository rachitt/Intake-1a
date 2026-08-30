/**
 * The content script: the agent's eyes and hands, and nothing else.
 *
 * It holds no plan, no knowledge of eSource, and no memory between commands.
 * All it does is turn the live page into a Semantic Snapshot, and turn refs
 * back into synthetic user input. Keeping it this thin is what keeps the
 * platform-specific surface of the whole system down to zero lines.
 */

import { captureSnapshot } from './snapshot';
import { chooseOptionRef, clickRef, dragRef, pressKeyRef, readRef, setTextRef, setToggleRef } from './actuator';
import type { ActOutcome, ContentCommand, ContentResponse } from '../shared/protocol';

const INSTALLED = '__esourceAgentContentInstalled';

/** Injected repeatedly by design (tabs reload); make that harmless. */
if ((window as unknown as Record<string, unknown>)[INSTALLED]) {
  // already listening
} else {
  (window as unknown as Record<string, unknown>)[INSTALLED] = true;
  chrome.runtime.onMessage.addListener((message: ContentCommand, _sender, sendResponse) => {
    handle(message)
      .then(sendResponse)
      .catch((err: unknown) => {
        sendResponse({ kind: 'error', message: err instanceof Error ? err.message : String(err) } satisfies ContentResponse);
      });
    return true; // async
  });
}

/**
 * Wait for the page to stop changing.
 *
 * Applications re-render asynchronously, and snapshotting mid-render produces a
 * diff full of noise that hides the actual effect. Rather than sleeping a fixed
 * amount — too slow when the app is fast, too short when it is not — this
 * watches mutations and returns as soon as they stop, with a hard ceiling.
 */
function settle(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const quietFor = 90;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = self.setTimeout(finish, quietFor);
    });
    const ceiling = self.setTimeout(finish, maxMs);

    function finish() {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(ceiling);
      // One animation frame, so layout has been applied before we measure boxes.
      requestAnimationFrame(() => resolve());
    }

    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      attributes: true,
      characterData: true,
    });
    timer = self.setTimeout(finish, quietFor);
  });
}

function perform(command: ContentCommand): { ok: boolean; detail: string } {
  switch (command.kind) {
    case 'click':
      return clickRef(command.ref);
    case 'setText':
      return setTextRef(command.ref, command.value);
    case 'chooseOption':
      return chooseOptionRef(command.ref, command.value);
    case 'setToggle':
      return setToggleRef(command.ref, command.desired);
    case 'pressKey':
      return pressKeyRef(command.ref, command.key);
    case 'drag':
      return dragRef(command.sourceRef, command.targetRef);
    default:
      return { ok: false, detail: `"${command.kind}" is not an action.` };
  }
}

async function handle(command: ContentCommand): Promise<ContentResponse> {
  switch (command.kind) {
    case 'ping':
      return { kind: 'pong', url: location.href };

    case 'snapshot':
      return { kind: 'snapshot', snapshot: captureSnapshot({ includeGeneric: command.includeGeneric }) };

    case 'read':
      return { kind: 'read', value: readRef(command.ref) };

    case 'actAndObserve': {
      const result = perform(command.action);
      await settle(command.settleMs ?? 1200);
      const outcome: ActOutcome = {
        ok: result.ok,
        detail: result.detail,
        after: captureSnapshot(),
      };
      return { kind: 'outcome', outcome };
    }

    default: {
      const result = perform(command);
      return { kind: 'outcome', outcome: { ok: result.ok, detail: result.detail } };
    }
  }
}
