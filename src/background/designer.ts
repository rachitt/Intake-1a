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
import { rippledBeyond } from '../shared/diff';
import { emptyObservation } from '../shared/types';
import type { Grounder, Intent } from './grounder';
import type { Observation, Page } from './page';
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
    private page: Page,
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
      this.log('The remembered element library no longer matches this screen; rediscovering it.', 'warn');
    }

    const discovered = this.discoverPalette(snap);
    if (discovered.length) {
      this.profile.libraryEntries = discovered.map((e) => e.name);
      this.log(`Element library discovered with ${discovered.length} entries: ${discovered.map((e) => e.name).join(', ')}`);
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

    const regions = candidates.length
      ? candidates
      : // Fall back to any region that is mostly short-named activatable items.
        snapshot.regions
          .filter((r) => r.kind !== 'toolbar' && r.kind !== 'navigation' && r.members.length >= 5)
          .sort((a, b) => b.members.length - a.members.length);

    for (const region of regions) {
      const nodes = region.members
        .map((ref) => snapshot.nodes.find((n) => n.ref === ref))
        .filter((n): n is SnapshotNode => Boolean(n))
        .filter((n) => this.looksActivatable(n) && n.name.length > 0 && n.name.length <= 40);

      // A palette's entries are distinct from one another and there are several.
      const names = new Set(nodes.map((n) => n.name));
      if (names.size >= 5 && names.size >= nodes.length * 0.9) {
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

  // ── properties ──────────────────────────────────────────────────────────────

  /** Is there a control on this screen that satisfies the intent at all? */
  async has(intent: Intent, snapshot?: Snapshot): Promise<boolean> {
    const snap = snapshot ?? (await this.page.current());
    const ranked = this.grounder.rank(snap, { ...intent, ignoreMemory: true });
    return Boolean(ranked[0] && ranked[0].score >= (intent.threshold ?? 0.55));
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

    const added = await this.addElement(entryName);
    if (!added.ok) {
      notes.push(added.detail);
      return { observation, cleanedUp: true, notes };
    }

    // Name it, which both identifies its rendering on the canvas and proves the
    // label control is a live editor rather than a decoy.
    const labelled = await this.setText(INTENTS.fieldLabel(), sentinel);
    if (!labelled.ok) notes.push(`Could not set a probe label: ${labelled.detail}`);
    else if (!labelled.live) notes.push('The label input accepted text without anything else on the page reacting — it may be inert.');

    // What does the property editor offer for this type?
    let snapshot = await this.page.capture();
    observation.offersOptionEditor =
      (await this.has(INTENTS.optionAdd(), snapshot)) || (await this.has(INTENTS.optionBulkInput(), snapshot));
    observation.offersRange =
      (await this.has(INTENTS.fieldMin(), snapshot)) && (await this.has(INTENTS.fieldMax(), snapshot));
    observation.offersFormula = await this.has(INTENTS.fieldFormula(), snapshot);
    observation.offersPrecision = await this.has(INTENTS.fieldPrecision(), snapshot);

    // A choice control renders nothing informative until it has choices, so give
    // it two before looking at how it presents them.
    if (observation.offersOptionEditor) {
      const seeded = await this.seedProbeOptions();
      if (!seeded) notes.push('The coded-value editor was present but two probe values could not be entered.');
      snapshot = await this.page.capture();
    }

    this.readRendering(snapshot, sentinel, observation, notes);

    const cleanedUp = await this.deleteSelected();
    if (!cleanedUp) notes.push(`The probe field "${sentinel}" could not be deleted and may still be on the form.`);

    this.profile.probes[entryName] = observation;
    return { observation, cleanedUp, notes };
  }

  /** Two throwaway coded values, enough to reveal how choices are presented. */
  private async seedProbeOptions(): Promise<boolean> {
    let entered = 0;
    for (const [code, label] of [['P1', 'Probe One'], ['P2', 'Probe Two']] as const) {
      const snapshot = await this.page.capture();
      const addResult = await this.grounder.ground(snapshot, INTENTS.optionAdd());
      if (!addResult.ok) break;
      await this.page.click(addResult.ref);

      const after = await this.page.capture();
      const codeRefs = this.grounder.rank(after, { ...INTENTS.optionCode(), ignoreMemory: true });
      const labelRefs = this.grounder.rank(after, { ...INTENTS.optionLabel(), ignoreMemory: true });
      // The row just added is the last one, so take the last candidate of each.
      const codeNode = codeRefs.filter((c) => c.score > 0.4).at(-1);
      const labelNode = labelRefs.filter((c) => c.score > 0.4).at(-1);
      if (codeNode) await this.page.setText(codeNode.node.ref, code);
      if (labelNode) await this.page.setText(labelNode.node.ref, label);
      if (codeNode || labelNode) entered++;
    }
    return entered >= 2;
  }

  /**
   * Read how the built field renders, which is what separates the types that
   * names cannot.
   *
   * The canvas is identified structurally: it is the region, other than the
   * palette, the property editor and the chrome, that contains a control the
   * agent has just named. Every judgement stays `null` when it could not be
   * observed — "could not tell" and "no" must never be conflated, because a
   * false negative here silently picks the wrong widget.
   */
  private readRendering(snapshot: Snapshot, sentinel: string, out: ObservedBehaviour, notes: string[]): void {
    const excludedKinds = new Set(['palette', 'editor', 'toolbar', 'navigation']);
    const excludedRegions = new Set(snapshot.regions.filter((r) => excludedKinds.has(r.kind)).map((r) => r.id));

    const candidates = snapshot.nodes.filter((n) => !excludedRegions.has(n.region));

    // The card wrapping the field carries the sentinel plus other chrome text;
    // the field's own rendering is either named exactly the sentinel, named
    // "<sentinel>: <choice>", or is an unnamed two-state control beside it.
    const controls = candidates.filter((n) => CONTROL_ROLES.has(n.role));
    const named = controls.filter((n) => n.name === sentinel || n.name.startsWith(`${sentinel}:`) || n.name.startsWith(`${sentinel} `));
    const preview = named.length ? named : controls;

    if (!preview.length) {
      // A two-state control is often rendered as a pair of plain buttons.
      const buttons = candidates.filter(
        (n) => n.role === 'button' && !n.name.includes(sentinel) && n.name.length > 0 && n.name.length <= 24,
      );
      if (buttons.length === 2) {
        out.rendersBinary = true;
        out.rendersMultiSelect = false;
        out.rendersExpandedChoices = null;
        out.rendersValueKind = 'binary';
        return;
      }
      notes.push('Could not find the field on the canvas, so how it renders is unknown.');
      return;
    }

    const radios = preview.filter((n) => n.role === 'radio');
    const checks = preview.filter((n) => n.role === 'checkbox' || n.role === 'switch');
    const combos = preview.filter((n) => n.role === 'combobox' || n.role === 'listbox');
    const texts = preview.filter((n) => n.role === 'textbox' || n.role === 'spinbutton' || n.role === 'searchbox');

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
    } else if (checks.length === 1 || radios.length === 1) {
      // A lone tick with no choice list is a single boolean flag, not a list.
      out.rendersBinary = true;
      out.rendersMultiSelect = false;
      out.rendersExpandedChoices = null;
      out.rendersValueKind = 'binary';
    } else if (texts.length) {
      const text = texts[0]!;
      out.rendersBinary = false;
      out.rendersMultiSelect = null;
      out.rendersExpandedChoices = null;
      out.rendersMultiline = Boolean(text.state.multiline);
      out.rendersReadOnly = Boolean(text.state.readOnly);
      out.rendersValueKind = valueKindFromInput(text.state.inputKind);
    }

    if (out.rendersMultiline === null && texts.length === 0) out.rendersMultiline = false;
    if (out.rendersReadOnly === null && texts.length === 0) out.rendersReadOnly = false;
  }

  /** Which region is the canvas, for drag fallbacks. */
  private canvasRegion(snapshot: Snapshot) {
    const excluded = new Set(['palette', 'editor', 'toolbar', 'navigation']);
    return snapshot.regions.find((r) => !excluded.has(r.kind) && r.members.length > 0);
  }
}

/**
 * Only commit to a value kind when the platform states one. Many designers
 * render every preview as a plain text box, and inferring "text" from that
 * would argue against date, time and numeric types for no reason.
 */
function valueKindFromInput(inputKind: string | undefined): ValueKind | null {
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
      return null;
  }
}
