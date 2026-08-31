/**
 * Building the Semantic Snapshot from a live DOM.
 *
 * Two jobs, both of which have to work on a page nobody has seen:
 *
 *   1. Turn interactive elements into role + accessible name + state.
 *   2. Infer STRUCTURE — which controls belong together, and what each cluster
 *      is probably for — from shape alone.
 *
 * (2) is what replaces "find the element library by its container id". A form
 * designer, on any platform, has a cluster of many similar activatable items
 * (the library), a cluster of labelled inputs (the property editor), a small
 * row of buttons at an edge (the toolbar) and a rendering of the thing being
 * built (the canvas). Those shapes survive a total DOM rewrite; ids do not.
 */

import { accessibleName, elementRole, isInteractiveRole, normaliseText } from './accname';
import type { Ref, Role, Snapshot, SnapshotNode, SnapshotRegion } from '../shared/snapshot';

// ── ref registry ──────────────────────────────────────────────────────────────

let snapshotCounter = 0;
let refCounter = 0;

/**
 * Several generations of refs are kept alive at once.
 *
 * A single logical step routinely spans more than two snapshots — write a code,
 * write a label, then read both back — and each action re-captures. Keeping
 * only the latest two generations means the ref taken at the start of the step
 * has already been evicted by the time it is read, which looks exactly like the
 * control having vanished. Callers must still cope with `null`, because a
 * re-render genuinely does replace elements; this only removes the failures
 * that were an artefact of bookkeeping.
 */
const REF_GENERATIONS = 5;
const generations: Map<Ref, Element>[] = [new Map()];

export function resolveRef(ref: Ref): Element | null {
  for (const generation of generations) {
    const el = generation.get(ref);
    if (el && el.isConnected) return el;
  }
  return null;
}

// ── visibility ────────────────────────────────────────────────────────────────

function isVisible(el: Element): boolean {
  const he = el as HTMLElement;
  if (!he.isConnected) return false;
  if (el.getAttribute('aria-hidden') === 'true') return false;
  if ((el as HTMLElement).hasAttribute?.('inert')) return false;
  const style = getComputedStyle(he);
  if (style.display === 'none' || style.visibility === 'hidden' || style.visibility === 'collapse') return false;
  if (Number(style.opacity) === 0) return false;
  const rect = he.getBoundingClientRect();
  if (rect.width <= 0 && rect.height <= 0) {
    // Zero-size is usually genuinely hidden, but a visually-hidden-but-focusable
    // control (a common a11y pattern) still matters, so keep focusable ones.
    return he.tabIndex >= 0;
  }
  return true;
}

/** The modal that currently owns the page, if any. */
function findActiveModal(root: Document): Element | null {
  const open = Array.from(root.querySelectorAll('dialog[open]'));
  if (open.length) return open[open.length - 1] ?? null;

  const flagged = Array.from(root.querySelectorAll('[aria-modal="true"], [role="dialog"], [role="alertdialog"]'))
    .filter((el) => isVisible(el));
  if (!flagged.length) return null;

  // The topmost by stacking order is the one in charge.
  let best: Element | null = null;
  let bestZ = -Infinity;
  for (const el of flagged) {
    const z = Number(getComputedStyle(el as HTMLElement).zIndex);
    const score = Number.isFinite(z) ? z : 0;
    if (score >= bestZ) {
      bestZ = score;
      best = el;
    }
  }
  return best;
}

// ── state extraction ──────────────────────────────────────────────────────────

function ariaBool(el: Element, attr: string): boolean | undefined {
  const v = el.getAttribute(attr);
  if (v === null) return undefined;
  return v === 'true' || v === '';
}

function controlOptions(el: Element, role: Role): string[] | undefined {
  if (el.tagName.toLowerCase() === 'select') {
    return Array.from((el as HTMLSelectElement).options).map((o) => normaliseText(o.textContent) || o.value);
  }
  if (role === 'listbox' || role === 'combobox') {
    const owned = el.getAttribute('aria-controls') ?? el.getAttribute('aria-owns');
    const listRoot = owned ? document.getElementById(owned) : el;
    const options = listRoot ? Array.from(listRoot.querySelectorAll('[role="option"]')) : [];
    if (options.length) return options.map((o) => accessibleName(o).name).filter(Boolean);
  }
  return undefined;
}

