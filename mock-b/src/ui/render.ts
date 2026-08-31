import { fieldType } from '../shared/study';
import { ELEMENT_KINDS, elementKindByCanonical, PLATFORM_LABEL } from '../spec/surface';
import type { BuiltDocument, BuiltElement, MockBState, Stage } from '../engine/state';
import type { MockBStore } from '../engine/store';
import { combobox } from './combobox';
import { aria, box, button, h, labelled, multilineInput, textInput, toggle, transientId } from './dom';

/**
 * Mock B's surface.
 *
 * Every structural choice here is deliberately the opposite of Mock A's, so
 * that an agent which happens to work on both is working on something real:
 *
 *   - **Wizard, not drill-down.** Three numbered stages reached through a tab
 *     strip, rather than a list that opens a detail page that opens a designer.
 *   - **Mirrored designer.** The property inspector is on the LEFT and the
 *     element library on the RIGHT. Mock A has them the other way round.
 *   - **Save lives in an overflow menu**, next to two things that look like
 *     saving and are not, and one that destroys work.
 *   - **Custom widgets.** Choices are `role="combobox"` divs, switches are
 *     `role="switch"` buttons; there is not a native `<select>` on the page.
 *   - **Different words for everything.** A visit is a timepoint, a form is a
 *     document, a label is question text, required is mandatory, a repeating
 *     form is a log.
 */

const STAGES: { id: Stage; caption: string }[] = [
  { id: 'schedule', caption: '1. Schedule' },
  { id: 'documents', caption: '2. Documents' },
  { id: 'design', caption: '3. Design' },
];

/**
 * A key describing the STRUCTURE currently on screen.
 *
 * Everything that changes which controls exist is in it; nothing that merely
 * changes what a control contains is. Re-rendering only when this changes is
 * how a component library behaves — typing into a box does not replace the box
 * — and doing otherwise would make this mock hostile in a way no real
 * application is: every keystroke would destroy the element being typed into,
 * so no value could ever be read back from the node that accepted it.
 */
export function layoutKey(store: MockBStore): string {
  const { study, ui } = store.getState();

  const studyKey = study.timepoints
    .map((t) => `${t.id}[${t.documents.map((d) => `${d.id}:${d.status}:${d.revision}:${d.elements.length}`).join(',')}]`)
    .join('|');

  const design = ui.design;
  const selected = store.selected();
  const designKey = design.working
    ? [
        design.working.id,
        design.dirty,
        design.working.elements.map((e) => e.id).join(','),
        design.selectedElementId ?? '-',
        selected
          ? [
              selected.kind,
              selected.values.length,
              selected.rule.mode,
              selected.mandatory,
              // The chosen controlling question changes what the combobox
              // DISPLAYS, so it has to repaint. Leaving it out left the widget
              // showing its placeholder after a choice had been made — the
              // choice was recorded and invisible, which is the one thing a
              // control must never be.
              selected.rule.mode === 'conditional' ? selected.rule.whenElementId : '',
            ].join(':')
          : '-',
        design.menuOpen,
        design.openCombo ?? '-',
        design.notice ?? '',
      ].join('~')
    : '-';

  return [
    ui.stage,
    ui.activeTimepointId ?? '-',
    ui.activeDocumentId ?? '-',
    ui.timepointFormOpen,
    ui.documentFormOpen,
    ui.documentDraft.log,
    studyKey,
    designKey,
  ].join('#');
}

export function mount(store: MockBStore, root: HTMLElement): void {
  let last: string | null = null;
  const paint = (): void => {
    const key = layoutKey(store);
    if (key === last) return;
    last = key;
    root.replaceChildren(build(store));
  };
  store.subscribe(paint);
  paint();

  // Clicking anywhere else dismisses the overflow menu and any open listbox,
  // as a component library would. Both stop propagation on their own controls,
  // so this only ever fires for a click that really was somewhere else.
  document.addEventListener('click', () => {
    const design = store.getState().ui.design;
    if (design.menuOpen) store.setMenuOpen(false);
    else if (design.openCombo) store.setOpenCombo(null);
  });
}

