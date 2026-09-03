/** Walk the mock to its form designer and dump what the agent perceives there. */
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const bundle = await build({
  entryPoints: [join(root, 'tests/harness/agent-in-page.ts')],
  bundle: true, write: false, format: 'iife', target: ['chrome116'], platform: 'browser', logLevel: 'warning',
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto('http://localhost:5173/?reset=1', { waitUntil: 'domcontentloaded' });

await page.getByRole('button', { name: '+ Add Visit' }).click();
await page.getByLabel('Visit Name').fill('Screening');
await page.getByLabel('Window Start (day)').fill('-28');
await page.getByLabel('Window End (day)').fill('-1');
await page.getByRole('button', { name: 'Save Visit' }).click();
await page.getByText('Screening', { exact: false }).first().click();
await page.getByRole('button', { name: /New Source Document/i }).click();
await page.getByLabel(/Name/i).first().fill('Demographics');
await page.getByRole('button', { name: /^Create/i }).click();
await page.getByRole('button', { name: /Edit/i }).first().click();
await page.waitForTimeout(500);
await page.addScriptTag({ content: bundle.outputFiles[0].text });
console.log('=== FORM DESIGNER ===');
console.log(await page.evaluate(() => globalThis.__agentSnapshot()));

const editish = await page.evaluate(() =>
  [...document.querySelectorAll('button,a')].map((b) => b.textContent.trim()).filter(Boolean));
console.log('buttons on screen:', JSON.stringify(editish));
await browser.close();
