/**
 * Working inside a form designer, whatever one looks like.
 *
 * This is the layer that knows the SHAPE of the job — there is a palette of
 * field types, a canvas holding what you have built, and a property editor for
 * whatever is selected — without knowing anything about a particular product's
 * rendering of that shape.
 *
 * The single most valuable thing in here is `probeEntry`. Rather than guessing
 * from a name what a library entry means, it builds one, watches what the
 * platform then offers, deletes it, and reports what it saw. Behaviour is the
 * same on every eSource; vocabulary is not.
 */

import { INTENTS } from './intents';
import { nameSimilarity } from './grounder';
import { rippledBeyond } from '../shared/diff';
import { emptyObservation } from '../shared/types';
import type { Grounder, Intent } from './grounder';
import type { Observation, PageLike } from './page';
import type { ObservedBehaviour, ValueKind } from '../shared/types';
import type { Ref, Snapshot, SnapshotNode } from '../shared/snapshot';
import type { Store } from './store';

/** Roles that represent a data-entry control rendered on a canvas. */
const CONTROL_ROLES = new Set([
  'textbox', 'spinbutton', 'searchbox', 'checkbox', 'radio', 'switch', 'combobox', 'listbox', 'option',
]);

export interface PaletteEntry {
  name: string;
  ref: Ref;
}

export interface ProbeResult {
  observation: ObservedBehaviour;
  /** Whether the probe element could be cleaned up afterwards. */
  cleanedUp: boolean;
  /** Anything worth telling a human about how the probe went. */
  notes: string[];
}

export class Designer {
  constructor(
    private page: PageLike,
    private grounder: Grounder,
    private store: Store,
    private log: (message: string, level?: 'info' | 'warn' | 'error') => void,
  ) {}

  private get profile() {
    return this.store.profile!;
  }

  // ── the palette ─────────────────────────────────────────────────────────────

  /**
   * The list of field types this platform offers, in the words it uses.
   *
   * Discovered once from the shape of the page, then remembered by NAME, which
   * is stable across re-renders in a way that region ids and refs are not.
   */
  async paletteEntries(snapshot?: Snapshot): Promise<PaletteEntry[]> {
    const snap = snapshot ?? (await this.page.current());

    const remembered = this.profile.libraryEntries;
    if (remembered.length) {
      const found: PaletteEntry[] = [];
      for (const name of remembered) {
        const node = snap.nodes.find((n) => n.name === name && this.looksActivatable(n));
        if (node) found.push({ name, ref: node.ref });
      }
      // Tolerate a couple of entries being filtered out of view; re-discover if
      // the remembered list has clearly stopped describing this screen.
      if (found.length >= Math.ceil(remembered.length * 0.6)) return found;
    }

    const discovered = this.discoverPalette(snap);
    if (discovered.length) {
      const names = discovered.map((e) => e.name);
      const changed = names.join('|') !== remembered.join('|');
      this.profile.libraryEntries = names;
      // Only worth saying when the answer actually changed. This method is also
      // how the agent asks "am I in a form designer?", so it runs on every
      // screen, and announcing a rediscovery each time buries the real events.
      if (changed) this.log(`Element library discovered with ${names.length} entries: ${names.join(', ')}`);
    }
    return discovered;
  }

  private looksActivatable(node: SnapshotNode): boolean {
    return (
      (node.role === 'button' || node.role === 'listitem' || node.role === 'option' || node.role === 'link' || node.role === 'menuitem') &&
      !node.state.disabled
    );
  }

  /**
   * Find the palette by shape: the cluster of many structurally-similar
   * activatable items that is not the toolbar and not a table of built things.
   */
  private discoverPalette(snapshot: Snapshot): PaletteEntry[] {
    const candidates = snapshot.regions
      .filter((r) => r.kind === 'palette')
      .sort((a, b) => b.confidence * b.members.length - a.confidence * a.members.length);

    // The fallback is deliberately stricter than the classifier, not looser: it
    // only runs when nothing was confidently classified, and accepting the
    // wrong cluster here is expensive. A wrong palette does not merely fail —
    // it makes "am I in a form designer?" answer yes on the wrong screen, and
    // every later judgement inherits that mistake.
    const MIN_CONFIDENT = 5;
    const MIN_FALLBACK = 8;

    const regions = candidates.length
      ? candidates
      : snapshot.regions
          .filter((r) => r.kind !== 'toolbar' && r.kind !== 'navigation' && r.members.length >= MIN_FALLBACK)
          .sort((a, b) => b.members.length - a.members.length);
    const minimum = candidates.length ? MIN_CONFIDENT : MIN_FALLBACK;

    for (const region of regions) {
      const nodes = region.members
        .map((ref) => snapshot.nodes.find((n) => n.ref === ref))
        .filter((n): n is SnapshotNode => Boolean(n))
        .filter((n) => this.looksActivatable(n) && n.name.length > 0 && n.name.length <= 40);

      // A palette's entries are distinct from one another and there are several.
      const names = new Set(nodes.map((n) => n.name));
      if (names.size >= minimum && names.size >= nodes.length * 0.9) {
        return nodes.map((n) => ({ name: n.name, ref: n.ref }));
      }
    }
    return [];
  }

