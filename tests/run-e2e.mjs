/**
 * Drive the agent end to end against a running eSource and report honestly.
 *
 *   node tests/run-e2e.mjs --url http://localhost:5173/ --ir <study.ir.json>
 *
 * Options:
 *   --url        the eSource to build into        (default http://localhost:5173/)
 *   --ir         the study specification          (required)
 *   --api-key    a Gemini key, or $GEMINI_API_KEY (optional)
 *   --model      model id                          (default gemini-3-flash)
 *   --headed     watch it work
 *   --out        where to write the run report     (default tests/results)
 *   --limit      build only the first N visits, for a quick smoke run
 *   --answers    JSON file of reviewer answers, keyed by escalation id — what a
 *                study builder would choose when clearing the human gate
 *
 * The agent under test is the same code the extension ships. Only the page
 * channel and the human gate are substituted — see tests/harness/agent-in-page.ts.
 */

import { chromium } from 'playwright';
import { build } from 'esbuild';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const args = parseArgs(process.argv.slice(2));
const url = args.url ?? 'http://localhost:5173/';
const irPath = args.ir;
const outDir = resolve(root, args.out ?? 'tests/results');
const apiKey = args['api-key'] ?? process.env['GEMINI_API_KEY'] ?? '';
const model = args.model ?? 'gemini-3-flash';

// What a reviewer answers at the gate. Absent this, the run measures the agent
// with nobody watching, which is not how the tool is meant to be used.
const answers = args.answers ? JSON.parse(await readFile(resolve(args.answers), 'utf8')) : {};

if (!irPath) {
  console.error('--ir <study.ir.json> is required');
  process.exit(2);
}

// ── bundle the harness ────────────────────────────────────────────────────────

const bundle = await build({
  entryPoints: [join(root, 'tests/harness/agent-in-page.ts')],
  bundle: true,
  write: false,
  format: 'iife',
  target: ['chrome116'],
  platform: 'browser',
  sourcemap: false,
  logLevel: 'warning',
});
const harnessJs = bundle.outputFiles[0].text;

// ── the study specification ───────────────────────────────────────────────────

let irText = await readFile(resolve(irPath), 'utf8');
if (args.limit) {
  const ir = JSON.parse(irText);
  ir.visits = ir.visits.slice(0, Number(args.limit));
  irText = JSON.stringify(ir);
  console.log(`Limited to the first ${args.limit} visit(s).`);
}

// ── run ───────────────────────────────────────────────────────────────────────

const browser = await chromium.launch({ headless: !args.headed });
const context = await browser.newContext({ viewport: { width: 1600, height: 1000 } });
const page = await context.newPage();

page.on('console', (message) => {
  const text = message.text();
  if (text.startsWith('[info]') || text.startsWith('[warn]') || text.startsWith('[error]')) console.log(text);
});
page.on('pageerror', (err) => console.error('page error:', err.message));

const target = url.includes('?') ? `${url}&reset=1` : `${url}?reset=1`;
console.log(`\nOpening ${target}\n`);
await page.goto(target, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(700);

await page.addScriptTag({ content: harnessJs });

const started = Date.now();
const report = await page.evaluate(
  async ({ irText, apiKey, model, answers }) => {
    const run = globalThis.__agentRun;
    return run(irText, { apiKey, model, policy: 'accept-best', answers });
  },
  { irText, apiKey, model, answers },
  { timeout: 0 },
);

// ── what the platform actually contains ───────────────────────────────────────
//
// This is the ONLY place a mock's debug dump is used: to grade the agent from
// the outside. The agent itself never touched it.
const dump = await page.evaluate(() => {
  const hook = globalThis['__' + 'exportState'];
  return typeof hook === 'function' ? hook() : null;
});

await mkdir(outDir, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const reportPath = join(outDir, `run-${stamp}.json`);
await writeFile(reportPath, JSON.stringify(report, null, 2));
if (dump) await writeFile(join(outDir, `state-${stamp}.json`), dump);

if (args.headed) await page.waitForTimeout(3000);
await browser.close();

// ── summary ───────────────────────────────────────────────────────────────────

const wall = ((Date.now() - started) / 1000).toFixed(1);
console.log('\n' + '─'.repeat(72));
console.log(`  ${report.ok ? 'RUN COMPLETED' : 'RUN FAILED'}   ${wall}s wall clock, ${report.actions} page actions, ${report.llmCalls} model calls`);
console.log('─'.repeat(72));

if (report.error) console.log(`\n  error: ${report.error.split('\n')[0]}`);

const c = report.counters;
console.log(`\n  built:    ${c.visitsBuilt}/${c.visitsTotal} visits, ${c.formsBuilt}/${c.formsTotal} forms, ${c.fieldsBuilt}/${c.fieldsTotal} fields`);
console.log(`  verified: ${c.verified} fields read back, ${c.failed} failures`);

if (report.libraryEntries.length) {
  console.log(`\n  element library found (${report.libraryEntries.length}): ${report.libraryEntries.join(' · ')}`);
}

if (report.typeMap.length) {
  console.log('\n  type mapping established by probing:');
  for (const entry of [...report.typeMap].sort((a, b) => a.canonical.localeCompare(b.canonical))) {
    console.log(`    ${entry.canonical.padEnd(14)} → ${entry.libraryName.padEnd(24)} ${(entry.confidence * 100).toFixed(0)}% (${entry.source})`);
  }
}

if (report.provenCommit) {
  console.log(`\n  commit affordance proven: "${report.provenCommit.name}" — ${report.provenCommit.provenBy}`);
}
if (report.rejectedCommits.length) {
  console.log('  save look-alikes rejected:');
  for (const rejected of report.rejectedCommits) console.log(`    "${rejected.name}" — ${rejected.why}`);
}

if (report.questions.length) {
  console.log(`\n  the human gate was asked ${report.questions.length} question(s):`);
  for (const question of report.questions) {
    console.log(`    [${question.kind}] ${question.question}`);
    console.log(`      affects ${question.affectedCount} entr${question.affectedCount === 1 ? 'y' : 'ies'} — ${question.answered}`);
  }
} else {
  console.log('\n  the human gate was not needed.');
}

if (report.coverage?.length) {
  const fields = report.coverage.filter((r) => r.field);
  const missing = fields.filter((r) => !r.present);
  console.log(`\n  reconciliation: ${fields.length - missing.length}/${fields.length} fields found by reading the platform back`);
}

console.log(`\n  report: ${reportPath}`);
if (dump) console.log(`  state:  ${join(outDir, `state-${stamp}.json`)}`);
console.log('');

process.exit(report.ok ? 0 : 1);

function parseArgs(argv) {
  const out = {};
  for (let i = 0; i < argv.length; i++) {
    const token = argv[i];
    if (!token.startsWith('--')) continue;
    const key = token.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) {
      out[key] = next;
      i++;
    } else {
      out[key] = true;
    }
  }
  return out;
}