function build(store: MockBStore): HTMLElement {
  const state = store.getState();
  const shell = box('_tw9c_shell');
  shell.append(chrome(store, state), stageBody(store, state));
  return shell;
}

// ── chrome ────────────────────────────────────────────────────────────────────

function chrome(store: MockBStore, state: MockBState): HTMLElement {
  const brand = box('_tw9c_brand', [
    h('span', { class: '_tw9c_product' }, [PLATFORM_LABEL]),
    h('span', { class: '_tw9c_study' }, [`Protocol ${state.study.code}`]),
  ]);

  const strip = h('div', { class: '_tw9c_steps', role: 'tablist' });
  for (const stage of STAGES) {
    const active = state.ui.stage === stage.id;
    const reachable =
      stage.id === 'schedule' ||
      (stage.id === 'documents' && Boolean(state.ui.activeTimepointId)) ||
      (stage.id === 'design' && Boolean(state.ui.activeDocumentId));
    const tab = h(
      'div',
      {
        class: `_tw9c_step${active ? ' _tw9c_step_on' : ''}${reachable ? '' : ' _tw9c_step_off'}`,
        role: 'tab',
        tabindex: '0',
        'aria-selected': active ? 'true' : 'false',
        'aria-disabled': reachable ? 'false' : 'true',
      },
      [stage.caption],
    );
    if (reachable) tab.addEventListener('click', () => store.goToStage(stage.id));
    strip.append(tab);
  }

  return box('_tw9c_chrome', [brand, strip]);
}

/**
 * The breadcrumb.
 *
 * Named after the things it leads back to — the protocol, then the timepoint —
 * because that is what a breadcrumb is. Nothing in it says "back": the words
 * are proper nouns, which is exactly the case an agent has to handle by
 * knowing what it is looking for rather than by matching a generic word.
 */
function crumbs(store: MockBStore, state: MockBState): HTMLElement {
  const trail = box('_tw9c_crumbs');
  const study = button(state.study.code, '_tw9c_crumb');
  study.addEventListener('click', () => store.goToStage('schedule'));
  trail.append(study);

  const timepoint = store.activeTimepoint();
  if (timepoint) {
    trail.append(h('span', { class: '_tw9c_sep' }, ['/']));
    const node = button(timepoint.title, '_tw9c_crumb');
    node.addEventListener('click', () => store.goToStage('documents'));
    trail.append(node);
  }

  const working = state.ui.design.working;
  if (state.ui.stage === 'design' && working) {
    trail.append(h('span', { class: '_tw9c_sep' }, ['/']), h('span', { class: '_tw9c_crumb_now' }, [working.title]));
  }
  return trail;
}

function heading(text: string): HTMLElement {
  return h('h1', { class: '_tw9c_h1' }, [text]);
}

function stageBody(store: MockBStore, state: MockBState): HTMLElement {
  switch (state.ui.stage) {
    case 'schedule':
      return scheduleStage(store, state);
    case 'documents':
      return documentsStage(store, state);
    case 'design':
      return designStage(store, state);
  }
}

// ── stage 1: the schedule ─────────────────────────────────────────────────────