function controlValue(el: Element, role: Role): string | undefined {
  const tag = el.tagName.toLowerCase();
  if (tag === 'select') {
    const sel = el as HTMLSelectElement;
    if (sel.multiple) {
      return Array.from(sel.selectedOptions).map((o) => normaliseText(o.textContent) || o.value).join(', ');
    }
    const chosen = sel.selectedOptions[0];
    return chosen ? normaliseText(chosen.textContent) || chosen.value : '';
  }
  if (tag === 'input') {
    const input = el as HTMLInputElement;
    const type = (input.type ?? '').toLowerCase();
    if (type === 'checkbox' || type === 'radio') return undefined;
    return input.value;
  }
  if (tag === 'textarea') return (el as HTMLTextAreaElement).value;
  if (el.hasAttribute('contenteditable')) return normaliseText(el.textContent);
  if (role === 'combobox') return normaliseText(el.getAttribute('aria-activedescendant') ? '' : el.textContent);
  return undefined;
}

function nodeState(el: Element, role: Role, inModal: boolean): SnapshotNode['state'] {
  const tag = el.tagName.toLowerCase();
  const he = el as HTMLElement & { disabled?: boolean; readOnly?: boolean; required?: boolean; checked?: boolean };

  const state: SnapshotNode['state'] = {
    visible: true,
    inModal: inModal || undefined,
  };

  const disabled = he.disabled === true || el.getAttribute('aria-disabled') === 'true' || el.hasAttribute('disabled');
  if (disabled) state.disabled = true;

  const readOnly = he.readOnly === true || el.getAttribute('aria-readonly') === 'true' || el.hasAttribute('readonly');
  if (readOnly) state.readOnly = true;

  const required = he.required === true || el.getAttribute('aria-required') === 'true' || el.hasAttribute('required');
  if (required) state.required = true;

  if (role === 'checkbox' || role === 'radio' || role === 'switch' || role === 'menuitem') {
    const checked = he.checked ?? ariaBool(el, 'aria-checked');
    if (checked !== undefined) state.checked = checked;
  }

  const expanded = ariaBool(el, 'aria-expanded');
  if (expanded !== undefined) state.expanded = expanded;

  const selected = ariaBool(el, 'aria-selected');
  if (selected !== undefined) state.selected = selected;

  if (tag === 'textarea') state.multiline = true;
  if (el.hasAttribute('contenteditable')) state.multiline = true;

  if (tag === 'select' && (el as HTMLSelectElement).multiple) state.multiSelectable = true;
  if (ariaBool(el, 'aria-multiselectable')) state.multiSelectable = true;

  if (tag === 'input') {
    const type = ((el as HTMLInputElement).type ?? 'text').toLowerCase();
    state.inputKind = type;
  } else if (tag === 'textarea') {
    state.inputKind = 'textarea';
  }

  const hint = normaliseText(el.getAttribute('placeholder') ?? el.getAttribute('title'));
  if (hint) state.formatHint = hint;

  if (he.tabIndex >= 0) state.focusable = true;

  return state;
}

// ── region inference ──────────────────────────────────────────────────────────

const SEMANTIC_CUT = new Set(['dialog', 'form', 'fieldset', 'nav', 'aside', 'main', 'section', 'table', 'header', 'footer']);

function isSemanticBoundary(el: Element): boolean {
  if (SEMANTIC_CUT.has(el.tagName.toLowerCase())) return true;
  const role = (el.getAttribute('role') ?? '').toLowerCase();
  return ['dialog', 'alertdialog', 'navigation', 'toolbar', 'form', 'table', 'grid', 'tablist', 'menu', 'region'].includes(role);
}

/**
 * Partition interactive elements into regions by descending the DOM and cutting
 * where a subtree stops being "one cluster".
 *
 * The rule: descend while a container is big and splits cleanly into several
 * child groups; cut when it is small enough to be a coherent cluster, or when
 * it is a semantic boundary. No ids, classes or tag names specific to any
 * platform take part in the decision.
 */
