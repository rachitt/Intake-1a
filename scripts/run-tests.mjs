/**
 * Run the unit tests.
 *
 * The tests are TypeScript because they exercise the extension's own modules
 * rather than a copy of them — a test written against a re-implementation of
 * the rule it is checking proves nothing. So they are bundled with the same
 * esbuild the extension is built with and handed to `node --test`.
 *
 *   node scripts/run-tests.mjs [pattern]
 *
 * Anything under `tests/unit/*.test.ts` is picked up.
 */

import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { readdir, rm, mkdir } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const source = join(root, 'tests', 'unit');
const out = join(root, 'node_modules', '.cache', 'unit-tests');
const pattern = process.argv[2];

const entries = (await readdir(source))
  .filter((f) => f.endsWith('.test.ts'))
  .filter((f) => !pattern || f.includes(pattern))
  .map((f) => join(source, f));

if (!entries.length) {
  console.error(`No test files found in tests/unit${pattern ? ` matching "${pattern}"` : ''}.`);
  process.exit(2);
}

await rm(out, { recursive: true, force: true });
await mkdir(out, { recursive: true });

await build({
  entryPoints: entries,
  outdir: out,
  outExtension: { '.js': '.mjs' },
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: ['node18'],
  sourcemap: 'inline',
  logLevel: 'warning',
  // Bundled so the tests import the real modules by path; nothing in what they
  // exercise reaches for a browser or an extension API.
  external: ['node:*'],
});

// Named explicitly rather than by directory: `--test <dir>` only picks up
// files matching Node's own naming convention, and these are bundles.
const built = (await readdir(out)).filter((f) => f.endsWith('.mjs')).map((f) => join(out, f));
const child = spawn(process.execPath, ['--test', ...built], { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
