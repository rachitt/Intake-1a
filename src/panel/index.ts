/**
 * The human gate, panel side.
 *
 * The design brief for this screen: a study builder should be able to clear the
 * queue in seconds, and should never be asked to re-verify work the agent was
 * sure about. So the queue holds CLASSES of decision — "which palette entry
 * means multi_select", asked once for all six fields that need it — and every
 * card leads with what it costs to get the answer wrong, then shows the
 * evidence the agent actually gathered rather than a bare confidence number.
 */

import type {
  BackgroundEvent,
  Escalation,
  EscalationResolution,
  PanelCommand,
  ProgressNode,
  RunState,
  Settings,
} from '../shared/protocol';
import type { IrProblem, IrStats } from '../shared/ir';

const port = chrome.runtime.connect({ name: 'panel' });

function send(command: PanelCommand): void {
  port.postMessage(command);
}

const $ = <T extends HTMLElement = HTMLElement>(id: string): T => document.getElementById(id) as T;

let state: RunState | null = null;
let hideFinished = false;
/** Which option a reviewer has selected on each open card, before confirming. */
const picked = new Map<string, string>();

// ── setup controls ────────────────────────────────────────────────────────────

$('ir-file').addEventListener('change', async (event) => {
  const input = event.target as HTMLInputElement;
  const file = input.files?.[0];
  if (!file) return;
  send({ kind: 'loadIr', text: await file.text(), filename: file.name });
});

const apiKey = $<HTMLInputElement>('api-key');
apiKey.addEventListener('change', () => send({ kind: 'setApiKey', key: apiKey.value }));

const model = $<HTMLSelectElement>('model');
model.addEventListener('change', () => send({ kind: 'setModel', model: model.value }));

$('start').addEventListener('click', () => send({ kind: 'start' }));
$('stop').addEventListener('click', () => send({ kind: 'abort' }));
$('export-audit').addEventListener('click', () => send({ kind: 'exportAudit' }));
$('export-coverage').addEventListener('click', () => send({ kind: 'exportCoverage' }));
$('forget').addEventListener('click', () => send({ kind: 'forgetProfile' }));
$('toggle-done').addEventListener('click', () => {
  hideFinished = !hideFinished;
  $('toggle-done').textContent = hideFinished ? 'Show all' : 'Hide finished';
  if (state) renderProgress(state);
});

// ── incoming events ───────────────────────────────────────────────────────────

port.onMessage.addListener((event: BackgroundEvent) => {
  switch (event.kind) {
    case 'state':
      state = event.state;
      render(event.state);
      break;
    case 'settings':
      applySettings(event.settings);
      break;
    case 'irProblems':
      renderIrFeedback(event.ok, event.problems, event.stats);
      break;
    case 'download':
      download(event.filename, event.content, event.mime);
      break;
    case 'error':
      $('status').textContent = event.message;
      break;
    default:
      break;
  }
});

send({ kind: 'getSettings' });
send({ kind: 'getState' });

function applySettings(settings: Settings): void {
  if (settings.apiKey && !apiKey.value) apiKey.value = settings.apiKey;
  model.value = settings.model;
  if (settings.irLoaded && settings.irFilename) {
    const summary = $('ir-summary');
    if (summary.hidden) {
      summary.hidden = false;
      summary.textContent = `Loaded: ${settings.irFilename}`;
    }
  }
}

// ── rendering ─────────────────────────────────────────────────────────────────

function render(next: RunState): void {
  $('phase-dot').dataset['phase'] = next.phase;
  $('status').textContent = next.message;

  const active = next.phase !== 'idle' && next.phase !== 'done' && next.phase !== 'failed';
  $('start').hidden = active;
  $<HTMLButtonElement>('start').disabled = active;
  // Stop is offered while there is something to stop, and withdrawn the moment
  // it has been pressed — a button that stays live after it has been obeyed
  // reads as a button that did nothing.
  $('stop').hidden = !active || next.phase === 'stopping';

  renderCounters(next);
  renderQueue(next);
  renderTypeMap(next);
  renderProgress(next);
  renderCoverage(next);
}

