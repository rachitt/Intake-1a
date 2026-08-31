/**
 * An end-to-end harness that runs the REAL agent against a real eSource in a
 * real browser, without needing anyone to click through the extension UI.
 *
 * It bundles the actual perception, actuation, grounding, type-mapping, build
 * and verification code — the same modules the extension ships — and swaps only
 * two things:
 *
 *   - the page channel, which calls the content-script functions directly
 *     instead of posting messages across the extension boundary;
 *   - the human gate, which answers according to a stated policy and RECORDS
 *     every question, so a run reports exactly what it would have asked a
 *     person and what it did about it.
 *
 * Nothing about the agent's reasoning is stubbed. In particular the harness has
 * no knowledge of the platform under test, so a result here means the same
 * thing a result in the extension would.
 */

import { captureSnapshot } from '../../src/content/snapshot';
import {
  chooseOptionRef,
  clickRef,
  dragRef,
  pressKeyRef,
  readRef,
  setTextRef,
  setToggleRef,
} from '../../src/content/actuator';
import { diffSnapshots } from '../../src/shared/diff';
import { renderSnapshot } from '../../src/shared/snapshot';
import { irStats, validateIr } from '../../src/shared/ir';
import { Builder, type Gate } from '../../src/background/builder';
import { Designer } from '../../src/background/designer';
import { FieldDiagnostician } from '../../src/background/diagnose';
import { Gemini } from '../../src/background/gemini';
import { Grounder } from '../../src/background/grounder';
import { TypeMapper } from '../../src/background/typemap';
import { runCoverageSweep } from '../../src/background/verify';
import { Store, emptyProfile } from '../../src/background/store';
import { INTENTS } from '../../src/background/intents';
const INTENTS_LABEL = INTENTS.fieldLabel();
import type { Observation, PageLike } from '../../src/background/page';
import type { ContentCommand, Escalation, EscalationResolution, ReadValue } from '../../src/shared/protocol';
import type { Ref, Snapshot } from '../../src/shared/snapshot';

// ── the page channel, in-process ──────────────────────────────────────────────

function settle(maxMs: number): Promise<void> {
  return new Promise((resolve) => {
    const quietFor = 60;
    let timer: number | undefined;
    const observer = new MutationObserver(() => {
      if (timer !== undefined) clearTimeout(timer);
      timer = self.setTimeout(finish, quietFor);
    });
    const ceiling = self.setTimeout(finish, maxMs);
    function finish() {
      observer.disconnect();
      if (timer !== undefined) clearTimeout(timer);
      clearTimeout(ceiling);
      requestAnimationFrame(() => resolve());
    }
    observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true, characterData: true });
    timer = self.setTimeout(finish, quietFor);
  });
}

class InPage implements PageLike {
  private snapshot: Snapshot | null = null;
  actions = 0;

  async attach(): Promise<void> {
    /* already in the page */
  }

  async current(force = false): Promise<Snapshot> {
    if (this.snapshot && !force) return this.snapshot;
    return this.capture();
  }

  async capture(): Promise<Snapshot> {
    this.snapshot = captureSnapshot();
    return this.snapshot;
  }

  async act(action: ContentCommand, settleMs = 700): Promise<Observation> {
    const before = await this.current();
    this.actions++;
    const result = perform(action);
    await settle(settleMs);
    const after = this.capture ? captureSnapshot() : before;
    this.snapshot = after;
    return { ok: result.ok, detail: result.detail, before, after, diff: diffSnapshots(before, after) };
  }

  async read(ref: Ref): Promise<ReadValue | null> {
    return readRef(ref);
  }

