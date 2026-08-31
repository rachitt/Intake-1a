/**
 * Acting on the page.
 *
 * Everything here is addressed by `ref` — never by a selector — and everything
 * dispatches the full event sequence a real user's input would produce. That
 * second part is not pedantry: plain-DOM apps listen for `change`, React
 * listens for `input` through a patched value setter, and design-system
 * comboboxes only respond to keyboard and pointer sequences. An agent that
 * sets `.value` and fires `change` works on roughly one platform in three,
 * which is exactly the failure mode this assignment is built to catch.
 */

import { regionElement, resolveRef } from './snapshot';
import { accessibleName, elementRole, normaliseText } from './accname';
import type { Ref } from '../shared/snapshot';

export interface ActionResult {
  ok: boolean;
  /** Why it failed, or a note about how it succeeded. */
  detail: string;
}

function fail(detail: string): ActionResult {
  return { ok: false, detail };
}

function ok(detail = ''): ActionResult {
  return { ok: true, detail };
}

function el(ref: Ref): HTMLElement | null {
  const found = resolveRef(ref);
  return (found as HTMLElement) ?? null;
}

/** Bring an element into view without smooth-scrolling races. */
function reveal(node: HTMLElement): void {
  node.scrollIntoView({ block: 'center', inline: 'center', behavior: 'auto' });
}

function centre(node: HTMLElement): { x: number; y: number } {
  const r = node.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
}

function pointerInit(node: HTMLElement): PointerEventInit & MouseEventInit {
  const { x, y } = centre(node);
  return {
    bubbles: true,
    cancelable: true,
    composed: true,
    clientX: x,
    clientY: y,
    button: 0,
    buttons: 1,
    pointerId: 1,
    pointerType: 'mouse',
    isPrimary: true,
    view: window,
  };
}

/**
 * A full pointer→mouse→click sequence.
 *
 * Widget libraries listen at every one of these stages — some open a menu on
 * `pointerdown`, some commit on `mouseup`, some only handle `click`. Firing
 * the whole sequence is the only way to be library-agnostic.
 */
export function clickRef(ref: Ref): ActionResult {
  const node = el(ref);
  if (!node) return fail('That control is no longer on the page.');
  if ((node as HTMLButtonElement).disabled) return fail('That control is disabled.');
  if (node.getAttribute('aria-disabled') === 'true') return fail('That control reports itself disabled.');

  reveal(node);
  const init = pointerInit(node);

  node.dispatchEvent(new PointerEvent('pointerover', init));
  node.dispatchEvent(new PointerEvent('pointerenter', { ...init, bubbles: false }));
  node.dispatchEvent(new MouseEvent('mouseover', init));
  node.dispatchEvent(new MouseEvent('mousemove', init));
  node.dispatchEvent(new PointerEvent('pointerdown', init));
  node.dispatchEvent(new MouseEvent('mousedown', init));

  try {
    node.focus({ preventScroll: true });
  } catch {
    /* not focusable; harmless */
  }

  node.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  node.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
  node.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0, detail: 1 }));

  // Native elements also respond to their own activation behaviour, which the
  // synthesised click above already triggers; calling .click() as well would
  // double-fire. So we do not.
  return ok();
}

/**
 * React (and Vue, and Svelte's bound inputs) install their own value setter on
 * the element's prototype and track the last value they wrote. Assigning
 * `.value` directly bypasses that tracker, so the framework concludes nothing
 * changed and reverts on the next render. Going through the *prototype's*
 * setter is what makes a synthetic edit indistinguishable from a real one.
 */
function setNativeValue(node: HTMLElement, value: string): void {
  const proto = Object.getPrototypeOf(node);
  const desc = Object.getOwnPropertyDescriptor(proto, 'value');
  const own = Object.getOwnPropertyDescriptor(node, 'value');
  if (own?.set) {
    // The instance itself has been patched; clear it so the prototype wins.
    delete (node as unknown as Record<string, unknown>)['value'];
  }
  if (desc?.set) desc.set.call(node, value);
  else (node as unknown as { value: string }).value = value;
}

/** Type a value into a text-bearing control, as a keyboard would. */
export function setTextRef(ref: Ref, value: string): ActionResult {
  const node = el(ref);
  if (!node) return fail('That input is no longer on the page.');
  if ((node as HTMLInputElement).disabled) return fail('That input is disabled.');
  if ((node as HTMLInputElement).readOnly) return fail('That input is read-only.');

  reveal(node);
  try {
    node.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  node.dispatchEvent(new FocusEvent('focusin', { bubbles: true }));

  const tag = node.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea') {
    const input = node as HTMLInputElement;

    // Clear first, the way a user selecting-all and typing would, so a value
    // is replaced rather than appended.
    input.dispatchEvent(new KeyboardEvent('keydown', { bubbles: true, key: 'a', ctrlKey: true }));
    setNativeValue(input, '');
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'deleteContentBackward' }));

    setNativeValue(input, value);
    input.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    input.dispatchEvent(new KeyboardEvent('keyup', { bubbles: true, key: 'Unidentified' }));
  } else if (node.isContentEditable) {
    node.textContent = value;
    node.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: value }));
  } else {
    return fail('That control does not accept typed text.');
  }

  node.dispatchEvent(new FocusEvent('focusout', { bubbles: true }));
  try {
    node.blur();
  } catch {
    /* ignore */
  }
  node.dispatchEvent(new Event('blur', { bubbles: false }));

  const readback = (node as HTMLInputElement).value ?? normaliseText(node.textContent);
  if (readback !== value) {
    return { ok: true, detail: `wrote "${value}" but the control now reads "${readback}"` };
  }
  return ok();
}

