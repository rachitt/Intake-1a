/**
 * Fail the build if the extension has learned anything about one particular
 * eSource.
 *
 * The submission stands or falls on running unchanged against platforms it has
 * never seen, so "we were careful" is not evidence. This is.
 *
 * WHAT IS BANNED, and why those things and not others:
 *
 *   - PRODUCT VOCABULARY. The names one vendor gives its widgets ("Check List",
 *     "Number (Whole)") and its debug hooks. These are the property of a single
 *     product; matching on them is precisely the shortcut being tested for.
 *   - DOM ADDRESSING outside the perception layer. Selectors, ids and class
 *     names anywhere but `src/content/` (which is the only code allowed to
 *     touch a page) and `src/panel/` (which addresses the extension's OWN UI).
 *   - The development URL of the practice mock.
 *
 * WHAT IS NOT BANNED, deliberately: canonical clinical and form-design English
 * — "visit", "source document", "required", "minimum", "coded value", "save".
 * Those are the domain's words, not a product's, and the intent catalogue is
 * built out of them on purpose. A rule that banned them would be banning the
 * agent from knowing what job it is doing.
 */

import { readdir, readFile } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const src = join(root, 'src');

/** Words that belong to one vendor's product surface and to nothing else. */
const PRODUCT_VOCABULARY = [
  'Calculated Field',
  'Check List',
  'Multi-line Textbox',
  'Single Line Textbox',
  'Number (Decimal)',
  'Number (Whole)',
  'Radio Buttons',
  'Yes/No Toggle',
  'Date/Time',
  'Save as Template',
  'Apply Pasted Values',
  'Paste Values',
  'Create New Version',
  'Element Visibility',
  'Source Documents',
  'Decimal Places',
];

/** The practice mock's debug hooks. An agent that reads these solved a different problem. */
const DEBUG_HOOKS = ['__readState', '__exportState', '__resetState', '__mockPlatform'];

/** Anything tying the code to where the practice mock happens to run. */
const ENVIRONMENT = ['localhost:5173', '127.0.0.1:5173', ':5173', 'esource-mock'];

/** DOM addressing is allowed only in the layer whose job is touching the DOM. */
const DOM_APIS = [
  'querySelector',
  'querySelectorAll',
  'getElementById',
  'getElementsByClassName',
  'getElementsByTagName',
  'closest(',
];

const DOM_ALLOWED_PREFIXES = ['content/', 'panel/'];

const failures = [];

async function walk(dir) {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) await walk(full);
    else if (/\.(ts|js|html|css)$/.test(entry.name)) await check(full);
  }
}

async function check(file) {
  const rel = relative(src, file).replace(/\\/g, '/');
  const text = await readFile(file, 'utf8');
  const lines = text.split('\n');

  lines.forEach((line, index) => {
    const at = `${rel}:${index + 1}`;

    // Comments may name a hazard in order to explain it; code may not.
    const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);

    for (const term of PRODUCT_VOCABULARY) {
      if (line.includes(term) && !isComment) {
        failures.push(`${at} contains product vocabulary "${term}" — the agent must discover this at runtime, not ship it.`);
      }
    }

    // Prose may name a hook in order to explain why it is never called; code may not.
    for (const hook of DEBUG_HOOKS) {
      if (line.includes(hook) && !isComment) {
        failures.push(`${at} references the practice mock's debug hook "${hook}".`);
      }
    }

    for (const term of ENVIRONMENT) {
      if (line.includes(term) && !isComment) {
        failures.push(`${at} hardcodes "${term}" from the practice environment.`);
      }
    }

    if (!DOM_ALLOWED_PREFIXES.some((p) => rel.startsWith(p))) {
      for (const api of DOM_APIS) {
        if (line.includes(api)) {
          failures.push(`${at} uses ${api} outside the perception layer — only src/content/ may touch a page's DOM.`);
        }
      }
    }
  });

  // A CSS-selector-shaped literal outside the layers allowed to address a DOM.
  if (!DOM_ALLOWED_PREFIXES.some((p) => rel.startsWith(p)) && /\.(ts|js)$/.test(rel)) {
    const selectorish = text.match(/['"`](?:#[a-zA-Z][\w-]*|\.[a-z][\w-]*\s*[>+~ ]\s*[\w.#[])[^'"`]*['"`]/g);
    for (const hit of selectorish ?? []) {
      failures.push(`${rel} contains a selector-shaped literal ${hit} outside the perception layer.`);
    }
  }
}

await walk(src);

if (failures.length) {
  console.error(`\nPortability check FAILED — ${failures.length} issue(s):\n`);
  for (const failure of failures) console.error(`  ✗ ${failure}`);
  console.error(
    '\nThe extension must run unchanged against an eSource it has never seen.\n' +
      'Anything specific to one platform belongs in the runtime platform profile, not in source.\n',
  );
  process.exit(1);
}

console.log('Portability check passed: no platform-specific strings, no DOM addressing outside the perception layer.');
