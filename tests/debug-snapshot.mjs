/** Print what the agent perceives on a page, optionally after clicking by name. */
import { chromium } from 'playwright';
import { build } from 'esbuild';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const url = process.argv[2] ?? 'http://localhost:5173/?reset=1';
const clicks = process.argv.slice(3);

const bundle = await build({
  entryPoints: [join(root, 'tests/harness/agent-in-page.ts')],
  bundle: true, write: false, format: 'iife', target: ['chrome116'], platform: 'browser', logLevel: 'warning',
});

const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
await page.goto(url, { waitUntil: 'domcontentloaded' });
await page.waitForTimeout(500);
await page.addScriptTag({ content: bundle.outputFiles[0].text });

for (const name of clicks) {
  await page.getByText(name, { exact: false }).first().click();
  await page.waitForTimeout(400);
  console.log(`\n### after clicking "${name}"\n`);
}

console.log(await page.evaluate(() => globalThis.__agentSnapshot()));
await browser.close();