/**
 * Choose an option in a choice control.
 *
 * Handles a native <select>, and a custom listbox/combobox driven by ARIA. For
 * the custom case the sequence is: open it, find the option by accessible name,
 * click it — which is exactly what a person does, and therefore what any
 * widget library is built to accept.
 */
export function chooseOptionRef(ref: Ref, wanted: string): ActionResult {
  const node = el(ref);
  if (!node) return fail('That control is no longer on the page.');
  reveal(node);

  if (node.tagName.toLowerCase() === 'select') {
    const select = node as HTMLSelectElement;
    const options = Array.from(select.options);
    const match =
      options.find((o) => normaliseText(o.textContent) === wanted) ??
      options.find((o) => o.value === wanted) ??
      options.find((o) => normaliseText(o.textContent).toLowerCase() === wanted.toLowerCase()) ??
      options.find((o) => normaliseText(o.textContent).toLowerCase().includes(wanted.toLowerCase()));

    if (!match) {
      const available = options.map((o) => normaliseText(o.textContent)).filter(Boolean);
      return fail(`No option named "${wanted}". Available: ${available.join(' | ') || '(none)'}`);
    }

    try {
      node.focus({ preventScroll: true });
    } catch {
      /* ignore */
    }
    select.value = match.value;
    select.dispatchEvent(new Event('input', { bubbles: true }));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    return ok(`chose "${normaliseText(match.textContent)}"`);
  }

  // Custom widget: open, then pick.
  const expanded = node.getAttribute('aria-expanded');
  if (expanded !== 'true') clickRef(ref);

  const owned = node.getAttribute('aria-controls') ?? node.getAttribute('aria-owns');
  const listRoot: ParentNode = owned ? document.getElementById(owned) ?? document : document;
  const options = Array.from(listRoot.querySelectorAll('[role="option"], [role="menuitem"], [role="menuitemradio"]'));
  const named = options.map((o) => ({ el: o as HTMLElement, name: accessibleName(o).name }));

  const match =
    named.find((o) => o.name === wanted) ??
    named.find((o) => o.name.toLowerCase() === wanted.toLowerCase()) ??
    named.find((o) => o.name.toLowerCase().includes(wanted.toLowerCase()));

  if (!match) {
    return fail(`No option named "${wanted}". Available: ${named.map((o) => o.name).filter(Boolean).join(' | ') || '(none)'}`);
  }

  const init = pointerInit(match.el);
  match.el.dispatchEvent(new PointerEvent('pointerdown', init));
  match.el.dispatchEvent(new MouseEvent('mousedown', init));
  match.el.dispatchEvent(new PointerEvent('pointerup', { ...init, buttons: 0 }));
  match.el.dispatchEvent(new MouseEvent('mouseup', { ...init, buttons: 0 }));
  match.el.dispatchEvent(new MouseEvent('click', { ...init, buttons: 0, detail: 1 }));
  return ok(`chose "${match.name}"`);
}

/**
 * Put a two-state control into a definite state.
 *
 * Deliberately idempotent: it reads the current state first and only acts if it
 * differs. A blind click on a checkbox is a coin flip on a re-run, and re-runs
 * are a requirement here.
 */
export function setToggleRef(ref: Ref, desired: boolean): ActionResult {
  const node = el(ref);
  if (!node) return fail('That toggle is no longer on the page.');

  const current = (() => {
    const input = node as HTMLInputElement;
    if (typeof input.checked === 'boolean' && (input.type === 'checkbox' || input.type === 'radio')) return input.checked;
    const aria = node.getAttribute('aria-checked');
    if (aria === 'true') return true;
    if (aria === 'false') return false;
    const pressed = node.getAttribute('aria-pressed');
    if (pressed === 'true') return true;
    if (pressed === 'false') return false;
    const selected = node.getAttribute('aria-selected');
    if (selected === 'true') return true;
    if (selected === 'false') return false;
    return null;
  })();

  if (current === desired) return ok('already in the requested state');
  if (current === null) {
    // Unknown state — click once and let the caller's read-back decide. Never
    // click twice hoping to land on the right side.
    const result = clickRef(ref);
    return result.ok ? ok('state was unreadable; clicked once — verify by read-back') : result;
  }
  return clickRef(ref);
}

