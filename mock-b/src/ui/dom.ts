/**
 * DOM helpers for a deliberately framework-shaped surface.
 *
 * Mock A is hand-written semantic HTML: real `<table>`s, real `<label for>`,
 * stable element ids. That is the friendly case. Mock B is what most real
 * applications actually look like once a component library has been through
 * them:
 *
 *   - **No element ids that survive a render.** Every id here is minted fresh
 *     on each paint and used only to wire `aria-labelledby`. Anything that
 *     remembered one would be pointing at a dead node a moment later.
 *   - **Generated-looking class names.** Nothing readable to hang a selector
 *     off, which is the state of any app built with CSS modules.
 *   - **`div`s with ARIA roles instead of semantic tags.** Rows are
 *     `role="row"`, not `<tr>`; the tab strip is `role="tablist"`, not a list
 *     of links.
 *   - **Labels wired by `aria-labelledby`**, not by `<label for>` as Mock A
 *     does, so a name has to be resolved rather than read off an attribute.
 *
 * None of this is adversarial. It is the ordinary output of a modern
 * front-end, and an agent that only copes with Mock A's tidier markup has not
 * been tested against anything.
 */

let idCounter = 0;

/** A fresh id, valid for exactly one render. */
export function transientId(): string {
  return `r${(++idCounter).toString(36)}${Math.random().toString(36).slice(2, 6)}`;
}

type Attrs = Record<string, string | number | boolean | undefined>;

export function h<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs: Attrs = {},
  children: (Node | string)[] = [],
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  for (const [key, value] of Object.entries(attrs)) {
    if (value === undefined || value === false) continue;
    node.setAttribute(key, value === true ? '' : String(value));
  }
  for (const child of children) node.append(child);
  return node;
}

/** A block-level div carrying one of the generated class names. */
export function box(className: string, children: (Node | string)[] = [], attrs: Attrs = {}): HTMLDivElement {
  return h('div', { class: className, ...attrs }, children);
}

/**
 * A labelled control, wired the way a component library wires one.
 *
 * The visible caption is a `<span>` with a transient id, and the control points
 * at it with `aria-labelledby`. There is no `<label for>` and no stable id
 * anywhere in the pair.
 */
export function labelled(caption: string, control: HTMLElement, className = '_tw9c_field'): HTMLDivElement {
  const captionId = transientId();
  const captionNode = h('span', { class: '_tw9c_caption', id: captionId }, [caption]);
  control.setAttribute('aria-labelledby', captionId);
  return box(className, [captionNode, control]);
}

/** A control labelled directly, for the places a component library does that instead. */
export function aria(control: HTMLElement, name: string): HTMLElement {
  control.setAttribute('aria-label', name);
  return control;
}

export function button(text: string, className = '_tw9c_btn'): HTMLButtonElement {
  return h('button', { type: 'button', class: className }, [text]);
}

export function textInput(value: string, onInput: (value: string) => void, className = '_tw9c_input'): HTMLInputElement {
  const input = h('input', { type: 'text', class: className });
  input.value = value;
  input.addEventListener('input', () => onInput(input.value));
  return input;
}

export function multilineInput(
  value: string,
  onInput: (value: string) => void,
  className = '_tw9c_textarea',
): HTMLTextAreaElement {
  const area = h('textarea', { rows: '3', class: className });
  area.value = value;
  area.addEventListener('input', () => onInput(area.value));
  return area;
}

/**
 * A switch, as a `role="switch"` button rather than a checkbox input.
 *
 * Mock A uses real `<input type="checkbox">`. This one is a div-with-a-role, so
 * an agent reading checked state has to read `aria-checked` rather than the
 * DOM property.
 */
export function toggle(on: boolean, onChange: (next: boolean) => void, className = '_tw9c_switch'): HTMLElement {
  const node = h('button', {
    type: 'button',
    class: `${className}${on ? ' _tw9c_on' : ''}`,
    role: 'switch',
    'aria-checked': on ? 'true' : 'false',
  });
  node.append(h('span', { class: '_tw9c_knob' }));
  node.addEventListener('click', () => onChange(!on));
  return node;
}
