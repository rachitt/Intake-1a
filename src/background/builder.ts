/**
 * The build pipeline.
 *
 * The WHAT is entirely deterministic — it falls out of the input file. The HOW
 * is where the agent has to think, because the platform is unknown. Keeping
 * those apart is what makes a 195-field run predictable: the plan never varies,
 * only the grounding does.
 *
 * Order here is not cosmetic. It is the mitigation for most of the ways this
 * job silently goes wrong:
 *
 *   - The type is fixed when the field is CREATED, and the type selector is
 *     never touched afterwards, because changing a type discards whatever the
 *     new type cannot hold — coded values, ranges, formulas — without saying so.
 *   - Labels are set immediately after creation, because a field that exists
 *     but was never named is structurally present and semantically worthless.
 *   - Skip logic runs as a SECOND PASS over each form, because a rule refers to
 *     another field by label and that field has to exist first.
 *   - Nothing is treated as built until it has been read back through the UI
 *     after a commit, because designer work lives in a working copy and
 *     navigating away can discard it without warning.
 *
 * Re-running is convergence, not repetition: everything is checked for before
 * it is created, so a second run on a half-built study finishes it rather than
 * duplicating it.
 */

import { Discloser } from './disclose';
import { INTENTS } from './intents';
import { Navigator } from './navigate';
import {
  assessAppearance,
  assessDisplacement,
  assessLabelOnCanvas,
  assessSelection,
  assessType,
  confirmLabelBeforeCommit,
  describeCause,
  emptyFieldEvidence,
  mergeReadBackEvidence,
  remedyForCause,
  retryIsWorthwhile,
  retryShouldRemoveElement,
} from './diagnose';
import { SIGNATURES } from '../shared/types';
import { formFingerprint, irPointer, type CanonicalType, type IrField, type IrForm, type IrStudy, type IrVisit } from '../shared/ir';
import type { Designer } from './designer';
import type { CanvasReading, Diagnosis, FieldAttemptEvidence, FieldDiagnostician, FieldFailureCause } from './diagnose';
import type { Grounded, Grounder, Intent } from './grounder';
import type { PageLike } from './page';
import type { Store } from './store';
import type { TypeMapper } from './typemap';
import type { Escalation, EscalationResolution, ProgressNode, TaskStatus } from '../shared/protocol';
import type { Snapshot, SnapshotNode } from '../shared/snapshot';

export interface Gate {
  /** Put a question to the human and wait for an answer. */
  raise(escalation: Escalation): Promise<EscalationResolution>;
  /** Put several questions up at once so the queue can be cleared in one pass. */
  raiseAll(escalations: Escalation[]): Promise<Map<string, EscalationResolution>>;
}

type Log = (message: string, level?: 'info' | 'warn' | 'error') => void;

/** What one attempt at one field produced, evidence and all. */
interface FieldAttempt {
  ok: boolean;
  evidence: FieldAttemptEvidence;
  /** How the screen read before the attempt, and after it. */
  before: CanvasReading;
  after: CanvasReading;
  /** Canvas entries that were not there before this attempt. */
  appeared: string[];
}

export class Builder {
  private commitProven = false;

  /**
   * Getting around is shared with the reconciliation sweep rather than written
   * twice — see `navigate.ts` for why that matters.
   */
  private readonly nav: Navigator;

  /** Finds affordances that a platform keeps one click deep. */
  private readonly discloser: Discloser;

  constructor(
    private page: PageLike,
    private grounder: Grounder,
    private designer: Designer,
    private typeMapper: TypeMapper,
    private store: Store,
    private gate: Gate,
    private diagnostician: FieldDiagnostician,
    private log: Log,
  ) {
    this.nav = new Navigator(
      page,
      grounder,
      designer,
      log,
      () => this.store.ir?.visits.map((v) => v.name) ?? [],
      () => this.store.ir?.study?.protocol_id ?? '',
      (text) => this.profile.notes.push(text),
    );
    this.discloser = new Discloser(page, grounder, store, log);
  }

  private get ir(): IrStudy {
    return this.store.ir!;
  }

  private get profile() {
    return this.store.profile!;
  }

  // ── progress bookkeeping ────────────────────────────────────────────────────

  private initProgress(): void {
    this.store.state.progress = this.ir.visits.map((visit, vi) => ({
      pointer: irPointer.visit(vi),
      label: visit.name,
      status: 'pending' as TaskStatus,
      children: visit.forms.map((form, fi) => ({
        pointer: irPointer.form(vi, fi),
        label: form.name,
        status: 'pending' as TaskStatus,
        children: form.fields.map((field, xi) => ({
          pointer: irPointer.field(vi, fi, xi),
          label: field.label,
          status: 'pending' as TaskStatus,
        })),
      })),
    }));

    const counters = this.store.state.counters;
    counters.visitsTotal = this.ir.visits.length;
    counters.formsTotal = this.ir.visits.reduce((n, v) => n + v.forms.length, 0);
    counters.fieldsTotal = this.ir.visits.reduce((n, v) => n + v.forms.reduce((m, f) => m + f.fields.length, 0), 0);
    this.store.notify();
  }

  private mark(pointer: string, status: TaskStatus, detail?: string): void {
    const walk = (nodes: ProgressNode[]): boolean => {
      for (const node of nodes) {
        if (node.pointer === pointer) {
          node.status = status;
          if (detail) node.detail = detail;
          return true;
        }
        if (node.children && walk(node.children)) return true;
      }
      return false;
    };
    walk(this.store.state.progress);
    this.store.notify();
  }

  /** The status currently recorded against a pointer, if any. */
  private statusOf(pointer: string): TaskStatus | undefined {
    const walk = (nodes: ProgressNode[]): TaskStatus | undefined => {
      for (const node of nodes) {
        if (node.pointer === pointer) return node.status;
        if (node.children) {
          const found = walk(node.children);
          if (found) return found;
        }
      }
      return undefined;
    };
    return walk(this.store.state.progress);
  }

  /**
   * Record an outcome without overwriting a more informative one.
   *
   * A field left with a person, or skipped for want of a type mapping, has
   * already been described more precisely than "failed"; flattening that on the
   * way out of the loop loses the reason a reviewer needs.
   */
  private settle(pointer: string, status: TaskStatus): void {
    const current = this.statusOf(pointer);
    if (status === 'failed' && (current === 'escalated' || current === 'skipped')) return;
    this.mark(pointer, status);
  }

  private audit(pointer: string, intent: string, extra: Partial<Parameters<Store['log']>[0]> = {}): void {
    this.store.log({ pointer, intent, level: 'info', ...extra });
  }

  // ── the run ─────────────────────────────────────────────────────────────────

  async run(): Promise<void> {
    this.initProgress();

    this.store.setPhase('reconnaissance', 'Working out how this platform is put together…');
    await this.goToVisitSchedule();

    // Types are resolved once, up front, inside the first form's designer where
    // probing is possible and harmless. Every field of a given type then builds
    // without asking anything again.
    await this.ensureVisit(this.ir.visits[0]!, 0);

    this.store.setPhase('building', 'Building the study.');
    for (let vi = 0; vi < this.ir.visits.length; vi++) {
      if (this.store.aborted) break;
      const visit = this.ir.visits[vi]!;
      await this.ensureVisit(visit, vi);
      await this.buildVisitForms(visit, vi);
      this.mark(irPointer.visit(vi), 'verified');
      this.store.state.counters.visitsBuilt++;
      this.store.notify();
    }
  }

  // ── navigation ──────────────────────────────────────────────────────────────
  //
  // All of it lives in `navigate.ts`, shared with the reconciliation sweep. The
  // sweep used to keep its own copy; it drifted, and a correctly built study
  // read back as empty. These are thin delegations so that cannot recur.

  private goToVisitSchedule(): Promise<boolean> {
    return this.nav.goToVisitSchedule();
  }

  private visitScheduleVisible(snapshot: Snapshot): boolean {
    return this.nav.visitScheduleVisible(snapshot);
  }

  private onVisitDetail(snapshot: Snapshot, visitName: string): boolean {
    return this.nav.onVisitDetail(snapshot, visitName);
  }

  private inDesigner(snapshot: Snapshot): boolean {
    return this.nav.inDesigner(snapshot);
  }

  private leaveDesignerIfOpen(context: string[] = []): Promise<void> {
    return this.nav.leaveDesignerIfOpen(context);
  }

  private rowFor(snapshot: Snapshot, name: string): SnapshotNode | undefined {
    return this.nav.rowFor(snapshot, name);
  }

  private findByName(snapshot: Snapshot, name: string): SnapshotNode | undefined {
    return this.nav.findByName(snapshot, name);
  }

  // ── visits ──────────────────────────────────────────────────────────────────