function scheduleStage(store: MockBStore, state: MockBState): HTMLElement {
  const body = box('_tw9c_stage');
  body.append(crumbs(store, state), heading('Study Plan'));

  const bar = box('_tw9c_bar');
  const add = button('Add Timepoint', '_tw9c_btn _tw9c_primary');
  add.addEventListener('click', () => store.toggleTimepointForm(!state.ui.timepointFormOpen));
  bar.append(add);
  body.append(bar);

  if (state.ui.timepointFormOpen) {
    const draft = state.ui.timepointDraft;
    const panel = box('_tw9c_panel');
    panel.append(
      h('h2', { class: '_tw9c_h2' }, ['New Timepoint']),
      labelled('Timepoint Name', textInput(draft.title, (v) => store.patchTimepointDraft({ title: v }))),
      labelled('Window Opens (Day)', textInput(draft.dayFrom, (v) => store.patchTimepointDraft({ dayFrom: v }))),
      labelled('Window Closes (Day)', textInput(draft.dayTo, (v) => store.patchTimepointDraft({ dayTo: v }))),
    );
    const actions = box('_tw9c_actions');
    const create = button('Create Timepoint', '_tw9c_btn _tw9c_primary');
    create.addEventListener('click', () => store.addTimepoint());
    const cancel = button('Cancel', '_tw9c_btn');
    cancel.addEventListener('click', () => store.toggleTimepointForm(false));
    actions.append(create, cancel);
    panel.append(actions);
    body.append(panel);
  }

  const grid = h('div', { class: '_tw9c_grid', role: 'table' });
  const head = h('div', { class: '_tw9c_grid_head', role: 'row' }, [
    h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['Timepoint']),
    h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['Window']),
    h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['Documents']),
    h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['']),
  ]);
  grid.append(head);

  if (!state.study.timepoints.length) {
    grid.append(box('_tw9c_empty', ['No timepoints yet. Every visit in the protocol has to be added here first.']));
  }

  for (const timepoint of state.study.timepoints) {
    const row = h('div', { class: '_tw9c_row', role: 'row' });
    const open = button('Open', '_tw9c_btn _tw9c_small');
    open.addEventListener('click', (event) => {
      event.stopPropagation();
      store.openTimepoint(timepoint.id);
    });
    row.append(
      h('div', { class: '_tw9c_cell', role: 'cell' }, [timepoint.title]),
      h('div', { class: '_tw9c_cell', role: 'cell' }, [
        timepoint.dayFrom || timepoint.dayTo ? `Day ${timepoint.dayFrom} to ${timepoint.dayTo}` : '—',
      ]),
      h('div', { class: '_tw9c_cell', role: 'cell' }, [String(timepoint.documents.length)]),
      h('div', { class: '_tw9c_cell', role: 'cell' }, [open]),
    );
    row.addEventListener('click', () => store.openTimepoint(timepoint.id));
    grid.append(row);
  }

  body.append(grid);
  return body;
}

// ── stage 2: the documents under one timepoint ────────────────────────────────

