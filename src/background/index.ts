/**
 * The service worker: wiring, and the human gate's other half.
 *
 * The gate is implemented here as a promise per question. When the agent cannot
 * settle something, it raises an escalation and awaits it; the panel resolves
 * it. Nothing under review is committed in the meantime, which is the point —
 * the brief is explicit that a tool which quietly guesses is worse than useless,
 * because a wrong field type costs more to discover after go-live than building
 * the study by hand would have.
 *
 * Questions are raised in BATCHES wherever possible, so a reviewer clears a
 * short queue in one pass instead of being interrupted 195 times.
 */

import { Builder, type Gate } from './builder';
import { Designer } from './designer';
import { FieldDiagnostician } from './diagnose';
import { Gemini } from './gemini';
import { Grounder } from './grounder';
import { Page } from './page';
import { TypeMapper } from './typemap';
import { irStats, validateIr } from '../shared/ir';
import { store } from './store';
import { runCoverageSweep } from './verify';
import type { BackgroundEvent, Escalation, EscalationResolution, PanelCommand } from '../shared/protocol';

// ── panel plumbing ────────────────────────────────────────────────────────────

chrome.runtime.onInstalled.addListener(() => {
  void chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => undefined);
});

const ports = new Set<chrome.runtime.Port>();

function broadcast(event: BackgroundEvent): void {
  for (const port of ports) {
    try {
      port.postMessage(event);
    } catch {
      ports.delete(port);
    }
  }
}

store.subscribe(() => broadcast({ kind: 'state', state: store.state }));

function log(message: string, level: 'info' | 'warn' | 'error' = 'info'): void {
  store.log({ pointer: '', intent: message, level });
  store.state.message = message;
  store.notify();
}

// ── the gate ──────────────────────────────────────────────────────────────────

const pending = new Map<string, (resolution: EscalationResolution) => void>();

const stopped = (): EscalationResolution => ({ choice: 'skip', note: 'the run was stopped', at: Date.now() });

const gate: Gate = {
  raise(escalation: Escalation): Promise<EscalationResolution> {
    // A stopped run must never open a new question. Work in progress unwinds
    // through many layers, and several of them ask before they give up — so
    // without this, pressing Stop mid-probe answers one question and is
    // immediately met with the next, which is indistinguishable from Stop not
    // working at all.
    if (store.aborted) return Promise.resolve(stopped());

    return new Promise((resolve) => {
      store.addEscalation(escalation);
      pending.set(escalation.id, (resolution) => {
        escalation.resolved = resolution;
        pending.delete(escalation.id);
        store.notify();
        resolve(resolution);
      });
      if (!store.state.escalations.some((e) => !e.resolved && e.id !== escalation.id)) {
        store.setPhase('blocked', escalation.question);
      }
    });
  },

  async raiseAll(escalations: Escalation[]): Promise<Map<string, EscalationResolution>> {
    if (store.aborted) return new Map(escalations.map((e) => [e.id, stopped()]));

    const answers = new Map<string, EscalationResolution>();
    const results = await Promise.all(
      escalations.map(async (e) => [e.id, await gate.raise(e)] as const),
    );
    for (const [id, resolution] of results) answers.set(id, resolution);
    return answers;
  },
};

// ── keeping this worker alive for the length of a run ─────────────────────────

/**
 * Everything a run consists of lives in this worker's memory: the builder's
 * call stack, the promise each open question is waiting on, the progress tree.
 * None of it is persisted, because none of it can be — an async call stack
 * halfway through a form designer cannot be written to storage and picked up
 * again.
 *
 * Manifest V3 evicts an idle service worker after about thirty seconds, and an
 * agent waiting at the human gate is, as far as Chrome is concerned, idle. That
 * is the worst possible moment to be evicted: the panel goes on showing a
 * question whose answer now has nowhere to go, and every button on it throws
 * "Attempting to use a disconnected port object" into a console nobody is
 * reading.
 *
 * Any extension API call resets the idle timer, so a run holds the worker open
 * by ticking one. This is a lifeline for the run rather than a background task,
 * so it is started with the run and cleared when the run ends.
 */
const HEARTBEAT_MS = 20_000;
let heartbeat: ReturnType<typeof setInterval> | undefined;

function holdWorkerAwake(): void {
  if (heartbeat !== undefined) return;
  heartbeat = setInterval(() => void chrome.runtime.getPlatformInfo().catch(() => undefined), HEARTBEAT_MS);
}

function letWorkerSleep(): void {
  if (heartbeat !== undefined) clearInterval(heartbeat);
  heartbeat = undefined;
}