  /** Create the visit if it is not already there. Idempotent by design. */
  private async ensureVisit(visit: IrVisit, vi: number): Promise<boolean> {
    const pointer = irPointer.visit(vi);
    await this.goToVisitSchedule();

    let snapshot = await this.page.capture();
    if (this.findByName(snapshot, visit.name)) {
      this.audit(pointer, `visit "${visit.name}" already exists`, { verification: 'pass' });
      this.mark(pointer, 'built', 'already present');
      return true;
    }

    this.mark(pointer, 'running');
    const open = await this.groundOrAsk(snapshot, INTENTS.visitCreate(), pointer, 'create a visit');
    if (!open) {
      // The reviewer named no control. They may still have made the visit by
      // hand, so the page is re-read rather than the run being abandoned.
      return this.settleByReadBack(pointer, `visit "${visit.name}"`, (later) => Boolean(this.findByName(later, visit.name)));
    }

    const opened = await this.page.click(open.ref);
    this.audit(pointer, `open the "create visit" form`, {
      chose: { role: open.node.role, name: open.node.name },
      rationale: open.rationale,
      confidence: open.confidence,
    });

    // The controls that appeared when the form opened are the form's own. This
    // is what keeps the agent from mistaking the button it just pressed for the
    // one that confirms — a loop that costs nothing to enter and never ends.
    const appeared = opened.diff.addedNodes.map((n) => n.name).filter(Boolean);

    const nameResult = await this.designer.setText({ ...INTENTS.visitName(), preferNames: appeared }, visit.name);
    if (!nameResult.ok) this.log(`Visit name could not be entered: ${nameResult.detail}`, 'warn');

    // Window days are entered verbatim. A platform that wants calendar dates
    // instead cannot be satisfied without a baseline date, which the input file
    // does not carry — that is recorded as an assumption, not silently guessed.
    await this.designer.setText({ ...INTENTS.visitWindowStart(), preferNames: appeared }, String(visit.window_start_day));
    await this.designer.setText({ ...INTENTS.visitWindowEnd(), preferNames: appeared }, String(visit.window_end_day));

    const beforeConfirm = await this.page.capture();
    const confirm = await this.groundOrAsk(
      beforeConfirm,
      { ...INTENTS.visitConfirm(), preferNames: appeared, excludeRefs: [open.ref] },
      pointer,
      'save the new visit',
    );
    if (!confirm) {
      return this.settleByReadBack(pointer, `visit "${visit.name}"`, (later) => Boolean(this.findByName(later, visit.name)));
    }
    const observation = await this.page.click(confirm.ref);

    snapshot = observation.after;
    const created = Boolean(this.findByName(snapshot, visit.name));
    this.audit(pointer, `create visit "${visit.name}"`, {
      chose: { role: confirm.node.role, name: confirm.node.name },
      rationale: confirm.rationale,
      confidence: confirm.confidence,
      observed: observation.detail,
      verification: created ? 'pass' : 'fail',
      level: created ? 'info' : 'error',
    });

    if (!created) {
      this.log(`Visit "${visit.name}" did not appear after saving.`, 'error');
      this.mark(pointer, 'failed', 'did not appear after saving');
      this.store.state.counters.failed++;
      return false;
    }
    this.mark(pointer, 'built');
    return true;
  }

  private openVisit(visit: IrVisit): Promise<boolean> {
    return this.nav.openVisit(visit.name);
  }

  // ── forms ───────────────────────────────────────────────────────────────────

  private async buildVisitForms(visit: IrVisit, vi: number): Promise<void> {
    if (!(await this.openVisit(visit))) {
      this.log(`Could not open visit "${visit.name}".`, 'error');
      return;
    }

    for (let fi = 0; fi < visit.forms.length; fi++) {
      if (this.store.aborted) break;
      const form = visit.forms[fi]!;
      await this.buildForm(visit, vi, form, fi);
      // Every form ends by returning to this visit, so the next one starts from
      // a known place rather than wherever the last action happened to land.
      await this.openVisit(visit);
    }
  }

  private async buildForm(visit: IrVisit, vi: number, form: IrForm, fi: number): Promise<void> {
    const pointer = irPointer.form(vi, fi);
    this.mark(pointer, 'running');

    const entry = await this.page.capture();
    this.log(`Building "${form.name}" (starting from "${entry.screenTitle || entry.title}").`);

    const created = await this.ensureForm(form, pointer);
    if (!created) {
      this.mark(pointer, 'escalated');
      return;
    }

    if (!(await this.openDesigner(form, pointer))) {
      this.mark(pointer, 'failed', 'the form designer could not be opened');
      return;
    }

    // Resolve the type vocabulary the first time a designer is open, since
    // probing needs one, and the answers serve the whole study.
    await this.ensureTypeMap();

    await this.buildFields(form, vi, fi, pointer);
    await this.applySkipLogic(form, vi, fi);

    // Committing and verifying are each a round trip through the platform. A
    // stopped run should not spend one: it has already been told the result
    // does not matter.
    if (this.store.aborted) {
      this.mark(pointer, 'skipped', 'the run was stopped');
      return;
    }

    // What the canvas held on the way into the save. Without it, a field that
    // is missing afterwards cannot be told apart from one that was never
    // there — and those need opposite repairs.
    await this.noteCanvasBeforeCommit(form, vi, fi);

    const committed = await this.commit(pointer, form);
    const verified = await this.verifyForm(visit, form, vi, fi, pointer);

    this.mark(pointer, verified ? 'verified' : committed ? 'built' : 'failed');
    this.store.state.counters.formsBuilt++;
    this.store.notify();
  }

  /**
   * Create the source document if it is not already under this visit.
   *
   * Properties that a platform only offers at creation time — a repeating/log
   * flag, typically — must be set here, because there may be no second chance.
   * The agent detects that case by looking for the affordance in the creation
   * dialog and again in the editor.
   */
  private async ensureForm(form: IrForm, pointer: string): Promise<boolean> {
    let snapshot = await this.page.capture();
    if (this.formAlreadyListed(snapshot, form.name)) {
      this.audit(pointer, `source document "${form.name}" already exists`, { verification: 'pass' });
      return true;
    }

    const open = await this.groundOrAsk(snapshot, INTENTS.formCreate(), pointer, 'create a source document');
    if (!open) {
      return this.settleByReadBack(pointer, `source document "${form.name}"`, (later) => this.formAlreadyListed(later, form.name));
    }
    const opened = await this.page.click(open.ref);
    const appeared = opened.diff.addedNodes.map((n) => n.name).filter(Boolean);

    const nameResult = await this.designer.setText({ ...INTENTS.formName(), preferNames: appeared }, form.name);
    if (!nameResult.ok) this.log(`Form name could not be entered: ${nameResult.detail}`, 'warn');

    if (form.repeating) {
      const repeating = await this.designer.setToggle({ ...INTENTS.formRepeating(), preferNames: appeared }, true);
      if (!repeating.ok) {
        const resolution = await this.gate.raise({
          id: `repeating:${pointer}`,
          kind: 'repeating_unsupported',
          question: `How does this platform mark "${form.name}" as a repeating log?`,
          reason: `The specification says this document holds many records per subject-visit, but no control for that could be found. ${repeating.detail}`,
          consequence:
            'Built as a single-record document, it will only ever hold one row — so concomitant medications or adverse events beyond the first cannot be recorded at all.',
          affectedCount: 1,
          affected: [pointer],
          options: [],
          allowsManual: true,
          createdAt: Date.now(),
        });

        // If the reviewer set it themselves, the control is now discoverable —
        // try once more so the profile learns it and the next repeating
        // document does not ask again.
        if (resolution.choice === 'manual') {
          const second = await this.designer.setToggle({ ...INTENTS.formRepeating(), preferNames: appeared }, true);
          this.audit(pointer, `re-check the repeating flag on "${form.name}" after a reviewer set it`, {
            observed: second.detail,
            verification: second.ok ? 'pass' : 'fail',
            level: second.ok ? 'info' : 'warn',
          });
          if (second.ok) this.profile.repeatingControl = this.profile.controls[INTENTS.formRepeating().id];
        }
      } else {
        this.profile.repeatingControl = this.profile.controls[INTENTS.formRepeating().id];
      }
    }

    const confirm = await this.groundOrAsk(
      await this.page.capture(),
      { ...INTENTS.formConfirm(), preferNames: appeared, excludeRefs: [open.ref] },
      pointer,
      'save the new source document',
    );
    if (!confirm) {
      return this.settleByReadBack(pointer, `source document "${form.name}"`, (later) => this.formAlreadyListed(later, form.name));
    }
    const observation = await this.page.click(confirm.ref);

    snapshot = observation.after;
    const exists = Boolean(this.findByName(snapshot, form.name));
    this.audit(pointer, `create source document "${form.name}"${form.repeating ? ' (repeating)' : ''}`, {
      chose: { role: confirm.node.role, name: confirm.node.name },
      rationale: confirm.rationale,
      confidence: confirm.confidence,
      observed: observation.detail,
      verification: exists ? 'pass' : 'fail',
      level: exists ? 'info' : 'error',
    });
    return exists;
  }

  /**
   * Open the form's designer, working around a lifecycle gate if there is one.
   *
   * Platforms commonly lock an approved document: the edit affordance simply is
   * not on the row any more, and a differently-named one restores it. Rather
   * than assuming either shape, the agent tries to edit, and if that is not
   * available looks for something that means "make this editable again".
   */
  private async openDesigner(form: IrForm, pointer: string): Promise<boolean> {
    const result = await this.nav.openDesigner(form.name);
    if (!result.ok) return false;
    this.log(`Opened the designer for "${form.name}" — ${result.detail}.`);
    this.audit(pointer, `open the designer for "${form.name}"`, {
      ...(result.chose ? { chose: result.chose } : {}),
      ...(result.rationale ? { rationale: result.rationale } : {}),
      ...(result.confidence !== undefined ? { confidence: result.confidence } : {}),
    });
    return true;
  }