  click(ref: Ref, settleMs?: number) { return this.act({ kind: 'click', ref }, settleMs); }
  setText(ref: Ref, value: string, settleMs?: number) { return this.act({ kind: 'setText', ref, value }, settleMs); }
  chooseOption(ref: Ref, value: string, settleMs?: number) { return this.act({ kind: 'chooseOption', ref, value }, settleMs); }
  setToggle(ref: Ref, desired: boolean, settleMs?: number) { return this.act({ kind: 'setToggle', ref, desired }, settleMs); }
  pressKey(ref: Ref, key: string, settleMs?: number) { return this.act({ kind: 'pressKey', ref, key }, settleMs); }

  async url(): Promise<string> {
    return location.href;
  }
}

function perform(command: ContentCommand): { ok: boolean; detail: string } {
  switch (command.kind) {
    case 'click': return clickRef(command.ref);
    case 'setText': return setTextRef(command.ref, command.value);
    case 'chooseOption': return chooseOptionRef(command.ref, command.value);
    case 'setToggle': return setToggleRef(command.ref, command.desired);
    case 'pressKey': return pressKeyRef(command.ref, command.key);
    case 'drag': return dragRef(command.sourceRef, command.targetRef);
    default: return { ok: false, detail: `"${command.kind}" is not an action.` };
  }
}

// ── a gate that answers by policy and records everything ──────────────────────

export type GatePolicy = 'accept-best' | 'always-skip';

interface RecordedQuestion {
  id: string;
  kind: Escalation['kind'];
  question: string;
  reason: string;
  affectedCount: number;
  options: { label: string; confidence: number; agreements: string[]; conflicts: string[] }[];
  answered: string;
}

/**
 * A reviewer's answers, keyed by escalation id.
 *
 * This is how a run measures what the tool is actually for. The agent is
 * human-in-the-loop by design: the number that matters is not what it does with
 * nobody watching, but what a study builder ends up with after clearing a queue
 * of the handful of things the agent honestly could not settle. Scoring only
 * the unattended run reports on a tool nobody would use that way.
 *
 * Answers are supplied per run and never baked into the agent, so nothing here
 * leaks a platform's vocabulary into the thing under test.
 */
export type ReviewerAnswers = Record<string, string>;

function makeGate(policy: GatePolicy, recorded: RecordedQuestion[], answers: ReviewerAnswers = {}): Gate {
  const answer = (escalation: Escalation): EscalationResolution => {
    const given = answers[escalation.id];
    if (given) {
      const match = escalation.options.find((o) => o.id === given || o.label === given);
      // An answer naming an option the agent did not offer is still an answer —
      // a reviewer may know something the agent could not see.
      return { choice: 'option', optionId: match?.id ?? given, at: Date.now() };
    }
    const best = escalation.options[0];
    // "accept-best" stands in for a reviewer taking the recommendation. It is
    // deliberately NOT a lower bar than a person would apply: below 0.5 the
    // agent has not really got a recommendation to give, so the item is skipped
    // and shows up in the report as unresolved rather than silently guessed.
    if (policy === 'accept-best' && best && best.confidence >= 0.5) {
      return { choice: 'option', optionId: best.id, at: Date.now() };
    }
    return { choice: 'skip', note: `no answer under the "${policy}" policy`, at: Date.now() };
  };

  const record = (escalation: Escalation, resolution: EscalationResolution) => {
    recorded.push({
      id: escalation.id,
      kind: escalation.kind,
      question: escalation.question,
      reason: escalation.reason,
      affectedCount: escalation.affectedCount,
      options: escalation.options.map((o) => ({
        label: o.label,
        confidence: o.confidence,
        agreements: o.agreements,
        conflicts: o.conflicts,
      })),
      answered: resolution.choice === 'option' ? `chose "${resolution.optionId}"` : resolution.choice,
    });
  };

  return {
    async raise(escalation) {
      const resolution = answer(escalation);
      escalation.resolved = resolution;
      record(escalation, resolution);
      return resolution;
    },
    async raiseAll(escalations) {
      const answers = new Map<string, EscalationResolution>();
      for (const escalation of escalations) {
        const resolution = answer(escalation);
        escalation.resolved = resolution;
        record(escalation, resolution);
        answers.set(escalation.id, resolution);
      }
      return answers;
    },
  };
}

