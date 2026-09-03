/**
 * The orchestrator's channel to a tab.
 *
 * Everything the agent can do to a page goes through `Page`. It owns the
 * current snapshot, and it enforces the rule that gives the rest of the system
 * its integrity: an action is never assumed to have worked. `act()` returns the
 * observed diff, and callers are expected to read it.
 */

import { diffSnapshots } from '../shared/diff';
import type { ActOutcome, ContentCommand, ContentResponse, ReadValue } from '../shared/protocol';
import type { Ref, Snapshot, SnapshotDiff, SnapshotNode } from '../shared/snapshot';

export class PageError extends Error {}

export interface Observation {
  ok: boolean;
  detail: string;
  before: Snapshot;
  after: Snapshot;
  diff: SnapshotDiff;
}

/**
 * What the rest of the orchestrator is allowed to do to a page.
 *
 * Stated as an interface rather than a class so the same build pipeline can be
 * driven against a real tab or against an in-page harness, without either one
 * being a special case. Note what is absent: nothing here accepts a selector.
 */
export interface PageLike {
  attach(): Promise<void>;
  current(force?: boolean): Promise<Snapshot>;
  capture(): Promise<Snapshot>;
  act(action: ContentCommand, settleMs?: number): Promise<Observation>;
  read(ref: Ref): Promise<ReadValue | null>;
  click(ref: Ref, settleMs?: number): Promise<Observation>;
  setText(ref: Ref, value: string, settleMs?: number): Promise<Observation>;
  chooseOption(ref: Ref, value: string, settleMs?: number): Promise<Observation>;
  setToggle(ref: Ref, desired: boolean, settleMs?: number): Promise<Observation>;
  pressKey(ref: Ref, key: string, settleMs?: number): Promise<Observation>;
  url(): Promise<string>;
}

export class Page implements PageLike {
  private snapshot: Snapshot | null = null;

  constructor(readonly tabId: number) {}

  /** Inject the content script if it is not already listening. */
  async attach(): Promise<void> {
    try {
      const pong = await this.send({ kind: 'ping' });
      if (pong.kind === 'pong') return;
    } catch {
      /* not injected yet */
    }
    await chrome.scripting.executeScript({
      target: { tabId: this.tabId, allFrames: false },
      files: ['content.js'],
    });
    const pong = await this.send({ kind: 'ping' });
    if (pong.kind !== 'pong') throw new PageError('Could not attach to the page.');
  }

  private send(command: ContentCommand): Promise<ContentResponse> {
    return new Promise((resolve, reject) => {
      chrome.tabs.sendMessage(this.tabId, command, (response: ContentResponse | undefined) => {
        const err = chrome.runtime.lastError;
        if (err) return reject(new PageError(err.message ?? 'message failed'));
        if (!response) return reject(new PageError('No response from the page.'));
        resolve(response);
      });
    });
  }

  /** The most recent snapshot, capturing one if there is none. */
  async current(force = false): Promise<Snapshot> {
    if (this.snapshot && !force) return this.snapshot;
    return this.capture();
  }

  async capture(): Promise<Snapshot> {
    const response = await this.send({ kind: 'snapshot' });
    if (response.kind !== 'snapshot') throw new PageError('Could not read the page.');
    this.snapshot = response.snapshot;
    return response.snapshot;
  }

  /**
   * Do something, wait for the page to settle, and report what changed.
   *
   * The returned diff — not the action's own success flag — is the evidence a
   * caller should act on. A click can "succeed" in the sense that the element
   * accepted it while doing nothing whatsoever, which is precisely the
   * near-miss control this kind of app is full of.
   */
  async act(action: ContentCommand, settleMs = 1200): Promise<Observation> {
    const before = await this.current();
    const response = await this.send({ kind: 'actAndObserve', action, settleMs });
    if (response.kind !== 'outcome') throw new PageError('The page did not report an outcome.');
    const outcome: ActOutcome = response.outcome;
    const after = outcome.after ?? (await this.capture());
    this.snapshot = after;
    return { ok: outcome.ok, detail: outcome.detail, before, after, diff: diffSnapshots(before, after) };
  }

  async read(ref: Ref): Promise<ReadValue | null> {
    const response = await this.send({ kind: 'read', ref });
    if (response.kind !== 'read') return null;
    return response.value;
  }

  async click(ref: Ref, settleMs?: number): Promise<Observation> {
    return this.act({ kind: 'click', ref }, settleMs);
  }

  async setText(ref: Ref, value: string, settleMs?: number): Promise<Observation> {
    return this.act({ kind: 'setText', ref, value }, settleMs);
  }

  async chooseOption(ref: Ref, value: string, settleMs?: number): Promise<Observation> {
    return this.act({ kind: 'chooseOption', ref, value }, settleMs);
  }

  async setToggle(ref: Ref, desired: boolean, settleMs?: number): Promise<Observation> {
    return this.act({ kind: 'setToggle', ref, desired }, settleMs);
  }

  async pressKey(ref: Ref, key: string, settleMs?: number): Promise<Observation> {
    return this.act({ kind: 'pressKey', ref, key }, settleMs);
  }

  /** Node lookup helpers over the current snapshot. */
  nodeByRef(snapshot: Snapshot, ref: Ref): SnapshotNode | undefined {
    return snapshot.nodes.find((n) => n.ref === ref);
  }

  async url(): Promise<string> {
    const tab = await chrome.tabs.get(this.tabId);
    return tab.url ?? '';
  }
}