  // ── building and removing an element ────────────────────────────────────────

  /**
   * Add one field of the given library type to the form under construction.
   *
   * A click is tried first because it is far more reliable to synthesise than a
   * drag; a drag onto the canvas is the fallback for palettes that only support
   * dragging. Success is judged by what changed on the page, never by the click
   * having been accepted.
   */
  async addElement(entryName: string): Promise<{ ok: boolean; observation: Observation | null; detail: string }> {
    const snapshot = await this.page.capture();
    const entries = await this.paletteEntries(snapshot);
    const entry = entries.find((e) => e.name === entryName);
    if (!entry) {
      return { ok: false, observation: null, detail: `The element library has no entry named "${entryName}" on this screen.` };
    }

    const observation = await this.page.click(entry.ref);
    if (this.elementWasAdded(observation)) return { ok: true, observation, detail: 'added by clicking the library entry' };

    // Fallback: drag the entry onto whatever looks like the canvas.
    const canvasRegion = this.canvasRegion(observation.after);
    if (canvasRegion) {
      const target = canvasRegion.members[0];
      if (target !== undefined) {
        const dragged = await this.page.act({ kind: 'drag', sourceRef: entry.ref, targetRef: target });
        if (this.elementWasAdded(dragged)) return { ok: true, observation: dragged, detail: 'added by dragging onto the canvas' };
      }
    }

    return {
      ok: false,
      observation,
      detail: `Clicking "${entryName}" did not add anything to the form (${observation.diff.magnitude} change(s) observed).`,
    };
  }

  /**
   * Did a field actually appear?
   *
   * Judged by the property editor coming alive, or by new controls appearing
   * outside the palette — both of which are what happens on any designer when a
   * field is created and selected.
   */
  private elementWasAdded(observation: Observation): boolean {
    const { diff, after } = observation;
    if (!diff.addedNodes.length && !diff.changed.length) return false;

    const paletteRegions = new Set(after.regions.filter((r) => r.kind === 'palette').map((r) => r.id));
    const outsidePalette = diff.addedNodes.filter((n) => !paletteRegions.has(n.region));
    if (outsidePalette.length >= 1) return true;

    // Some designers reuse an always-present property panel; a burst of value
    // changes in an editor region is the same evidence.
    const editorRegions = new Set(after.regions.filter((r) => r.kind === 'editor').map((r) => r.id));
    return diff.changed.length >= 2 && after.regions.some((r) => editorRegions.has(r.id));
  }

  async deleteSelected(): Promise<boolean> {
    const snapshot = await this.page.capture();
    const result = await this.grounder.ground(snapshot, INTENTS.fieldDelete());
    if (!result.ok) return false;
    const observation = await this.page.click(result.ref);
    return observation.diff.removedNames.length > 0 || observation.diff.magnitude > 0;
  }

  // ── the canvas ──────────────────────────────────────────────────────────────

  /**
   * Where a built field could be showing.
   *
   * Only the palette and the application chrome are ruled out, and both are
   * classified from shape rather than appearance. Nothing is excluded for
   * "looking like an editor": a designer canvas is full of inert previews of
   * the fields being built, so it looks exactly like a panel of inputs, and
   * excluding panels of inputs leaves the agent unable to see anything it has
   * made.
   *
   * The property editor is left in deliberately. Its controls are named after
   * PROPERTIES — "Label", "Code", "Minimum" — never after the field being
   * edited, so matching a field by its own label cannot collide with them.
   * Palette entries are excluded precisely because they can: a field labelled
   * "Date" would otherwise match the palette's "Date" button.
   */
  canvasRegionIds(snapshot: Snapshot): Set<number> {
    const ids = new Set<number>();
    for (const region of snapshot.regions) {
      if (region.kind === 'palette' || region.kind === 'toolbar' || region.kind === 'navigation') continue;
      ids.add(region.id);
    }
    return ids;
  }