function documentsStage(store: MockBStore, state: MockBState): HTMLElement {
  const timepoint = store.activeTimepoint();
  const body = box('_tw9c_stage');
  body.append(crumbs(store, state));
  if (!timepoint) {
    body.append(heading('Source Documents'), box('_tw9c_empty', ['Choose a timepoint first.']));
    return body;
  }

  // The heading names the timepoint. That is how anything looking at this
  // screen can tell WHICH timepoint it is looking at, rather than merely that
  // it is looking at one of them.
  body.append(heading(`${timepoint.title} — Source Documents`));

  const bar = box('_tw9c_bar');
  const add = button('Add Document', '_tw9c_btn _tw9c_primary');
  add.addEventListener('click', () => store.toggleDocumentForm(!state.ui.documentFormOpen));
  bar.append(add);
  body.append(bar);

  if (state.ui.documentFormOpen) {
    const draft = state.ui.documentDraft;
    const panel = box('_tw9c_panel');
    panel.append(
      h('h2', { class: '_tw9c_h2' }, ['New Source Document']),
      labelled('Document Title', textInput(draft.title, (v) => store.patchDocumentDraft({ title: v }))),
      // A repeating form, in this vendor's words. Offered ONLY here: once the
      // document exists there is no control for it, so an agent that means to
      // set it has to do so at creation or not at all.
      labelled(
        'Log Form (holds many entries per visit)',
        toggle(draft.log, (next) => store.patchDocumentDraft({ log: next })),
      ),
    );
    const actions = box('_tw9c_actions');
    const create = button('Create Document', '_tw9c_btn _tw9c_primary');
    create.addEventListener('click', () => store.addDocument());
    const cancel = button('Cancel', '_tw9c_btn');
    cancel.addEventListener('click', () => store.toggleDocumentForm(false));
    actions.append(create, cancel);
    panel.append(actions);
    body.append(panel);
  }

  const grid = h('div', { class: '_tw9c_grid', role: 'table' });
  grid.append(
    h('div', { class: '_tw9c_grid_head', role: 'row' }, [
      h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['Document']),
      h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['Kind']),
      h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['Status']),
      h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['Questions']),
      h('div', { class: '_tw9c_cell', role: 'columnheader' }, ['']),
    ]),
  );

  if (!timepoint.documents.length) {
    grid.append(box('_tw9c_empty', ['No source documents under this timepoint yet.']));
  }

  for (const doc of timepoint.documents) {
    const row = h('div', { class: '_tw9c_row', role: 'row' });
    const actions = box('_tw9c_cell_actions');
    if (doc.status === 'released') {
      // Locked. The way back to editable is a new revision, not an edit button.
      const revise = button('Start New Revision', '_tw9c_btn _tw9c_small');
      revise.addEventListener('click', (event) => {
        event.stopPropagation();
        store.newRevision(doc.id);
      });
      actions.append(revise);
    } else {
      const design = button('Design', '_tw9c_btn _tw9c_small');
      design.addEventListener('click', (event) => {
        event.stopPropagation();
        store.openDesigner(doc.id);
      });
      actions.append(design);
    }
    row.append(
      h('div', { class: '_tw9c_cell', role: 'cell' }, [doc.title]),
      h('div', { class: '_tw9c_cell', role: 'cell' }, [doc.log ? 'Log' : 'Single']),
      h('div', { class: '_tw9c_cell', role: 'cell' }, [doc.status === 'released' ? 'Released' : 'Draft']),
      h('div', { class: '_tw9c_cell', role: 'cell' }, [String(doc.elements.length)]),
      h('div', { class: '_tw9c_cell', role: 'cell' }, [actions]),
    );
    grid.append(row);
  }

  body.append(grid);
  return body;
}

// ── stage 3: the designer ─────────────────────────────────────────────────────

function designStage(store: MockBStore, state: MockBState): HTMLElement {
  const working = state.ui.design.working;
  const body = box('_tw9c_stage _tw9c_stage_wide');
  body.append(crumbs(store, state));
  if (!working) {
    body.append(heading('Design'), box('_tw9c_empty', ['Choose a source document to design.']));
    return body;
  }

  body.append(designerBar(store, state, working));

  // Mirrored against Mock A: inspector LEFT, canvas centre, library RIGHT.
  const columns = box('_tw9c_columns');
  columns.append(inspectorColumn(store, state), canvasColumn(store, state, working), libraryColumn(store));
  body.append(columns);

  if (state.ui.design.notice) {
    body.append(box('_tw9c_notice', [state.ui.design.notice]));
  }
  return body;
}

