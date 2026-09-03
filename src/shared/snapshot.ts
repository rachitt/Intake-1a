/**
 * The Semantic Snapshot — the ONLY view of a page that leaves the content
 * script.
 *
 * This type is the architectural load-bearing wall of the whole submission.
 * The orchestrator, the grounder and the model all reason over these nodes and
 * address elements by `ref` — an opaque integer. No CSS selector, element id,
 * class name or tag-shaped string ever crosses this boundary. That is not a
 * convention anyone has to remember; it is simply the only thing the type
 * permits, which is why the agent cannot become dependent on one platform's
 * DOM even by accident.
 *
 * What a node carries is what an accessibility tree carries: a role, an
 * accessible name, a value, states, and where it sits relative to everything
 * else. Those concepts exist on every web application ever built. The DOM that
 * expresses them does not.
 */

/** Opaque, per-snapshot handle for an element. Valid only for the snapshot that produced it. */
export type Ref = number;

/**
 * A normalised role. Native semantics, explicit ARIA roles and obvious
 * behavioural shapes all collapse into this small vocabulary, because a
 * platform-agnostic agent only ever needs to know what a control *does*.
 */
export type Role =
  | 'button'
  | 'link'
  | 'textbox'
  | 'searchbox'
  | 'spinbutton'
  | 'combobox'
  | 'listbox'
  | 'option'
  | 'checkbox'
  | 'radio'
  | 'switch'
  | 'slider'
  | 'tab'
  | 'tablist'
  | 'menuitem'
  | 'menu'
  | 'dialog'
  | 'row'
  | 'cell'
  | 'columnheader'
  | 'table'
  | 'list'
  | 'listitem'
  | 'heading'
  | 'region'
  | 'form'
  | 'group'
  | 'status'
  | 'alert'
  | 'image'
  | 'text'
  | 'generic';

export interface NodeState {
  disabled?: boolean;
  readOnly?: boolean;
  required?: boolean;
  checked?: boolean;
  expanded?: boolean;
  /**
   * The control reveals more controls when activated — a menu, a listbox, a
   * popup. Structural, not lexical: it is how a platform declares that what you
   * are looking for may not be on screen yet.
   */
  hasPopup?: boolean;
  selected?: boolean;
  multiline?: boolean;
  /** A listbox/select that holds more than one value at a time. */
  multiSelectable?: boolean;
  /** The element is inside a modal dialog that currently owns the page. */
  inModal?: boolean;
  /** Visible in the layout and not clipped to nothing. */
  visible?: boolean;
  /** Reachable by keyboard. */
  focusable?: boolean;
  /** Input type hint when the platform gives one (number, date, time, …). */
  inputKind?: string;
  /**
   * A format the control advertises — a placeholder or title such as
   * "DD-MMM-YYYY" or "HH:MM".
   *
   * Worth capturing because many designers render every field preview as a
   * plain text box and let the expected format be the only thing distinguishing
   * a date from a time from free text. It is a hint, never a guarantee.
   */
  formatHint?: string;
}

export interface SnapshotNode {
  ref: Ref;
  role: Role;
  /** Accessible name, computed the way a screen reader would compute it. */
  name: string;
  /** Where the name came from — a weak trust signal for the grounder. */
  nameFrom?: 'aria-label' | 'aria-labelledby' | 'label' | 'legend' | 'caption' | 'text' | 'title' | 'placeholder' | 'value' | 'none';
  /** Current value for value-bearing controls. */
  value?: string;
  /** Options a choice control currently offers, in order. */
  options?: string[];
  state: NodeState;
  /** Index of the parent node in the flat node array; -1 at the root. */
  parent: number;
  /** Depth in the pruned tree, for rendering and for region reasoning. */
  depth: number;
  /** Id of the structural region this node belongs to (see SnapshotRegion). */
  region: number;
  /** Layout box, used only for spatial reasoning (adjacency, panes). Never for selection. */
  box?: { x: number; y: number; w: number; h: number };
}

/**
 * A structural region, inferred from shape rather than from ids or classes.
 *
 * This is how the agent finds "the element library" on a platform that has
 * never been seen: not by looking for a known container, but by noticing a
 * cluster of many similar activatable items sitting together. Likewise an
 * "editor panel" is a cluster of labelled inputs, and a "toolbar" is a small
 * row of buttons at an edge.
 */