  /**
   * The control on the canvas that represents a field with this label.
   *
   * Matched on the label being the whole name or its leading part, because a
   * choice field renders one control per option, each named "<field>: <choice>".
   * Substring matching anywhere in the name would let a field called "Date"
   * match "Date of Birth".
   */
  fieldOnCanvas(snapshot: Snapshot, label: string): SnapshotNode | undefined {
    const canvas = this.canvasRegionIds(snapshot);
    return snapshot.nodes
      .filter(
        (n) =>
          canvas.has(n.region) &&
          (n.name === label || n.name.startsWith(`${label}:`) || n.name.startsWith(`${label} `)),
      )
      .sort((a, b) => a.name.length - b.name.length)[0];
  }

  /**
   * Is a field with this label present on the canvas at all?
   *
   * Broader than `fieldOnCanvas` on purpose. Some field types render previews
   * that carry no accessible name — a yes/no field draws two buttons reading
   * "Yes" and "No" — so the only trace of the field is the label printed beside
   * them. Reporting such a field missing would be the worst kind of error here:
   * recall matters more than precision, and a form that quietly lost a field is
   * not noticed until data collection has already started.
   */
  fieldPresentOnCanvas(snapshot: Snapshot, label: string): boolean {
    if (this.fieldOnCanvas(snapshot, label)) return true;
    const canvas = this.canvasRegionIds(snapshot);
    return snapshot.regions.some((r) => canvas.has(r.id) && r.texts.some((t) => t === label || t.startsWith(`${label} `)));
  }

  /**
   * Select a field on the canvas so the property editor shows it.
   *
   * Clicking the preview control works even though the preview itself is inert,
   * because the click bubbles to whatever wraps it — which is how a person
   * selects a field too. If nothing changes, the click landed somewhere with no
   * handler and the caller is told so rather than left assuming.
   */
  async selectFieldOnCanvas(label: string): Promise<boolean> {
    const snapshot = await this.page.capture();
    const node = this.fieldOnCanvas(snapshot, label);
    if (!node) return false;
    const observation = await this.page.click(node.ref);
    return observation.diff.magnitude > 0;
  }

  // ── properties ──────────────────────────────────────────────────────────────

  /**
   * Is there a control on this screen that satisfies the intent at all?
   *
   * Used to ask a platform what a field type is allowed to carry, so a false
   * positive here mismaps a type. The bar is therefore not just a score — a
   * control also has to be NAMED like the thing being looked for. Role and
   * position alone can push an unrelated input over a score threshold, and
   * "there is a formula box because some text input sits in the right panel"
   * is exactly the kind of inference that produces a confident wrong answer.
   */
  async has(intent: Intent, snapshot?: Snapshot): Promise<boolean> {
    const snap = snapshot ?? (await this.page.current());
    const ranked = this.grounder.rank(snap, { ...intent, ignoreMemory: true });
    const top = ranked[0];
    if (!top || top.score < (intent.threshold ?? 0.55)) return false;
    return top.why.some((reason) => reason.includes("matches the intent's vocabulary"));
  }

  /**
   * Set a text property, then confirm the control actually took the value.
   *
   * The read-back is not paranoia. A designer canvas typically renders inert
   * previews of the fields being built — real inputs, with real accessible
   * names, that accept keystrokes and persist nothing. Writing into one looks
   * exactly like success until the form is saved and the value is not there.
   */
  async setText(intent: Intent, value: string): Promise<{ ok: boolean; detail: string; live: boolean }> {
    const snapshot = await this.page.capture();
    const result = await this.grounder.ground(snapshot, intent);
    if (!result.ok) return { ok: false, detail: result.reason, live: false };

    const observation = await this.page.setText(result.ref, value);
    const live = rippledBeyond(observation.diff, result.node.name);

    const readBack = await this.page.read(result.ref);
    const took = readBack?.value === value;
    if (!took) {
      return {
        ok: false,
        detail: `Wrote "${value}" into "${result.node.name}" but it now reads "${readBack?.value ?? '(gone)'}".`,
        live,
      };
    }
    return { ok: true, detail: observation.detail, live };
  }