function partitionRegions(interactive: Element[]): Map<Element, Element[]> {
  const owners = new Map<Element, Element[]>();
  if (!interactive.length) return owners;

  const counts = new Map<Element, number>();
  for (const el of interactive) {
    let node: Element | null = el;
    while (node) {
      counts.set(node, (counts.get(node) ?? 0) + 1);
      node = node.parentElement;
    }
  }

  const MAX_CLUSTER = 14;
  const assign = (container: Element, members: Element[]) => {
    if (!members.length) return;
    owners.set(container, members);
  };

  const descend = (container: Element, members: Element[]) => {
    if (members.length <= MAX_CLUSTER) return assign(container, members);

    // Group members by which child of `container` they descend from.
    const groups = new Map<Element, Element[]>();
    const direct: Element[] = [];
    for (const m of members) {
      let child: Element | null = m;
      while (child && child.parentElement !== container) child = child.parentElement;
      if (!child) direct.push(m);
      else {
        const list = groups.get(child) ?? [];
        list.push(m);
        groups.set(child, list);
      }
    }

    // If everything funnels into a single child, that child is the real cluster.
    if (groups.size === 1 && !direct.length) {
      const [child, list] = [...groups][0]!;
      return descend(child, list);
    }
    if (groups.size === 0) return assign(container, members);

    // A semantic boundary is a good place to CUT, but it must never stop a
    // descent: a whole form designer is usually wrapped in one <main>, and
    // treating that as a single cluster collapses the palette, the canvas and
    // the property editor into one undifferentiated blob — which is precisely
    // the structure the agent needs to tell apart.
    for (const [child, list] of groups) {
      if (list.length <= MAX_CLUSTER) assign(child, list);
      else descend(child, list);
    }
    if (direct.length) assign(container, direct);
  };

  // Start at the smallest element containing everything.
  let root: Element = document.body;
  const all = counts.get(document.body) ?? 0;
  let cursor: Element | null = document.body;
  while (cursor) {
    const next: Element | null =
      Array.from(cursor.children).find((c) => (counts.get(c) ?? 0) === all) ?? null;
    if (!next) break;
    cursor = next;
    root = next;
  }

  descend(root, interactive);
  return owners;
}

interface Classified {
  kind: SnapshotRegion['kind'];
  confidence: number;
  evidence: string[];
}

/**
 * Guess what a cluster is FOR, from the roles and shape of its members.
 *
 * Every judgement here is a hypothesis carrying a confidence, never a fact.
 * The orchestrator treats a high-confidence "palette" as a good place to look
 * first for an element library, and falls back to searching everywhere if the
 * guess does not pan out — so a wrong guess costs time, never correctness.
 */