export interface SnapshotRegion {
  id: number;
  /** Heading or landmark label, when the page offers one. */
  name: string;
  /** What the region's shape suggests it is. A hypothesis, never a certainty. */
  kind: 'palette' | 'editor' | 'toolbar' | 'navigation' | 'table' | 'canvas' | 'dialog' | 'status' | 'unknown';
  /** Confidence in `kind`, 0..1. */
  confidence: number;
  /** Refs of the interactive nodes inside. */
  members: Ref[];
  box?: { x: number; y: number; w: number; h: number };
  /**
   * The visible text inside this region, as rendered lines.
   *
   * Necessary because not everything on a page is a control. A designer canvas
   * lists the fields built so far, and some of them render as previews that
   * carry no accessible name at all — a yes/no field draws two buttons labelled
   * "Yes" and "No" and never mentions the field. Reading the region's text is
   * the only way to confirm such a field is present, and a field that cannot be
   * confirmed present is reported missing, which is the most costly error this
   * agent can make.
   */
  texts: string[];
  /** Why the region was classified this way — surfaced in the audit log. */
  evidence: string[];
}

export interface Snapshot {
  /** Monotonic id; a ref is only meaningful together with this. */
  id: number;
  url: string;
  title: string;
  /** Text of any heading that names the current screen, best-effort. */
  screenTitle: string;
  nodes: SnapshotNode[];
  regions: SnapshotRegion[];
  /** Text currently in live regions (role=status/alert/aria-live) — how the app reports outcomes. */
  liveText: string[];
  /** True when a modal dialog owns the page; nodes outside it are inert. */
  modalOpen: boolean;
  /** Wall-clock capture time, for the audit trail. */
  at: number;
}

/** A compact difference between two snapshots — the agent's "what just happened". */
export interface SnapshotDiff {
  addedNodes: SnapshotNode[];
  removedNames: string[];
  /** Value/state changes on nodes that survived, keyed by accessible name. */
  changed: { name: string; role: Role; before: string; after: string }[];
  /** Live-region text that appeared since the previous snapshot. */
  newLiveText: string[];
  screenChanged: boolean;
  modalChanged: boolean;
  /** Total number of node-level differences — the magnitude of the effect. */
  magnitude: number;
}

/** Render a snapshot as compact indented text for a language model. */
export function renderSnapshot(snapshot: Snapshot, opts: { maxNodes?: number } = {}): string {
  const max = opts.maxNodes ?? 400;
  const lines: string[] = [];
  lines.push(`screen: ${snapshot.screenTitle || snapshot.title}`);
  if (snapshot.modalOpen) lines.push('a modal dialog currently owns the page');
  if (snapshot.liveText.length) lines.push(`app says: ${snapshot.liveText.join(' | ')}`);

  const byRegion = new Map<number, SnapshotNode[]>();
  for (const node of snapshot.nodes) {
    const list = byRegion.get(node.region) ?? [];
    list.push(node);
    byRegion.set(node.region, list);
  }

  let emitted = 0;
  for (const region of snapshot.regions) {
    const members = byRegion.get(region.id) ?? [];
    if (!members.length) continue;
    lines.push('');
    const named = region.name ? ` "${region.name}"` : '';
    lines.push(`[region ${region.id}${named} — looks like a ${region.kind} (${region.confidence.toFixed(2)}); ${members.length} controls]`);
    for (const node of members) {
      if (emitted++ >= max) {
        lines.push('  … (truncated)');
        return lines.join('\n');
      }
      lines.push('  ' + renderNode(node));
    }
  }
  return lines.join('\n');
}

function renderNode(node: SnapshotNode): string {
  const bits: string[] = [`ref=${node.ref}`, node.role];
  if (node.name) bits.push(JSON.stringify(node.name));
  if (node.value) bits.push(`value=${JSON.stringify(node.value.slice(0, 60))}`);
  if (node.options?.length) {
    const shown = node.options.slice(0, 6).join(', ');
    bits.push(`options=[${shown}${node.options.length > 6 ? `, +${node.options.length - 6} more` : ''}]`);
  }
  const s = node.state;
  const flags: string[] = [];
  if (s.disabled) flags.push('disabled');
  if (s.readOnly) flags.push('readonly');
  if (s.required) flags.push('required');
  if (s.checked) flags.push('checked');
  if (s.expanded) flags.push('expanded');
  if (s.selected) flags.push('selected');
  if (s.multiline) flags.push('multiline');
  if (s.multiSelectable) flags.push('multi-selectable');
  if (s.inputKind) flags.push(`kind=${s.inputKind}`);
  if (s.formatHint) flags.push(`format=${JSON.stringify(s.formatHint)}`);
  if (flags.length) bits.push(`(${flags.join(' ')})`);
  return bits.join(' ');
}