  async setToggle(intent: Intent, desired: boolean): Promise<{ ok: boolean; detail: string }> {
    const snapshot = await this.page.capture();
    const result = await this.grounder.ground(snapshot, intent);
    if (!result.ok) return { ok: false, detail: result.reason };

    await this.page.setToggle(result.ref, desired);
    const readBack = await this.page.read(result.ref);
    if (readBack?.checked === null || readBack?.checked === undefined) {
      return { ok: true, detail: `Set "${result.node.name}"; the control does not report its state, so this is unverified.` };
    }
    return readBack.checked === desired
      ? { ok: true, detail: `"${result.node.name}" is ${desired ? 'on' : 'off'}.` }
      : { ok: false, detail: `"${result.node.name}" did not change to ${desired ? 'on' : 'off'}.` };
  }

  /**
   * Choose an option, trying each plausible control until one demonstrably
   * takes the value.
   *
   * The escalation rule this embodies is worth stating: a human should be asked
   * about decisions that are IRREVERSIBLE or UNVERIFIABLE, not about decisions
   * that are cheap to test. Which of two controls sets a field's conditional
   * display is a near-tie the agent cannot settle by reading names — but it can
   * settle it by setting one and reading it back, and if the guess was wrong
   * nothing is lost but a click.
   *
   * Choosing a field's TYPE gets the opposite treatment, because that one is
   * destructive: setting it wrong discards coded values and ranges silently.
   * Reversibility, not confidence, decides which questions reach the reviewer,
   * and that is what keeps the queue short enough to be worth clearing.
   */
  async chooseOptionVerified(
    intent: Intent,
    wanted: string,
  ): Promise<{ ok: boolean; detail: string; tried: { name: string; score: number }[] }> {
    const snapshot = await this.page.capture();
    const candidates = this.grounder
      .rank(snapshot, { ...intent, ignoreMemory: true })
      .filter((c) => c.score >= 0.5)
      .slice(0, 3);

    const tried: { name: string; score: number }[] = [];
    for (const candidate of candidates) {
      tried.push({ name: candidate.node.name, score: candidate.score });
      await this.page.chooseOption(candidate.node.ref, wanted);

      const readBack = await this.page.read(candidate.node.ref);
      const value = (readBack?.value ?? '').toLowerCase();
      if (value && value.includes(wanted.toLowerCase())) {
        this.grounder.remember(intent.id, candidate.node, candidate.score, 'probe', `verified by reading "${readBack?.value}" back`);
        return { ok: true, detail: `"${candidate.node.name}" now reads "${readBack?.value}"`, tried };
      }
    }

    return {
      ok: false,
      detail: tried.length
        ? `Tried ${tried.map((t) => `"${t.name}"`).join(', ')}; none of them accepted "${wanted}".`
        : `Nothing on this screen looks like it could satisfy "${intent.goal}".`,
      tried,
    };
  }

  async chooseOption(intent: Intent, value: string): Promise<{ ok: boolean; detail: string }> {
    const snapshot = await this.page.capture();
    const result = await this.grounder.ground(snapshot, intent);
    if (!result.ok) return { ok: false, detail: result.reason };
    const observation = await this.page.chooseOption(result.ref, value);
    return { ok: observation.ok, detail: observation.detail };
  }

  // ── probing a library entry ─────────────────────────────────────────────────

