/**
 * The wire between the three worlds of the extension.
 *
 * Note what the content script will accept: refs, values and option names.
 * There is no message that carries a selector, and no message that asks for
 * arbitrary DOM. That is the boundary enforced in the type system rather than
 * in a code-review convention — the orchestrator physically cannot become
 * dependent on one platform's markup, because it is never given any.
 */

import type { Ref, Snapshot } from './snapshot';
import type { CanonicalType, IrPointer, IrProblem, IrStats, IrStudy } from './ir';
import type { ObservedBehaviour } from './types';

// ── content script commands ───────────────────────────────────────────────────

export type ContentCommand =
  | { kind: 'ping' }
  | { kind: 'snapshot'; includeGeneric?: boolean }
  | { kind: 'click'; ref: Ref }
  | { kind: 'setText'; ref: Ref; value: string }
  | { kind: 'chooseOption'; ref: Ref; value: string }
  | { kind: 'setToggle'; ref: Ref; desired: boolean }
  | { kind: 'pressKey'; ref: Ref; key: string }
  | { kind: 'drag'; sourceRef: Ref; targetRef: Ref }
  | { kind: 'read'; ref: Ref }
  /** Click, then wait for the page to settle, then re-capture. One round trip. */
  | { kind: 'actAndObserve'; action: ContentCommand; settleMs?: number };

export interface ActOutcome {
  ok: boolean;
  detail: string;
  /** The snapshot taken after the page settled. */
  after?: Snapshot;
}

/** A control read straight back off the page, for verification. */
export interface ReadValue {
  ok: boolean;
  role: string;
  name: string;
  value: string;
  checked: boolean | null;
  options: string[];
}

export type ContentResponse =
  | { kind: 'pong'; url: string }
  | { kind: 'snapshot'; snapshot: Snapshot }
  | { kind: 'outcome'; outcome: ActOutcome }
  | { kind: 'read'; value: ReadValue | null }
  | { kind: 'error'; message: string };

// ── run state, shared with the panel ──────────────────────────────────────────

export type RunPhase =
  | 'idle'
  | 'validating'
  | 'reconnaissance'
  | 'building'
  | 'verifying'
  | 'blocked'
  /** Stop was pressed; the run is unwinding out of the page work it was in. */
  | 'stopping'
  | 'done'
  | 'failed';

export type TaskStatus = 'pending' | 'running' | 'built' | 'verified' | 'escalated' | 'skipped' | 'failed';

export interface ProgressNode {
  pointer: IrPointer;
  label: string;
  status: TaskStatus;
  detail?: string;
  children?: ProgressNode[];
}

/**
 * One thing the agent will not decide on its own.
 *
 * The design principle behind the human gate is that escalations are CLASSES,
 * not instances: "which library entry means multi_select" is asked once and
 * answered for all 6 fields that need it. A queue with one row per uncertain
 * field would make a reviewer re-verify 195 things, which saves nobody any
 * time and is explicitly called out as a failure in the brief.
 */
export interface Escalation {
  id: string;
  kind:
    | 'type_mapping'
    | 'coded_values'
    | 'skip_logic'
    | 'range_rejected'
    | 'commit_unverified'
    | 'missing_after_readback'
    | 'form_reuse'
    | 'repeating_unsupported'
    | 'grounding_failed'
    /** One field could not be built, and the agent has worked out why. */
    | 'field_build_failed';
  /** One line, written for a study builder rather than an engineer. */
  question: string;
  /** Why the agent could not settle it. */
  reason: string;
  /** What is at stake if this is answered wrongly. */
  consequence: string;
  /** How many IR entries this single decision unblocks. */
  affectedCount: number;
  /** IR pointers this blocks, so the panel can show exactly what is parked. */
  affected: IrPointer[];
  /** Ordered candidate answers, best first. */
  options: EscalationOption[];
  /** Free-text answer permitted (e.g. "I did it by hand, re-check"). */
  allowsManual: boolean;
  createdAt: number;
  resolved?: EscalationResolution;
}