function classifyRegion(container: Element, members: Element[], nodes: SnapshotNode[]): Classified {
  const evidence: string[] = [];
  const roles = nodes.map((n) => n.role);
  const count = nodes.length;
  const countOf = (r: Role) => roles.filter((x) => x === r).length;

  const buttons = countOf('button') + countOf('listitem') + countOf('option');
  const inputs = countOf('textbox') + countOf('spinbutton') + countOf('combobox') + countOf('searchbox');
  const toggles = countOf('checkbox') + countOf('radio') + countOf('switch');
  const tabs = countOf('tab');
  const rows = countOf('row');
  const links = countOf('link');

  const rect = container.getBoundingClientRect();
  const tall = rect.height > rect.width * 1.3;
  const wide = rect.width > rect.height * 2.5;

  if (rows >= 2 || container.tagName.toLowerCase() === 'table') {
    evidence.push(`${rows} rows`);
    return { kind: 'table', confidence: 0.85, evidence };
  }

  if (tabs >= 2) {
    evidence.push(`${tabs} tabs`);
    return { kind: 'navigation', confidence: 0.8, evidence };
  }

  if (isSemanticBoundary(container) && (container.getAttribute('role') ?? '').includes('dialog')) {
    evidence.push('semantic dialog');
    return { kind: 'dialog', confidence: 0.9, evidence };
  }

  // A palette: MANY similar activatable items, structurally uniform, few inputs.
  //
  // The threshold is deliberately well above what a navigation bar or a button
  // group contains. A palette of field types is a long list by nature, and
  // mistaking a four-item nav strip for one sends the agent clicking around the
  // application chrome looking for a place to add a field.
  if (buttons >= 6 && inputs <= 1 && buttons / Math.max(count, 1) > 0.7) {
    const uniform = structuralUniformity(members);
    evidence.push(`${buttons} similar activatable items`, `structural uniformity ${uniform.toFixed(2)}`);
    if (tall) evidence.push('arranged as a tall column');
    const confidence = Math.min(0.95, 0.45 + uniform * 0.4 + (tall ? 0.1 : 0));
    if (confidence >= 0.6) return { kind: 'palette', confidence, evidence };
  }

  // An editor: labelled inputs and toggles clustered together.
  if (inputs + toggles >= 2 && (inputs + toggles) / Math.max(count, 1) >= 0.5) {
    const named = nodes.filter((n) => n.name && (n.nameFrom === 'label' || n.nameFrom === 'aria-label' || n.nameFrom === 'legend')).length;
    evidence.push(`${inputs} value inputs, ${toggles} toggles`, `${named} carry an authored label`);
    const confidence = Math.min(0.92, 0.45 + (named / Math.max(count, 1)) * 0.45);
    return { kind: 'editor', confidence, evidence };
  }

  // A toolbar: a short row of buttons hugging an edge.
  if (buttons >= 2 && count <= 8 && wide) {
    evidence.push(`${buttons} buttons in a wide, short strip`);
    return { kind: 'toolbar', confidence: 0.7, evidence };
  }

  if (links >= 3) {
    evidence.push(`${links} links`);
    return { kind: 'navigation', confidence: 0.6, evidence };
  }

  evidence.push(`${count} controls, no dominant shape`);
  return { kind: 'unknown', confidence: 0.2, evidence };
}

/** How alike are these elements structurally? A palette's items are near-identical. */
function structuralUniformity(members: Element[]): number {
  if (members.length < 2) return 0;
  const shapes = members.map((el) => {
    const parent = el.parentElement;
    const depth = (() => {
      let d = 0;
      let n: Element | null = el;
      while (n && n !== parent) {
        d++;
        n = n.parentElement;
      }
      return d;
    })();
    return `${el.tagName}:${el.children.length}:${depth}`;
  });
  const counts = new Map<string, number>();
  for (const s of shapes) counts.set(s, (counts.get(s) ?? 0) + 1);
  const top = Math.max(...counts.values());
  return top / shapes.length;
}

// ── the walk ──────────────────────────────────────────────────────────────────

function collectRoots(): (Document | ShadowRoot)[] {
  const roots: (Document | ShadowRoot)[] = [document];
  const queue: (Document | ShadowRoot)[] = [document];
  // Open shadow roots are part of the page for a user, so they are part of it
  // for the agent too. Closed roots are invisible to everyone alike.
  while (queue.length) {
    const root = queue.shift()!;
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const shadow = (el as Element & { shadowRoot?: ShadowRoot | null }).shadowRoot;
      if (shadow) {
        roots.push(shadow);
        queue.push(shadow);
      }
    }
    if (roots.length > 50) break;
  }
  return roots;
}

function screenHeading(): string {
  const headings = Array.from(document.querySelectorAll('h1, h2, [role="heading"]'))
    .filter((h) => isVisible(h))
    .map((h) => ({ el: h, text: normaliseText(h.textContent), y: h.getBoundingClientRect().top }))
    .filter((h) => h.text.length > 0 && h.text.length < 120)
    .sort((a, b) => a.y - b.y);
  return headings[0]?.text ?? '';
}

function liveRegionText(): string[] {
  const out: string[] = [];
  const nodes = document.querySelectorAll('[role="status"], [role="alert"], [aria-live="polite"], [aria-live="assertive"], output');
  for (const el of Array.from(nodes)) {
    if (!isVisible(el)) continue;
    const text = normaliseText(el.textContent);
    if (text) out.push(text);
  }
  return out;
}