// ── in-memory chrome.storage, so the real Store runs unmodified ───────────────

function stubChrome(): void {
  const backing = new Map<string, unknown>();
  const anyGlobal = globalThis as unknown as { chrome?: unknown };
  if (anyGlobal.chrome) return;
  anyGlobal.chrome = {
    storage: {
      local: {
        async get(keys: string | string[]) {
          const list = Array.isArray(keys) ? keys : [keys];
          const out: Record<string, unknown> = {};
          for (const key of list) if (backing.has(key)) out[key] = backing.get(key);
          return out;
        },
        async set(values: Record<string, unknown>) {
          for (const [key, value] of Object.entries(values)) backing.set(key, value);
        },
        async remove(key: string) {
          backing.delete(key);
        },
      },
    },
  };
}

// ── entry point ───────────────────────────────────────────────────────────────

export interface RunOptions {
  apiKey?: string;
  model?: string;
  policy?: GatePolicy;
  /** What a reviewer answers, keyed by escalation id. See ReviewerAnswers. */
  answers?: ReviewerAnswers;
  /** Skip the field-by-field sweep when only build behaviour is under test. */
  skipSweep?: boolean;
}

export interface RunReport {
  ok: boolean;
  error?: string;
  elapsedMs: number;
  actions: number;
  llmCalls: number;
  counters: Store['state']['counters'];
  typeMap: { canonical: string; libraryName: string; confidence: number; source: string }[];
  libraryEntries: string[];
  rejectedCommits: { name: string; why: string }[];
  provenCommit?: { name: string; provenBy: string };
  questions: RecordedQuestion[];
  coverage: Store['state']['coverage'];
  log: { level: string; message: string }[];
  irStats: ReturnType<typeof irStats> | null;
}

async function run(irText: string, options: RunOptions = {}): Promise<RunReport> {
  stubChrome();
  const started = Date.now();
  const messages: { level: string; message: string }[] = [];
  const questions: RecordedQuestion[] = [];

  const store = new Store();
  const page = new InPage();

  const log = (message: string, level: 'info' | 'warn' | 'error' = 'info') => {
    messages.push({ level, message });
    // Surfaced to the driving process so a long run is watchable.
    // eslint-disable-next-line no-console
    console.log(`[${level}] ${message}`);
  };

  try {
    const { ir, problems } = validateIr(JSON.parse(irText));
    for (const problem of problems.slice(0, 20)) log(`${problem.pointer}: ${problem.message}`, problem.severity === 'error' ? 'error' : 'warn');
    if (!ir) throw new Error('The input file did not validate.');

    store.ir = ir;
    store.settings.apiKey = options.apiKey ?? '';
    store.settings.model = options.model ?? 'gemini-2.5-flash';
    store.profile = emptyProfile(location.origin);
    store.state.irStats = irStats(ir);

    const llm = new Gemini(
      () => store.settings.apiKey,
      () => store.settings.model,
      () => store.state.counters.llmCalls++,
    );
    const grounder = new Grounder(() => store.profile!, llm, (m) => log(m, 'warn'));
    const designer = new Designer(page, grounder, store, log);
    const typeMapper = new TypeMapper(designer, store, llm, log);
    const gate = makeGate(options.policy ?? 'accept-best', questions, options.answers ?? {});
    const builder = new Builder(page, grounder, designer, typeMapper, store, gate, new FieldDiagnostician(llm, log), log);

    await builder.run();
    if (!options.skipSweep) {
      store.state.coverage = await runCoverageSweep(page, grounder, designer, store, log);
    }

    return report(true, undefined);
  } catch (err) {
    const message = err instanceof Error ? `${err.message}\n${err.stack ?? ''}` : String(err);
    log(message, 'error');
    return report(false, message);
  }

  function report(ok: boolean, error?: string): RunReport {
    return {
      ok,
      error,
      elapsedMs: Date.now() - started,
      actions: page.actions,
      llmCalls: store.state.counters.llmCalls,
      counters: store.state.counters,
      typeMap: store.state.typeMap.map((t) => ({
        canonical: t.canonical,
        libraryName: t.libraryName,
        confidence: t.confidence,
        source: t.source,
      })),
      libraryEntries: store.profile?.libraryEntries ?? [],
      rejectedCommits: store.profile?.rejectedCommits ?? [],
      provenCommit: store.profile?.commit
        ? { name: store.profile.commit.name, provenBy: store.profile.commit.provenBy }
        : undefined,
      questions,
      coverage: store.state.coverage,
      log: messages,
      irStats: store.state.irStats ?? null,
    };
  }
}

