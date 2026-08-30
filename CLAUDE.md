# CLAUDE.md

Guidance for working in this repository.

## What this is

A Chrome extension that acts as an agent: it reads a study specification (an IR
JSON file) and drives an **arbitrary** eSource form designer in the browser to
build the study — visits, source documents, and every field with its type,
label, required flag, coded values, range check, formula and skip logic — with
a human gate for anything it is not sure about.

## The one rule that overrides everything

**Nothing platform-specific may appear in extension source.** No CSS selectors,
element ids, class names, button labels, element-library entry names, screen
orders, or URLs belonging to any particular eSource. The extension is graded by
being run, unchanged, against mocks it has never seen; a single hardcoded
selector is a failed submission.

How this is enforced structurally, not by discipline:

- The content script is the only code that touches the DOM. It emits a
  **Semantic Snapshot** — roles, accessible names, states, inferred regions —
  and elements are addressed only by opaque integer `ref`s.
- `src/shared/protocol.ts` has no message that can carry a selector, so the
  orchestrator physically cannot receive one.
- Anything learned about a specific platform (what it calls its widgets, where
  its real Save is) is **runtime data** in the platform profile, keyed by
  origin, never a constant in source.
- `npm run lint:portability` fails the build on platform-specific strings.

Vocabulary in `src/background/intents.ts` is canonical *domain* English
("save", "required", "minimum", "coded value") — a statement of what the agent
wants, not a label to match. That is allowed; product-specific wording is not.

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle into `dist/`, loadable unpacked in Chrome |
| `npm run watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint:portability` | Fail on any platform-specific string in source |
| `npm run verify` | typecheck + portability lint |
| `npm run diff` | Diff a built study against the IR, for by-hand verification |

## Git conventions

- **Conventional Commits** subjects: `feat:`, `fix:`, `docs:`, `chore:`,
  `refactor:`, `test:`.
- **Never** add a `Co-Authored-By: Claude` trailer, or any AI attribution
  trailer, to commit messages.
- Commit in **batches** as coherent chunks of work complete — not one large
  commit at the end.
- Work on **feature branches** and open a PR per feature. Keep `main` clean.
- Bodies explain *why*, wrapped at 80 columns.

## Architecture

```
src/
├── shared/     types crossing all three worlds: IR, snapshot, protocol, diff
├── content/    perception (accessible names, snapshot, regions) + actuation
├── background/ orchestrator: profile, grounder, type mapping, build, verify
└── panel/      the human gate
```

Flow: **perceive → decide → act → confirm.** Every action is followed by a
fresh snapshot and a diff; the diff, not the click, is the evidence that
anything happened. Nothing is treated as persisted until it has been read back
through the UI.

## Things that are easy to get wrong here

- **Set a field's type before its dependent properties.** Platforms silently
  discard values the current type cannot hold when the type changes.
- **Coded values are `{ code, label }` pairs.** Entering labels only produces a
  field that looks right and stores the wrong thing.
- **Bulk value entry usually replaces rather than appends.** Read it back.
- **Skip logic needs its controlling field to exist first** — hence a second
  pass after all fields in a form are built.
- **Reaching a screen is not building.** Designer work lives in a working copy;
  navigating away can discard it without warning.
- **Never call the mock's `__readState()` debug hook** from extension code. It
  is a convenience for by-hand verification only and will not exist on the
  platforms that matter. `scripts/diff-ir.mjs` may use it; `src/` may not.
- **Recall beats precision.** A missing form or field is the most heavily
  penalised failure; a spurious extra one is a lesser problem.
