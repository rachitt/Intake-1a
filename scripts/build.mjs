import { build, context } from 'esbuild';
import { cp, mkdir, rm } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const out = resolve(root, 'dist');
const watch = process.argv.includes('--watch');

/**
 * Three independent bundles, because an MV3 extension has three worlds:
 *
 *   background/  service worker  — the orchestrator. ESM, since MV3 allows it.
 *   content/     page world      — perception + actuation. IIFE, injected on demand.
 *   panel/       side panel      — the human gate. IIFE, loaded from panel.html.
 *
 * No content hashing: the manifest names these files, and a stable name is
 * what makes "load unpacked, reload" cheap during development.
 */
const targets = [
  { in: 'src/background/index.ts', out: 'background.js', format: 'esm' },
  { in: 'src/content/index.ts', out: 'content.js', format: 'iife' },
  { in: 'src/panel/index.ts', out: 'panel.js', format: 'iife' },
];

async function copyStatic() {
  await cp(resolve(root, 'src/manifest.json'), resolve(out, 'manifest.json'));
  await cp(resolve(root, 'src/panel/panel.html'), resolve(out, 'panel.html'));
  await cp(resolve(root, 'src/panel/panel.css'), resolve(out, 'panel.css'));
  await cp(resolve(root, 'src/icons'), resolve(out, 'icons'), { recursive: true });
}

async function run() {
  await rm(out, { recursive: true, force: true });
  await mkdir(out, { recursive: true });

  const configs = targets.map((t) => ({
    entryPoints: [resolve(root, t.in)],
    outfile: resolve(out, t.out),
    bundle: true,
    format: t.format,
    target: ['chrome116'],
    platform: 'browser',
    sourcemap: watch ? 'inline' : false,
    minify: !watch,
    legalComments: 'none',
    logLevel: 'info',
  }));

  if (watch) {
    const ctxs = await Promise.all(configs.map((c) => context(c)));
    await Promise.all(ctxs.map((c) => c.watch()));
    await copyStatic();
    console.log('watching… (static files are copied once; re-run to refresh them)');
  } else {
    await Promise.all(configs.map((c) => build(c)));
    await copyStatic();
    console.log(`built -> ${out}`);
  }
}

run().catch((err) => {
  console.error(err);
  process.exit(1);
});