function designerBar(store: MockBStore, state: MockBState, working: BuiltDocument): HTMLElement {
  const bar = box('_tw9c_designbar');
  const left = box('_tw9c_designbar_left', [
    h('span', { class: '_tw9c_doc_title' }, [working.title]),
    h('span', { class: '_tw9c_doc_state' }, [
      state.ui.design.dirty ? 'Uncommitted changes' : `Revision ${working.revision}`,
    ]),
  ]);

  const right = box('_tw9c_designbar_right');

  // A decoy that sits where a Save button would sit on most platforms. It opens
  // a read-only view and persists nothing.
  const preview = button('Preview', '_tw9c_btn');
  preview.addEventListener('click', () => store.setNotice('Preview is not available in this build.'));
  right.append(preview);

  // The overflow menu. This platform's ONLY commit affordance is inside it.
  const trigger = aria(button('⋯', '_tw9c_btn _tw9c_more'), 'More actions');
  trigger.setAttribute('aria-haspopup', 'menu');
  trigger.setAttribute('aria-expanded', state.ui.design.menuOpen ? 'true' : 'false');
  trigger.addEventListener('click', (event) => {
    event.stopPropagation();
    store.setMenuOpen(!state.ui.design.menuOpen);
  });
  right.append(trigger);

  if (state.ui.design.menuOpen) {
    const menu = h('div', { class: '_tw9c_menu', role: 'menu' });
    const item = (text: string, run: () => void): HTMLElement => {
      const node = h('div', { class: '_tw9c_menuitem', role: 'menuitem', tabindex: '0' }, [text]);
      node.addEventListener('click', (event) => {
        event.stopPropagation();
        run();
      });
      return node;
    };
    menu.append(
      // Two look-alikes above the real one, and a destructive action below it.
      item('Save to Template Gallery', () => store.saveAsTemplate()),
      item('Validate Document', () => store.setNotice('Validation found no problems.')),
      item('Commit Changes', () => store.commit()),
      item('Release Document', () => store.release()),
      item('Discard Changes', () => store.discard()),
    );
    right.append(menu);
  }

  bar.append(left, right);
  return bar;
}

/** The element library — on the RIGHT here, and speaking this vendor's vocabulary. */
function libraryColumn(store: MockBStore): HTMLElement {
  const column = box('_tw9c_library');
  column.append(h('h2', { class: '_tw9c_h2' }, ['Element Library']));
  const list = box('_tw9c_library_list');
  for (const kind of ELEMENT_KINDS) {
    const entry = button(kind.label, '_tw9c_library_item');
    entry.addEventListener('click', () => store.addElement(kind.canonical));
    list.append(entry);
  }
  column.append(list);
  return column;
}

function canvasColumn(store: MockBStore, state: MockBState, working: BuiltDocument): HTMLElement {
  const column = box('_tw9c_canvas');
  column.append(h('h2', { class: '_tw9c_h2' }, ['Form Layout']));
  const surface = box('_tw9c_surface');

  if (!working.elements.length) {
    surface.append(box('_tw9c_empty', ['Add elements from the library on the right.']));
  }

  for (const element of working.elements) {
    const selected = element.id === state.ui.design.selectedElementId;
    const card = box(`_tw9c_card${selected ? ' _tw9c_card_on' : ''}`);
    card.addEventListener('click', () => store.selectElement(element.id));

    const notes = [elementKindByCanonical(element.kind).label];
    if (element.mandatory) notes.push('Mandatory');
    if (element.rule.mode === 'conditional') notes.push('Conditional');

    card.append(
      box('_tw9c_card_head', [
        h('span', { class: '_tw9c_card_q' }, [element.question || '(unnamed question)']),
        h('span', { class: '_tw9c_card_meta' }, [notes.join(' · ')]),
      ]),
      inertPreview(element),
    );
    surface.append(card);
  }

  column.append(surface);
  return column;
}

/**
 * The inert preview of a built element.
 *
 * Writes into these land in the DOM and persist nowhere — they are a picture of
 * the form, not the form. Each is named after the question it previews, which
 * is how the canvas can be read at all; the yes/no switch is the exception,
 * drawing two buttons that carry no trace of the question, exactly as a real
 * designer would.
 */