  /** Are we inside a form designer? Judged by the palette being present. */
  private designerOpen(): Promise<boolean> {
    return this.nav.designerOpen();
  }

  // ── type vocabulary ─────────────────────────────────────────────────────────

  private async ensureTypeMap(): Promise<void> {
    const needed = new Set<CanonicalType>();
    for (const visit of this.ir.visits) for (const form of visit.forms) for (const field of form.fields) needed.add(field.type);
    const outstanding = [...needed].filter((t) => !this.profile.typeMap[t]);
    if (!outstanding.length) return;

    this.store.setPhase('reconnaissance', 'Working out what this platform calls each kind of field…');
    const outcome = await this.typeMapper.resolve(outstanding);

    // Probing stops early when the run is stopped, which leaves every type it
    // never reached looking unresolved. Asking about those would block a run
    // that is on its way out, on answers nothing will read.
    if (outcome.escalations.length && !this.store.aborted) {
      this.store.setPhase('blocked', `Waiting on ${outcome.escalations.length} field-type decision(s).`);
      const answers = await this.gate.raiseAll(outcome.escalations);
      for (const [id, resolution] of answers) {
        const type = id.replace(/^type:/, '') as CanonicalType;
        if (resolution.choice === 'option' && resolution.optionId) {
          this.typeMapper.applyHumanChoice(type, resolution.optionId);
          this.log(`A reviewer mapped ${type} to "${resolution.optionId}".`);
        } else if (resolution.choice === 'skip') {
          this.log(`A reviewer chose to skip every ${type} field.`, 'warn');
        }
      }
    }
    if (!this.store.aborted) this.store.setPhase('building', 'Building the study.');
  }

  private libraryNameFor(type: CanonicalType): string | null {
    return this.profile.typeMap[type]?.libraryName ?? null;
  }

  // ── fields ──────────────────────────────────────────────────────────────────

  /**
   * The fields already standing in the form currently open, in build order.
   *
   * Kept because most of what can go wrong with a field is only visible
   * RELATIVE to its neighbours: a name that lands in the wrong editor is
   * invisible on its own and obvious the moment you notice the field built a
   * moment ago has stopped showing its own.
   */
  private builtInForm: { label: string; pointer: string }[] = [];

  /** The last attempt at each field, so verification can build on what it saw. */
  private fieldEvidence = new Map<string, FieldAttemptEvidence>();

  /** What the canvas held immediately before the form was committed. */
  private beforeCommit: { reading: CanvasReading; visible: string[] } | null = null;

  private async buildFields(form: IrForm, vi: number, fi: number, formPointer: string): Promise<void> {
    this.builtInForm = [];

    for (let xi = 0; xi < form.fields.length; xi++) {
      if (this.store.aborted) break;
      const field = form.fields[xi]!;
      const pointer = irPointer.field(vi, fi, xi);
      this.mark(pointer, 'running');

      const snapshot = await this.page.capture();
      if (this.fieldOnCanvas(snapshot, field.label)) {
        this.mark(pointer, 'built', 'already present');
        this.builtInForm.push({ label: field.label, pointer });
        continue;
      }

      const built = await this.buildFieldWithRetry(field, pointer);
      this.settle(pointer, built ? 'built' : 'failed');
      if (built) {
        this.store.state.counters.fieldsBuilt++;
        this.builtInForm.push({ label: field.label, pointer });
      } else {
        this.store.state.counters.failed++;
      }
      this.store.notify();
    }
    void formPointer;
  }