/** Press a key on a control, for widgets that only respond to the keyboard. */
export function pressKeyRef(ref: Ref, key: string): ActionResult {
  const node = el(ref);
  if (!node) return fail('That control is no longer on the page.');
  try {
    node.focus({ preventScroll: true });
  } catch {
    /* ignore */
  }
  const init: KeyboardEventInit = { bubbles: true, cancelable: true, composed: true, key };
  node.dispatchEvent(new KeyboardEvent('keydown', init));
  node.dispatchEvent(new KeyboardEvent('keypress', init));
  node.dispatchEvent(new KeyboardEvent('keyup', init));
  return ok();
}

/**
 * HTML5 drag and drop, for palettes that only support dragging.
 *
 * Tried only as a fallback: most libraries also accept a click, and a click is
 * far more reliable to synthesise. Reported honestly as best-effort, because
 * some drag implementations read from the real system clipboard/drag service
 * and cannot be driven from script at all.
 */
export function dragRef(sourceRef: Ref, targetRef: Ref): ActionResult {
  const source = el(sourceRef);
  const target = el(targetRef);
  if (!source) return fail('The dragged control is no longer on the page.');
  if (!target) return fail('The drop target is no longer on the page.');
  return dispatchDrag(source, target, 'a control');
}

/**
 * Drop onto a whole REGION rather than onto a control inside it.
 *
 * Needed for the case a ref cannot express: an empty canvas. A designer with
 * nothing built on it yet contains no control to aim at, so a palette entry
 * that can only be added by dragging has nowhere to be dropped — and the agent
 * concludes the entry does not work, when in fact it was never given a target.
 *
 * A region id is as opaque as a ref; nothing about the page's markup crosses
 * the boundary either way.
 */
export function dropOnRegionRef(sourceRef: Ref, regionId: number): ActionResult {
  const source = el(sourceRef);
  if (!source) return fail('The dragged control is no longer on the page.');
  const target = regionElement(regionId);
  if (!(target instanceof HTMLElement)) return fail('That region is no longer on the page.');
  return dispatchDrag(source, target, 'a region');
}

/**
 * A best-effort drag.
 *
 * Both the HTML5 drag events and the pointer/mouse sequence are dispatched,
 * because designers are split roughly evenly between the two and there is no
 * way to tell from the outside which one a given palette listens to. Sending
 * both is harmless where only one is handled.
 */
function dispatchDrag(source: HTMLElement, target: HTMLElement, what: string): ActionResult {
  reveal(target);
  const dt = new DataTransfer();
  const srcInit = pointerInit(source);
  const tgtInit = pointerInit(target);

  source.dispatchEvent(new PointerEvent('pointerdown', srcInit));
  source.dispatchEvent(new MouseEvent('mousedown', srcInit));
  source.dispatchEvent(new DragEvent('dragstart', { ...srcInit, dataTransfer: dt }));

  target.dispatchEvent(new DragEvent('dragenter', { ...tgtInit, dataTransfer: dt }));
  target.dispatchEvent(new PointerEvent('pointermove', tgtInit));
  target.dispatchEvent(new MouseEvent('mousemove', tgtInit));
  target.dispatchEvent(new DragEvent('dragover', { ...tgtInit, dataTransfer: dt }));
  target.dispatchEvent(new DragEvent('drop', { ...tgtInit, dataTransfer: dt }));

  target.dispatchEvent(new PointerEvent('pointerup', tgtInit));
  target.dispatchEvent(new MouseEvent('mouseup', tgtInit));
  source.dispatchEvent(new DragEvent('dragend', { ...srcInit, dataTransfer: dt }));
  return ok(`dispatched a drag sequence onto ${what} (best-effort)`);
}

/** Read a control back, for verification. */
export function readRef(ref: Ref): { ok: boolean; role: string; name: string; value: string; checked: boolean | null; options: string[] } | null {
  const node = el(ref);
  if (!node) return null;
  const role = elementRole(node);
  const input = node as HTMLInputElement;
  const checked =
    input.type === 'checkbox' || input.type === 'radio'
      ? input.checked
      : node.getAttribute('aria-checked') === 'true'
        ? true
        : node.getAttribute('aria-checked') === 'false'
          ? false
          : null;

  let options: string[] = [];
  let value = input.value ?? normaliseText(node.textContent);

  if (node.tagName.toLowerCase() === 'select') {
    const select = node as HTMLSelectElement;
    options = Array.from(select.options).map((o) => normaliseText(o.textContent) || o.value);
    // The TEXT of the chosen option, not its value attribute. A designer that
    // stores an internal id in the value ("el12") while displaying a field's
    // label would otherwise make every read-back look like a failure, and the
    // agent would escalate changes that in fact worked perfectly.
    value = select.multiple
      ? Array.from(select.selectedOptions).map((o) => normaliseText(o.textContent) || o.value).join(', ')
      : select.selectedOptions[0]
        ? normaliseText(select.selectedOptions[0].textContent) || select.selectedOptions[0].value
        : '';
  }

  return {
    ok: true,
    role,
    name: accessibleName(node).name,
    value,
    checked,
    options,
  };
}