/**
 * A marker that outlives this worker, so a run that died with it can be
 * reported rather than left looking like a run that is merely slow.
 */
const RUN_MARKER = 'runInProgress';

async function noteRunning(on: boolean): Promise<void> {
  try {
    if (on) await chrome.storage.session.set({ [RUN_MARKER]: Date.now() });
    else await chrome.storage.session.remove(RUN_MARKER);
  } catch {
    // Session storage is a convenience here, never a dependency.
  }
}

// If the marker is still set when this worker starts, the worker that set it
// did not live to clear it. Say so plainly: a half-finished study reported as
// finished is exactly the failure this tool exists to avoid.
void (async () => {
  try {
    const raw = await chrome.storage.session.get(RUN_MARKER);
    if (raw[RUN_MARKER] === undefined) return;
    await chrome.storage.session.remove(RUN_MARKER);
    store.setPhase(
      'failed',
      'The previous run was interrupted — Chrome shut the extension down while it was working, ' +
        'and a run in progress cannot survive that. Start it again: every step checks whether its ' +
        'work is already there before it builds, so nothing is duplicated and what was built stands.',
    );
  } catch {
    // Nothing to report if the marker cannot be read.
  }
})();

// ── the run ───────────────────────────────────────────────────────────────────

let running = false;

async function startRun(tabId: number): Promise<void> {
  if (running) {
    log('A run is already in progress.', 'warn');
    return;
  }
  if (!store.ir) {
    broadcast({ kind: 'error', message: 'Load an input file first.' });
    return;
  }

  running = true;
  holdWorkerAwake();
  void noteRunning(true);
  store.aborted = false;
  store.audit.length = 0;
  store.state = { ...store.state, phase: 'validating', escalations: [], typeMap: [], startedAt: Date.now() };
  store.state.counters = {
    visitsBuilt: 0, visitsTotal: 0, formsBuilt: 0, formsTotal: 0, fieldsBuilt: 0, fieldsTotal: 0,
    verified: 0, escalated: 0, repaired: 0, failed: 0, llmCalls: 0,
  };
  store.notify();

  try {
    const page = new Page(tabId);
    await page.attach();

    const url = await page.url();
    const origin = new URL(url).origin;
    store.state.origin = origin;
    await store.loadProfile(origin);
    log(`Attached to ${origin}.`);

    const llm = new Gemini(
      () => store.settings.apiKey,
      () => store.settings.model,
      () => {
        store.state.counters.llmCalls++;
        store.notify();
      },
      // A model name that had to be repaired is a run-level event, not a
      // detail of one call: it changes who answered every question afterwards.
      (message, level) => log(message, level ?? 'warn'),
    );
    if (!llm.configured) {
      log('No Gemini API key is set — the agent will use deterministic grounding only and escalate anything ambiguous.', 'warn');
    }

    const grounder = new Grounder(() => store.profile!, llm, (m) => log(m, 'warn'));
    const designer = new Designer(page, grounder, store, log);
    const typeMapper = new TypeMapper(designer, store, llm, log);
    const diagnostician = new FieldDiagnostician(llm, log);
    const builder = new Builder(page, grounder, designer, typeMapper, store, gate, diagnostician, log);

    await builder.run();

    if (!store.aborted) {
      store.setPhase('verifying', 'Reading the whole study back and comparing it with the input file…');
      store.state.coverage = await runCoverageSweep(page, grounder, designer, store, log);
      await store.saveProfile();

      const rows = store.state.coverage;
      const fields = rows.filter((r) => r.field);
      const missing = fields.filter((r) => !r.present).length;
      store.setPhase(
        'done',
        `Finished. ${fields.length - missing} of ${fields.length} fields verified` +
          (missing ? `, ${missing} missing.` : '.'),
      );
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    store.setPhase('failed', message);
    log(message, 'error');
  } finally {
    store.state.finishedAt = Date.now();
    running = false;
    letWorkerSleep();
    void noteRunning(false);
    // Said last, so nothing the run logs on its way out can talk over it.
    if (store.aborted) store.setPhase('idle', 'Stopped.');
    store.notify();
  }
}

// ── messages ──────────────────────────────────────────────────────────────────

chrome.runtime.onConnect.addListener((port) => {
  if (port.name !== 'panel') return;
  ports.add(port);
  port.onDisconnect.addListener(() => ports.delete(port));

  port.onMessage.addListener((message: PanelCommand) => {
    void handle(message, port);
  });

  void store.load().then(() => {
    port.postMessage({ kind: 'settings', settings: store.settings } satisfies BackgroundEvent);
    port.postMessage({ kind: 'state', state: store.state } satisfies BackgroundEvent);
  });
});


async function handle(message: PanelCommand, port: chrome.runtime.Port): Promise<void> {
  switch (message.kind) {
    case 'getState':
      port.postMessage({ kind: 'state', state: store.state } satisfies BackgroundEvent);
      break;

    case 'getSettings':
      port.postMessage({ kind: 'settings', settings: store.settings } satisfies BackgroundEvent);
      break;

    case 'setApiKey':
      store.settings.apiKey = message.key.trim();
      await store.saveSettings();
      port.postMessage({ kind: 'settings', settings: store.settings } satisfies BackgroundEvent);
      break;

    case 'setModel':
      store.settings.model = message.model;
      await store.saveSettings();
      port.postMessage({ kind: 'settings', settings: store.settings } satisfies BackgroundEvent);
      break;

    case 'loadIr': {
      let parsed: unknown;
      try {
        parsed = JSON.parse(message.text);
      } catch (err) {
        port.postMessage({
          kind: 'irProblems',
          ok: false,
          problems: [{ pointer: '', message: `That file is not valid JSON: ${err instanceof Error ? err.message : ''}`, severity: 'error' }],
        } satisfies BackgroundEvent);
        return;
      }

      const { ir, problems } = validateIr(parsed);
      if (!ir) {
        port.postMessage({ kind: 'irProblems', ok: false, problems } satisfies BackgroundEvent);
        return;
      }
      await store.saveIr(ir, message.filename);
      const stats = irStats(ir);
      store.state.irStats = stats;
      store.setPhase(
        'idle',
        `Loaded ${message.filename}: ${stats.visits} visits, ${stats.formInstances} forms (${stats.distinctForms} distinct), ${stats.fields} fields.`,
      );
      port.postMessage({ kind: 'irProblems', ok: true, problems, stats } satisfies BackgroundEvent);
      port.postMessage({ kind: 'settings', settings: store.settings } satisfies BackgroundEvent);
      break;
    }

    case 'start': {
      const tabId = message.tabId ?? (await activeTabId());
      if (tabId === undefined) {
        port.postMessage({ kind: 'error', message: 'No page to drive — open the eSource in a tab first.' } satisfies BackgroundEvent);
        return;
      }
      void startRun(tabId);
      break;
    }

    case 'abort':
      store.aborted = true;
      // Release anything waiting on the gate so the run can unwind cleanly.
      for (const [id, resolve] of pending) {
        resolve(stopped());
        pending.delete(id);
      }
      // The run is not over until it has unwound out of whatever page work it
      // was in the middle of; `finally` has the last word on the phase. Saying
      // "stopping" rather than "stopped" is the honest report until then.
      store.setPhase(running ? 'stopping' : 'idle', running ? 'Stopping…' : 'Stopped.');
      break;

    case 'resolveEscalation': {
      const resolve = pending.get(message.id);
      const escalation = store.state.escalations.find((e) => e.id === message.id);
      if (escalation) {
        escalation.resolved = message.resolution;
        store.log({
          pointer: escalation.affected[0] ?? '',
          intent: escalation.question,
          humanDecision:
            message.resolution.choice === 'option'
              ? `chose "${message.resolution.optionId}"`
              : message.resolution.choice === 'manual'
                ? `handled by hand: ${message.resolution.note ?? ''}`
                : `skipped: ${message.resolution.note ?? ''}`,
          level: 'info',
        });
      }
      resolve?.(message.resolution);
      if (![...pending.keys()].length && store.state.phase === 'blocked') {
        store.setPhase('building', 'Continuing.');
      }
      store.notify();
      break;
    }

    case 'exportAudit':
      port.postMessage({
        kind: 'download',
        filename: `esource-agent-audit-${stamp()}.jsonl`,
        content: store.exportAudit(),
        mime: 'application/x-ndjson',
      } satisfies BackgroundEvent);
      break;

    case 'exportCoverage':
      port.postMessage({
        kind: 'download',
        filename: `esource-agent-coverage-${stamp()}.csv`,
        content: store.exportCoverage(),
        mime: 'text/csv',
      } satisfies BackgroundEvent);
      break;

    case 'forgetProfile': {
      const origin = store.state.origin ?? (await currentOrigin());
      if (origin) {
        await store.forgetProfile(origin);
        log(`Forgot everything learned about ${origin}; the next run will rediscover it from scratch.`);
      }
      break;
    }

    default:
      break;
  }
}

async function activeTabId(): Promise<number | undefined> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab?.id;
}

async function currentOrigin(): Promise<string | null> {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab?.url) return null;
  try {
    return new URL(tab.url).origin;
  } catch {
    return null;
  }
}

function stamp(): string {
  return new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
}
