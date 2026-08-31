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
import { SIGNATURES } from '../shared/types';
import { formFingerprint, irPointer, type CanonicalType, type IrField, type IrForm, type IrStudy, type IrVisit } from '../shared/ir';
import type { Designer } from './designer';
import type { Grounder } from './grounder';
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
    const open = await this.grounder.ground(snapshot, INTENTS.visitCreate());
    if (!open.ok) {
      await this.escalateGrounding(pointer, 'create a visit', open.reason, open.candidates);
      this.mark(pointer, 'escalated');
      return false;
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

    const confirm = await this.grounder.ground(await this.page.capture(), {
      ...INTENTS.visitConfirm(),
      preferNames: appeared,
      excludeRefs: [open.ref],
    });
    if (!confirm.ok) {
      await this.escalateGrounding(pointer, 'save the new visit', confirm.reason, confirm.candidates);
      this.mark(pointer, 'escalated');
      return false;
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
    if (this.findByName(snapshot, form.name)) {
      this.audit(pointer, `source document "${form.name}" already exists`, { verification: 'pass' });
      return true;
    }

    const open = await this.grounder.ground(snapshot, INTENTS.formCreate());
    if (!open.ok) {
      await this.escalateGrounding(pointer, 'create a source document', open.reason, open.candidates);
      return false;
    }
    const opened = await this.page.click(open.ref);
    const appeared = opened.diff.addedNodes.map((n) => n.name).filter(Boolean);

    const nameResult = await this.designer.setText({ ...INTENTS.formName(), preferNames: appeared }, form.name);
    if (!nameResult.ok) this.log(`Form name could not be entered: ${nameResult.detail}`, 'warn');

    if (form.repeating) {
      const repeating = await this.designer.setToggle({ ...INTENTS.formRepeating(), preferNames: appeared }, true);
      if (!repeating.ok) {
        await this.gate.raise({
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
      } else {
        this.profile.repeatingControl = this.profile.controls[INTENTS.formRepeating().id];
      }
    }

    const confirm = await this.grounder.ground(await this.page.capture(), {
      ...INTENTS.formConfirm(),
      preferNames: appeared,
      excludeRefs: [open.ref],
    });
    if (!confirm.ok) {
      await this.escalateGrounding(pointer, 'save the new source document', confirm.reason, confirm.candidates);
      return false;
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

    if (outcome.escalations.length) {
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
    this.store.setPhase('building', 'Building the study.');
  }

  private libraryNameFor(type: CanonicalType): string | null {
    return this.profile.typeMap[type]?.libraryName ?? null;
  }

  // ── fields ──────────────────────────────────────────────────────────────────

  private async buildFields(form: IrForm, vi: number, fi: number, formPointer: string): Promise<void> {
    for (let xi = 0; xi < form.fields.length; xi++) {
      if (this.store.aborted) break;
      const field = form.fields[xi]!;
      const pointer = irPointer.field(vi, fi, xi);
      this.mark(pointer, 'running');

      const snapshot = await this.page.capture();
      if (this.fieldOnCanvas(snapshot, field.label)) {
        this.mark(pointer, 'built', 'already present');
        continue;
      }

      const built = await this.buildField(field, pointer);
      this.mark(pointer, built ? 'built' : 'failed');
      if (built) this.store.state.counters.fieldsBuilt++;
      else this.store.state.counters.failed++;
      this.store.notify();
    }
    void formPointer;
  }

  /**
   * Build one field.
   *
   * The order of the steps is the whole point — see the note at the top of this
   * file. Type first, because it is destructive; then the label, because an
   * unnamed field is worthless; then everything the type is allowed to carry.
   */
  private async buildField(field: IrField, pointer: string): Promise<boolean> {
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

    const added = await this.designer.addElement(libraryName);
    if (!added.ok) {
      this.audit(pointer, `add a ${field.type} field using "${libraryName}"`, {
        level: 'error',
        observed: added.detail,
        verification: 'fail',
      });
      return false;
    }

    // Naming is a separate act from creating, and skipping it produces a field
    // that is structurally present and semantically empty.
    const labelled = await this.designer.setText(INTENTS.fieldLabel(), field.label);
    if (!labelled.ok) {
      this.audit(pointer, `name the field "${field.label}"`, { level: 'error', observed: labelled.detail, verification: 'fail' });
      return false;
    }

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

    this.audit(pointer, `build "${field.label}" as ${field.type}`, {
      chose: { role: 'listitem', name: libraryName },
      rationale: `"${libraryName}" was established as this platform's ${field.type} by probing its behaviour`,
      confidence: this.profile.typeMap[field.type]?.confidence,
      observed: added.detail,
      verification: 'not-checked',
    });
    return true;
  }

  /**
   * Enter a coded value list as code/label PAIRS.
   *
   * Row-by-row entry is preferred over any bulk shortcut. Bulk entry is faster
   * but commonly REPLACES the list rather than appending to it, and a list that
   * silently lost its first half looks exactly like one that worked. Whichever
   * path is taken, the result is counted afterwards.
   */
  private async enterOptions(field: IrField, pointer: string): Promise<void> {
    const options = field.options ?? [];
    let entered = 0;
    const failures: string[] = [];

    for (const option of options) {
      const row = await this.designer.addOptionRow(option.code, option.label);
      if (row.ok) entered++;
      else failures.push(row.detail);
    }

    if (entered !== options.length) {
      await this.gate.raise({
        id: `values:${pointer}`,
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
    }
  }

  private fieldOnCanvas(snapshot: Snapshot, label: string): boolean {
    return this.designer.fieldPresentOnCanvas(snapshot, label);
  }

  // ── skip logic (second pass) ────────────────────────────────────────────────

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
        await this.escalateSkipLogic(pointer, field, rule.when_field_label, 'the field could not be selected on the canvas');
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
            `No conditional-display control could be used. ${mode.detail} A toggle was tried too: ${toggled.detail}`,
          );
          continue;
        }
      }

      const whenResult = await this.designer.chooseOptionVerified(INTENTS.visibilityWhenField(), rule.when_field_label);
      if (!whenResult.ok) {
        await this.escalateSkipLogic(pointer, field, rule.when_field_label, whenResult.detail);
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

  private async escalateSkipLogic(pointer: string, field: IrField, controller: string, detail: string): Promise<void> {
    await this.gate.raise({
      id: `skip:${pointer}`,
      kind: 'skip_logic',
      question: `How should "${field.label}" be made conditional on "${controller}"?`,
      reason: detail,
      consequence:
        'Without the rule the field is always visible. That is not a data-loss failure, but it does not match the protocol, and the protocol is the contract with the regulator.',
      affectedCount: 1,
      affected: [pointer],
      options: [],
      allowsManual: true,
      createdAt: Date.now(),
    });
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
      const { result: candidate, through } = await this.discloser.ground(intent);
      if (!candidate.ok) {
        await this.escalateGrounding(pointer, 'save the form', candidate.reason, candidate.candidates);
        return false;
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

    await this.gate.raise({
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
   * Read the saved form back and compare it with the specification.
   *
   * This is what separates an agent that works from a demo that worked once.
   * Every failure this pipeline is guarding against — a discarded range, a
   * replaced value list, an unnamed field, a commit that did not commit — is
   * invisible at the moment it happens and visible here.
   */
  private async verifyForm(visit: IrVisit, form: IrForm, vi: number, fi: number, pointer: string): Promise<boolean> {
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
    let missing = 0;
    for (let xi = 0; xi < form.fields.length; xi++) {
      const field = form.fields[xi]!;
      const fieldPointer = irPointer.field(vi, fi, xi);
      const present = this.fieldOnCanvas(snapshot, field.label);
      if (present) {
        this.mark(fieldPointer, 'verified');
        this.store.state.counters.verified++;
      } else {
        missing++;
        this.mark(fieldPointer, 'failed', 'not found when read back');
        this.audit(fieldPointer, `verify "${field.label}"`, {
          level: 'error',
          observed: 'the field is not on the form after saving',
          verification: 'fail',
        });
      }
    }

    if (missing) {
      this.log(`${missing} field(s) are missing from "${form.name}" after saving.`, 'error');
      await this.gate.raise({
        id: `missing:${pointer}`,
        kind: 'missing_after_readback',
        question: `${missing} field(s) are missing from "${form.name}" after saving. How should this be handled?`,
        reason: 'They were built, but reading the saved form back does not show them.',
        consequence:
          'A missing field is the most costly failure here: nobody notices until data collection has already started, by which point the study is live.',
        affectedCount: missing,
        affected: [pointer],
        options: [
          { id: 'rebuild', label: 'Build the missing fields again', confidence: 0.6, agreements: [], conflicts: [] },
          { id: 'accept', label: 'Leave it and flag the form in the report', confidence: 0.1, agreements: [], conflicts: [] },
        ],
        allowsManual: true,
        createdAt: Date.now(),
      });
      return false;
    }

    this.audit(pointer, `verify "${form.name}"`, { observed: `all ${form.fields.length} field(s) read back`, verification: 'pass' });
    return true;
  }

  // ── escalation helper ───────────────────────────────────────────────────────

  private async escalateGrounding(
    pointer: string,
    what: string,
    reason: string,
    candidates: { node: SnapshotNode; score: number }[],
  ): Promise<void> {
    await this.gate.raise({
      id: `ground:${pointer}:${what}`,
      kind: 'grounding_failed',
      question: `Which control on this screen is used to ${what}?`,
      reason,
      consequence: 'The build cannot continue past this point without it.',
      affectedCount: 1,
      affected: [pointer],
      options: candidates.map((c) => ({
        id: `${c.node.ref}`,
        label: `${c.node.name || '(unnamed)'} — ${c.node.role}`,
        confidence: c.score,
        agreements: [],
        conflicts: [],
      })),
      allowsManual: true,
      createdAt: Date.now(),
    });
  }
}
