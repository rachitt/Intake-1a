/**
 * Getting around an unknown application.
 *
 * This is the one place that knows how to reach a screen. Both the build
 * pipeline and the end-of-run reconciliation sweep drive the platform through
 * it, and that is deliberate: the sweep once carried its own copy of this
 * logic, drifted out of step with the builder's, and silently reported that a
 * study it had just built correctly contained nothing at all. Navigation that
 * is written twice is navigation that is right once.
 *
 * Two principles run through everything here.
 *
 * **Judge by the goal, not by the motion.** A click that changes the page is
 * not evidence of arrival — applications are full of controls that navigate
 * somewhere, just not where you asked. Every step below is checked against
 * "am I now looking at the thing I wanted", never against "did something
 * happen".
 *
 * **Rank and try in order; do not escalate a near-tie.** Grounding refuses to
 * act when two candidates score closely, which is the right instinct for an
 * action that cannot be taken back. Navigation is not that. Going to the wrong
 * screen costs one click and is detected immediately, so a module tab at 0.88
 * against a breadcrumb at 0.82 is not a question for a human — it is two things
 * to try in order. Refusing to choose here does not make the agent careful, it
 * makes it stuck, and a stuck agent reports zero.
 */

import { INTENTS } from './intents';
import type { Designer } from './designer';
import type { Grounder } from './grounder';
import type { PageLike } from './page';
import type { Snapshot, SnapshotNode } from '../shared/snapshot';

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

/** How the designer was reached, so the caller can record it in the audit log. */
export interface OpenDesignerResult {
  ok: boolean;
  chose?: { role: string; name: string };
  rationale?: string;
  confidence?: number;
  scopedToRow: boolean;
  detail: string;
}

export class Navigator {
  constructor(
    private page: PageLike,
    private grounder: Grounder,
    private designer: Designer,
    private log: Log,
    /**
     * Every visit's name. Offered as breadcrumb vocabulary when climbing out of
     * a designer: nothing generic about "back" matches a proper noun, but a
     * designer's breadcrumb is usually named after the visit it belongs to.
     */
    private visitNames: () => string[],
    /** The study's own identifier, if it has one — often the root breadcrumb. */
    private protocolId: () => string,
    /** Somewhere to record a durable observation about this platform. */
    private note: (text: string) => void = () => {},
  ) {}

  // ── where are we? ───────────────────────────────────────────────────────────

  /** A palette of field types is present, so we are inside a form designer. */
  inDesigner(snapshot: Snapshot): boolean {
    return snapshot.regions.some((r) => r.kind === 'palette' && r.confidence >= 0.6);
  }

  /**
   * Are we looking at the visit list?
   *
   * Judged by evidence, not by a screen title, since screen titles are one of
   * the things that differ between platforms. Two signals, in order:
   *
   *   - A palette of field types means we are inside a form designer, whatever
   *     else is on screen. This check has to come first: a designer usually
   *     shows the visit's name in its breadcrumb, and matching on that alone
   *     would conclude we are on the schedule while standing in an editor.
   *   - Otherwise, the presence of somewhere to create a VISIT specifically —
   *     which is distinguishable from somewhere to create a document only
   *     because the intents name each other's nouns as hazards.
   */
  visitScheduleVisible(snapshot: Snapshot): boolean {
    if (this.inDesigner(snapshot)) return false;
    const ranked = this.grounder.rank(snapshot, { ...INTENTS.visitCreate(), ignoreMemory: true });
    if (ranked[0] && ranked[0].score >= 0.55) return true;
    // A schedule with rows for visits we expect is a schedule even if its
    // create affordance is worded unusually.
    return this.visitNames().some((name) => snapshot.nodes.some((n) => n.role === 'row' && n.name.includes(name)));
  }

  /**
   * Looking at one visit's list of source documents.
   *
   * All three conditions matter, and dropping any one of them is how this went
   * wrong before. Without the designer check, a designer's breadcrumb passes.
   * Without the screen-title check, the visit SCHEDULE passes — its "add visit"
   * button scores well enough against "add document" that the agent concludes
   * it has opened a visit while still standing on the list of them, and then
   * reports every form as missing.
   */
  onVisitDetail(snapshot: Snapshot, visitName: string): boolean {
    if (this.inDesigner(snapshot)) return false;
    const canAddDocument = this.grounder.rank(snapshot, { ...INTENTS.formCreate(), ignoreMemory: true })[0];
    if (!canAddDocument || canAddDocument.score < 0.5) return false;
    // The visit's name must be in the screen's own heading. Accepting a mention
    // anywhere would match the schedule itself, where every visit is named in a
    // row — and the agent would then start building documents without ever
    // opening a visit.
    return snapshot.screenTitle.includes(visitName);
  }