function inertPreview(element: BuiltElement): HTMLElement {
  const holder = box('_tw9c_preview');
  const name = element.question;
  switch (element.kind) {
    case 'text':
      holder.append(aria(h('input', { type: 'text', class: '_tw9c_input' }), name));
      break;
    case 'textarea':
      holder.append(aria(h('textarea', { rows: '2', class: '_tw9c_textarea' }), name));
      break;
    case 'integer':
    case 'decimal':
      holder.append(aria(h('input', { type: 'text', inputmode: 'numeric', class: '_tw9c_input' }), name));
      break;
    case 'date':
      holder.append(aria(h('input', { type: 'date', class: '_tw9c_input' }), name));
      break;
    case 'time':
      holder.append(aria(h('input', { type: 'time', class: '_tw9c_input' }), name));
      break;
    case 'datetime':
      holder.append(aria(h('input', { type: 'datetime-local', class: '_tw9c_input' }), name));
      break;
    case 'boolean': {
      const pair = box('_tw9c_pair');
      pair.append(button('Yes', '_tw9c_btn _tw9c_small'), button('No', '_tw9c_btn _tw9c_small'));
      holder.append(pair);
      break;
    }
    case 'checkbox':
      holder.append(aria(h('div', { class: '_tw9c_tick', role: 'checkbox', 'aria-checked': 'false' }), name));
      break;
    case 'single_select': {
      const shell = aria(
        h('div', { class: '_tw9c_combo', role: 'combobox', 'aria-expanded': 'false', 'aria-haspopup': 'listbox' }, [
          h('span', { class: '_tw9c_combo_text' }, [element.values[0]?.text ?? 'Choose one']),
        ]),
        name,
      );
      holder.append(shell);
      break;
    }
    case 'multi_select': {
      const list = box('_tw9c_ticks');
      for (const value of element.values) {
        list.append(
          box('_tw9c_tickrow', [
            aria(h('div', { class: '_tw9c_tick', role: 'checkbox', 'aria-checked': 'false' }), `${name}: ${value.text}`),
            h('span', {}, [value.text]),
          ]),
        );
      }
      holder.append(list);
      break;
    }
    case 'radio': {
      const list = box('_tw9c_radios');
      for (const value of element.values) {
        list.append(
          box('_tw9c_tickrow', [
            aria(h('div', { class: '_tw9c_radio', role: 'radio', 'aria-checked': 'false' }), `${name}: ${value.text}`),
            h('span', {}, [value.text]),
          ]),
        );
      }
      holder.append(list);
      break;
    }
    case 'calculated': {
      const shown = aria(h('input', { type: 'text', class: '_tw9c_input', readonly: true }), name);
      (shown as HTMLInputElement).value = element.expression ? `= ${element.expression}` : '';
      holder.append(shown);
      break;
    }
  }
  return holder;
}

// ── the inspector ─────────────────────────────────────────────────────────────

function inspectorColumn(store: MockBStore, state: MockBState): HTMLElement {
  const column = box('_tw9c_inspector');
  column.append(h('h2', { class: '_tw9c_h2' }, ['Question Properties']));

  const element = store.selected();
  if (!element) {
    column.append(box('_tw9c_empty', ['Select an element on the form to edit it.']));
    return column;
  }

  const def = fieldType(element.kind);

  column.append(
    labelled('Question Text', textInput(element.question, (v) => store.patchSelected({ question: v }))),
    labelled(
      'Element Kind',
      combobox({
        name: 'Element Kind',
        options: ELEMENT_KINDS.map((k) => ({ value: k.canonical, text: k.label })),
        value: element.kind,
        placeholder: 'Choose a kind',
        open: state.ui.design.openCombo === 'kind',
        setOpen: (open) => store.setOpenCombo(open ? 'kind' : null),
        onChange: (value) => store.changeKind(value as BuiltElement['kind']),
      }),
    ),
    labelled('Mandatory', toggle(element.mandatory, (next) => store.patchSelected({ mandatory: next }))),
  );

  if (def.hasRange) {
    const group = box('_tw9c_group');
    group.append(
      h('h3', { class: '_tw9c_h3' }, ['Range Check']),
      labelled('Lowest Allowed', textInput(element.lowest, (v) => store.patchSelected({ lowest: v }))),
      labelled('Highest Allowed', textInput(element.highest, (v) => store.patchSelected({ highest: v }))),
      labelled('Unit of Measure', textInput(element.unit, (v) => store.patchSelected({ unit: v }))),
    );
    column.append(group);
  }

  if (def.hasFormula) {
    column.append(labelled('Expression', textInput(element.expression, (v) => store.patchSelected({ expression: v }))));
  }

  if (def.hasOptions) column.append(valuesGroup(store, state, element));

  column.append(ruleGroup(store, state, element));

  const remove = button('Remove Element', '_tw9c_btn _tw9c_danger');
  remove.addEventListener('click', () => store.deleteSelected());
  column.append(remove);

  return column;
}

