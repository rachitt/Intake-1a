/**
 * Accessible name and role computation.
 *
 * A deliberately faithful (if compact) implementation of the way a screen
 * reader names a control: aria-label, then aria-labelledby, then an associated
 * <label>, then a <legend> or <caption>, then the element's own text, then
 * title, then placeholder.
 *
 * This matters far more than it looks. The accessible name is the ONE
 * identifier that means the same thing on every platform: a "Save" button is
 * named Save whether it is a <button>, an <a role="button">, or a div with a
 * click handler, and whether its class is `.btn-primary` or `.x7fq`. Building
 * the agent's entire view of the page out of names and roles is what lets the
 * same code drive an eSource nobody has seen.
 */

import type { Role } from '../shared/snapshot';

const MAX_NAME = 200;

export function normaliseText(text: string | null | undefined): string {
  return (text ?? '').replace(/\s+/g, ' ').trim().slice(0, MAX_NAME);
}

export interface NamedResult {
  name: string;
  from:
    | 'aria-label'
    | 'aria-labelledby'
    | 'label'
    | 'legend'
    | 'caption'
    | 'text'
    | 'title'
    | 'placeholder'
    | 'value'
    | 'none';
}

/** Text content, with elements that are hidden from assistive tech excluded. */
function visibleText(el: Element, depth = 0): string {
  if (depth > 6) return '';
  let out = '';
  for (const child of Array.from(el.childNodes)) {
    if (child.nodeType === Node.TEXT_NODE) {
      out += child.textContent ?? '';
    } else if (child.nodeType === Node.ELEMENT_NODE) {
      const ce = child as Element;
      if (ce.getAttribute('aria-hidden') === 'true') continue;
      const tag = ce.tagName.toLowerCase();
      if (tag === 'script' || tag === 'style' || tag === 'template' || tag === 'svg') continue;
      // A nested control's own value is not part of its container's name.
      if (tag === 'input' || tag === 'select' || tag === 'textarea') continue;
      out += ' ' + visibleText(ce, depth + 1);
    }
    if (out.length > MAX_NAME * 3) break;
  }
  return out;
}

function labelledByText(el: Element): string {
  const ids = (el.getAttribute('aria-labelledby') ?? '').split(/\s+/).filter(Boolean);
  if (!ids.length) return '';
  const root = el.getRootNode() as Document | ShadowRoot;
  const parts: string[] = [];
  for (const id of ids) {
    const target = root.getElementById?.(id) ?? document.getElementById(id);
    if (target) parts.push(visibleText(target));
  }
  return normaliseText(parts.join(' '));
}

/** The <label> associated with a form control, by `for=`, by wrapping, or by proximity. */
function associatedLabel(el: Element): string {
  const id = el.getAttribute('id');
  if (id) {
    const root = el.getRootNode() as Document | ShadowRoot;
    const escaped = cssEscape(id);
    const explicit = (root as ParentNode).querySelector?.(`label[for="${escaped}"]`);
    if (explicit) {
      const text = normaliseText(visibleText(explicit));
      if (text) return text;
    }
  }

  const wrapping = el.closest('label');
  if (wrapping) {
    const text = normaliseText(visibleText(wrapping));
    if (text) return text;
  }

  // Proximity fallback: many designers wire a label and a control together with
  // nothing but layout. Look at the immediately preceding sibling, and at the
  // first label inside the smallest enclosing row-like container.
  const prev = el.previousElementSibling;
  if (prev && prev.tagName.toLowerCase() === 'label') {
    const text = normaliseText(visibleText(prev));
    if (text) return text;
  }
  const parent = el.parentElement;
  if (parent) {
    const label = parent.querySelector(':scope > label');
    if (label) {
      const text = normaliseText(visibleText(label));
      if (text) return text;
    }
  }
  return '';
}