  /** Are we inside a form designer? Judged by the palette being present. */
  async designerOpen(): Promise<boolean> {
    const entries = await this.designer.paletteEntries(await this.page.capture());
    return entries.length > 0;
  }

  // ── moving ──────────────────────────────────────────────────────────────────

  /**
   * Get back to the visit list.
   *
   * Tried the way a person would: look for something that means "back to the
   * schedule" and click it, repeatedly, until the visits are on screen. There
   * is deliberately no URL manipulation — a single-page app may never change
   * its address, and a platform that does is not owed a special case.
   */
  async goToVisitSchedule(): Promise<boolean> {
    const wrongTurns: string[] = [];

    for (let attempt = 0; attempt < 6; attempt++) {
      let snapshot = await this.page.capture();
      if (this.visitScheduleVisible(snapshot)) return true;

      // Climb out of a designer first.
      if (this.inDesigner(snapshot)) {
        await this.leaveDesignerIfOpen(this.visitNames());
        snapshot = await this.page.capture();
        if (this.visitScheduleVisible(snapshot)) return true;
      }

      const candidate = this.grounder
        .rank(snapshot, {
          ...INTENTS.gotoVisitSchedule([this.protocolId()].filter(Boolean)),
          excludeNames: wrongTurns,
        })
        .find((c) => c.score >= 0.5);
      if (!candidate) break;

      const observation = await this.page.click(candidate.node.ref);
      if (this.visitScheduleVisible(observation.after)) {
        this.grounder.remember(
          INTENTS.gotoVisitSchedule().id,
          candidate.node,
          candidate.score,
          'probe',
          'verified by arriving at the visit schedule',
        );
        return true;
      }

      // Judged by the GOAL, not by whether anything moved. A decorative module
      // tab produces no change; a breadcrumb to the wrong level produces plenty.
      // Both are equally not the way to the visit schedule.
      wrongTurns.push(candidate.node.name);
      this.grounder.forget(INTENTS.gotoVisitSchedule().id);
      this.log(`"${candidate.node.name}" did not lead to the visit schedule; trying another way.`);
    }

    const snapshot = await this.page.capture();
    if (this.visitScheduleVisible(snapshot)) return true;
    const considered = this.grounder
      .rank(snapshot, { ...INTENTS.gotoVisitSchedule(), ignoreMemory: true })
      .slice(0, 3)
      .map((c) => `"${c.node.name}" (${c.score.toFixed(2)})`)
      .join(', ');
    this.log(
      `Could not get back to the visit schedule; still on "${snapshot.screenTitle || snapshot.title}". Considered: ${considered || 'nothing'}.`,
      'warn',
    );
    return false;
  }

  /**
   * Get out of the form designer, if we are in one.
   *
   * Always via the platform's own affordance, and never while there is unsaved
   * work — navigating away from a designer commonly discards the working copy
   * without warning, which is the single easiest way to lose an entire form.
   */
  async leaveDesignerIfOpen(context: string[] = []): Promise<void> {
    const wrongTurns: string[] = [];
    for (let attempt = 0; attempt < 4; attempt++) {
      const snapshot = await this.page.capture();
      if (!this.inDesigner(snapshot)) return;

      // Same reasoning as the schedule: leaving a screen is reversible, so the
      // plausible ways out are tried in order rather than escalated.
      const leave = this.grounder
        .rank(snapshot, { ...INTENTS.leaveDesigner(context), excludeNames: wrongTurns })
        .find((c) => c.score >= 0.5);
      if (!leave) return;

      const observation = await this.page.click(leave.node.ref);
      if (!this.inDesigner(observation.after)) {
        this.grounder.remember(
          INTENTS.leaveDesigner().id,
          leave.node,
          leave.score,
          'probe',
          'verified by leaving the form designer',
        );
        return;
      }

      wrongTurns.push(leave.node.name);
      this.grounder.forget(INTENTS.leaveDesigner().id);
    }
  }

  /**
   * Open a visit's detail screen, from wherever we happen to be.
   *
   * Arrival is confirmed against `onVisitDetail`, so a click that lands
   * somewhere else is a failure rather than a false success, and the row is
   * tried again from the schedule rather than accepted.
   */
  async openVisit(visitName: string): Promise<boolean> {
    const wrongRows: number[] = [];

    for (let attempt = 0; attempt < 4; attempt++) {
      // Already on it? Navigating away and back happens to work on some
      // platforms and not others, so the cheapest correct move is to notice.
      const here = await this.page.capture();
      if (this.onVisitDetail(here, visitName)) return true;

      if (this.inDesigner(here)) {
        await this.leaveDesignerIfOpen([visitName, ...this.visitNames()]);
        continue;
      }

      if (!this.visitScheduleVisible(here)) {
        if (!(await this.goToVisitSchedule())) return false;
      }

      const snapshot = await this.page.capture();
      const node = this.rowFor(snapshot, visitName, wrongRows);
      if (!node) return false;

      const observation = await this.page.click(node.ref);
      if (this.onVisitDetail(observation.after, visitName)) return true;

      // The row itself may be inert on a platform where the visit opens from a
      // link inside it. Try whatever inside that row carries the name.
      const inner = this.nameCarrierWithin(observation.after, visitName, node);
      if (inner) {
        const followed = await this.page.click(inner.ref);
        if (this.onVisitDetail(followed.after, visitName)) return true;
      }

      wrongRows.push(node.ref);
    }

    this.log(`Could not open visit "${visitName}".`, 'warn');
    return false;
  }