/**
 * Capture the page.
 *
 * `includeGeneric` widens the net to non-interactive text when the agent is
 * doing reconnaissance and needs to read what is on screen rather than act.
 */
export function captureSnapshot(opts: { includeGeneric?: boolean } = {}): Snapshot {
  generations.unshift(new Map());
  generations.length = Math.min(generations.length, REF_GENERATIONS);
  const currentRefs = generations[0]!;
  const id = ++snapshotCounter;

  const modal = findActiveModal(document);
  const roots = collectRoots();

  const elements: Element[] = [];
  for (const root of roots) {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      const role = elementRole(el);
      const interactive = isInteractiveRole(role);
      const wanted = interactive || (opts.includeGeneric && (role === 'heading' || role === 'status' || role === 'alert'));
      if (!wanted) continue;
      if (!isVisible(el)) continue;
      // When a modal owns the page, everything behind it is inert — reasoning
      // about it would ground the agent on controls it cannot reach.
      if (modal && !modal.contains(el)) continue;
      elements.push(el);
    }
  }

  const owners = partitionRegions(elements);
  const containerOf = new Map<Element, Element>();
  for (const [container, members] of owners) {
    for (const m of members) containerOf.set(m, container);
  }

  const regionIds = new Map<Element, number>();
  let nextRegionId = 0;

  const nodes: SnapshotNode[] = [];
  const indexOf = new Map<Element, number>();

  for (const el of elements) {
    const role = elementRole(el);
    const named = accessibleName(el);
    const container = containerOf.get(el) ?? document.body;
    let regionId = regionIds.get(container);
    if (regionId === undefined) {
      regionId = nextRegionId++;
      regionIds.set(container, regionId);
    }

    const ref = ++refCounter;
    currentRefs.set(ref, el);

    const rect = el.getBoundingClientRect();
    const node: SnapshotNode = {
      ref,
      role,
      name: named.name,
      nameFrom: named.from,
      state: nodeState(el, role, Boolean(modal && modal.contains(el))),
      parent: -1,
      depth: 0,
      region: regionId,
      box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
    };
    const value = controlValue(el, role);
    if (value !== undefined && value !== '') node.value = value;
    const options = controlOptions(el, role);
    if (options?.length) node.options = options;

    indexOf.set(el, nodes.length);
    nodes.push(node);
  }

  // Parent links, so the model can see nesting without seeing the DOM.
  for (const [el, i] of indexOf) {
    let p: Element | null = el.parentElement;
    while (p) {
      const pi = indexOf.get(p);
      if (pi !== undefined) {
        nodes[i]!.parent = pi;
        nodes[i]!.depth = nodes[pi]!.depth + 1;
        break;
      }
      p = p.parentElement;
    }
  }

  const regions: SnapshotRegion[] = [];
  for (const [container, regionId] of regionIds) {
    const members = owners.get(container) ?? [];
    const memberNodes = members.map((m) => nodes[indexOf.get(m)!]).filter(Boolean) as SnapshotNode[];
    const classified = classifyRegion(container, members, memberNodes);
    const rect = container.getBoundingClientRect();
    regions.push({
      id: regionId,
      name: regionName(container),
      kind: classified.kind,
      confidence: classified.confidence,
      members: memberNodes.map((n) => n.ref),
      box: { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) },
      evidence: classified.evidence,
    });
  }
  regions.sort((a, b) => a.id - b.id);

  return {
    id,
    url: location.href,
    title: document.title,
    screenTitle: screenHeading(),
    nodes,
    regions,
    liveText: liveRegionText(),
    modalOpen: Boolean(modal),
    at: Date.now(),
  };
}

/** A region's own name: its heading, its aria-label, or nothing. */
function regionName(container: Element): string {
  const aria = normaliseText(container.getAttribute('aria-label'));
  if (aria) return aria;
  const heading = container.querySelector('h1, h2, h3, h4, h5, h6, legend, caption, [role="heading"]');
  if (heading && container.contains(heading)) {
    const text = normaliseText(heading.textContent);
    if (text && text.length < 80) return text;
  }
  return '';
}