  /**
   * Build one field of a candidate type and observe what the platform reveals.
   *
   * This is the answer to "how do you map canonical types onto an unknown
   * element library". A name tells you what a vendor decided to call something;
   * this tells you what it actually is. Two entries sitting one row apart with
   * near-identical names are separated cleanly here, because only one of them
   * offers a coded-value editor, and only one renders as a list.
   *
   * The probe is destructive by nature, so it runs in an empty form under
   * construction and deletes what it made. If cleanup fails that is reported
   * rather than hidden, since a stray field is a real (if lesser) defect.
   */
  async probeEntry(entryName: string): Promise<ProbeResult> {
    const cached = this.profile.probes[entryName];
    if (cached) return { observation: cached, cleanedUp: true, notes: ['reused an earlier probe of this entry'] };

    const notes: string[] = [];
    const observation = emptyObservation();
    const sentinel = `ZZProbe${Math.floor(Math.random() * 9000 + 1000)}`;

    // Remember what was on screen BEFORE the field existed. Everything the
    // field brings with it is then identifiable by subtraction, which is the
    // only way to find a designer's canvas that does not depend on the canvas
    // looking different from a property panel — and it does not, because it is
    // full of inert previews of the very controls being built.
    const before = await this.page.capture();
    const preExisting = new Set(before.nodes.map(nodeKey));

    const added = await this.addElement(entryName);
    if (!added.ok) {
      notes.push(added.detail);
      return { observation, cleanedUp: true, notes };
    }

    // Name it. This is not only to identify its rendering: adding a control and
    // naming it are separate acts on every designer, and a probe that skips the
    // second one is not exercising the same path a real field will take.
    const labelled = await this.setText(INTENTS.fieldLabel(), sentinel);
    if (!labelled.ok) notes.push(`Could not set a probe label: ${labelled.detail}`);

    // What does the property editor offer for this type?
    let snapshot = await this.page.capture();
    observation.offersOptionEditor =
      (await this.has(INTENTS.optionAdd(), snapshot)) || (await this.has(INTENTS.optionBulkInput(), snapshot));
    observation.offersRange =
      (await this.has(INTENTS.fieldMin(), snapshot)) && (await this.has(INTENTS.fieldMax(), snapshot));
    observation.offersFormula = await this.has(INTENTS.fieldFormula(), snapshot);
    observation.offersPrecision = await this.has(INTENTS.fieldPrecision(), snapshot);
    observation.offersTemporalOptions = await this.has(INTENTS.fieldTemporalOptions(), snapshot);

    // A choice control renders nothing informative until it has choices, so give
    // it two before looking at how it presents them.
    if (observation.offersOptionEditor) {
      const seeded = await this.seedProbeOptions();
      if (!seeded.ok) {
        notes.push(`The coded-value editor was present but two probe values could not be entered: ${seeded.detail}`);
      }
      snapshot = await this.page.capture();
    }

    this.readRendering(snapshot, preExisting, sentinel, observation, notes);

    const cleanedUp = await this.deleteSelected();
    if (!cleanedUp) notes.push(`The probe field "${sentinel}" could not be deleted and may still be on the form.`);

    this.profile.probes[entryName] = observation;
    return { observation, cleanedUp, notes };
  }

  /** Two throwaway coded values, enough to reveal how choices are presented. */
  private async seedProbeOptions(): Promise<{ ok: boolean; detail: string }> {
    let entered = 0;
    let detail = '';
    for (const [code, label] of [['P1', 'Probe One'], ['P2', 'Probe Two']] as const) {
      const row = await this.addOptionRow(code, label);
      if (!row.ok) {
        detail = row.detail;
        break;
      }
      entered++;
    }
    return { ok: entered >= 2, detail };
  }

  /**
   * Add one coded value and fill in both halves of it.
   *
   * The row to write into is the one that JUST APPEARED — identified from the
   * diff, not by taking the last of a ranked list. That distinction matters
   * more than it looks: a property panel typically has a field-level "Label"
   * input as well as a "Label" input per coded value, they are named
   * identically, and picking the wrong one overwrites the field's own name with
   * the text of its last option. The field then looks built and is mislabelled.
   */
  async addOptionRow(code: string, label: string): Promise<{ ok: boolean; detail: string }> {
    const snapshot = await this.page.capture();
    const add = await this.grounder.ground(snapshot, INTENTS.optionAdd());
    if (!add.ok) return { ok: false, detail: add.reason };

    const observation = await this.page.click(add.ref);
    const fresh = observation.diff.addedNodes.filter(
      (n) => n.role === 'textbox' || n.role === 'spinbutton' || n.role === 'searchbox',
    );
    if (fresh.length < 2) {
      return {
        ok: false,
        detail: `Adding a coded value produced ${fresh.length} new input(s); expected a code and a label.`,
      };
    }

    // Which of the new inputs is the code and which is the label? Decided by
    // what they are named; if the platform names neither, fall back to reading
    // order and say so, rather than silently assuming a convention.
    const scored = fresh.map((node) => ({
      node,
      codeScore: bestLexicalName(node.name, INTENTS.optionCode().lexicon),
      labelScore: bestLexicalName(node.name, INTENTS.optionLabel().lexicon),
    }));

    let codeNode = scored.slice().sort((a, b) => b.codeScore - a.codeScore)[0];
    let labelNode = scored.filter((s) => s.node !== codeNode?.node).sort((a, b) => b.labelScore - a.labelScore)[0];

    if (!codeNode || !labelNode || (codeNode.codeScore === 0 && labelNode.labelScore === 0)) {
      const ordered = fresh
        .slice()
        .sort((a, b) => (a.box?.y ?? 0) - (b.box?.y ?? 0) || (a.box?.x ?? 0) - (b.box?.x ?? 0));
      codeNode = { node: ordered[0]!, codeScore: 0, labelScore: 0 };
      labelNode = { node: ordered[1]!, codeScore: 0, labelScore: 0 };
    }

    await this.page.setText(codeNode.node.ref, code);
    await this.page.setText(labelNode.node.ref, label);

    // Read back by looking for the values on the page rather than through the
    // refs just written to. Entering a value can cause the editor to re-render,
    // which replaces the very elements those refs point at — so a ref-based
    // check reports a failure that did not happen, and, worse, would report
    // success if the platform had quietly moved the value somewhere else.
    const after = await this.page.capture();
    const values = after.nodes.map((n) => n.value ?? '');
    const ok = values.includes(code) && values.includes(label);
    return {
      ok,
      detail: ok
        ? `entered ${code} = ${label}`
        : `wrote ${code} = ${label} but neither value can be found on the page afterwards`,
    };
  }