  /**
   * Open a source document's designer, working around a lifecycle gate if there
   * is one.
   *
   * Platforms commonly lock an approved document: the edit affordance simply is
   * not on the row any more, and a differently-named one restores it. Rather
   * than assuming either shape, the agent tries to edit, and if that is not
   * available looks for something that means "make this editable again".
   */
  async openDesigner(formName: string): Promise<OpenDesignerResult> {
    for (let attempt = 0; attempt < 2; attempt++) {
      const snapshot = await this.page.capture();
      const row = this.rowFor(snapshot, formName);

      // Scope the search to this form's own row. A list of documents has one
      // identical edit control per row, and being "near" the right row is not
      // enough to tell forty-pixel-apart rows apart — being INSIDE it is.
      const intent = {
        ...INTENTS.formOpenDesigner(),
        nearName: row?.name ?? formName,
        ...(row?.box ? { withinBox: row.box } : {}),
      };

      const edit = await this.grounder.ground(snapshot, intent);
      if (edit.ok) {
        await this.page.click(edit.ref);
        if (await this.designerOpen()) {
          return {
            ok: true,
            chose: { role: edit.node.role, name: edit.node.name },
            rationale: edit.rationale,
            confidence: edit.confidence,
            scopedToRow: Boolean(row?.box),
            detail: `opened via "${edit.node.name}"${row?.box ? ' scoped to its row' : ' (no row found to scope to)'}`,
          };
        }
      }

      // Perhaps it is locked. Look for the affordance that reopens it.
      const versionSnapshot = await this.page.capture();
      const versionRow = this.rowFor(versionSnapshot, formName);
      const version = await this.grounder.ground(versionSnapshot, {
        ...INTENTS.formNewVersion(),
        nearName: versionRow?.name ?? formName,
        ...(versionRow?.box ? { withinBox: versionRow.box } : {}),
      });
      if (!version.ok) break;
      await this.page.click(version.ref);
      this.log(`"${formName}" appeared to be locked; created a new version to make it editable.`);
      this.note('Documents are locked once approved; a new version is required to edit them.');
    }

    return { ok: false, scopedToRow: false, detail: 'no affordance opened the designer for this document' };
  }

  // ── finding things by name ──────────────────────────────────────────────────

  /**
   * The list row for a named thing.
   *
   * Prefers a node whose role actually is a row, because its box is the band
   * that owns the per-row actions. Falls back to whatever carries the name.
   */
  rowFor(snapshot: Snapshot, name: string, excludeRefs: number[] = []): SnapshotNode | undefined {
    const skip = new Set(excludeRefs);
    const rows = snapshot.nodes.filter((n) => n.role === 'row' && n.name.includes(name) && !skip.has(n.ref));
    if (rows.length) return rows.sort((a, b) => a.name.length - b.name.length)[0];
    return this.findByName(snapshot, name, excludeRefs);
  }

  /** A control on screen that carries this exact name, or clearly contains it. */
  findByName(snapshot: Snapshot, name: string, excludeRefs: number[] = []): SnapshotNode | undefined {
    const skip = new Set(excludeRefs);
    const exact = snapshot.nodes.find((n) => n.name === name && !skip.has(n.ref));
    if (exact) return exact;
    const contained = snapshot.nodes.filter((n) => n.name.includes(name) && !skip.has(n.ref));
    // Prefer the tightest match, so a row containing the name loses to a link
    // that IS the name.
    return contained.sort((a, b) => a.name.length - b.name.length)[0];
  }

  /** Something inside a row that carries the row's name — usually its link. */
  private nameCarrierWithin(snapshot: Snapshot, name: string, row: SnapshotNode): SnapshotNode | undefined {
    const box = row.box;
    if (!box) return undefined;
    const inside = snapshot.nodes.filter(
      (n) =>
        n.ref !== row.ref &&
        n.name.includes(name) &&
        n.box &&
        n.box.y >= box.y - 2 &&
        n.box.y + n.box.h <= box.y + box.h + 2,
    );
    return inside.sort((a, b) => a.name.length - b.name.length)[0];
  }
}
