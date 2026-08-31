/**
 * Looking behind things.
 *
 * An affordance that is not on screen has not necessarily been removed. Real
 * applications hide their less-used actions one click deep — an overflow menu,
 * a kebab, a split button's caret, a "More" disclosure — and which actions get
 * hidden is a product decision nobody agreed on. One platform puts Save on the
 * toolbar; the next puts Preview on the toolbar and Save in the menu beside it.
 *
 * An agent that only ever grounds against the visible screen concludes, quite
 * confidently and quite wrongly, that the second platform has no way to save.
 * That is not a small failure: on a designer that discards its working copy
 * when you navigate away, never finding the commit affordance means every form
 * is built perfectly and then thrown away, and the agent has no idea.
 *
 * The search is structural, never lexical. Nothing here matches "More" or "⋯"
 * or any other product's wording. A disclosure is recognised by what ARIA says
 * it is — `aria-haspopup`, or `aria-expanded="false"` — which is a standard
 * every accessible application already speaks, and the caller's own intent
 * decides what counts as having found the thing.
 *
 * Two properties make this safe to do:
 *
 *   - **Only what APPEARED is considered.** After opening a disclosure, the
 *     candidates are the nodes the click added, not the whole screen. Without
 *     that the agent would just re-find whatever it had already rejected.
 *   - **It is put back.** A disclosure that did not reveal the wanted thing is
 *     closed again before the next is tried, so the search leaves the page as
 *     it found it.
 *
 * What is learned is remembered per platform: the second form does not go
 * looking for the menu again, it opens the one that worked.
 */

import type { Grounder, GroundResult, Intent } from './grounder';
import type { PageLike } from './page';
import type { Snapshot, SnapshotNode } from '../shared/snapshot';
import type { Store } from './store';

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

export interface DisclosedResult {
  result: GroundResult;
  /** The disclosure that had to be opened first, if any. */
  through?: { role: string; name: string };
}

export class Discloser {
  constructor(
    private page: PageLike,
    private grounder: Grounder,
    private store: Store,
    private log: Log,
  ) {}

  private get profile() {
    return this.store.profile!;
  }

  /**
   * Ground an intent, opening a disclosure first if it is not on screen.
   *
   * The direct attempt always comes first: most affordances are simply there,
   * and opening menus speculatively would be both slow and a good way to
   * trigger something unintended.
   */
  async ground(intent: Intent): Promise<DisclosedResult> {
    const snapshot = await this.page.capture();
    const direct = await this.grounder.ground(snapshot, intent);
    if (direct.ok) return { result: direct };

    // Candidates come from ONE snapshot and are used against it. Capturing
    // again between choosing a disclosure and opening it would mint fresh refs
    // and leave the chosen one pointing at nothing.
    const remembered = this.profile.disclosures?.[intent.id];
    const candidates = this.disclosures(snapshot, remembered?.name);

    // Somewhere this worked before? Try that first, then everything else.
    const rememberedNode = remembered ? this.byName(snapshot, remembered.name) : undefined;
    const ordered = rememberedNode ? [rememberedNode, ...candidates] : candidates;

    for (const node of ordered) {
      const found = await this.tryThrough(intent, snapshot, node);
      if (found) return found;
    }

    // Report the ORIGINAL failure. Saying "no disclosure worked" would tell a
    // reviewer about the search rather than about the problem.
    return { result: direct };
  }

  /**
   * Open one disclosure and look inside it.
   *
   * Returns undefined and restores the page if the intent was not satisfied by
   * anything the disclosure revealed.
   */
  private async tryThrough(
    intent: Intent,
    before: Snapshot,
    node: SnapshotNode,
  ): Promise<DisclosedResult | undefined> {
    const opened = await this.page.click(node.ref);
    const revealed = opened.diff.addedNodes;
    if (!revealed.length) return undefined;

    // Only what appeared. Anything already on screen was available to the
    // direct attempt and was not good enough.
    const inside = await this.grounder.ground(opened.after, {
      ...intent,
      preferNames: revealed.map((n) => n.name).filter(Boolean),
      excludeRefs: before.nodes.map((n) => n.ref),
    });

    if (inside.ok) {
      this.remember(intent.id, node);
      this.log(`This platform keeps "${intent.goal}" behind "${node.name}" rather than on screen.`);
      return { result: inside, through: { role: node.role, name: node.name } };
    }

    // Put it back. A menu left hanging open covers the next thing to be read.
    await this.close(node.name);
    return undefined;
  }

  /**
   * Close a disclosure we opened, by activating it again.
   *
   * Best effort: some platforms close on any outside interaction and the second
   * click is a no-op, which is fine. What matters is not leaving an open menu
   * over the page for the next snapshot to read.
   */
  private async close(name: string): Promise<void> {
    const snapshot = await this.page.capture();
    const still = this.byName(snapshot, name);
    if (still) await this.page.click(still.ref);
  }

  /**
   * Controls that admit there is more behind them.
   *
   * Ordered by how strongly they say so: an explicit `aria-haspopup` is a
   * declaration, while `aria-expanded="false"` is a weaker hint that something
   * is collapsed. Anything already open is skipped — its contents were on
   * screen for the direct attempt.
   */
  private disclosures(snapshot: Snapshot, skip?: string): SnapshotNode[] {
    return snapshot.nodes
      .filter(
        (n) =>
          !n.state.disabled &&
          n.state.visible !== false &&
          n.name !== skip &&
          (n.role === 'button' || n.role === 'link' || n.role === 'menuitem' || n.role === 'combobox') &&
          (n.state.hasPopup === true || n.state.expanded === false),
      )
      .sort((a, b) => Number(Boolean(b.state.hasPopup)) - Number(Boolean(a.state.hasPopup)))
      .slice(0, 4);
  }

  private byName(snapshot: Snapshot, name: string): SnapshotNode | undefined {
    return snapshot.nodes.find((n) => n.name === name && n.state.disabled !== true);
  }

  private remember(intentId: string, node: SnapshotNode): void {
    if (!this.profile.disclosures) this.profile.disclosures = {};
    this.profile.disclosures[intentId] = { role: node.role, name: node.name };
  }
}
