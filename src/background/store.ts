/**
 * Run state, the audit log, settings, and the learned platform profile.
 *
 * Two things here are load-bearing rather than plumbing:
 *
 *   - The AUDIT LOG. Every action carries the IR pointer it came from and the
 *     reason the agent chose the control it chose. The brief calls traceability
 *     non-optional in a regulated environment, and a log written after the fact
 *     is not traceability, so it is written as the run happens and exported
 *     whole.
 *
 *   - The PLATFORM PROFILE. Everything the agent learns about a particular
 *     eSource — what its library entries are called, where its real Save is,
 *     which control means "required" — lives here, keyed by origin, as DATA.
 *     None of it is in the source. That is the whole generalisation argument:
 *     learning "this one says Picklist" at runtime is legitimate; shipping
 *     "Picklist" in a constant is the failure the assignment is testing for.
 */

import { DEFAULT_MODEL, isOfferedModel } from './gemini';
import type { AuditRecord, Escalation, RunState, Settings, TypeMappingEntry } from '../shared/protocol';
import type { IrStudy } from '../shared/ir';
import type { CanonicalType } from '../shared/ir';
import type { ObservedBehaviour } from '../shared/types';
import type { Role } from '../shared/snapshot';

// ── learned platform knowledge ────────────────────────────────────────────────

/**
 * A control the agent has learned to find again, described the way the PAGE
 * describes it — role plus accessible name. Not a selector: if the platform
 * re-renders with a different DOM but the same semantics, this still resolves;
 * if the semantics change, it correctly stops resolving and the agent re-grounds.
 */
export interface LearnedControl {
  role: Role;
  name: string;
  /** Region kind it was found in, as a tie-breaker on re-resolution. */
  regionKind?: string;
  confidence: number;
  /** How it was established. */
  source: 'deterministic' | 'model' | 'probe' | 'human';
  /** Free-text justification, carried into the audit log. */
  rationale?: string;
  learnedAt: number;
}

export interface PlatformProfile {
  origin: string;
  /** Whatever the platform calls itself, read off the page. Descriptive only. */
  platformLabel?: string;
  /** Intent id → the control that satisfied it last time. */
  controls: Record<string, LearnedControl>;
  /** Canonical type → the library entry that realises it here. */
  typeMap: Partial<Record<CanonicalType, TypeMappingEntry>>;
  /** Library entry names exactly as this platform words them, in panel order. */
  libraryEntries: string[];
  /** Observations gathered while probing each library entry. */
  probes: Record<string, ObservedBehaviour>;
  /**
   * The affordance proven to persist work, established by a round trip rather
   * than by its label. Populated only once an edit has been shown to survive
   * leaving and re-entering the editor.
   */
  commit?: LearnedControl & { provenBy: string };
  /** Save-shaped controls proven NOT to persist — the near-miss decoys. */
  rejectedCommits: { name: string; why: string }[];
  /**
   * Intent id → the disclosure that has to be opened before the affordance is
   * on screen at all. Populated when an intent is found only inside a menu.
   */
  disclosures?: Record<string, { role: Role; name: string }>;
  /** Whether a form definition can be reused across visits here. null = not yet tested. */
  formReuse: 'supported' | 'unsupported' | null;
  /** How this platform models a repeating/log form, if at all. */
  repeatingControl?: LearnedControl;
  /**
   * How this designer takes a new field from its palette — by clicking the
   * entry, or by dragging it onto the canvas.
   *
   * Learned by trying, because the two fail identically from the outside: on a
   * drag-only palette a click is accepted and nothing appears, which is
   * indistinguishable from an entry that does not work at all.
   */
  paletteInteraction?: 'click' | 'drag';
  /** Notes worth showing a human. */
  notes: string[];
  updatedAt: number;
}

export function emptyProfile(origin: string): PlatformProfile {
  return {
    origin,
    controls: {},
    typeMap: {},
    libraryEntries: [],
    probes: {},
    rejectedCommits: [],
    formReuse: null,
    notes: [],
    updatedAt: Date.now(),
  };
}

