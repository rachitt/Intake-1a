# eSource Study Builder Agent

A Chrome extension that reads a clinical study specification and builds it into
an eSource form designer — every visit, every source document, and every field
with its type, label, required flag, coded values, range check, formula and skip
logic — with a human gate for anything it cannot settle honestly.

The point of it is that the form designer is **unknown**. Every eSource platform
has different navigation, a different DOM, a different widget library and a
different name for each field type; there is no API to rely on and no standard
to code against. So the agent contains no selectors, no element ids, no button
labels and no screen order belonging to any particular platform. It perceives a
page semantically, decides in domain vocabulary, acts, and then reads back what
actually happened.

Two mocks are included, deliberately sharing nothing but the clinical domain,
and every number below is reported for both.

---

## Status

| | Mock A | Mock B |
|---|---|---|
| Visits | 4 / 4 | 4 / 4 |
| Source documents | 28 / 28 | 28 / 28 |
| Fields | 195 / 195 | 195 / 195 |
| Property checks | **655 / 655 (100%)** | **655 / 655 (100%)** |
| Fields the agent could read back and prove | 176 / 195 | 163 / 195 |
| Questions put to the human | 0 | 5 |
| Wall clock | 140 s | 134 s |

Property checks are every type, label, required flag, coded-value pair (code
*and* label), min, max, unit, formula, display rule and repeating flag in the
specification — 655 of them across 195 fields. The figures come from
`scripts/diff-ir.mjs`, which diffs a platform's saved state against the input
file. It is a developer tool, not part of the agent.