function renderCounters(next: RunState): void {
  const c = next.counters;
  if (!c.fieldsTotal) {
    $('counters').hidden = true;
    return;
  }
  $('counters').hidden = false;
  $('counters').innerHTML = [
    counter(`${c.visitsBuilt}/${c.visitsTotal}`, 'visits'),
    counter(`${c.formsBuilt}/${c.formsTotal}`, 'forms'),
    counter(`${c.fieldsBuilt}/${c.fieldsTotal}`, 'fields'),
    counter(String(c.llmCalls), 'model calls'),
  ].join('');
}

function counter(value: string, label: string): string {
  return `<div class="counter"><b>${escapeHtml(value)}</b><span>${escapeHtml(label)}</span></div>`;
}

/**
 * The queue.
 *
 * Open questions first, resolved ones kept below so a reviewer can see what
 * they already decided without those decisions competing for attention.
 */
function renderQueue(next: RunState): void {
  const open = next.escalations.filter((e) => !e.resolved);
  const done = next.escalations.filter((e) => e.resolved);

  const section = $('queue-section');
  if (!next.escalations.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $('queue-count').textContent = open.length ? `${open.length} open` : 'all clear';

  const container = $('queue');
  container.innerHTML = '';

  // When several questions are the same shape, offer to take every
  // recommendation at once — the difference between a gate that costs seconds
  // and one that costs a morning.
  const batchable = open.filter((e) => e.options.length > 0 && (e.options[0]?.confidence ?? 0) >= 0.6);
  if (batchable.length > 1) {
    const bar = document.createElement('div');
    bar.className = 'card';
    bar.innerHTML =
      `<h3>${batchable.length} questions have a clear front-runner</h3>` +
      `<p class="why">You can accept each agent recommendation in one go, then review the rest individually.</p>`;
    const button = document.createElement('button');
    button.className = 'primary';
    button.textContent = `Accept ${batchable.length} recommendations`;
    button.addEventListener('click', () => {
      for (const escalation of batchable) {
        const best = escalation.options[0];
        if (best) resolve(escalation.id, { choice: 'option', optionId: best.id, at: Date.now() });
      }
    });
    bar.append(button);
    container.append(bar);
  }

  for (const escalation of open) container.append(card(escalation));
  for (const escalation of done) container.append(card(escalation));
}

function card(escalation: Escalation): HTMLElement {
  const el = document.createElement('div');
  el.className = escalation.resolved ? 'card resolved' : 'card';

  const heading = document.createElement('h3');
  heading.textContent = escalation.question;
  el.append(heading);

  const why = document.createElement('p');
  why.className = 'why';
  why.textContent = escalation.reason;
  el.append(why);

  // What it costs to be wrong, above the mechanics of being stuck.
  const stake = document.createElement('p');
  stake.className = 'stake';
  stake.textContent = escalation.consequence;
  el.append(stake);

  if (escalation.affectedCount > 0) {
    const affects = document.createElement('p');
    affects.className = 'affects';
    affects.textContent =
      escalation.affectedCount === 1
        ? 'Affects 1 entry in the specification.'
        : `Answering this settles ${escalation.affectedCount} entries in the specification.`;
    el.append(affects);
  }

  if (escalation.resolved) {
    const outcome = document.createElement('p');
    outcome.className = 'why';
    outcome.textContent =
      escalation.resolved.choice === 'option'
        ? `You chose: ${escalation.resolved.optionId}`
        : escalation.resolved.choice === 'manual'
          ? `Handled by hand${escalation.resolved.note ? `: ${escalation.resolved.note}` : ''}`
          : `Skipped${escalation.resolved.note ? `: ${escalation.resolved.note}` : ''}`;
    el.append(outcome);
    return el;
  }

  escalation.options.forEach((option, index) => {
    const button = document.createElement('button');
    button.className = 'option';
    button.setAttribute('aria-pressed', String(picked.get(escalation.id) === option.id));

    const head = document.createElement('div');
    head.className = 'option-head';
    const name = document.createElement('span');
    name.className = 'option-name';
    name.textContent = option.label;
    if (index === 0 && option.confidence >= 0.6) {
      const tag = document.createElement('span');
      tag.className = 'recommended';
      tag.textContent = 'best match';
      name.append(' ', tag);
    }
    const score = document.createElement('span');
    score.className = 'option-score';
    score.textContent = `${Math.round(option.confidence * 100)}%`;
    head.append(name, score);
    button.append(head);

    const meter = document.createElement('div');
    meter.className = 'meter';
    const fill = document.createElement('i');
    fill.style.width = `${Math.round(option.confidence * 100)}%`;
    meter.append(fill);
    button.append(meter);

    // The evidence, in the agent's own words. This is what makes the decision
    // fast: "this one revealed a coded-value editor and that one didn't" is
    // something a study builder can act on; "0.86" is not.
    const evidence = document.createElement('ul');
    evidence.className = 'evidence';
    for (const line of option.agreements.slice(0, 3)) {
      const li = document.createElement('li');
      li.textContent = line;
      evidence.append(li);
    }
    for (const line of option.conflicts.slice(0, 3)) {
      const li = document.createElement('li');
      li.className = 'no';
      li.textContent = line;
      evidence.append(li);
    }
    if (evidence.children.length) button.append(evidence);

    button.addEventListener('click', () => {
      picked.set(escalation.id, option.id);
      if (state) renderQueue(state);
    });
    el.append(button);
  });

  const actions = document.createElement('div');
  actions.className = 'card-actions';

  if (escalation.options.length) {
    const confirm = document.createElement('button');
    confirm.className = 'primary';
    confirm.textContent = 'Use this';
    confirm.disabled = !picked.has(escalation.id);
    confirm.addEventListener('click', () => {
      const choice = picked.get(escalation.id);
      if (choice) resolve(escalation.id, { choice: 'option', optionId: choice, at: Date.now() });
    });
    actions.append(confirm);
  }

  if (escalation.allowsManual) {
    const manual = document.createElement('button');
    manual.className = 'ghost';
    manual.textContent = "I'll do it by hand";
    manual.title = 'Do it yourself in the page, then let the agent carry on and verify it.';
    manual.addEventListener('click', () => {
      const note = prompt('What did you do? (recorded in the audit log)') ?? '';
      resolve(escalation.id, { choice: 'manual', note, at: Date.now() });
    });
    actions.append(manual);
  }

  const skip = document.createElement('button');
  skip.className = 'ghost';
  skip.textContent = 'Skip';
  skip.addEventListener('click', () => {
    const note = prompt('Why skip this? (recorded in the audit log)') ?? '';
    resolve(escalation.id, { choice: 'skip', note, at: Date.now() });
  });
  actions.append(skip);

  el.append(actions);
  return el;
}

function resolve(id: string, resolution: EscalationResolution): void {
  picked.delete(id);
  send({ kind: 'resolveEscalation', id, resolution });
}

function renderTypeMap(next: RunState): void {
  const section = $('typemap-section');
  if (!next.typeMap.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $('typemap').innerHTML = next.typeMap
    .slice()
    .sort((a, b) => a.canonical.localeCompare(b.canonical))
    .map(
      (entry) =>
        `<div class="map-row"><code>${escapeHtml(entry.canonical)}</code>` +
        `<span class="arrow">→</span><span>${escapeHtml(entry.libraryName)}</span>` +
        `<span class="src">${escapeHtml(entry.source)} ${Math.round(entry.confidence * 100)}%</span></div>`,
    )
    .join('');
}

function renderProgress(next: RunState): void {
  const section = $('progress-section');
  if (!next.progress.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const lines: string[] = [];
  const walk = (nodes: ProgressNode[], depth: number) => {
    for (const node of nodes) {
      const finished = node.status === 'verified' || node.status === 'built';
      if (hideFinished && finished && depth === 2) continue;
      lines.push(
        `<div class="node depth-${depth}">` +
          `<span class="chip ${node.status}">${escapeHtml(node.status)}</span>` +
          `<span class="label">${escapeHtml(node.label)}</span>` +
          (node.detail ? `<span class="detail">${escapeHtml(node.detail)}</span>` : '') +
          `</div>`,
      );
      if (node.children) walk(node.children, depth + 1);
    }
  };
  walk(next.progress, 0);
  $('progress').innerHTML = `<div class="tree">${lines.join('')}</div>`;
}

/**
 * The verification summary.
 *
 * Missing items are listed first and in full, because a form or field that
 * never got built is the failure that costs the most and is noticed the latest.
 */
function renderCoverage(next: RunState): void {
  const section = $('coverage-section');
  const rows = next.coverage;
  if (!rows?.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;

  const fields = rows.filter((r) => r.field);
  const missing = fields.filter((r) => !r.present);
  const wrong = fields.filter(
    (r) =>
      r.present &&
      [r.labelOk, r.requiredOk, r.optionsOk, r.rangeOk, r.formulaOk, r.skipOk].some((v) => v === false),
  );

  const parts: string[] = [];
  parts.push(
    `<div class="summary"><b>${fields.length - missing.length}/${fields.length}</b> fields present, ` +
      `<b class="${wrong.length ? 'cov-bad' : 'cov-good'}">${wrong.length}</b> with a property that does not match the specification.</div>`,
  );

  if (missing.length) {
    parts.push(
      `<div class="problems"><b>Missing (${missing.length})</b><ul>` +
        missing.slice(0, 25).map((r) => `<li>${escapeHtml(`${r.visit} / ${r.form} / ${r.field}`)}</li>`).join('') +
        (missing.length > 25 ? `<li>…and ${missing.length - 25} more</li>` : '') +
        `</ul></div>`,
    );
  }

  if (wrong.length) {
    parts.push(
      `<div class="problems warn"><b>Mismatched (${wrong.length})</b><ul>` +
        wrong
          .slice(0, 25)
          .map((r) => `<li>${escapeHtml(`${r.form} / ${r.field}`)} — ${escapeHtml(r.notes.slice(0, 2).join('; '))}</li>`)
          .join('') +
        (wrong.length > 25 ? `<li>…and ${wrong.length - 25} more</li>` : '') +
        `</ul></div>`,
    );
  }

  $('coverage').innerHTML = parts.join('');
}

function renderIrFeedback(ok: boolean, problems: IrProblem[], stats?: IrStats): void {
  const summary = $('ir-summary');
  const box = $('ir-problems');

  if (stats) {
    summary.hidden = false;
    summary.innerHTML =
      `<b>${stats.visits}</b> visits · <b>${stats.formInstances}</b> forms ` +
      `(<b>${stats.distinctForms}</b> distinct) · <b>${stats.fields}</b> fields · ` +
      `${stats.withOptions} coded · ${stats.withRange} with ranges · ${stats.withFormula} calculated · ` +
      `${stats.skipRules} display rules · ${stats.repeatingForms} repeating`;
  }

  if (!problems.length) {
    box.hidden = true;
    return;
  }
  const errors = problems.filter((p) => p.severity === 'error');
  box.hidden = false;
  box.className = errors.length ? 'problems' : 'problems warn';
  box.innerHTML =
    `<b>${ok ? `${problems.length} note(s)` : `${errors.length} problem(s) — the file cannot be built`}</b><ul>` +
    problems.slice(0, 12).map((p) => `<li>${escapeHtml(`${p.pointer || 'file'}: ${p.message}`)}</li>`).join('') +
    (problems.length > 12 ? `<li>…and ${problems.length - 12} more</li>` : '') +
    `</ul>`;
}

// ── helpers ───────────────────────────────────────────────────────────────────

function download(filename: string, content: string, mime: string): void {
  const blob = new Blob([content], { type: mime });
  const url = URL.createObjectURL(blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.click();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (c) =>
    c === '&' ? '&amp;' : c === '<' ? '&lt;' : c === '>' ? '&gt;' : c === '"' ? '&quot;' : '&#39;',
  );
}