(globalThis as unknown as Record<string, unknown>)['__agentRun'] = run;

/** Debug aid: add one element of a library entry and dump the page as perceived. */
(globalThis as unknown as Record<string, unknown>)['__agentAdd'] = async (entryName: string) => {
  stubChrome();
  const store = new Store();
  store.profile = emptyProfile(location.origin);
  const page = new InPage();
  const messages: string[] = [];
  const log = (m: string) => messages.push(m);
  const llm = new Gemini(() => '', () => '', () => undefined);
  const grounder = new Grounder(() => store.profile!, llm, log);
  const designer = new Designer(page, grounder, store, log);
  const added = await designer.addElement(entryName);
  await designer.setText({ ...INTENTS_LABEL }, 'ZZProbe1234');
  return { added: added.ok, detail: added.detail, snapshot: renderSnapshot(await page.capture(), { maxNodes: 300 }), log: messages };
};

/** Debug aid: add an element, name it, add two coded values, and dump the page. */
(globalThis as unknown as Record<string, unknown>)['__agentSeed'] = async (entryName: string) => {
  stubChrome();
  const store = new Store();
  store.profile = emptyProfile(location.origin);
  const page = new InPage();
  const messages: string[] = [];
  const log = (m: string) => messages.push(m);
  const llm = new Gemini(() => '', () => '', () => undefined);
  const grounder = new Grounder(() => store.profile!, llm, log);
  const designer = new Designer(page, grounder, store, log);
  const added = await designer.addElement(entryName);
  const labelled = await designer.setText({ ...INTENTS_LABEL }, 'ZZProbe1234');
  const r1 = await designer.addOptionRow('P1', 'Probe One');
  const r2 = await designer.addOptionRow('P2', 'Probe Two');
  return {
    added: added.ok, labelled: labelled.ok, r1, r2,
    snapshot: renderSnapshot(await page.capture(), { maxNodes: 300 }),
  };
};

/** Debug aid: probe one library entry and report what the agent concluded. */
(globalThis as unknown as Record<string, unknown>)['__agentProbe'] = async (entryName: string) => {
  stubChrome();
  const store = new Store();
  store.profile = emptyProfile(location.origin);
  const page = new InPage();
  const messages: string[] = [];
  const log = (m: string) => messages.push(m);
  const llm = new Gemini(() => '', () => '', () => undefined);
  const grounder = new Grounder(() => store.profile!, llm, log);
  const designer = new Designer(page, grounder, store, log);
  const result = await designer.probeEntry(entryName);
  return {
    entry: entryName,
    observation: result.observation,
    notes: result.notes,
    cleanedUp: result.cleanedUp,
    snapshot: renderSnapshot(await page.capture(), { maxNodes: 300 }),
    log: messages,
  };
};

/** Debug aid: what the agent sees right now, as the model would be shown it. */
(globalThis as unknown as Record<string, unknown>)['__agentSnapshot'] = () =>
  renderSnapshot(captureSnapshot(), { maxNodes: 500 });