  /**
   * Read how the built field renders, which is what separates the types that
   * names cannot.
   *
   * Finding the canvas is the subtle part. It cannot be done by excluding
   * whatever "looks like an editor", because a designer canvas is full of inert
   * preview inputs and therefore looks exactly like one — that resemblance is
   * the trap. So the property editor is identified positively, as the region
   * containing the control that just accepted the field's label, and the canvas
   * is what remains once that, the palette and the chrome are set aside.
   *
   * Every judgement stays `null` when it could not be observed. "Could not
   * tell" and "no" must never be conflated, because a false negative here
   * silently picks the wrong widget.
   */
  private readRendering(
    snapshot: Snapshot,
    preExisting: Set<string>,
    sentinel: string,
    out: ObservedBehaviour,
    notes: string[],
  ): void {
    const excluded = new Set<number>();
    for (const region of snapshot.regions) {
      if (region.kind === 'palette' || region.kind === 'toolbar' || region.kind === 'navigation') excluded.add(region.id);
    }

    // The property editor, found by where the label control lives.
    const labelRanked = this.grounder.rank(snapshot, { ...INTENTS.fieldLabel(), ignoreMemory: true });
    const labelNode = labelRanked[0] && labelRanked[0].score >= 0.5 ? labelRanked[0].node : undefined;
    if (labelNode) excluded.add(labelNode.region);
    else notes.push('The property editor could not be located, so the canvas was identified by elimination alone.');

    // Only what the field itself brought onto the page. Page tabs, palette
    // filters and every other permanent control were there beforehand and are
    // not part of how this field renders.
    let candidates = snapshot.nodes.filter((n) => !excluded.has(n.region) && !preExisting.has(nodeKey(n)));

    // Drop the card that wraps the field. Its accessible name is the run-together
    // text of everything inside it, so it swallows SEVERAL of the other names —
    // and it is never itself a form control.
    //
    // Both conditions are needed. Filtering anything that merely contains one
    // other name removes real choices, because a choice list names its options
    // "<field>: <choice>" and an option whose label has not yet rendered is a
    // prefix of the one that has.
    const names = candidates.map((n) => n.name).filter(Boolean);
    candidates = candidates.filter((n) => {
      if (CONTROL_ROLES.has(n.role)) return true;
      const swallowed = names.filter((other) => other !== n.name && other.length > 0 && n.name.includes(other)).length;
      return swallowed < 2;
    });

    const preferred = candidates.filter(
      (n) => n.name === sentinel || n.name.startsWith(`${sentinel}:`) || n.name.startsWith(`${sentinel} `),
    );
    const preview = preferred.length ? preferred : candidates;

    // Recorded so an escalation can show a reviewer what the agent actually saw
    // on the canvas, rather than only the conclusion it drew from it.
    notes.push(
      preview.length
        ? `canvas rendered: ${preview.map((n) => `${n.role} "${n.name}"`).join(', ')}`
        : 'canvas rendered nothing the agent could identify',
    );

    const radios = preview.filter((n) => n.role === 'radio');
    const checks = preview.filter((n) => n.role === 'checkbox' || n.role === 'switch');
    const combos = preview.filter((n) => n.role === 'combobox' || n.role === 'listbox');
    const texts = preview.filter((n) => n.role === 'textbox' || n.role === 'spinbutton' || n.role === 'searchbox');
    // A two-state control is very often a pair of plain buttons rather than a
    // native control — "Yes" and "No" side by side.
    const pills = preview.filter((n) => n.role === 'button' && n.name.length > 0 && n.name.length <= 24);

    if (combos.length) {
      out.rendersMultiSelect = Boolean(combos[0]!.state.multiSelectable);
      out.rendersExpandedChoices = false;
      out.rendersBinary = false;
      out.rendersValueKind = 'coded';
    } else if (checks.length >= 2) {
      out.rendersMultiSelect = true;
      out.rendersExpandedChoices = true;
      out.rendersBinary = false;
      out.rendersValueKind = 'coded';
    } else if (radios.length >= 2) {
      out.rendersMultiSelect = false;
      out.rendersExpandedChoices = true;
      out.rendersBinary = false;
      out.rendersValueKind = 'coded';
    } else if (checks.length === 1) {
      // A lone tick with no choice list is a single flag, not a list.
      out.rendersBinary = true;
      out.rendersBinaryShape = 'tick';
      out.rendersMultiSelect = false;
      out.rendersValueKind = 'binary';
    } else if (!texts.length && pills.length === 2) {
      out.rendersBinary = true;
      out.rendersBinaryShape = 'named-pair';
      out.rendersMultiSelect = false;
      out.rendersValueKind = 'binary';
    } else if (texts.length) {
      const text = texts[0]!;
      out.rendersBinary = false;
      out.rendersMultiline = Boolean(text.state.multiline);
      out.rendersReadOnly = Boolean(text.state.readOnly);
      out.rendersValueKind = valueKindFromControl(text.state.inputKind, text.state.formatHint);
    } else {
      notes.push('Could not find the field on the canvas, so how it renders is unknown.');
      return;
    }

    if (out.rendersMultiline === null && !texts.length) out.rendersMultiline = false;
    if (out.rendersReadOnly === null && !texts.length) out.rendersReadOnly = false;
  }