function cssEscape(value: string): string {
  const anyWindow = window as unknown as { CSS?: { escape?: (v: string) => string } };
  if (anyWindow.CSS?.escape) return anyWindow.CSS.escape(value);
  return value.replace(/["\\]/g, '\\$&');
}

/**
 * Compute an element's accessible name.
 *
 * Order follows the accname spec closely enough for agent purposes. The
 * `nameFrom` provenance is returned because it is a trust signal: a name that
 * came from `aria-label` is a deliberate authoring decision, while one derived
 * from a placeholder is a guess, and the grounder weights them differently.
 */
export function accessibleName(el: Element): NamedResult {
  const ariaLabel = normaliseText(el.getAttribute('aria-label'));
  if (ariaLabel) return { name: ariaLabel, from: 'aria-label' };

  const labelled = labelledByText(el);
  if (labelled) return { name: labelled, from: 'aria-labelledby' };

  const tag = el.tagName.toLowerCase();

  if (tag === 'input' || tag === 'select' || tag === 'textarea' || el.hasAttribute('contenteditable')) {
    const assoc = associatedLabel(el);
    if (assoc) return { name: assoc, from: 'label' };

    const fieldset = el.closest('fieldset');
    const legend = fieldset?.querySelector(':scope > legend');
    if (legend) {
      const text = normaliseText(visibleText(legend));
      if (text) return { name: text, from: 'legend' };
    }

    const title = normaliseText(el.getAttribute('title'));
    if (title) return { name: title, from: 'title' };

    const placeholder = normaliseText(el.getAttribute('placeholder'));
    if (placeholder) return { name: placeholder, from: 'placeholder' };

    // A button-shaped input carries its name in its value.
    const type = (el.getAttribute('type') ?? '').toLowerCase();
    if (tag === 'input' && (type === 'submit' || type === 'button' || type === 'reset')) {
      const value = normaliseText((el as HTMLInputElement).value);
      if (value) return { name: value, from: 'value' };
    }
    return { name: '', from: 'none' };
  }

  if (tag === 'table') {
    const caption = el.querySelector(':scope > caption');
    if (caption) {
      const text = normaliseText(visibleText(caption));
      if (text) return { name: text, from: 'caption' };
    }
  }

  if (tag === 'img') {
    const alt = normaliseText(el.getAttribute('alt'));
    if (alt) return { name: alt, from: 'text' };
  }

  const own = normaliseText(visibleText(el));
  if (own) return { name: own, from: 'text' };

  const title = normaliseText(el.getAttribute('title'));
  if (title) return { name: title, from: 'title' };

  return { name: '', from: 'none' };
}

const EXPLICIT_ROLES: Record<string, Role> = {
  button: 'button',
  link: 'link',
  textbox: 'textbox',
  searchbox: 'searchbox',
  spinbutton: 'spinbutton',
  combobox: 'combobox',
  listbox: 'listbox',
  option: 'option',
  checkbox: 'checkbox',
  radio: 'radio',
  switch: 'switch',
  slider: 'slider',
  tab: 'tab',
  tablist: 'tablist',
  menuitem: 'menuitem',
  menuitemcheckbox: 'menuitem',
  menuitemradio: 'menuitem',
  menu: 'menu',
  menubar: 'menu',
  dialog: 'dialog',
  alertdialog: 'dialog',
  row: 'row',
  gridcell: 'cell',
  cell: 'cell',
  columnheader: 'columnheader',
  rowheader: 'columnheader',
  table: 'table',
  grid: 'table',
  treegrid: 'table',
  list: 'list',
  listitem: 'listitem',
  heading: 'heading',
  region: 'region',
  form: 'form',
  group: 'group',
  radiogroup: 'group',
  status: 'status',
  alert: 'alert',
  img: 'image',
  presentation: 'generic',
  none: 'generic',
};

/**
 * Normalise an element to a role.
 *
 * Native semantics first, then explicit ARIA, then behavioural shape. The last
 * step matters on design-system-heavy platforms where every control is a div:
 * a div with a click handler and a tabindex is, for the agent's purposes, a
 * button, whatever the markup claims.
 */
export function elementRole(el: Element): Role {
  const explicit = (el.getAttribute('role') ?? '').trim().toLowerCase().split(/\s+/)[0];
  if (explicit && EXPLICIT_ROLES[explicit]) return EXPLICIT_ROLES[explicit] as Role;

  const tag = el.tagName.toLowerCase();
  switch (tag) {
    case 'button':
      return 'button';
    case 'a':
      return el.hasAttribute('href') ? 'link' : 'generic';
    case 'select':
      return (el as HTMLSelectElement).multiple ? 'listbox' : 'combobox';
    case 'option':
      return 'option';
    case 'textarea':
      return 'textbox';
    case 'summary':
      return 'button';
    case 'dialog':
      return 'dialog';
    case 'table':
      return 'table';
    case 'tr':
      return 'row';
    case 'td':
      return 'cell';
    case 'th':
      return 'columnheader';
    case 'ul':
    case 'ol':
      return 'list';
    case 'li':
      return 'listitem';
    case 'form':
      return 'form';
    case 'fieldset':
      return 'group';
    case 'section':
    case 'main':
    case 'aside':
      return 'region';
    case 'nav':
      return 'region';
    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6':
      return 'heading';
    case 'img':
      return 'image';
    case 'input': {
      const type = ((el as HTMLInputElement).type ?? 'text').toLowerCase();
      if (type === 'checkbox') return 'checkbox';
      if (type === 'radio') return 'radio';
      if (type === 'range') return 'slider';
      if (type === 'number') return 'spinbutton';
      if (type === 'search') return 'searchbox';
      if (type === 'submit' || type === 'button' || type === 'reset' || type === 'image') return 'button';
      if (type === 'hidden') return 'generic';
      return 'textbox';
    }
    default:
      break;
  }

  if (el.hasAttribute('contenteditable') && el.getAttribute('contenteditable') !== 'false') return 'textbox';

  // Behavioural shape: interactive-looking divs and spans.
  const tabindex = el.getAttribute('tabindex');
  const clickable =
    el.hasAttribute('onclick') ||
    (tabindex !== null && tabindex !== '-1') ||
    (el as HTMLElement).style?.cursor === 'pointer';
  if (clickable) {
    const cursor = getComputedStyle(el as HTMLElement).cursor;
    if (cursor === 'pointer' || tabindex !== null) return 'button';
  }

  return 'generic';
}

/** Is this element meaningfully interactive, i.e. worth putting in the snapshot? */
export function isInteractiveRole(role: Role): boolean {
  switch (role) {
    case 'button':
    case 'link':
    case 'textbox':
    case 'searchbox':
    case 'spinbutton':
    case 'combobox':
    case 'listbox':
    case 'option':
    case 'checkbox':
    case 'radio':
    case 'switch':
    case 'slider':
    case 'tab':
    case 'menuitem':
    case 'row':
      return true;
    default:
      return false;
  }
}