  /**
   * Build one field — and when it does not work, find out WHY before trying
   * again.
   *
   * "It failed, try it again" is not a repair strategy, it is a coin toss: a
   * second identical attempt fixes a transient and does nothing at all for the
   * five ways this actually fails, one of which (a name landing in the previous
   * field's editor) is made strictly worse by repeating it. So every attempt
   * collects evidence, a failed attempt is classified from that evidence, and
   * what happens next follows from the classification — including doing
   * nothing, where the field is in fact fine and only the reading of it is
   * broken.
   *
   * Two attempts, never a loop. If the same cause comes back a second time the
   * attempt is not what is wrong, and the only useful thing left to spend is a
   * person's attention — spent on a question that says what went wrong rather
   * than that something did.
   */
  private async buildFieldWithRetry(field: IrField, pointer: string, maxAttempts = 2): Promise<boolean> {
    const libraryName = this.libraryNameFor(field.type);
    if (!libraryName) {
      this.mark(pointer, 'skipped', `no mapping for ${field.type}`);
      this.audit(pointer, `build "${field.label}"`, {
        level: 'warn',
        observed: `skipped — no library entry is mapped to ${field.type}`,
        verification: 'not-checked',
      });
      return false;
    }

    let previous: Diagnosis | null = null;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      if (this.store.aborted) return false;

      const outcome = await this.attemptField(field, pointer, libraryName, attempt);
      this.fieldEvidence.set(pointer, outcome.evidence);

      if (outcome.ok) {
        this.audit(pointer, `build "${field.label}" as ${field.type}`, {
          chose: { role: 'listitem', name: libraryName },
          rationale: `"${libraryName}" was established as this platform's ${field.type} by probing its behaviour`,
          confidence: this.profile.typeMap[field.type]?.confidence,
          observed: describeAttempt(outcome.evidence),
          verification: 'pass',
        });
        if (attempt > 1) {
          this.store.state.counters.repaired++;
          this.log(`"${field.label}" went in on attempt ${attempt}.`);
        }
        return true;
      }

      const diagnosis = await this.diagnostician.diagnose(outcome.evidence, {
        before: outcome.before,
        after: outcome.after,
        spec: specOf(field),
      });
      this.recordDiagnosis(pointer, field, diagnosis, attempt);
      this.reportCollateralDamage(outcome.evidence);

      const repeated = previous?.cause === diagnosis.cause;
      const outOfAttempts = attempt >= maxAttempts;
      if (outOfAttempts || repeated || !retryIsWorthwhile(diagnosis.cause)) {
        return this.escalateFieldFailure(pointer, field, diagnosis, attempt, repeated);
      }

      // Never retry over the top of a half-built element: that turns one
      // missing field into two broken ones.
      if (retryShouldRemoveElement(diagnosis.cause)) await this.removeStray(field, outcome.evidence);
      previous = diagnosis;
    }
    return false;
  }

  /**
   * One attempt at one field, checked at every step rather than at the end.
   *
   * The order of the steps is the whole point — see the note at the top of this
   * file. Type first, because it is destructive; then the label, because an
   * unnamed field is worthless; then everything the type is allowed to carry.
   *
   * What is new here is that each step is CONFIRMED before the next one runs,
   * and the confirmations are recorded whether they pass or fail. That matters
   * most between creating an element and naming it: if the property editor is
   * still attached to the previous field, writing the name is not a failure
   * that can be retried, it is damage to a field that was already correct. So
   * the selection is settled first, and the attempt is abandoned rather than
   * risking the write.
   */
  private async attemptField(
    field: IrField,
    pointer: string,
    libraryName: string,
    attempt: number,
  ): Promise<FieldAttempt> {
    const evidence = emptyFieldEvidence(field.label, field.type, libraryName, attempt);
    const peers = this.builtInForm.map((p) => p.label);

    const before = await this.page.capture();
    evidence.canvasBefore = this.designer.canvasEntries(before);
    const beforeReading = this.designer.readCanvas(before);
    const peersVisibleBefore = this.designer.visibleLabels(before, peers);
    evidence.peerLabelsExpected = peers.length;

    // ── did an element appear at all? ─────────────────────────────────────────
    const added = await this.designer.addElement(libraryName);
    let snapshot = await this.page.capture();
    evidence.canvasAfterAdd = this.designer.canvasEntries(snapshot);
    const appeared = evidence.canvasAfterAdd.filter((n) => !evidence.canvasBefore.includes(n));
    evidence.elementAppeared = assessAppearance({ addedReportedOk: added.ok, appeared });
    if (!added.ok) evidence.notes.push(added.detail);
    if (appeared.length) evidence.notes.push(`the canvas gained: ${appeared.join(', ')}`);
    if (!evidence.elementAppeared) return this.attemptFailed(evidence, beforeReading, snapshot, appeared);

    // ── is the editor on the element that just appeared? ──────────────────────
    snapshot = await this.confirmSelection(snapshot, appeared, peers, evidence);
    if (evidence.labelEditorOnSelection === false) {
      return this.attemptFailed(evidence, beforeReading, snapshot, appeared);
    }

    // ── did the name go in, and go in HERE? ───────────────────────────────────
    const labelled = await this.designer.setText(INTENTS.fieldLabel(), field.label);
    evidence.labelWriteAccepted = labelled.ok;
    if (!labelled.ok) evidence.notes.push(labelled.detail);

    snapshot = await this.page.capture();
    const peersVisibleAfter = this.designer.visibleLabels(snapshot, peers);
    const labelVisibleNow = this.designer.fieldPresentOnCanvas(snapshot, field.label);
    evidence.peerLabelsVisible = peersVisibleAfter.length;
    evidence.labelDisplacedFrom = assessDisplacement({
      peersVisibleBefore,
      peersVisibleAfter,
      labelVisibleAfter: labelVisibleNow,
    });

    // Confirm the name reached the canvas — but a negative here is NOT a
    // failure. A designer that only paints a label onto a preview once the
    // selection moves on shows nothing for the field just named, which is
    // every field at the moment it is checked. So this can only confirm; the
    // authoritative check is deferred to just before the form is saved.
    const onCanvasNow = assessLabelOnCanvas({
      labelVisible: labelVisibleNow,
      peersVisibleBefore,
    });
    evidence.addedElementShowsLabel = onCanvasNow === true ? true : null;
    evidence.notes.push(
      onCanvasNow === false
        ? 'the canvas had not taken the new name up yet; it is checked again before the form is saved'
        : onCanvasNow === null
          ? 'no field on this canvas is showing its label, so the name could not be confirmed there'
          : 'the canvas shows the expected label',
    );

    if (!labelled.ok || evidence.labelDisplacedFrom) {
      return this.attemptFailed(evidence, beforeReading, snapshot, appeared);
    }

    // ── is it the kind of field that was asked for? ───────────────────────────
    //
    // Read, never written. Changing a type after the fact discards whatever the
    // new type cannot hold, so a mismatch is a reason to rebuild the field from
    // the right palette entry, not to correct it in place.
    evidence.displayedType = this.designer.displayedType(snapshot);
    evidence.typeMatches = await this.typeAsExpected(snapshot, evidence.displayedType, libraryName);
    if (evidence.typeMatches === false) return this.attemptFailed(evidence, beforeReading, snapshot, appeared);

    // ── everything the type is allowed to carry ───────────────────────────────
    if (field.required) await this.designer.setToggle(INTENTS.fieldRequired(), true);

    const signature = SIGNATURES[field.type];

    if (signature.hasRange) {
      if (field.min !== undefined) await this.designer.setText(INTENTS.fieldMin(), String(field.min));
      if (field.max !== undefined) await this.designer.setText(INTENTS.fieldMax(), String(field.max));
      if (field.units) await this.designer.setText(INTENTS.fieldUnits(), field.units);
    }

    if (signature.hasFormula && field.formula) {
      const formula = await this.designer.setText(INTENTS.fieldFormula(), field.formula);
      if (!formula.ok) this.log(`Formula for "${field.label}" could not be entered: ${formula.detail}`, 'warn');
    }

    if (signature.hasOptions && field.options?.length) {
      await this.enterOptions(field, pointer);
    }

    const settled = await this.page.capture();
    evidence.presentBeforeCommit = this.designer.fieldPresentOnCanvas(settled, field.label);
    return { ok: true, evidence, before: beforeReading, after: this.designer.readCanvas(settled), appeared };
  }

  private attemptFailed(
    evidence: FieldAttemptEvidence,
    before: CanvasReading,
    snapshot: Snapshot,
    appeared: string[],
  ): FieldAttempt {
    return { ok: false, evidence, before, after: this.designer.readCanvas(snapshot), appeared };
  }

  /**
   * Settle which element the property editor is attached to, before writing
   * anything into it.
   *
   * The failure this exists for is quiet and expensive: a platform that does
   * not select a newly added element leaves the editor pointing at the previous
   * field, so the next name overwrites it. The result is a form with the right
   * number of fields, one of them named twice and one of them not at all — and
   * nothing on screen says so.
   *
   * The tell is that the label control is already holding the name of a field
   * built earlier in this form. That is checked first, and if it holds, the
   * agent selects what it just added and looks again rather than writing.
   */
  private async confirmSelection(
    snapshot: Snapshot,
    appeared: string[],
    peers: string[],
    evidence: FieldAttemptEvidence,
  ): Promise<Snapshot> {
    let snap = snapshot;
    let read = this.readSelection(snap, appeared, peers);
    evidence.labelEditorValueBefore = read.value;

    if (read.verdict === false && appeared.length) {
      const target = appeared[0]!;
      if (await this.designer.selectFieldOnCanvas(target)) {
        snap = await this.page.capture();
        const second = this.readSelection(snap, appeared, peers);
        evidence.notes.push(
          `the property editor was on another field; selecting "${target}" first ` +
            `${second.verdict === false ? 'did not move it' : 'moved it onto the new element'}`,
        );
        read = second;
      }
    }

    evidence.labelEditorOnSelection = read.verdict;
    return snap;
  }

  /**
   * Whose properties is the editor showing?
   *
   * `null` wherever the platform gives no way to tell, which is common and
   * safe. Only a positive sign of the WRONG element counts as a failure.
   */
  private readSelection(
    snapshot: Snapshot,
    appeared: string[],
    peers: string[],
  ): { verdict: boolean | null; value: string | null } {
    const editor = this.designer.labelEditor(snapshot);
    const value = editor ? editor.value : null;
    const verdict = assessSelection({
      hasLabelEditor: Boolean(editor),
      labelEditorValue: value,
      selectedEntry: this.designer.selectedCanvasEntry(snapshot),
      appeared,
      peers,
    });
    return { verdict, value };
  }

  /**
   * Does the editor's idea of the field's type match the palette entry used?
   *
   * A disagreement is only believed when the control is demonstrably speaking
   * the PALETTE's vocabulary — that is, what it shows is itself one of the
   * entries in the element library. Any other control that happens to be named
   * like a type (a format, a display mode, a unit) would otherwise condemn a
   * perfectly good field to being deleted and built again.
   */
  private async typeAsExpected(snapshot: Snapshot, displayed: string | null, libraryName: string): Promise<boolean | null> {
    const entries = await this.designer.paletteEntries(snapshot);
    return assessType({ displayed, libraryName, paletteNames: entries.map((e) => e.name) });
  }

  // ── acting on a diagnosis ───────────────────────────────────────────────────

  /** Put the diagnosis where a person will find it: the log, and the progress tree. */
  private recordDiagnosis(pointer: string, field: IrField, diagnosis: Diagnosis, attempt: number): void {
    const rationale =
      diagnosis.source === 'model'
        ? 'proposed by the model, then checked against what the agent observed before being accepted'
        : diagnosis.source === 'deterministic'
          ? 'established from what the agent observed during the attempt'
          : 'nothing the agent observed explains it';

    this.audit(pointer, `diagnose why "${field.label}" was not built (attempt ${attempt})`, {
      level: diagnosis.cause === 'unknown' ? 'warn' : 'error',
      observed: `${describeCause(diagnosis.cause)} — ${diagnosis.why}`,
      confidence: diagnosis.confidence,
      rationale,
      verification: 'fail',
      diagnosis: {
        cause: diagnosis.cause,
        confidence: diagnosis.confidence,
        source: diagnosis.source,
        why: diagnosis.why,
        ...(diagnosis.modelProposal ? { modelProposal: diagnosis.modelProposal } : {}),
      },
    });

    this.mark(pointer, 'failed', describeCause(diagnosis.cause));
    this.log(`"${field.label}": ${describeCause(diagnosis.cause)} — ${diagnosis.why}`, 'warn');
  }

  /**
   * A name written into the wrong editor damages TWO fields, and only one of
   * them is the one being built. The other is already marked built and would
   * sail through to the end of the run looking fine, so it is un-marked here
   * and left for the form's read-back to rebuild.
   */
  private reportCollateralDamage(evidence: FieldAttemptEvidence): void {
    const victim = evidence.labelDisplacedFrom;
    if (!victim) return;
    const peer = this.builtInForm.find((p) => p.label === victim);
    if (!peer) return;

    this.mark(peer.pointer, 'failed', 'its label was overwritten while a later field was being named');
    this.audit(peer.pointer, `re-check "${victim}"`, {
      level: 'error',
      observed: `it stopped showing its label when "${evidence.expectedLabel}" was named, so that write landed on it`,
      verification: 'fail',
    });
    this.builtInForm = this.builtInForm.filter((p) => p.label !== victim);
    this.store.state.counters.failed++;
  }

  /**
   * Remove what this attempt left behind — and nothing else.
   *
   * Deliberately not "delete whatever is selected". The failure most likely to
   * bring us here is the editor being attached to the wrong element, so the
   * selection is exactly what must not be trusted. Only a canvas entry that
   * appeared during this attempt, and is not a field already built, is a
   * candidate; if none can be identified the stray is left alone, because a
   * duplicate is a lesser defect than a deleted good field.
   */
  private async removeStray(field: IrField, evidence: FieldAttemptEvidence): Promise<void> {
    const appeared = evidence.canvasAfterAdd.filter((n) => !evidence.canvasBefore.includes(n));
    const candidates = [field.label, ...appeared].filter((n) => !this.builtInForm.some((p) => p.label === n));

    for (const candidate of candidates) {
      if (!(await this.designer.selectFieldOnCanvas(candidate))) continue;
      if (await this.designer.deleteSelected()) {
        evidence.notes.push(`removed the half-built "${candidate}" before trying again`);
        return;
      }
    }
    evidence.notes.push(
      'nothing on the canvas could be identified as the half-built element, so it was left alone rather than ' +
        'risk deleting a field that was already correct',
    );
  }

  /**
   * Ask a person — with the cause, not just the symptom.
   *
   * The difference between "a field is missing" and "the name was written into
   * another field's editor, and the field built just before it has lost its
   * own" is the difference between a question a reviewer can answer in seconds
   * and one that makes them go and look.
   */
  private async escalateFieldFailure(
    pointer: string,
    field: IrField,
    diagnosis: Diagnosis,
    attempts: number,
    repeated: boolean,
  ): Promise<boolean> {
    const cause = diagnosis.cause;
    const worthRetrying = retryIsWorthwhile(cause);

    // Asked once per CAUSE, not once per field.
    //
    // Fields fail for platform-level reasons: if the label control this
    // designer offers is not the one that names a field, that is true of every
    // field in the study, and a queue with one identically-worded row per field
    // is not a gate, it is a wall. A reviewer clearing it watches it refill
    // with the question they just answered. So the first answer is kept and
    // applied to every later field that fails the same way, with each affected
    // pointer written to the audit log so nothing becomes invisible.
    const already = this.fieldFailureDecisions.get(cause);
    if (already) {
      this.audit(pointer, `apply a reviewer's earlier answer about ${describeCause(cause)} to "${field.label}"`, {
        humanDecision:
          already.choice === 'option'
            ? `${already.optionId} — their earlier answer for the same cause`
            : already.choice === 'manual'
              ? 'handled by hand'
              : 'skipped',
        observed: diagnosis.why,
        verification: 'fail',
        level: 'warn',
      });
      return this.actOnFieldFailure(already, pointer, field, cause, attempts);
    }

    const resolution = await this.gate.raise({
      id: `field:${cause}`,
      kind: 'field_build_failed',
      question: `"${field.label}" could not be built — ${describeCause(cause)}. How should it be handled?`,
      reason:
        `${diagnosis.why} ` +
        (repeated
          ? 'The same thing happened on both attempts, so building it again is not the answer. '
          : `Tried ${attempts} time(s). `) +
        (diagnosis.source === 'model'
          ? 'That reading was proposed by the model and checked against what the agent observed. '
          : '') +
        remedyForCause(cause) +
        ' This answer will be applied to any other field that fails the same way, so it is not asked again.',
      consequence:
        'A missing field is the most costly failure here: nobody notices until data collection has already started, ' +
        'by which point the study is live.',
      affectedCount: 1,
      affected: [pointer],
      options: [
        {
          id: 'retry',
          label: 'Try building this one field again',
          confidence: worthRetrying ? 0.4 : 0.1,
          agreements: [],
          conflicts: worthRetrying ? [] : ['the field is probably already there; building it again would duplicate it'],
        },
        { id: 'accept', label: 'Leave it and flag it in the report', confidence: 0.1, agreements: [], conflicts: [] },
      ],
      allowsManual: true,
      createdAt: Date.now(),
    });

    this.fieldFailureDecisions.set(cause, resolution);
    return this.actOnFieldFailure(resolution, pointer, field, cause, attempts);
  }

  /**
   * A reviewer's answer about a field, kept per CAUSE for the run.
   * See `escalateFieldFailure` for why this is not asked once per field.
   */
  private fieldFailureDecisions = new Map<FieldFailureCause, EscalationResolution>();

  /** Carry out what a reviewer decided — and check it rather than believe it. */
  private async actOnFieldFailure(
    resolution: EscalationResolution,
    pointer: string,
    field: IrField,
    cause: FieldFailureCause,
    attempts: number,
  ): Promise<boolean> {
    // One reviewer-requested attempt, and it is judged by what appears on the
    // canvas rather than by having been asked for.
    if (resolution.choice === 'option' && resolution.optionId === 'retry') {
      const libraryName = this.libraryNameFor(field.type);
      if (!libraryName) return false;
      const again = await this.attemptField(field, pointer, libraryName, attempts + 1);
      this.fieldEvidence.set(pointer, again.evidence);
      this.audit(pointer, `build "${field.label}" again, as a reviewer asked`, {
        observed: describeAttempt(again.evidence),
        verification: again.ok ? 'pass' : 'fail',
        level: again.ok ? 'info' : 'error',
      });
      if (again.ok) this.store.state.counters.repaired++;
      return again.ok;
    }

    // "I did it by hand" is checked, not believed.
    if (resolution.choice === 'manual') {
      const there = this.fieldOnCanvas(await this.page.capture(), field.label);
      this.audit(pointer, `read "${field.label}" back after a reviewer handled it at the gate`, {
        observed: there ? 'it is on the canvas' : 'it is still not on the canvas',
        verification: there ? 'pass' : 'fail',
        level: there ? 'info' : 'warn',
      });
      this.mark(pointer, there ? 'built' : 'escalated', there ? 'done by hand' : 'left for a person');
      return there;
    }

    this.mark(pointer, 'escalated', describeCause(cause));
    return false;
  }

  /**
   * Enter a coded value list as code/label PAIRS.
   *
   * Row-by-row entry is preferred over any bulk shortcut. Bulk entry is faster
   * but commonly REPLACES the list rather than appending to it, and a list that
   * silently lost its first half looks exactly like one that worked. Whichever
   * path is taken, the result is counted afterwards.
   */
  private async enterOptions(field: IrField, pointer: string, attempt = 0): Promise<void> {
    const options = field.options ?? [];
    let entered = 0;
    const failures: string[] = [];

    for (const option of options) {
      const row = await this.designer.addOptionRow(option.code, option.label);
      if (row.ok) entered++;
      else failures.push(row.detail);
    }

    if (entered !== options.length) {
      const resolution = await this.gate.raise({
        id: `values:${pointer}:${attempt}`,
        kind: 'coded_values',
        question: `The coded value list for "${field.label}" did not go in cleanly. How should it be handled?`,
        reason:
          `${entered} of ${options.length} value(s) were entered and read back with both a code and a label.` +
          (failures.length ? ` First problem: ${failures[0]}` : ''),
        consequence:
          'A field whose value list is short or label-only looks correct on screen and stores the wrong thing, which is not discovered until data is being analysed.',
        affectedCount: 1,
        affected: [pointer],
        options: [
          { id: 'retry', label: 'Try entering the list again', confidence: 0.5, agreements: [], conflicts: [] },
          { id: 'accept', label: 'Accept what is there', confidence: 0.2, agreements: [], conflicts: [] },
        ],
        allowsManual: true,
        createdAt: Date.now(),
      });

      // Bulk value entry usually replaces rather than appends, so a second run
      // through the list is a real repair and not a duplicate — but only once,
      // because a list that fails twice is failing for a reason retrying will
      // not fix.
      if (attempt === 0 && resolution.choice === 'option' && resolution.optionId === 'retry') {
        this.log(`Entering the coded value list for "${field.label}" again, as asked.`);
        await this.enterOptions(field, pointer, attempt + 1);
      }
    }
  }

  /**
   * Is this source document already in the list under the current visit?
   *
   * Looked for among the LIST ROWS, not anywhere on screen. A document is very
   * often named after the visit that holds it — the study has a form called
   * "End of Treatment" under a visit called "End of Treatment (Week 12)" — and
   * a screen showing that visit says its name in the heading and again in the
   * breadcrumb. Matching the whole screen therefore finds the visit's own name,
   * concludes the document already exists, and never creates it. A form that
   * silently never got built is the most expensive failure here, so the check
   * is narrowed to the only place a document can actually be listed.
   *
   * Where a platform lists documents as something other than rows there is
   * nothing to narrow to, and the broader check stands. Erring towards building
   * is deliberate: a duplicate is visible and cheap, an absence is neither.
   */
  private formAlreadyListed(snapshot: Snapshot, name: string): boolean {
    const rows = snapshot.nodes.filter((n) => n.role === 'row');
    if (rows.length) return rows.some((r) => r.name.includes(name));
    return Boolean(this.findByName(snapshot, name));
  }

  private fieldOnCanvas(snapshot: Snapshot, label: string): boolean {
    return this.designer.fieldPresentOnCanvas(snapshot, label);
  }

  // ── skip logic (second pass) ────────────────────────────────────────────────

  /**
   * A reviewer's answer about conditional display, kept per cause for the run.
   * See `escalateSkipLogic` for why this is not asked once per rule.
   */
  private skipLogicDecisions = new Map<string, EscalationResolution>();

  /**
   * Apply conditional display rules, after every field in the form exists.
   *
   * This is a separate pass for one reason: a rule names its controlling field
   * by label, and that field has to be there before the rule can point at it.
   * Doing it inline would work for rules whose controller happens to come first
   * and fail silently for the rest.
   */
  private async applySkipLogic(form: IrForm, vi: number, fi: number): Promise<void> {
    const rules = form.fields
      .map((field, xi) => ({ field, xi }))
      .filter((entry) => entry.field.skip_logic);
    if (!rules.length) return;

    for (const { field, xi } of rules) {
      if (this.store.aborted) break;
      const pointer = irPointer.field(vi, fi, xi);
      const rule = field.skip_logic!;

      const selected = await this.designer.selectFieldOnCanvas(field.label);
      if (!selected) {
        this.log(`Cannot apply a display rule to "${field.label}" — it could not be selected on the canvas.`, 'warn');
        await this.escalateSkipLogic(pointer, field, rule.when_field_label, 'not-selectable', 'the field could not be selected on the canvas');
        continue;
      }

      // Switching a field to conditional display is reversible and its result
      // is readable, so the agent tries the plausible controls rather than
      // asking. Only a genuine dead end reaches the reviewer.
      const mode = await this.designer.chooseOptionVerified(INTENTS.visibilityMode(), 'when');
      if (!mode.ok) {
        // Some platforms model this as a toggle rather than a choice.
        const toggled = await this.designer.setToggle(INTENTS.visibilityMode(), true);
        if (!toggled.ok) {
          await this.escalateSkipLogic(
            pointer,
            field,
            rule.when_field_label,
            'no-control',
            `No conditional-display control could be used. ${mode.detail} A toggle was tried too: ${toggled.detail}`,
          );
          continue;
        }
      }

      const whenResult = await this.designer.chooseOptionVerified(INTENTS.visibilityWhenField(), rule.when_field_label);
      if (!whenResult.ok) {
        await this.escalateSkipLogic(pointer, field, rule.when_field_label, 'no-when-field', whenResult.detail);
        continue;
      }

      const valueResult = await this.designer.setText(INTENTS.visibilityValue(), rule.equals_value);
      if (!valueResult.ok) {
        const chosen = await this.designer.chooseOptionVerified(INTENTS.visibilityValue(), rule.equals_value);
        if (!chosen.ok) {
          await this.escalateSkipLogic(
            pointer,
            field,
            rule.when_field_label,
            'no-value',
            `The expected value could not be entered. ${valueResult.detail} ${chosen.detail}`,
          );
          continue;
        }
      }

      this.audit(pointer, `show "${field.label}" only when "${rule.when_field_label}" is ${rule.equals_value}`, {
        verification: 'not-checked',
      });
    }
  }

  /**
   * Ask about a display rule that could not be applied — once per CAUSE.
   *
   * Conditional display fails the same way for every rule in a study: either
   * this designer exposes the affordance or it does not. Asking per rule turns
   * one platform-level question into thirteen identically worded ones, and a
   * reviewer clearing them watches the queue refill with the question they just
   * answered, which reads as the gate being broken. So the first answer is kept
   * and applied to every later rule that fails the same way, with each affected
   * pointer written to the audit log so nothing becomes invisible.
   */
  private async escalateSkipLogic(
    pointer: string,
    field: IrField,
    controller: string,
    cause: string,
    detail: string,
  ): Promise<void> {
    const already = this.skipLogicDecisions.get(cause);
    if (already) {
      this.audit(pointer, `show "${field.label}" only when "${controller}" matches`, {
        humanDecision: `${already.choice === 'manual' ? 'handled by hand' : 'skipped'} — a reviewer's earlier answer for the same cause, applied here too`,
        observed: detail,
        verification: 'fail',
        level: 'warn',
      });
      this.mark(pointer, already.choice === 'manual' ? 'built' : 'skipped', 'display rule left to a reviewer');
      return;
    }

    const outstanding = this.skipLogicRulesRemaining(cause);
    const resolution = await this.gate.raise({
      id: `skip:${cause}`,
      kind: 'skip_logic',
      question: `How should conditional display be set up on this platform? First case: "${field.label}", shown only when "${controller}" matches.`,
      reason: detail,
      consequence:
        'Without the rule the field is always visible. That is not a data-loss failure, but it does not match the protocol, and the protocol is the contract with the regulator.',
      affectedCount: outstanding,
      affected: [pointer],
      options: [],
      allowsManual: true,
      createdAt: Date.now(),
    });

    this.skipLogicDecisions.set(cause, resolution);
    this.mark(pointer, resolution.choice === 'manual' ? 'built' : 'skipped', 'display rule left to a reviewer');
  }

  /** How many display rules in the whole study one answer could settle. */
  private skipLogicRulesRemaining(_cause: string): number {
    let n = 0;
    for (const visit of this.ir.visits) for (const form of visit.forms) for (const f of form.fields) if (f.skip_logic) n++;
    return n;
  }

  // ── committing ──────────────────────────────────────────────────────────────

  /**
   * Persist the designer's work — and, the first time, PROVE which control
   * actually does that.
   *
   * The proof is a round trip: commit, leave the designer, come back, and see
   * whether the work is still there. Nothing else is sufficient on an unknown
   * platform, because a designer's toolbar routinely holds something that looks
   * like Save, reports success, and persists nothing.
   */
  private async commit(pointer: string, form: IrForm): Promise<boolean> {
    if (this.store.aborted) return false;

    const tried: string[] = [];

    for (let attempt = 0; attempt < 3; attempt++) {
      // Everything already shown not to persist is ruled out by name, both
      // within this run and from what the profile learned earlier. Without
      // that, the grounder keeps re-offering the same plausible look-alike and
      // the agent never gets far enough to notice that the real affordance is
      // somewhere it has not looked.
      const ruledOut = [...new Set([...tried, ...this.profile.rejectedCommits.map((r) => r.name)])];
      const intent = {
        ...INTENTS.commitWork(),
        excludeRefs: [] as number[],
        excludeNames: ruledOut,
        ignoreMemory: attempt > 0,
      };

      // Through a disclosure if need be. Not every platform puts Save on the
      // toolbar, and one that keeps it in an overflow menu is not a platform
      // without a Save — it is a platform the agent has not finished looking
      // at. Getting this wrong is silent and total: the form builds perfectly
      // and is discarded on the way out.
      const { result: grounded, through } = await this.discloser.ground(intent);
      let candidate: Grounded;
      if (grounded.ok) {
        candidate = grounded;
      } else {
        // Ask, and use what comes back — a reviewer who names this platform's
        // save is teaching the profile, not just unblocking one form.
        const named = await this.groundOrAsk(await this.page.capture(), intent, pointer, 'save the form');
        if (!named) return false;
        candidate = named;
      }
      if (through) {
        this.audit(pointer, `open "${through.name}" to reach this platform's save`, {
          chose: through,
          rationale: 'the commit affordance is not on the toolbar here; it is inside this disclosure',
        });
      }
      if (tried.includes(candidate.node.name)) {
        // The grounder keeps offering something already shown not to work.
        this.grounder.forget(intent.id);
        break;
      }
      tried.push(candidate.node.name);

      const observation = await this.page.click(candidate.ref);
      const said = observation.diff.newLiveText.join('; ');

      if (this.commitProven && this.profile.commit?.name === candidate.node.name) {
        this.audit(pointer, `save "${form.name}"`, {
          chose: { role: candidate.node.role, name: candidate.node.name },
          rationale: 'this control was proven to persist work earlier in the run',
          observed: said || observation.detail,
          verification: 'not-checked',
        });
        return true;
      }

      // Prove it: leave, come back, and look for a field we know we built.
      const witness = form.fields[0]?.label;
      const survived = witness ? await this.roundTrip(form, witness) : false;

      if (survived) {
        this.commitProven = true;
        this.profile.commit = {
          role: candidate.node.role,
          name: candidate.node.name,
          confidence: 1,
          source: 'probe',
          rationale: 'an edit made before clicking it survived leaving and re-entering the designer',
          learnedAt: Date.now(),
          provenBy: `round trip on "${form.name}"`,
        };
        this.grounder.remember(intent.id, candidate.node, 1, 'probe', 'proven by round trip');
        await this.store.saveProfile();
        this.log(`"${candidate.node.name}" is this platform's real save — an edit survived a round trip.`);
        this.audit(pointer, `save "${form.name}"`, {
          chose: { role: candidate.node.role, name: candidate.node.name },
          rationale: 'proven to persist work by leaving the designer and re-reading the form',
          observed: said || observation.detail,
          verification: 'pass',
        });
        return true;
      }

      this.profile.rejectedCommits.push({
        name: candidate.node.name,
        why: `work did not survive leaving and re-entering the designer${said ? ` (it said: "${said}")` : ''}`,
      });
      this.log(
        `"${candidate.node.name}" looks like a save but did not persist anything — treating it as a look-alike and trying the next candidate.`,
        'warn',
      );
      this.grounder.forget(intent.id);

      // The work was lost with the working copy, so rebuild before retrying.
      if (!(await this.openDesigner(form, pointer))) return false;
      await this.ensureTypeMap();
      const [vi, fi] = this.locate(form);
      if (vi >= 0) await this.buildFields(form, vi, fi, pointer);
    }

    const resolution = await this.gate.raise({
      id: `commit:${pointer}`,
      kind: 'commit_unverified',
      question: `Which control actually saves work in this form designer?`,
      reason:
        `Tried ${tried.map((t) => `"${t}"`).join(', ')}. In each case the work did not survive leaving the designer and returning, ` +
        'which is the only reliable test of whether something persisted.',
      consequence:
        'Until this is settled nothing built in the designer will survive, and the study will look complete on screen while being empty underneath.',
      affectedCount: 1,
      affected: [pointer],
      options: tried.map((name) => ({ id: name, label: name, confidence: 0.3, agreements: [], conflicts: ['work did not survive a round trip'] })),
      allowsManual: true,
      createdAt: Date.now(),
    });

    // A reviewer who names the save control overrules the round-trip evidence,
    // but the claim is still tested rather than believed: the work has to
    // survive leaving the designer and coming back, exactly as before.
    if (resolution.choice === 'option' && resolution.optionId) {
      const snapshot = await this.page.capture();
      const node = snapshot.nodes.find((n) => n.name === resolution.optionId);
      if (node) {
        await this.page.click(node.ref);
        const witness = form.fields[0]?.label;
        const survived = witness ? await this.roundTrip(form, witness) : false;
        this.audit(pointer, `save "${form.name}" using the control a reviewer named`, {
          chose: { role: node.role, name: node.name },
          rationale: 'named at the human gate',
          verification: survived ? 'pass' : 'fail',
          level: survived ? 'info' : 'error',
        });
        if (survived) {
          this.commitProven = true;
          this.profile.commit = {
            role: node.role,
            name: node.name,
            confidence: 1,
            source: 'human',
            rationale: 'named by a reviewer at the human gate',
            learnedAt: Date.now(),
            provenBy: `an edit to "${form.name}" survived leaving the designer and coming back`,
          };
          this.grounder.remember(INTENTS.commitWork().id, node, 1, 'human', 'named by a reviewer and proven by a round trip');
          return true;
        }
      }
    }

    // "I'll do it by hand" means the reviewer saved it themselves. That is not
    // taken on trust either — the same round trip decides.
    if (resolution.choice === 'manual') {
      const witness = form.fields[0]?.label;
      const survived = witness ? await this.roundTrip(form, witness) : false;
      this.audit(pointer, `check whether a reviewer's manual save of "${form.name}" persisted`, {
        verification: survived ? 'pass' : 'fail',
        level: survived ? 'info' : 'error',
      });
      return survived;
    }

    return false;
  }

  /** Leave the designer and come back; report whether a known field is still there. */
  private async roundTrip(form: IrForm, witnessLabel: string): Promise<boolean> {
    const [vi] = this.locate(form);
    const visit = vi >= 0 ? this.ir.visits[vi] : undefined;

    await this.leaveDesignerIfOpen(visit ? [visit.name] : []);
    if (visit) await this.openVisit(visit);
    else await this.goToVisitSchedule();

    if (!(await this.openDesigner(form, ''))) return false;
    const after = await this.page.capture();
    return this.fieldOnCanvas(after, witnessLabel);
  }

  /** Where does this form sit in the input file? */
  private locate(form: IrForm): [number, number] {
    const fingerprint = formFingerprint(form);
    for (let vi = 0; vi < this.ir.visits.length; vi++) {
      const forms = this.ir.visits[vi]!.forms;
      for (let fi = 0; fi < forms.length; fi++) {
        if (formFingerprint(forms[fi]!) === fingerprint && forms[fi]!.name === form.name) return [vi, fi];
      }
    }
    return [-1, -1];
  }

  // ── verification ────────────────────────────────────────────────────────────

  /**
   * Remember what the canvas held on the way into a commit.
   *
   * This one reading is what makes "the save lost it" and "it was never built"
   * distinguishable afterwards. Without it, both look identical at read-back —
   * a field that is not there — and they need opposite repairs: one wants a
   * different save, the other wants the field built.
   */
  private async noteCanvasBeforeCommit(form: IrForm, vi: number, fi: number): Promise<void> {
    if (this.store.aborted) return;
    const snapshot = await this.page.capture();
    const labels = form.fields.map((f) => f.label);
    const visible = this.designer.visibleLabels(snapshot, labels);
    this.beforeCommit = { reading: this.designer.readCanvas(snapshot), visible };

    // The deferred half of the post-add label check. Every field has now been
    // committed by the act of building the one after it, so a name that is
    // still not on the canvas is genuinely not on the element.
    for (let xi = 0; xi < form.fields.length; xi++) {
      const pointer = irPointer.field(vi, fi, xi);
      const evidence = this.fieldEvidence.get(pointer);
      if (!evidence) continue;
      const label = form.fields[xi]!.label;
      const shows = confirmLabelBeforeCommit({ label, visibleLabels: visible });
      if (shows === null) continue;
      evidence.addedElementShowsLabel = shows;
      if (!shows) {
        this.audit(pointer, `re-check "${label}" on the canvas before saving`, {
          level: 'warn',
          observed: 'the element is there, but the canvas still does not show its name',
          verification: 'fail',
        });
      }
    }
  }

  /**
   * Read the saved form back and compare it with the specification.
   *
   * This is what separates an agent that works from a demo that worked once.
   * Every failure this pipeline is guarding against — a discarded range, a
   * replaced value list, an unnamed field, a commit that did not commit — is
   * invisible at the moment it happens and visible here.
   *
   * A field that is missing here is DIAGNOSED before anything is done about it,
   * because the repairs diverge completely. A field the save discarded should
   * be built again; a field that is present and merely unreadable must NOT be,
   * because building it again is how a form ends up with two of everything.
   */
  private async verifyForm(
    visit: IrVisit,
    form: IrForm,
    vi: number,
    fi: number,
    pointer: string,
    attempt = 0,
  ): Promise<boolean> {
    if (this.store.aborted) return false;

    // Read-back has to start from outside the designer, so that what is read is
    // the SAVED form rather than the working copy still open on screen. A check
    // performed against the copy you just edited proves nothing.
    await this.leaveDesignerIfOpen([visit.name]);
    await this.openVisit(visit);

    if (!(await this.openDesigner(form, pointer))) {
      this.audit(pointer, `verify "${form.name}"`, { level: 'error', observed: 'could not reopen the designer to read it back', verification: 'fail' });
      return false;
    }

    const snapshot = await this.page.capture();
    const labels = form.fields.map((f) => f.label);
    const seen = {
      canvasEntries: this.designer.canvasEntries(snapshot),
      visible: this.designer.visibleLabels(snapshot, labels),
    };

    const missingIndexes: number[] = [];
    for (let xi = 0; xi < form.fields.length; xi++) {
      const field = form.fields[xi]!;
      const fieldPointer = irPointer.field(vi, fi, xi);
      if (this.fieldOnCanvas(snapshot, field.label)) {
        this.mark(fieldPointer, 'verified');
        this.store.state.counters.verified++;
      } else {
        missingIndexes.push(xi);
      }
    }
    const missing = missingIndexes.length;

    if (!missing) {
      this.audit(pointer, `verify "${form.name}"`, { observed: `all ${form.fields.length} field(s) read back`, verification: 'pass' });
      return true;
    }

    // Work out why, field by field, before spending a person's attention or a
    // rebuild on any of them.
    const diagnoses = new Map<number, Diagnosis>();
    for (const xi of missingIndexes) {
      const field = form.fields[xi]!;
      const fieldPointer = irPointer.field(vi, fi, xi);
      const evidence = this.evidenceForReadBack(field, fieldPointer, labels, seen);
      const diagnosis = await this.diagnostician.diagnose(evidence, {
        before: this.beforeCommit?.reading ?? this.designer.readCanvas(snapshot),
        after: this.designer.readCanvas(snapshot),
        spec: specOf(field),
      });
      diagnoses.set(xi, diagnosis);
      this.fieldEvidence.set(fieldPointer, evidence);

      this.mark(fieldPointer, 'failed', describeCause(diagnosis.cause));
      this.audit(fieldPointer, `verify "${field.label}"`, {
        level: 'error',
        observed: `the field is not on the form after saving — ${describeCause(diagnosis.cause)}: ${diagnosis.why}`,
        confidence: diagnosis.confidence,
        verification: 'fail',
        diagnosis: {
          cause: diagnosis.cause,
          confidence: diagnosis.confidence,
          source: diagnosis.source,
          why: diagnosis.why,
          ...(diagnosis.modelProposal ? { modelProposal: diagnosis.modelProposal } : {}),
        },
      });
    }

    // Fields the read-back cannot see, but which the evidence says are there.
    // Rebuilding these is not a repair, it is a duplicate.
    const blind = missingIndexes.filter((xi) => !retryIsWorthwhile(diagnoses.get(xi)!.cause));
    const rebuildable = missingIndexes.filter((xi) => !blind.includes(xi));

    const causes = [...new Set(missingIndexes.map((xi) => describeCause(diagnoses.get(xi)!.cause)))];
    this.log(`${missing} field(s) are missing from "${form.name}" after saving — ${causes.join('; ')}.`, 'error');

    const examples = missingIndexes
      .slice(0, 3)
      .map((xi) => `"${form.fields[xi]!.label}": ${diagnoses.get(xi)!.why}`)
      .join(' ');

    const resolution = await this.gate.raise({
      id: `missing:${pointer}:${attempt}`,
      kind: 'missing_after_readback',
      question: `${missing} field(s) are missing from "${form.name}" after saving — ${causes.join('; ')}. How should this be handled?`,
      reason:
        'They were built, but reading the saved form back does not show them. ' +
        `Diagnosed as: ${causes.join('; ')}. ` +
        (blind.length
          ? `${blind.length} of them look present and merely unreadable, so building those again would duplicate them. `
          : '') +
        examples,
      consequence:
        'A missing field is the most costly failure here: nobody notices until data collection has already started, by which point the study is live.',
      affectedCount: missing,
      affected: missingIndexes.map((xi) => irPointer.field(vi, fi, xi)),
      options: [
        {
          id: 'rebuild',
          label: rebuildable.length === missing
            ? 'Build the missing fields again'
            : `Build the ${rebuildable.length} genuinely missing field(s) again, and leave the rest`,
          confidence: rebuildable.length ? 0.6 : 0.1,
          agreements: [],
          conflicts: blind.length ? [`${blind.length} field(s) appear to be there already`] : [],
        },
        { id: 'accept', label: 'Leave it and flag the form in the report', confidence: 0.1, agreements: [], conflicts: [] },
      ],
      allowsManual: true,
      createdAt: Date.now(),
    });

    // One retry, not a loop, and only over the fields a rebuild could help. If
    // building them a second time does not make them survive a save, the cause
    // is not the attempt — it is the platform or the form — and asking a person
    // to watch it fail again wastes the one thing the gate is spending, which
    // is their attention.
    if (attempt === 0 && resolution.choice === 'option' && resolution.optionId === 'rebuild' && rebuildable.length) {
      this.log(`Building the ${rebuildable.length} missing field(s) of "${form.name}" again, as asked.`);

      // Whatever DID read back is this form's context for the rebuild, so a
      // name landing in one of their editors is still caught.
      this.builtInForm = form.fields
        .map((f, xi) => ({ label: f.label, pointer: irPointer.field(vi, fi, xi), xi }))
        .filter((e) => !missingIndexes.includes(e.xi))
        .map((e) => ({ label: e.label, pointer: e.pointer }));

      for (const xi of rebuildable) {
        if (this.store.aborted) break;
        const field = form.fields[xi]!;
        const fieldPointer = irPointer.field(vi, fi, xi);
        this.mark(fieldPointer, 'running');
        const built = await this.buildFieldWithRetry(field, fieldPointer);
        this.settle(fieldPointer, built ? 'built' : 'failed');
        if (built) this.builtInForm.push({ label: field.label, pointer: fieldPointer });
      }

      await this.noteCanvasBeforeCommit(form, vi, fi);
      await this.commit(pointer, form);
      this.store.state.counters.repaired += rebuildable.length;
      return this.verifyForm(visit, form, vi, fi, pointer, attempt + 1);
    }

    // "I'll do it by hand" is checked, not believed: read the form back once
    // more and let what is on screen decide.
    if (attempt === 0 && resolution.choice === 'manual') {
      return this.verifyForm(visit, form, vi, fi, pointer, attempt + 1);
    }

    return false;
  }

  /**
   * Everything known about a field that did not read back.
   *
   * The rule itself lives in `diagnose.ts` so that the classifier, the tests
   * and this one caller cannot drift apart.
   */
  private evidenceForReadBack(
    field: IrField,
    fieldPointer: string,
    labels: string[],
    seen: { canvasEntries: string[]; visible: string[] },
  ): FieldAttemptEvidence {
    const prior =
      this.fieldEvidence.get(fieldPointer) ??
      emptyFieldEvidence(field.label, field.type, this.libraryNameFor(field.type), 1);

    return mergeReadBackEvidence(prior, {
      label: field.label,
      allLabels: labels,
      beforeCommit: this.beforeCommit
        ? { canvasEntries: this.beforeCommit.reading.canvasEntries, visible: this.beforeCommit.visible }
        : null,
      afterCommit: seen,
    });
  }

  // ── escalation helpers ──────────────────────────────────────────────────────

  /**
   * Ground an intent; if that fails, ask a person — and then USE the answer.
   *
   * A reviewer naming a control is the strongest evidence about this platform
   * the agent will ever get, so it is written into the profile exactly like a
   * grounding the agent worked out for itself. That is also what stops the
   * same question being asked once per visit: answered on the first screen, it
   * is remembered for the rest of the run.
   *
   * A null return means no control was named — the reviewer either did it by
   * hand or skipped. Neither is taken on trust: the caller re-reads the page
   * and decides from what is actually there, which is the same standard every
   * other step in this file is held to.
   */
  /**
   * Answers a reviewer gave that named no control, kept per intent for the run.
   * A named control needs no memo here — the grounder itself remembers it.
   */
  private declinedGroundings = new Map<string, EscalationResolution>();

  private async groundOrAsk(
    snapshot: Snapshot,
    intent: Intent,
    pointer: string,
    what: string,
  ): Promise<Grounded | null> {
    const found = await this.grounder.ground(snapshot, intent);
    if (found.ok) return found;

    // Asked and answered. A reviewer who declined to name this control once is
    // not helped by being asked again on the next visit in the same words — and
    // when they DID name one, the grounder remembers it, so this never runs.
    const already = this.declinedGroundings.get(intent.id);
    if (already) {
      this.audit(pointer, `${what}: a reviewer's earlier answer for this control applies here too`, {
        humanDecision: already.choice === 'manual' ? 'handled by hand' : 'skipped',
        observed: found.reason,
        level: 'warn',
      });
      return null;
    }

    const resolution = await this.gate.raise({
      id: `ground:${intent.id}`,
      kind: 'grounding_failed',
      question: `Which control on this screen is used to ${what}?`,
      reason: found.reason,
      consequence: 'The build cannot continue past this point without it.',
      affectedCount: 1,
      affected: [pointer],
      options: found.candidates.map((c) => ({
        id: `${c.node.ref}`,
        label: `${c.node.name || '(unnamed)'} — ${c.node.role}`,
        confidence: c.score,
        agreements: [],
        conflicts: [],
      })),
      allowsManual: true,
      createdAt: Date.now(),
    });

    const adopted = this.adoptChosenControl(resolution, snapshot, intent, pointer, what);
    if (!adopted) this.declinedGroundings.set(intent.id, resolution);
    return adopted;
  }

  /**
   * Decide an escalated step by looking, not by taking the answer on trust.
   *
   * "I'll do it by hand" and "Skip" arrive here the same way, and they are told
   * apart the only way that is safe on a platform the agent does not know: read
   * the page back and see whether the thing is there. A reviewer who really did
   * create it by hand passes; a note saying so without the work does not.
   */
  private async settleByReadBack(
    pointer: string,
    what: string,
    exists: (snapshot: Snapshot) => boolean,
  ): Promise<boolean> {
    const there = exists(await this.page.capture());
    this.audit(pointer, `read ${what} back after a reviewer handled it at the gate`, {
      observed: there ? 'it is there' : 'it is still not there',
      verification: there ? 'pass' : 'fail',
      level: there ? 'info' : 'warn',
    });
    this.mark(pointer, there ? 'built' : 'escalated', there ? 'done by hand' : 'left for a person');
    return there;
  }

  /** Turn a reviewer's pick into a grounding, and remember it. */
  private adoptChosenControl(
    resolution: EscalationResolution,
    snapshot: Snapshot,
    intent: Intent,
    pointer: string,
    what: string,
  ): Grounded | null {
    if (resolution.choice !== 'option' || !resolution.optionId) return null;

    const ref = Number(resolution.optionId);
    const node = snapshot.nodes.find((n) => n.ref === ref);
    if (!node) {
      this.log(`The control a reviewer chose to ${what} is no longer on screen; re-reading instead.`, 'warn');
      return null;
    }

    this.grounder.remember(intent.id, node, 1, 'human', `a reviewer identified this as the way to ${what}`);
    this.audit(pointer, `a reviewer identified the control used to ${what}`, {
      chose: { role: node.role, name: node.name },
      rationale: 'named at the human gate, and remembered for the rest of the run',
      confidence: 1,
    });
    return { ref: node.ref, node, confidence: 1, rationale: `named by a reviewer`, source: 'human', alternatives: [] };
  }
}