  /** Which region is the canvas, for drag fallbacks. */
  private canvasRegion(snapshot: Snapshot) {
    const excluded = new Set(['palette', 'editor', 'toolbar', 'navigation']);
    return snapshot.regions.find((r) => !excluded.has(r.kind) && r.members.length > 0);
  }
}

/**
 * Identity of a control across snapshots.
 *
 * Refs and region ids are per-snapshot; role plus accessible name is what
 * survives a re-render, which is exactly what is needed to ask "was this here
 * before?".
 */
function nodeKey(node: SnapshotNode): string {
  return `${node.role}|${node.name}`;
}

function bestLexicalName(name: string, lexicon: readonly string[]): number {
  let best = 0;
  for (const term of lexicon) best = Math.max(best, nameSimilarity(name, term));
  return best;
}

/**
 * What kind of value does this control hold?
 *
 * A native input type settles it outright. Failing that, many designers render
 * every preview as a plain text box and advertise the expected shape in a
 * placeholder — "DD-MMM-YYYY", "HH:MM" — which is then the only thing telling a
 * date from a time from free text. That hint is read here.
 *
 * Returning `null` is normal and safe: an unknown kind simply does not vote.
 */
function valueKindFromControl(inputKind: string | undefined, formatHint: string | undefined): ValueKind | null {
  switch (inputKind) {
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'datetime-local':
      return 'datetime';
    default:
      break;
  }

  if (!formatHint) return null;
  const hint = formatHint.toLowerCase();
  // A clock component: an hour token, or a colon between digit placeholders.
  const hasTime = /\bhh\b/.test(hint) || /\bhour/.test(hint) || /:\s*mm\b/.test(hint) || /\bmm\s*:/.test(hint);
  // A calendar component: a year or day token, or a month name token.
  const hasDate = /y{2,4}/.test(hint) || /\bdd\b/.test(hint) || /\bmmm\b/.test(hint) || /\bmonth\b/.test(hint) || /\bday\b/.test(hint);

  if (hasDate && hasTime) return 'datetime';
  if (hasDate) return 'date';
  if (hasTime) return 'time';
  return null;
}