/**
 * The coded-value editor.
 *
 * A code and its shown text, side by side on a row — the pair a coded value
 * actually is. The bulk box beneath OVERWRITES the list, and says so, which is
 * the honest version of a shortcut that is usually discovered the hard way.
 */
function valuesGroup(store: MockBStore, state: MockBState, element: BuiltElement): HTMLElement {
  const group = box('_tw9c_group');
  group.append(h('h3', { class: '_tw9c_h3' }, ['Answer List']));

  element.values.forEach((value, index) => {
    const row = box('_tw9c_valuerow');
    row.append(
      labelled('Stored Code', textInput(value.code, (v) => store.setValueCode(index, v)), '_tw9c_field _tw9c_narrow'),
      labelled('Shown Text', textInput(value.text, (v) => store.setValueText(index, v)), '_tw9c_field'),
    );
    const drop = aria(button('×', '_tw9c_btn _tw9c_small _tw9c_danger'), 'Remove this answer');
    drop.addEventListener('click', () => store.removeValue(index));
    row.append(drop);
    group.append(row);
  });

  const add = button('Add Answer', '_tw9c_btn _tw9c_small');
  add.addEventListener('click', () => store.addValue());
  group.append(add);

  group.append(
    labelled(
      'Bulk Load (overwrites the list)',
      multilineInput(state.ui.design.bulkText, (v) => store.setBulkText(v)),
    ),
  );
  const apply = button('Apply Bulk Load', '_tw9c_btn _tw9c_small');
  apply.addEventListener('click', () => store.applyBulk());
  group.append(apply);

  return group;
}

/** Conditional display, in this vendor's words. */
function ruleGroup(store: MockBStore, state: MockBState, element: BuiltElement): HTMLElement {
  const group = box('_tw9c_group');
  group.append(h('h3', { class: '_tw9c_h3' }, ['Display Rule']));

  group.append(
    labelled(
      'When To Show',
      combobox({
        name: 'When To Show',
        options: [
          { value: 'always', text: 'Always Show' },
          { value: 'conditional', text: 'Show Only When…' },
        ],
        value: element.rule.mode,
        placeholder: 'Choose',
        open: state.ui.design.openCombo === 'rule',
        setOpen: (open) => store.setOpenCombo(open ? 'rule' : null),
        onChange: (value) => store.setRuleMode(value as 'always' | 'conditional'),
      }),
    ),
  );

  if (element.rule.mode === 'conditional') {
    const candidates = store.controllerCandidates();
    group.append(
      labelled(
        'Controlling Question',
        combobox({
          name: 'Controlling Question',
          options: candidates.map((c) => ({ value: c.id, text: c.question })),
          value: element.rule.whenElementId,
          placeholder: 'Choose a question',
          open: state.ui.design.openCombo === 'controller',
          setOpen: (open) => store.setOpenCombo(open ? 'controller' : null),
          onChange: (value) => store.setRuleController(value),
        }),
      ),
      labelled('Required Answer', textInput(element.rule.requiredAnswer, (v) => store.setRuleAnswer(v))),
    );
  }

  return group;
}

export { transientId };
