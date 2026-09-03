/**
 * Load the built extension in a real Chrome and check that it comes up.
 *
 *   node tests/verify-extension.mjs [--headed]
 *
 * This is the "can you install it and run it yourself" check, automated so the
 * README's claims about it are measured rather than remembered. It verifies the
 * three things that have to be true before anything else can be:
 *
 *   1. Chrome accepts the unpacked extension and the MV3 service worker
 *      registers without throwing.
 *   2. The side panel document loads, and its human gate renders.
 *   3. The panel can talk to the background worker over the extension's own
 *      message channel — the thing that carries escalations to a reviewer.
 *
 * It does NOT drive a build. That is what tests/run-e2e.mjs is for.
 */

import { chromium } from 'playwright';
import { mkdtemp, rm } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const dist = join(root, 'dist');
const headed = process.argv.includes('--headed');

if (!existsSync(join(dist, 'manifest.json'))) {
  console.error('dist/manifest.json is missing — run `npm run build` first.');
  process.exit(2);
}

const profile = await mkdtemp(join(tmpdir(), 'esource-ext-'));
const checks = [];
const check = (name, ok, detail = '') => {
  checks.push({ name, ok, detail });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? ` — ${detail}` : ''}`);
};

const context = await chromium.launchPersistentContext(profile, {
  headless: !headed,
  channel: 'chromium',
  args: [`--disable-extensions-except=${dist}`, `--load-extension=${dist}`],
});

try {
  // ── 1. the service worker ───────────────────────────────────────────────────
  let [worker] = context.serviceWorkers();
  if (!worker) worker = await context.waitForEvent('serviceworker', { timeout: 15000 });

  const extensionId = new URL(worker.url()).host;
  check('Chrome loaded the unpacked extension', Boolean(extensionId), `extension id ${extensionId}`);

  const workerErrors = [];
  worker.on('console', (m) => {
    if (m.type() === 'error') workerErrors.push(m.text());
  });

  // Ask the worker something only a live worker can answer.
  const alive = await worker.evaluate(() => typeof chrome !== 'undefined' && Boolean(chrome.runtime?.id));
  check('the background service worker is running', alive === true);

  // ── 2. the side panel ───────────────────────────────────────────────────────
  const panel = await context.newPage();
  const panelErrors = [];
  panel.on('pageerror', (e) => panelErrors.push(e.message));
  await panel.goto(`chrome-extension://${extensionId}/panel.html`, { waitUntil: 'domcontentloaded' });
  await panel.waitForTimeout(600);

  check('the side panel document loads', panelErrors.length === 0, panelErrors.join('; ') || 'no page errors');

  const title = await panel.title();
  check('the side panel has a title', Boolean(title), title);

  // Checked against the panel's actual structure rather than a text search.
  // "Some words that sound like a gate appeared on the page" would pass on a
  // panel whose queue never renders at all.
  const ui = await panel.evaluate(() => {
    const has = (id) => Boolean(document.getElementById(id));
    return {
      controls: document.querySelectorAll('button, input, select, [role="button"]').length,
      queue: has('queue-section') && has('queue') && has('queue-count'),
      progress: has('progress-section') && has('progress'),
      typemap: has('typemap-section') && has('typemap'),
      coverage: has('coverage-section'),
      irInput: has('ir-file'),
      run: has('start') && has('stop'),
    };
  });
  check('the panel renders its controls', ui.controls > 0, `${ui.controls} interactive control(s)`);
  check('the human-gate queue is present', ui.queue);
  check('the progress tree is present', ui.progress);
  check('the type-mapping view is present', ui.typemap);
  check('the reconciliation view is present', ui.coverage);
  check('the specification can be loaded', ui.irInput);
  check('the run controls are present', ui.run);

  // ── 3. panel → background messaging ─────────────────────────────────────────
  //
  // The channel escalations travel over. A panel that renders but cannot reach
  // the worker would show an empty queue forever and look, misleadingly, fine.
  const reply = await panel.evaluate(
    () =>
      new Promise((done) => {
        let settled = false;
        const finish = (value) => {
          if (!settled) {
            settled = true;
            done(value);
          }
        };
        setTimeout(() => finish({ ok: false, why: 'no reply within 5s' }), 5000);
        try {
          // The panel talks to the worker over a long-lived port named "panel",
          // which is the channel escalations and progress travel on. Asking for
          // the run state is the smallest question that proves it is connected.
          const port = chrome.runtime.connect({ name: 'panel' });
          port.onDisconnect.addListener(() =>
            finish({ ok: false, why: chrome.runtime.lastError?.message ?? 'the port closed' }),
          );
          port.onMessage.addListener((event) => {
            if (event?.kind === 'state' || event?.kind === 'settings') {
              finish({ ok: true, why: `the worker answered with "${event.kind}"` });
            }
          });
          port.postMessage({ kind: 'getState' });
        } catch (e) {
          finish({ ok: false, why: String(e) });
        }
      }),
  );
  check('the panel can reach the background worker', reply.ok === true, reply.why);

  check('the service worker logged no errors', workerErrors.length === 0, workerErrors.join('; ') || 'clean');
} catch (error) {
  check('the extension came up', false, error instanceof Error ? error.message : String(error));
} finally {
  await context.close();
  await rm(profile, { recursive: true, force: true });
}

const failed = checks.filter((c) => !c.ok);
console.log(`\n${checks.length - failed.length}/${checks.length} checks passed\n`);
process.exit(failed.length ? 1 : 0);