/**
 * The field as the specification states it, for a question put to the model.
 *
 * Canonical domain vocabulary only — this describes what is WANTED, never what
 * any platform calls it.
 */
function specOf(field: IrField): Record<string, string> {
  const spec: Record<string, string> = { label: field.label, type: field.type, required: String(Boolean(field.required)) };
  if (field.min !== undefined) spec['minimum'] = String(field.min);
  if (field.max !== undefined) spec['maximum'] = String(field.max);
  if (field.units) spec['units'] = field.units;
  if (field.formula) spec['formula'] = field.formula;
  if (field.options?.length) spec['coded values'] = String(field.options.length);
  if (field.skip_logic) spec['shown when'] = `${field.skip_logic.when_field_label} is ${field.skip_logic.equals_value}`;
  return spec;
}

/** What actually happened during an attempt, in one line, for the audit log. */
function describeAttempt(evidence: FieldAttemptEvidence): string {
  const said = (name: string, value: boolean | null) => (value === null ? '' : `${name}: ${value ? 'yes' : 'no'}`);
  const parts = [
    said('element appeared', evidence.elementAppeared),
    said('editor on the new element', evidence.labelEditorOnSelection),
    said('label read back', evidence.labelWriteAccepted),
    said('label on the canvas', evidence.addedElementShowsLabel),
    said('type as expected', evidence.typeMatches),
    ...evidence.notes,
  ].filter(Boolean);
  return parts.join('; ');
}