The read-back row is deliberately lower than the one above it, and the gap is
in the *reading*, not the building. 19 fields on each platform, and 13
display rules on Mock B, are built correctly and cannot be confirmed through the
UI afterwards — their canvas previews carry no accessible name, and Mock B's
condition control reports its own label instead of its value.
[Verification](#verification) takes that apart, because a tool that overstates
what it has proven is the expensive kind of wrong.

Mock B's five questions are all one kind — *"which library entry means
`integer`?"* — asked once per canonical type rather than once per field.
Answering all five is five clicks and settles 95 fields.

---

## Contents

- [Install and run](#install-and-run)
- [Architecture](#architecture) — how the agent perceives, decides, acts and confirms
- [Mapping canonical types onto an unknown element library](#mapping-canonical-types-onto-an-unknown-element-library)
- [The human gate](#the-human-gate) — what is escalated, and what the reviewer sees
- [Portability](#portability) — how it generalises, and the evidence for it
- [Verification](#verification)
- [Failure modes](#failure-modes)
- [Performance](#performance)
- [What I'd build next, given two more weeks](#what-id-build-next-given-two-more-weeks)
- [Development](#development)
- [Assumptions](#assumptions)
- [Commands](#commands)

---

## Install and run

**Prerequisites:** Node 18+ (20+ recommended) and Chrome 116+.

```bash
npm install
npm run build          # bundles into dist/
```

In Chrome: **chrome://extensions** → enable **Developer mode** → **Load
unpacked** → select `dist/`. Pin the extension and click it to open the side
panel.

Start a platform to build into:

```bash
cd intake-takehome-2/esource-mock && npm install && npm run dev   # Mock A, :5173
cd mock-b && npm install && npm run dev                           # Mock B, :5273
```

In the side panel: load `intake-takehome-2/data/abc-101-study.ir.json`,
optionally paste a Gemini API key (it runs fine without one — see [Failure
modes](#failure-modes)), and press **Run** with the platform's tab focused.

### Running it headlessly

```bash
npm run verify              # typecheck + the portability lint + 84 unit tests
npm run verify:extension    # loads the built extension in a real Chrome (13 checks)
npm run e2e -- --ir intake-takehome-2/data/abc-101-study.ir.json
npm run diff -- <state-dump.json> intake-takehome-2/data/abc-101-study.ir.json
```

`npm run e2e` drives the same agent code the extension ships; only the page
channel and the human gate are substituted (`tests/harness/agent-in-page.ts`).
Useful flags: `--url http://localhost:5273/` for Mock B, `--headed` to watch,
`--limit 1` for a smoke run, and `--answers tests/mock-b-reviewer-answers.json`
to model a reviewer clearing the queue.

---

## Architecture

```
src/
├── shared/     types crossing all three worlds: IR, snapshot, protocol, diff
├── content/    perception (accessible names, snapshot, regions) + actuation
├── background/ orchestrator: profile, grounder, type mapping, build, verify
└── panel/      the human gate
```

The loop is **perceive → decide → act → confirm**, and the last step is the one
that matters.

### Perceive

The content script is the only code in the repository that touches the DOM. It
emits a **Semantic Snapshot**: roles, accessible names computed the way a screen
reader computes them, states, values, layout boxes, and inferred **regions**.
Elements are addressed only by opaque integer `ref`s.

Regions are inferred from shape, never from ids or classes. A cluster of many
similar activatable items with almost no inputs is a *palette*; a cluster of
labelled inputs is an *editor*; a short row of buttons hugging an edge is a
*toolbar*. That is how the agent finds "the element library" on a platform
nobody has seen — not by looking for a known container, but by noticing the
shape one always has.

### Decide

The orchestrator works in **intents** (`src/background/intents.ts`), stated in
canonical *domain* English: "persist the work done in this form designer", "set
the field's label", "enter the code a coded value stores". These are statements
of what the agent wants, never labels to match.

The **grounder** scores every node on screen against an intent — role, name
similarity, region kind, proximity, and a per-platform memory of what worked
last time — and returns either a confident choice or a refusal with its
candidates. Each intent carries an `avoid` list as well as a `lexicon`, because
form designers are full of controls that sit next to the one you want and do
something else.

Where the vocabulary is genuinely unfamiliar, a model (Gemini, optional) ranks
candidates. It is a tie-breaker, not the driver: a handful of calls across a
195-field build, and the build completes without any.

### Act

`src/content/actuator.ts` performs clicks, text entry, toggles and option
choices, handling both native form controls and custom ARIA widgets. A
`role="combobox"` div whose options do not exist in the DOM until it is opened
is driven by opening it first, then activating the option.

### Confirm

**Every action is followed by a fresh snapshot and a diff, and the diff — not
the click — is the evidence that anything happened.** Nothing is treated as
persisted until it has been read back through the UI.

Three consequences worth naming:

- **The commit affordance is proven, not believed.** The first time the agent
  saves, it saves, leaves the designer, comes back, and looks for a field it
  knows it built. Only a control that survives that round trip is recorded as
  this platform's Save. On Mock B this rejected `Apply Bulk Load` and accepted
  `Commit Changes`; on Mock A it accepted `Save`.
- **Arrival is judged by the goal, not by motion.** A click that changed the
  page is not evidence of arriving anywhere. Navigation lives once, in
  `navigate.ts`, shared by the builder and the reconciliation sweep.
- **A reconciliation sweep walks the finished study back through the UI**, field
  by field, producing a row per specification entry saying what is actually
  there. It never touches a debug hook.

### Build order

The order is a mitigation, not a preference:

- The **type is fixed when the field is created**, and the type selector is
  never touched afterwards, because changing a type silently discards whatever
  the new type cannot hold.
- **Labels are set immediately after creation**, because a field that exists but
  was never named is structurally present and semantically worthless.
- **Skip logic is a second pass** over each form, because a rule names its
  controlling field by label and that field has to exist first.
- **Re-running converges.** Everything is checked for before it is created, so a
  second run on a half-built study finishes it rather than duplicating it.

---

## Mapping canonical types onto an unknown element library

Name matching fails here by construction, and platforms make it fail on purpose.
Mock A puts `Check List` (multi-select) next to `Checkbox` (one tick). Mock B
puts `Pick Many` next to `Tick Box`, and `Free Text` next to `Free Text (Long)`.
Character similarity cannot separate those.

So the mapping is established the other way round — **by behaviour**:

1. **Probe.** Build one field from a library entry, watch what the property
   editor then offers, watch what the field renders as on the canvas, delete it.
2. **Classify.** Score that observation against every canonical type's
   *capability signature*. An entry that reveals a coded-value editor and renders
   several tick boxes **is** a multi-select, whatever it is called.
3. **Invert** to get canonical → library entry, accepting only unambiguous
   assignments: one clear winner (≥ 0.82), a clear margin over the runner-up
   (≥ 0.15), and enough of the signature actually observed (≥ 0.5 coverage).
4. **Escalate** the rest, **once per type**, with the evidence laid out — never
   per field, and never as a guess.

Names are still used, but only to decide which entry to probe first, which
affects speed and nothing else.

On Mock A this resolves all thirteen types by probing, with no questions asked.
On Mock B it resolves eight and escalates five, because Mock B genuinely does
not distinguish them behaviourally: `Number` and `Number (Precise)` offer an
identical property editor, and its date, time and datetime previews all render
as text boxes. That is the correct answer — the platform does not expose the
difference, so the agent does not invent one.

---

## The human gate

### What gets escalated

The rule is **reversibility, not confidence**.

A decision that is cheap to test is tested, not asked about. Which of two
controls sets a field's conditional display is a near-tie the agent cannot
settle by reading names — but it can set one and read it back, and if the guess
was wrong nothing is lost but a click. The same goes for navigation: going to
the wrong screen costs one click and is instantly detectable, so plausible
routes are ranked and tried in order. Refusing to choose there would not make
the agent careful, it would make it stuck, and a stuck agent reports zero.

A decision that is **irreversible or unverifiable** goes to a human:

| Kind | Why it cannot be guessed |
|---|---|
| `type_mapping` | Setting a type wrong silently discards coded values, ranges and formulas. Asked once per canonical type. |
| `grounding_failed` | Two candidates too close to separate, for an action that cannot be undone. |
| `missing_after_readback` | Fields that are not there after saving. Rebuild, or accept? |
| `commit_unverified` | Nothing could be proven to persist the work. |
| `skip_logic` | A rule whose controlling field could not be reached. |
| `repeating_unsupported` | No control for a repeating log, which can only be set at creation. |

Because escalation happens **before** the affected piece is saved, a wrong
answer is a question rather than a database migration.

### What the reviewer sees

Each card in **Needs your decision** carries, in this order:

- **The question**, in the study builder's language, not the agent's.
- **Why it is being asked** — the actual evidence: *"`Number` (1.00) and `Number
  (Precise)` (1.00) behave too much alike to choose between them safely."*
- **What it costs to be wrong**, above the mechanics of being stuck.
- **How much it settles**: *"Answering this settles 36 entries in the
  specification."*
- **The candidates**, best first, the front-runner tagged `best match`, each
  showing what agreed and what conflicted.
- **Skip** and **handle by hand** as first-class outcomes, both recorded.

When several open questions have a clear front-runner, one **Accept N
recommendations** button takes them all — the difference between a gate costing
seconds and one costing a morning. A tool that makes a study builder re-verify
all 195 fields has saved nobody any time, so the queue is five items on a
platform the agent has never seen and zero on one it has.

Every decision, escalated or not, is written to an audit log carrying the
JSON-pointer into the input file, what was chosen, why, the confidence, and what
was observed afterwards. For any element the agent created, you can say which
entry it came from and why.

---

## Portability

### Enforced structurally, not by discipline

- The content script is the only code that touches the DOM.
- `src/shared/protocol.ts` has **no message that can carry a selector**, so the
  orchestrator physically cannot receive one.
- Anything learned about a platform — what it calls its widgets, where its real
  Save lives, what it hides behind a menu — is **runtime data** in a profile
  keyed by origin, never a constant in source.
- `npm run lint:portability` fails the build on platform-specific strings and on
  DOM addressing outside the perception layer.

### The two mocks

`mock-b/` exists to attack the assumptions `mock-a` might have baked in. It
implements the same clinical domain and the same read oracle, and differs
everywhere else:

| | Mock A | Mock B |
|---|---|---|
| Navigation | list → detail → designer | three-stage **wizard** with a tab strip |
| Designer layout | palette left, inspector right | **mirrored** |
| Save | a `Save` button on the toolbar | **inside an overflow menu**, under two look-alikes |
| Choices | native `<select>` | **`role="combobox"` divs**; options do not exist until opened |
| Toggles | `<input type="checkbox">` | `role="switch"` buttons |
| Rows | `<table>` markup | `role="row"` divs |
| Labels | `<label for>` + stable ids | **`aria-labelledby`, and no id survives a render** |
| Class names | readable | generated |
| A visit is a | Visit | Timepoint |
| A form is a | Source Document | Document; a repeating one is a **Log** |
| A label is a | Label | **Question Text** |
| Required is | Required | **Mandatory** |
| Library | `Dropdown`, `Check List`, `Yes/No Toggle`, `Number (Whole)` … | `Pick One`, `Pick Many`, `Yes / No Switch`, `Number` … |
| Library order | alphabetical | by frequency of use |

Mock B has its own traps: `Pick One` and `Pick Many` differ by a word and are
single- and multi-select; `Tick Box` sits directly under `Pick Many` and is a
single tick, not a list; `Option Buttons` shares no word with `Pick One` and is
nonetheless its closest relative.

It is a fair platform, not a hostile one. Two defects found while testing were
fixed in the mock rather than worked around in the agent, because they made it
unfair rather than merely unfamiliar: it rebuilt its entire DOM on every
keystroke (destroying the element being typed into — no real framework does
this), and its comboboxes named the wrapper around the widget rather than the
widget, leaving the control anonymous to anything reading the page as a screen
reader would.

### What running against a second platform found

The first run against Mock B, with the agent unchanged, scored:

```
visits 4/4    forms 27/28    fields 0/195    property checks 27/35
```

Everything above the field level generalised. Nothing below it survived, for one
reason: Mock B keeps Save inside an overflow menu, the agent only ever looked at
the visible screen, and Mock B discards a designer's working copy when you
navigate away. Every form was built perfectly and then thrown away. It did not
claim otherwise — it escalated *"Which control on this screen is used to save
the form?"* for every form and reported `0 fields verified`.

Four gaps, all closed platform-neutrally, with Mock A held at 655/655 throughout:

**1. Affordances hidden one click deep.** The agent now looks inside disclosures
when an intent cannot be satisfied on screen — recognised **structurally**, by
`aria-haspopup` or `aria-expanded="false"`, never by matching "More" or "⋯".
Only nodes the click *added* are considered, so it cannot re-find what it
already rejected; a disclosure that revealed nothing is closed again; and what
it learns is remembered per platform. `0 → 41` of 47 fields on the first visit.

**2. Stale handles after a re-render.** Two variants, both silent. Choices were
*verified* through a ref the re-render had destroyed, so a choice that worked
read back as a failure. Worse, all candidates were ranked from one snapshot and
acted on in turn — trying the first re-rendered the page and killed every later
ref, so the second failed with *"that control is no longer on the page"*, which
reads as "this platform cannot do that" when the control was still on screen.
This cost all thirteen display rules.

**3. Matching a form against the whole screen.** Source documents are routinely
named after the visit holding them — this study has a form called *End of
Treatment* under a visit called *End of Treatment (Week 12)* — and the screen
says the visit's name in its heading and again in its breadcrumb. The agent
found that, concluded the form existed, and never built it. Existence is now
checked among the list rows, falling back to the broad check where a platform
lists documents as something else: a duplicate is cheap, an absence is not.

**4. Vocabulary narrower than the domain.** A visit window *opens* and *closes*
as readily as it *starts* and *ends*. Both are ordinary clinical English.

### Untested

Being specific about this is more useful than a claim of generality:

- A combobox that portals its listbox to `document.body` rather than rendering
  it in place.
- An element library with **group headings**, which may not read as a single
  uniform palette region.
- Canvas virtualisation — a form long enough that its later fields are not in
  the DOM until scrolled to.
- `<iframe>`-hosted designers. The content script runs in the top frame.
- Drag-and-drop-only palettes. There is a drag fallback, and it fires whenever a
  click adds nothing, but both mocks add an element on click — so it has never
  been exercised against a platform that genuinely requires it.
- Non-English platform vocabulary. The intent lexicons are English.

---

## Verification

Three independent checks, run against both platforms. They agree on what was
built and disagree — usefully — on what can be proven afterwards.

**1. An external diff of the platform's saved state.** `scripts/diff-ir.mjs`
compares the study each platform actually saved against the input file, field by
field and property by property. It is a developer tool, not part of the agent,
and it is the closest thing here to ground truth:

```
Mock A:  visits 4/4   forms 28/28   fields 195/195   property checks 655/655 (100.0%)
Mock B:  visits 4/4   forms 28/28   fields 195/195   property checks 655/655 (100.0%)
```

**2. The agent's own read-back.** The reconciliation sweep re-opens all 28
documents and selects all 195 fields through the UI, reading each property out
of the property editor. It never touches a debug hook, so it is limited to what
the platform is willing to say on screen:

| | Mock A | Mock B |
|---|---|---|
| verified | 176 | 163 |
| unverified | 19 | 19 |
| properties that do not match | 0 | 13 |
| missing | 0 | 0 |

Those four categories used to be two, and collapsing them hid things in both
directions. **`unverified` is not `missing`:** those 19 fields are on the form,
but their canvas preview carries no accessible name, so nothing about them could
be read — and calling that missing sends a reviewer to rebuild a field that is
already there. **`wrong properties` is not `verified`:** a study whose dates had
all been built as free text would otherwise pass its own reconciliation at
195/195, a number that would mean only that 195 things existed.

Mock B's 13 are a false negative, and the by-hand check below is what settled
it — the display rules did persist. The sweep reads Mock B's condition control
and gets `Show Only When…`, which is the control's own label, rather than the
field it is set to.

So the honest reading is: 655/655 built on both, 176 and 163 fields the agent
can *prove* it built, and a reading layer that is behind the building layer on
both platforms. That gap is the first thing in
[what I'd build next](#what-id-build-next-given-two-more-weeks).

**3. By-hand verification.** Both saved studies were dumped with `__readState()`
from the DevTools console — the method the brief itself recommends over clicking
through 28 forms — and compared against the input file entry by entry, with the
two disagreements above chased down individually. Both platforms give the same
answers:

| Checked by hand | Mock A | Mock B |
|---|---|---|
| Fields present, under the right form and visit | 195 / 195 | 195 / 195 |
| Coded-value pairs carrying **both** a code and a label, in order | 163 / 163 | 163 / 163 |
| Formula fields (`Body Mass Index`, `Pulse Pressure` ×4, `QTcF Interval` ×2) | 7 / 7 | 7 / 7 |
| Range and unit (`Height` 100–250 `cm`, `Body Temperature` 34–42 `C`, `QT Interval` 200–700 `ms`, …) | correct | correct |
| Forms marked repeating (Medical History, Prior and Concomitant Medications, Adverse Events, Concomitant Medications) | 4 / 4 | 4 / 4 |
| Display rules naming the right controlling field **and** the right value | 13 / 13 | 13 / 13 |

Nothing was found built wrongly. What by-hand checking has found, twice now, is
the *reporting* being wrong: first the sweep claiming 0/188 on a study the diff
scored 195/195 — duplicated navigation logic that had drifted, coded values read
one row out because a field's own label box outranks them lexically, and
properties read off the canvas rather than the property editor, because a canvas
preview is named after the field it previews — and now the 13 display rules it
reads as unset. All of them false negatives, which is the direction to fail in,
but an honest self-report that cries wolf is not much better than one that does
not report at all.

---

## Failure modes

**No model available.** Every number in this document is a no-model result. The
runs reported here had a key configured and attempted model calls — two on
Mock A, three on Mock B — and every one of them failed. Neither build noticed.
The agent logs *"the model could not be consulted… probing on name similarity
instead"* and carries on from probing and region shape alone.

A model id is also the one piece of vendor vocabulary the agent cannot discover
from the page, so it is the one thing here that goes stale on its own — and it
goes stale silently, as an HTTP 404 on every call, which reads as *"the model is
broken"* rather than *"that name was retired"*. A 404 is therefore treated as a
retired **name**: the models the key can actually reach are listed once, a
replacement is chosen from this build's preferences, and the call is retried.
The substitution is said out loud, because a run that quietly used a different
model than the one on screen is reproducible only by accident.

**Genuinely ambiguous type mappings.** When two library entries behave
identically, the agent escalates rather than guessing, once per canonical type.
Five questions on Mock B, none on Mock A.

**A palette that will not add a field on click.** A drag-only palette and a
broken palette entry fail identically from outside: the click is accepted and
nothing appears. So the agent drags before it concludes anything — at a
*region*, not a control, because an empty canvas has no controls to aim at — and
records which interaction worked in the platform profile, so a drag-only
designer is dragged from then on rather than clicked uselessly 195 more times.
`element_not_added` now means clicking *and* dragging did nothing, and the human
gate says so.

**A commit affordance it cannot prove.** If nothing survives the round trip, it
escalates `commit_unverified` rather than reporting a save that did not happen.

**A control it cannot ground.** It escalates with its top candidates and their
scores, rather than clicking the best of a bad set.

**A field that is not there after saving.** Detected by read-back and escalated
as `missing_after_readback`, with a rebuild option.

**A field it cannot read back.** Reported as *unverified*, never as missing, and
the rebuild option is **withheld** rather than offered at a low score — a
reviewer reads the options, not the confidences, and an option that is present
is one the tool is prepared to carry out. Rebuilding a field that is already on
the form duplicates it.

**A field whose properties do not match.** Reported separately from both of the
above, with the property named, because the repair is to correct that property
and not to rebuild the field.

**Results from a run that was not this one.** A side panel outlives the tab it
was run against, so it can be reopened in front of a completely different site
still showing the last study's tree, counters and "complete" message. Whose
results these are is now re-answered every time the panel is shown, and the
panel names the site it is pointed at. A run still in flight is never disturbed.

The general shape: it fails loudly, at the point of failure, with the evidence
attached — and it never reports a field as built that it has not read back. The
failure mode it is built hardest against is the quiet one, because a wrong field
type discovered after go-live costs more than building the study by hand would
have.

### Known rough edges

- **Probing is order-sensitive.** The same platform can resolve `date` by
  behaviour on one run and escalate it on another, depending on which entries
  were probed first. The agent errs toward escalating, so this costs clicks
  rather than correctness, but it should be deterministic and is not. `--limit`
  runs and full runs can therefore differ in how many questions they ask.
- **The reading layer is behind the building layer.** 19 fields on both mocks,
  and 13 display rules on Mock B, are built correctly and cannot be confirmed
  through the UI. Neither is a build defect; both make the agent's self-report
  worse than its actual work. See [Verification](#verification).

---

## Performance

**Just over two minutes** for the whole study — 4 visits, 28 source documents,
195 fields — on both platforms:

| | Mock A | Mock B |
|---|---|---|
| Wall clock | 140 s | 134 s |
| Page actions | 1,761 | 1,787 |

Roughly **0.7 seconds per field**, including the read-back of every one of them
and the full end-of-run reconciliation sweep. The comparison worth making is
that this is the task a study builder does by hand over days.

The dominant cost is the settle delay after each action, not thinking. Runs are
serial by design: a form designer holds one working copy, and parallelism would
mean racing it.

---

## What I'd build next, given two more weeks

In roughly this order, because the first two are defects and the rest are
features.

1. **Close the read-back gap.** 19 fields on both platforms and 13 display rules
   on Mock B are built correctly and cannot be proven. Neither looks hard: a
   canvas preview with no accessible name can be identified from the selection
   rather than by name, and a combobox should be read by its selected value
   rather than by its own label. This is the highest-value item in the list — it
   is the difference between *195 built* and *195 proven*, and proof is the
   whole product.
2. **Deterministic probing.** Probe every library entry once, up front, into a
   fixed classification, rather than probing lazily per outstanding type. The
   order-sensitivity above is the most annoying real defect.
3. **Distinguish types by more than rendering.** Where a property editor cannot
   separate `integer` from `decimal`, its *validation* can — enter `1.5` and see
   whether it is kept. That converts several of Mock B's five questions into
   probes, using the same "ask the platform, don't guess" method as everything
   else.
4. **A real re-run story.** Convergence is implemented and lightly tested. It
   deserves a proper suite — half-built studies, partially-correct fields,
   renamed forms — and a `--repair` mode that touches only what disagrees, which
   is what the `wrong properties` category is already asking for.
5. **Amendment diffs.** The protocol changes; the study has to change with it.
   Given two IR versions, build only the delta and report exactly what it
   touched — the thing that actually saves a site weeks, repeatedly.
6. **iframes and virtualised canvases**, the two structural gaps most likely to
   appear in a real product.
7. **A richer traceability export.** The audit log has the data; it should
   produce a signed, human-readable build record suitable for a regulatory
   binder.
8. **Escalation batching by shape.** The panel batches identical questions
   today. It should cluster *similar* ones — every range check the platform
   rejected, together, with one decision.

---

## Development

### Built with AI assistance

**Claude Code, running Claude Opus 5**, was used throughout, driven
conversationally against a live platform rather than by writing code and hoping.
Three places it was worth having:

- **The debugging loop.** What this problem rewards is *run the agent → read the
  failure → form a hypothesis → instrument → fix*, and that loop is fast with a
  model in it. Most of the fixes listed under [Portability](#portability) were
  found by adding a single diagnostic log line, running, reading the output and
  deleting the line again — including the one where every form on Mock B was
  built perfectly and then silently discarded, because Save was inside an
  overflow menu.
- **Building the adversarial second platform.** Mock B exists only to attack the
  assumptions Mock A might have baked in: 2,100 lines that ship no feature and
  produce no score. That is exactly the work that gets cut under time pressure,
  and it is where most of the evidence in this README came from.
- **Arguing about what a number means.** Splitting one "missing" count into
  missing, unverified and wrong-properties came out of pushing on what a single
  195/195 was actually claiming. The headline number got worse and started
  meaning something.

Two things to know about the other direction, since the brief asks:

- **It is fluent enough to be wrong convincingly.** The first three explanations
  for the sweep reporting `0/188` were plausible, well-argued and wrong. What
  settled it was refusing to change anything until a log line said what the
  agent had actually looked at. Every real fix here came from an observation,
  not an argument.
- **It generalises from one example unless stopped.** The steady pull is toward
  "make Mock B pass", which is how a hardcoded selector arrives one refactor at
  a time. `npm run lint:portability` exists partly as a guard against that.

### Runtime model use

The agent can consult **Gemini** as an *optional* tie-breaker for unfamiliar
vocabulary — ranking grounding candidates and library entries when names alone
cannot separate them. **Gemini 3 Flash** is the default; **Gemini 3.5 Flash
Lite** and **Gemini 3.1 Flash Lite** are also offered, and the panel picker
chooses between them. Flash-class throughout, because the model is asked only
where meaning is genuinely ambiguous, so latency per call matters more than
depth — and every answer it gives is checked against the page afterwards
regardless of who gave it.

It is never the driver. A full build makes a handful of calls and completes with
none, which is not a hypothetical: see [Failure modes](#failure-modes).

---

## Assumptions

- **Visit windows are entered as study days**, verbatim from the input file. A
  platform wanting calendar dates cannot be satisfied without a baseline date,
  which the input file does not carry. *Open question for a clinical SME: should
  the agent prompt for a baseline date, or is a day offset always available?*
- **Forms are rebuilt under each visit** rather than reused across them. The
  input has 17 distinct definitions across 28 appearances. Rebuilding is the
  choice that cannot silently produce a shared definition someone later edits at
  one visit and unknowingly changes at four. *Open question: when a platform
  supports a reusable library form, is a shared definition or a copy intended?*
- **A field's `label` is its identity**, used for skip-logic references and for
  idempotency. The input carries no stable field ids.
- **`checkbox` is a single tick; `multi_select` is a list.** This distinction is
  the single most common way a build looks finished and is not.
- **`?reset=1` between runs.** The mocks keep everything in memory. Re-run
  convergence is implemented, but the reported numbers are from clean runs.

---

## Commands

| Command | What it does |
|---|---|
| `npm run build` | Bundle into `dist/`, loadable unpacked in Chrome |
| `npm run watch` | Rebuild on change |
| `npm run typecheck` | `tsc --noEmit` |
| `npm run lint:portability` | Fail on any platform-specific string in source |
| `npm run verify` | typecheck + portability lint + unit tests |
| `npm run verify:extension` | Load the built extension in Chrome and check it comes up |
| `npm run e2e` | Drive a full build against a running platform |
| `npm run diff` | Diff a built study against the specification |
