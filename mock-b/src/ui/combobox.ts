import { h, transientId } from './dom';

/**
 * A custom combobox, built the way a component library builds one.
 *
 * Mock A uses a native `<select>`, where choosing an option is a single DOM
 * operation and the browser does the rest. This is the other case, and it is
 * far more common in production: a `div` with `role="combobox"` that opens a
 * `role="listbox"` of `role="option"` divs, none of which is a form control at
 * all.
 *
 * What that changes for an agent:
 *
 *   - There is no `value` property to read. The current choice is the widget's
 *     visible text, and its `aria-activedescendant`.
 *   - The options do not exist in the DOM until it is opened, so a single
 *     snapshot of a closed combobox cannot enumerate what it offers.
 *   - Selecting is two acts — open, then click an option — where a native
 *     select is one.
 *
 * The listbox is rendered inline rather than in a portal, which keeps it inside
 * the region it belongs to. That is the kinder of the two common shapes; a
 * portal to `document.body` would be harder still, and is noted in the README
 * as untested rather than pretended otherwise.
 */
export interface ComboOption {
  value: string;
  text: string;
}

export interface ComboboxSpec {
  options: ComboOption[];
  value: string;
  placeholder: string;
  onChange: (value: string) => void;
  /** Open state lives with the caller so a re-render does not close it. */
  open: boolean;
  setOpen: (open: boolean) => void;
}

export function combobox(spec: ComboboxSpec): HTMLElement {
  const listId = transientId();
  const current = spec.options.find((o) => o.value === spec.value);

  const control = h(
    'div',
    {
      class: `_tw9c_combo${spec.open ? ' _tw9c_combo_open' : ''}`,
      role: 'combobox',
      tabindex: '0',
      'aria-expanded': spec.open ? 'true' : 'false',
      'aria-haspopup': 'listbox',
      'aria-controls': listId,
    },
    [h('span', { class: '_tw9c_combo_text' }, [current ? current.text : spec.placeholder])],
  );

  const wrapper = h('div', { class: '_tw9c_combo_wrap' }, [control]);

  control.addEventListener('click', (event) => {
    event.stopPropagation();
    spec.setOpen(!spec.open);
  });
  control.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      spec.setOpen(!spec.open);
    }
  });

  if (spec.open) {
    const list = h('div', { class: '_tw9c_listbox', role: 'listbox', id: listId });
    for (const option of spec.options) {
      const selected = option.value === spec.value;
      const item = h(
        'div',
        {
          class: `_tw9c_option${selected ? ' _tw9c_option_on' : ''}`,
          role: 'option',
          'aria-selected': selected ? 'true' : 'false',
        },
        [option.text],
      );
      item.addEventListener('click', (event) => {
        event.stopPropagation();
        spec.onChange(option.value);
        spec.setOpen(false);
      });
      list.append(item);
    }
    wrapper.append(list);
  }

  return wrapper;
}