// ── in-memory run state ───────────────────────────────────────────────────────

export function emptyRunState(): RunState {
  return {
    phase: 'idle',
    message: 'Load an input file to begin.',
    progress: [],
    escalations: [],
    typeMap: [],
    counters: {
      visitsBuilt: 0,
      visitsTotal: 0,
      formsBuilt: 0,
      formsTotal: 0,
      fieldsBuilt: 0,
      fieldsTotal: 0,
      verified: 0,
      escalated: 0,
      repaired: 0,
      failed: 0,
      llmCalls: 0,
    },
  };
}

/**
 * The run state, made to describe the site actually in front of the panel.
 *
 * A finished run's results belong to ONE origin. The panel outlives the tab it
 * was run against — it is a side panel, it survives that tab being closed, and
 * it is reopened against whatever is in front of it now — so without this it
 * greets you on a new site with the previous site's progress tree, its coverage
 * table, and a message saying the study is complete. That is not cosmetic: it
 * reports work as done somewhere it has not been started.
 *
 * Kept pure, and separate from the tab plumbing, because the interesting part
 * is the decision rather than the lookup: an active run must never be disturbed
 * by someone glancing at another tab, and a run that has finished must not
 * follow them to the next site.
 */
export function runStateForSite(
  state: RunState,
  origin: string,
  study: { loaded: boolean; protocolId?: string },
): { changed: boolean; state: RunState } {
  // Anything mid-flight owns the panel. Switching tabs while a build is running
  // is normal — a person checks something and comes back — and wiping the run
  // they are watching would be far worse than showing them the wrong site.
  const settled = state.phase === 'idle' || state.phase === 'done' || state.phase === 'failed';
  if (!settled || state.origin === origin) return { changed: false, state };

  // Is there anything here that belongs to the site being left? A panel that
  // has only ever been pointed at a site, without a run, has nothing to set
  // aside — and announcing "the last run was on…" when there was no run is a
  // small lie that makes a person go looking for results that never existed.
  const carriesResults =
    state.phase !== 'idle' ||
    state.progress.length > 0 ||
    state.escalations.length > 0 ||
    Boolean(state.startedAt) ||
    Boolean(state.coverage);

  if (!carriesResults) return { changed: true, state: { ...state, origin } };

  const previous = state.origin;
  const wasOn = previous ? ` The last run was on ${previous}, so its results are not shown here.` : '';
  return {
    changed: true,
    state: {
      ...emptyRunState(),
      origin,
      message: study.loaded
        ? `Ready to build ${study.protocolId ? `"${study.protocolId}"` : 'the loaded study'} into ${origin}.${wasOn}`
        : `Load an input file to begin.${wasOn}`,
    },
  };
}

const STORAGE = {
  settings: 'settings',
  ir: 'ir',
  profilePrefix: 'profile:',
} as const;

export class Store {
  state: RunState = emptyRunState();
  audit: AuditRecord[] = [];
  ir: IrStudy | null = null;
  irFilename = '';
  profile: PlatformProfile | null = null;
  settings: Settings = { apiKey: '', model: DEFAULT_MODEL, irLoaded: false };

  private seq = 0;
  private listeners = new Set<() => void>();
  /** Set while a run is paused waiting on the human gate. */
  paused = false;
  aborted = false;

  subscribe(fn: () => void): () => void {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  }

  notify(): void {
    for (const fn of this.listeners) fn();
  }

  // ── persistence ─────────────────────────────────────────────────────────────

  async load(): Promise<void> {
    const raw = await chrome.storage.local.get([STORAGE.settings, STORAGE.ir]);
    const settings = raw[STORAGE.settings] as Partial<Settings> | undefined;
    if (settings) this.settings = { ...this.settings, ...settings };

    // A model this build no longer offers is almost certainly one that has been
    // retired, and a retired name is not a degraded run — it is an HTTP 404 on
    // every call. Migrating it here is what makes updating the list actually
    // fix anything: without this, anyone who has used the tool once keeps the
    // dead name forever, because a stored setting always beats a new default.
    if (!isOfferedModel(this.settings.model)) {
      this.settings.model = DEFAULT_MODEL;
      await this.saveSettings();
    }

    const ir = raw[STORAGE.ir] as { study: IrStudy; filename: string } | undefined;
    if (ir?.study) {
      this.ir = ir.study;
      this.irFilename = ir.filename ?? '';
      this.settings.irLoaded = true;
      this.settings.irFilename = this.irFilename;
    }
  }