export interface EscalationOption {
  id: string;
  label: string;
  /** Confidence the agent has in this candidate, 0..1. */
  confidence: number;
  /** Observations for and against, in plain language. */
  agreements: string[];
  conflicts: string[];
  /** Coverage of the probe that produced the evidence, 0..1. */
  coverage?: number;
}

export interface EscalationResolution {
  choice: 'option' | 'manual' | 'skip';
  optionId?: string;
  note?: string;
  at: number;
}

export interface AuditRecord {
  seq: number;
  at: number;
  /** Which entry of the input file this action came from. */
  pointer: IrPointer;
  /** What the agent was trying to do, in domain terms. */
  intent: string;
  /** The control it chose, described the way the page describes it. */
  chose?: { role: string; name: string };
  /** Why that control, in one line. */
  rationale?: string;
  confidence?: number;
  /** What actually happened, from the diff — not from the button's label. */
  observed?: string;
  /** Result of reading the artifact back afterwards. */
  verification?: 'pass' | 'fail' | 'not-checked';
  /**
   * Why something failed, where the agent could establish it.
   *
   * Kept structured rather than folded into `observed`, because the whole point
   * of classifying a failure is that the next step differs by cause — and a log
   * a person has to parse prose out of is not traceability.
   */
  diagnosis?: {
    cause: string;
    confidence: number;
    /** Deterministic checks, the model checked against them, or neither. */
    source: string;
    why: string;
    /** What the model suggested, kept even where the evidence overruled it. */
    modelProposal?: { cause: string; why: string; rejectedBecause?: string };
  };
  humanDecision?: string;
  level: 'info' | 'warn' | 'error';
}

export interface TypeMappingEntry {
  canonical: CanonicalType;
  /** The library entry's name, exactly as this platform words it. */
  libraryName: string;
  confidence: number;
  source: 'probed' | 'human' | 'assumed';
  observation?: ObservedBehaviour;
  agreements?: string[];
  conflicts?: string[];
}

export interface CoverageRow {
  pointer: IrPointer;
  visit: string;
  form: string;
  field?: string;
  present: boolean;
  typeOk: boolean | null;
  labelOk: boolean | null;
  requiredOk: boolean | null;
  optionsOk: boolean | null;
  rangeOk: boolean | null;
  formulaOk: boolean | null;
  skipOk: boolean | null;
  repeatingOk: boolean | null;
  notes: string[];
}

export interface RunState {
  phase: RunPhase;
  startedAt?: number;
  finishedAt?: number;
  /** Origin the profile belongs to. */
  origin?: string;
  message: string;
  progress: ProgressNode[];
  escalations: Escalation[];
  typeMap: TypeMappingEntry[];
  counters: {
    visitsBuilt: number;
    visitsTotal: number;
    formsBuilt: number;
    formsTotal: number;
    fieldsBuilt: number;
    fieldsTotal: number;
    verified: number;
    escalated: number;
    repaired: number;
    failed: number;
    llmCalls: number;
  };
  coverage?: CoverageRow[];
  irStats?: IrStats;
}

// ── panel ⇄ background ────────────────────────────────────────────────────────

export type PanelCommand =
  | { kind: 'getState' }
  | { kind: 'loadIr'; text: string; filename: string }
  | { kind: 'setApiKey'; key: string }
  | { kind: 'setModel'; model: string }
  | { kind: 'getSettings' }
  | { kind: 'start'; tabId?: number }
  | { kind: 'pause' }
  | { kind: 'resume' }
  | { kind: 'abort' }
  | { kind: 'resolveEscalation'; id: string; resolution: EscalationResolution }
  | { kind: 'exportAudit' }
  | { kind: 'exportCoverage' }
  | { kind: 'forgetProfile' };

export interface Settings {
  apiKey: string;
  model: string;
  irLoaded: boolean;
  irFilename?: string;
}

export type BackgroundEvent =
  | { kind: 'state'; state: RunState }
  | { kind: 'settings'; settings: Settings }
  | { kind: 'audit'; records: AuditRecord[] }
  | { kind: 'download'; filename: string; content: string; mime: string }
  | { kind: 'irProblems'; problems: IrProblem[]; stats?: IrStats; ok: boolean }
  | { kind: 'error'; message: string };

export type IrPayload = IrStudy;
