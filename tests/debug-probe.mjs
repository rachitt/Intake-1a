/**
 * Open the designer, add one element of a given library entry, and print the
 * page exactly as the agent perceives it.
 *
 * This is the tool for diagnosing type mapping: if a canonical type is being
 * confused with its neighbour, the reason is visible here.
 *
 *   node tests/debug-probe.mjs "Yes/No Toggle" "Radio Buttons"
 *   node tests/debug-probe.mjs --probe "Check List"     # full probe verdict
 */

import { chromium } from 'playwright';
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const fullProbe = argv.includes('--probe');
const entries = argv.filter((a) => !a.startsWith('--'));

const bundle = await build({
  entryPoints: [join(root, 'tests/harness/agent-in-page.ts')],
  bundle: true, write: false, format: 'iife', target: ['chrome116'], platform: 'browser', logLevel: 'warning',
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5173/?reset=1', { waitUntil: 'domcontentloaded' });
await page.getByRole('button', { name: '+ Add Visit' }).click();
await page.getByLabel('Visit Name').fill('Screening');
await page.getByRole('button', { name: 'Save Visit' }).click();
await page.getByText('Screening', { exact: false }).first().click();
await page.getByRole('button', { name: /New Source Document/i }).click();
await page.getByLabel(/Name/i).first().fill('Demographics');
await page.getByRole('button', { name: /^Create/i }).click();
await page.getByRole('button', { name: /Edit/i }).first().click();
await page.waitForTimeout(400);
await page.addScriptTag({ content: bundle.outputFiles[0].text });

for (const entry of entries) {
  if (fullProbe) {
    const out = await page.evaluate((e) => globalThis.__agentProbe(e), entry);
    console.log(`\n=== ${entry} — probe verdict ===`);
    console.log('observation:', JSON.stringify(out.observation, null, 1));
    if (out.notes.length) console.log('notes:', out.notes.join(' | '));
  } else {
    const out = await page.evaluate((e) => globalThis.__agentAdd(e), entry);
    console.log(`\n=== ${entry} — added=${out.added} ${out.detail ?? ''} ===`);
    console.log(out.snapshot);
  }
}

await browser.close();