  async saveSettings(): Promise<void> {
    await chrome.storage.local.set({ [STORAGE.settings]: this.settings });
  }

  async saveIr(study: IrStudy, filename: string): Promise<void> {
    this.ir = study;
    this.irFilename = filename;
    this.settings.irLoaded = true;
    this.settings.irFilename = filename;
    await chrome.storage.local.set({ [STORAGE.ir]: { study, filename } });
    await this.saveSettings();
  }

  async loadProfile(origin: string): Promise<PlatformProfile> {
    const key = STORAGE.profilePrefix + origin;
    const raw = await chrome.storage.local.get(key);
    const stored = raw[key] as PlatformProfile | undefined;
    this.profile = stored ?? emptyProfile(origin);
    return this.profile;
  }

  async saveProfile(): Promise<void> {
    if (!this.profile) return;
    this.profile.updatedAt = Date.now();
    await chrome.storage.local.set({ [STORAGE.profilePrefix + this.profile.origin]: this.profile });
  }

  async forgetProfile(origin: string): Promise<void> {
    await chrome.storage.local.remove(STORAGE.profilePrefix + origin);
    this.profile = emptyProfile(origin);
  }

  // ── audit ───────────────────────────────────────────────────────────────────

  log(record: Omit<AuditRecord, 'seq' | 'at'>): AuditRecord {
    const full: AuditRecord = { ...record, seq: ++this.seq, at: Date.now() };
    this.audit.push(full);
    // Keep memory bounded on very long runs; the export streams the whole log,
    // so trimming the in-memory tail is a UI concern only.
    if (this.audit.length > 20000) this.audit.splice(0, 5000);
    return full;
  }

  /**
   * The audit log as JSONL — one self-contained record per line, which is what
   * makes it greppable and diffable outside this tool.
   */
  exportAudit(): string {
    const header = {
      kind: 'esource-agent-audit',
      version: 1,
      exportedAt: new Date().toISOString(),
      origin: this.profile?.origin,
      protocol: this.ir?.study?.protocol_id,
      irFile: this.irFilename,
      typeMap: this.state.typeMap,
    };
    return [JSON.stringify(header), ...this.audit.map((r) => JSON.stringify(r))].join('\n');
  }

  exportCoverage(): string {
    const rows = this.state.coverage ?? [];
    const cols = [
      'pointer', 'visit', 'form', 'field', 'status', 'present', 'readable', 'typeOk', 'labelOk', 'requiredOk',
      'optionsOk', 'rangeOk', 'formulaOk', 'skipOk', 'repeatingOk', 'notes',
    ];
    const escape = (v: unknown) => {
      const s = v === null || v === undefined ? '' : Array.isArray(v) ? v.join('; ') : String(v);
      return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
    };
    return [
      cols.join(','),
      ...rows.map((r) => cols.map((c) => escape((r as unknown as Record<string, unknown>)[c])).join(',')),
    ].join('\n');
  }

  // ── convenience mutators ────────────────────────────────────────────────────

  setPhase(phase: RunState['phase'], message: string): void {
    this.state.phase = phase;
    this.state.message = message;
    this.notify();
  }

  addEscalation(escalation: Escalation): void {
    this.state.escalations.push(escalation);
    this.state.counters.escalated++;
    this.notify();
  }

  recordTypeMapping(entry: TypeMappingEntry): void {
    const existing = this.state.typeMap.findIndex((t) => t.canonical === entry.canonical);
    if (existing >= 0) this.state.typeMap[existing] = entry;
    else this.state.typeMap.push(entry);
    if (this.profile) this.profile.typeMap[entry.canonical] = entry;
    this.notify();
  }
}

export const store = new Store();
