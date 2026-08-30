# Development Rules

## Default context

This repo holds many packages. `packages/coding-agent/` is the subject of a request unless it names
another one. "Agent" in a request means that CLI, not the assistant answering.

Maps and indexes: [`packages/coding-agent/DEVELOPMENT.md`](packages/coding-agent/DEVELOPMENT.md) maps
the source tree to its owning documents; [`docs/internal/README.md`](docs/internal/README.md) indexes
contributor docs ([onboarding](docs/internal/onboarding.md), [testing](docs/internal/testing.md));
[`review.md`](review.md) is the pull-request review guide; [`docs/handbook/`](docs/handbook/) is the
operator manual.

|Member|Description|
|---|---|
|`contracts/wire`|Dependency-free wire and presentation types, so a browser, a test client or a second host need not depend on coding-agent|
|`contracts/view`|Dependency-free tool view model, so a tool describes its output without constructing a terminal component|
|`packages/ai`|Multi-provider LLM client with streaming support|
|`packages/catalog`|Model catalog: bundled models.json, provider descriptors, model identity/classification|
|`packages/agent`|Agent runtime with tool calling and state management|
|`packages/coding-agent`|Main CLI application (primary focus)|
|`hosts/terminal/engine`|Terminal UI library with differential rendering|
|`packages/stats`|Local observability dashboard (`veyyon stats`)|
|`packages/utils`|Shared utilities (logger, streams, temp files)|
|`packages/argot`|Per-project shorthand vocabularies: lossless substitution codec over `AGENTS.dict`. Published standalone — depends on nothing in this repo|
|`packages/hashline`|Line-anchored patch language the edit tool applies, with a pluggable filesystem backend|
|`packages/mnemopi`|Local SQLite memory engine: triples, embeddings, recall|
|`packages/tool-render`|Shared React tool-call renderers for HTML export, collab-web and the stats dashboard|
|`packages/collab-web`|Browser guest client and local relay for collab live sessions (private)|
|`packages/swarm-extension`|Swarm orchestration extension|
|`packages/evals`|Every model and agent evaluation: the DeepSWE, Terminal-Bench 3.0 and TypeScript-edit suites, harness adapters, execution backends, run store, REST/SSE API and live dashboard (private)|
|`packages/simulations`|Deterministic offline simulations driving real subsystems end to end (private)|
|`natives/bridge/addon`|The napi addon: the only Rust surface TypeScript calls (grep, glob, text measurement, highlighting, clipboard, SIXEL)|
|`natives/bridge/bindings`|Bindings for native text/image/grep operations|
|`natives/code/ast`|Structural search, replace and code-block summaries over tree-sitter and ast-grep|
|`natives/diff/kernel`|Line-comparison engine for unified diff, ported from GNU diff `compareseq` and `shift_boundaries`|
|`natives/diff/uu-diff`|`diff` as an in-process shell builtin|
|`natives/fs/iso`|Copy-on-write filesystem isolation and change diffing (APFS clonefile, Linux overlayfs, Windows ProjFS)|
|`natives/fs/uutils-ctx`|Thread-local stdio and cwd the uutils builtins run against|
|`natives/search/glob`|Glob normalization, brace expansion, depth bounds and compilation|
|`natives/search/grep-kernel`|One compiled matcher over regex and PCRE2 for every search path|
|`natives/search/uu-grep`|`grep` as an in-process shell builtin, ripgrep-backed|
|`natives/search/walker`|Parallel directory traversal with entry caching, gitignore filtering and cancellation|
|`natives/shell`|In-process POSIX shell: interpreter, coreutils builtins, output minimizer, process supervision|
|`natives/testing/scratch`|Scratch directories removed on drop, including on panic (test only)|
|`natives/text/keys`|Zero-copy parser for the Kitty keyboard protocol and legacy escape sequences|
|`natives/text/measure`|ANSI-aware width measurement, grapheme segmentation and truncation over UTF-16|
|`tests/conformance`|Whole-product conformance corpus and harness, on virtual clock, filesystem, terminal and network (test only, issue #877)|

Every `contracts/*`, `hosts/*` and `packages/*` member is TypeScript. First-party Rust is grouped
by purpose under `natives/`, vendored Rust is `natives/vendor/`, and the whole-product conformance
corpus is
`tests/conformance/`.
`contracts/*` is the interface layer: a member there has zero runtime dependencies on anything in
this repository, which
`packages/coding-agent/test/architecture/a-contract-depends-on-nothing-in-this-repository.test.ts`
enforces by sweeping the directory rather than by naming its members.
`contracts/tsconfig.workspace.json` and `packages/tsconfig.workspace.json` are shared TypeScript
config, not packages; `natives/vendor` is vendored third-party code, not a first-party crate.
`scripts/workspace-layout.ts` resolves the member list out of the root `package.json` and
`Cargo.toml`, expanding each pattern against the tree, so a member arrives covered at whatever depth
it sits and whether a glob or a literal path declares it:
`scripts/package-map-coverage.test.ts` fails when a resolved member is missing from
the table or when `ARCHITECTURE.md` grows a second copy of it,
`scripts/workspace-test-coverage.test.ts` fails when a member ships tests no bucket runs, and
`scripts/workspace-typecheck-coverage.test.ts` fails when a member declares no `check:types`.

Import catalog values — bundled models, model-thinking helpers, identity, descriptors, model
manager and cache — from `@veyyon/catalog/<module>`, never through `@veyyon/ai`. Type-only imports
of `Model`, `Api`, `ThinkingConfig` and `Effort` from `@veyyon/ai` are fine.

## Visual evidence

[`docs/handbook/src/foundations/verification.md`](docs/handbook/src/foundations/verification.md) is
the only capture authority. Read it and use it verbatim. There are no fallbacks: a capture taken any
other way is not evidence and satisfies no gate here.

### Recording UI captures

Record all visual proof through the containerized X11 capture harness on the private display:

```sh
# UI change: record After and Before pair
proof/docker/record-x11.sh proof/scenes/<name>.sh        # writes After to proof/captures/x11/
proof/docker/record-x11-before.sh proof/scenes/<name>.sh # writes Before to proof/captures/x11/before/

# Settings change: record Off and On differential
OUT_DIR=proof/captures/x11/off proof/docker/record-x11.sh proof/scenes/<name>.sh
OUT_DIR=proof/captures/x11/on SCENE_SETTINGS='<setting>: <val>' proof/docker/record-x11.sh proof/scenes/<name>.sh

# Degradation change: one pair per terminal width. OUT_DIR is a docker bind mount, so it
# has to be absolute, and both arms take it, since one directory cannot hold two arms
# whose frames share the scene's mark names. About 12 pixels per column.
for px in 960 1200 1440; do
	SCENE_WIDTH=${px} OUT_DIR="${PWD}/proof/captures/x11/w${px}" \
		proof/docker/record-x11.sh proof/scenes/<name>.sh
	SCENE_WIDTH=${px} OUT_DIR="${PWD}/proof/captures/x11/before/w${px}" \
		proof/docker/record-x11-before.sh proof/scenes/<name>.sh
done
```

### What is NOT evidence

None of these is evidence, and none satisfies any gate or PR visual requirement:

- **Off-screen ANSI PNG rasters** (`scripts/demos/render-proof.ts`). This is strictly a local debugging aid for checking ANSI contrast/fills on synthetic fixtures; it never proves reachable UI, live state, correct sizing, or window clipping. It must never be presented as satisfying visual proof requirements.
- **tmux captures** (`capture-pane`). It renders on a black ground, stripping styles and background fills.
- **Mock-ups, hand-built frames, or unpaired images**.

Two things stand beside a capture and replace neither: string/ANSI assertions that pin exact bytes,
colours and widths, and the operator's own screenshots, which are ground truth.

## UI change evidence

A pull request that changes visible UI carries a labeled **Before** and **After** pair in its body
before it can merge. Both frames show the same surface, dimensions, terminal configuration and state
apart from the intended change, and both come from the capture config above. A static change proves
with a PNG pair, an animation with a GIF/WebP pair; a still never proves an animation.

Proof frames are **embedded inline** in the pull request description as Markdown images
(`![After](https://github.com/user-attachments/assets/...)`), never pasted as monospace text
blocks, never left as bare attachments, and never linked to a path in the repository.

GitHub exposes no API for comment attachments. `gh image`, the `drogers0/gh-image` extension,
reproduces the web upload flow and prints the canonical `user-attachments` Markdown reference for
each file. It is unofficial and it is the only supported route here:

```sh
gh extension install drogers0/gh-image      # once per machine
gh image check-token                        # prints the account, or fails closed
gh image proof/captures/x11/before/<scene>.png proof/captures/x11/<scene>.png
# ![before](https://github.com/user-attachments/assets/...)
# ![after](https://github.com/user-attachments/assets/...)
```

The token comes from a browser session, so `check-token` runs before the upload rather than after a
half-written body. Pass `GH_SESSION_TOKEN` in the environment instead of `--token`, which is visible
in the process list.

One pair covers a change that alters one surface in one state. A change that alters how a surface
degrades carries a labeled pair for **every state and every width it reaches** — each composer
state, each mode combination, and each terminal width where the layout changes what it drops or
shortens. Two frames of the widest terminal prove nothing about the narrow one, which is where a
shed segment is decided. Name each pair for the state and the width it shows.

Proof frames are committed nowhere: not `assets/`, not a README, not the handbook, not the website.
The regeneration command belongs in the handbook page that owns the surface.

## GitHub

Never comment on GitHub (issues, PRs, discussions) and never create issues, unless the request says
exactly what to write.

Never write a closing keyword into a commit message, a pull request title, or a pull request body.
`Closes`, `Fixes`, `Resolves` and their variants (`close`, `closed`, `fix`, `fixed`, `resolve`,
`resolved`) are not annotations: GitHub closes the referenced issue the moment the commit reaches the
default branch, or the pull request merges. That is a state change on someone else's report, it needs
the same approval as closing the issue by hand, and a push to `main` grants no such approval.

Reference an issue with `Refs #911` or a bare `#911`. Both link the commit to the issue and close
nothing. An issue closes when the reporter has confirmed the fix in a release, and only when the
request says to close it.

A closing keyword that already landed cannot be undone by editing the commit message: reopen the
issue and say it autoclosed.

Reviewing a pull request follows [`review.md`](review.md): its section order, its reject-on-sight
list, and its rule that a finding names the file, the line and the input that breaks it. Do not
report a review as clean from the GitHub summary alone.

## Proving a feature (the 10-minute rule)

A feature is done when a demo, a settings differential and a bench exist for it, not when it
compiles. Every proof is a differential: the same surface with the feature off and on. One frame at
defaults proves nothing, because it does not show the knob doing anything.

Know which kind of change you are proving. An ephemeral change (a theme hover-preview, a one-shot
toggle) reverts, and its differential is live-vs-reverted. A settings change persists across
restarts, and its differential is off-vs-on across two launches showing the value written to config.

Every user-facing feature lands with:

1. **A committed demo under `proof/scenes/`.** It drives the real feature end to end the way a user
   reaches it, and shows it behaving differently off vs on. Not a unit test, not a snippet in a
   comment.
2. **A settings differential in the pull request body.** The settings screen with the feature off,
   then with it on, each arm seeded before the session starts rather than toggled by a keybinding
   that may not land, and both arms driven from one scene so they regenerate together. The capture
   config above states how an arm is seeded. Two identical frames, or an "on" frame that is not on,
   is a failed proof: check the bytes differ and the values changed.
3. **A committed bench with exact parity.** Same corpus, inputs and seed. The off-arm reproduces the
   pre-feature baseline to the token or the millisecond, so any delta belongs to the feature. Report
   the exact numbers.

Assert every setting the feature adds end to end: the default is honored, each non-default value
changes observable behavior, an invalid value fails loud. A setting that appears in the defaults and
never reaches behavior is a dead flag.

An experimental feature that is off hides its dependent knobs completely — not greyed out, not
inert, gone. Wire each dependent setting to a `ui.condition` that reads the master toggle. Declare
the setting in `packages/coding-agent/src/config/settings-domains/<domain>.ts` and register its
predicate in `CONDITIONS` in `packages/coding-agent/src/modes/terminal/components/selectors/settings-defs.ts`; the
selector hides any setting whose condition returns false. The off-vs-on pair proves it: off shows
only the master toggle, on shows the toggle plus its dependents.

A feature that cannot meet this bar says so in its settings group, stays off by default, hides its
dependent knobs while off, and carries a backlog row for the missing proof. It does not ship as done.

## Agents are a cost ladder, not a taxonomy

`scout`, `reviewer`, `librarian`, `designer`, `sonic` and `task` are cost lanes, not job titles, and
the model does not route by domain. The axis is how much reasoning, context and tool surface the work
needs. Certainty decides scope, not size: known edits across many files and repositories are light
work, one file of unknown work is heavy.

Enabling or disabling an agent must change where work lands, not only what the prompt says. It does
not today; the mechanism is in
[`docs/internal/task-agent-discovery.md`](docs/internal/task-agent-discovery.md) under "What the
model is actually told, and why enablement is inert". Read it before touching the roster.

- Before adding, renaming or re-describing an agent, name which spawns move to it and which move off
  it. A row that changes no behavior does not ship.
- Two agents that share a prompt body are one agent. Diff the prompts the workers receive and the
  models they resolve through `resolveSubagentModel` before claiming the prompt distinguishes them.

## Code Quality

- No `any` unless absolutely necessary.
- Never `ReturnType<>`. Name the type.
- Imports are top-level, and a type is never imported dynamically: no `import("pkg").Type`. A
  dynamic `await import()` is allowed only where a lazy boundary already exists, which is the tool
  dispatch table (`packages/coding-agent/src/tools/index.ts`), CLI command dispatch, and the
  barrels held out of TUI startup. `scripts/a-module-is-imported-at-the-top-of-its-file.test.ts`
  pins that set, so a new site elsewhere fails.
- Check `node_modules` for external API types instead of guessing.
- A third-party version that two or more packages share lives in `workspaces.catalog` in the root
  `package.json`, and each of those packages writes `"react": "catalog:"`. A dependency already in
  the catalog is never restated by a package, even at a version that agrees today. A dependency with
  one consumer may keep a literal range. Peer dependencies stay literal — a consumer outside this
  workspace cannot resolve `catalog:` — but must name the version the catalog resolves.
  `scripts/workspace-catalog-pins.test.ts` fails on the first three; it cannot see a single-consumer
  literal, which it is not meant to catch.
- Barrels use `export * from "./module"`, including for types and single-specifier cases. When stars
  create ambiguity, remove the redundant export path rather than keeping duplicates.
- Class privacy: ES `#private` fields, externally accessible members bare. No
  `private`/`protected`/`public` keyword on a field or method, except on a constructor parameter
  property where TypeScript requires it (`constructor(private readonly session: ToolSession)`) and on
  a private constructor, which has no `#` spelling. A hook a subclass overrides stays bare, since a
  `#` member cannot be overridden. `scripts/class-privacy-is-the-hash.test.ts` enforces this across
  every package, with a shrink-only allowlist for files a lane is editing right now.
- Use `Promise.withResolvers()`, not `new Promise((resolve, reject) => ...)`.
- Prompts live in static `.md` files and are imported with
  `import content from "./prompt.md" with { type: "text" }`, with Handlebars for dynamic content.
  Never build a prompt in code and never `readFile` one.
- Workers re-enter the CLI entrypoint; never spawn a separate worker entry module. Spawn sites use:

  ```ts
  import { workerHostEntry } from "@veyyon/utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```

  A new worker kind adds its selector to the dispatch table in `cli.ts`, keeps the fallback branch,
  and is validated by `veyyon --smoke-test` (wired into `ci:test:smoke` and
  `scripts/install-tests/run-ci.sh`). Add a sibling smoke if the worker sits on a different module
  graph. Mechanics and the history behind this shape:
  [`docs/internal/bun-surface.md`](docs/internal/bun-surface.md).

## Bun

Bun is the runtime and the test runner. The direction is Rust and Cargo, so new code does not grow
the Bun surface.

In new code reach for the portable option first, in this order: the language, `node:*`, POSIX
tooling, then Bun. Choose a Bun API only when no reasonable portable equivalent exists, and name the
missing equivalent in a comment.

|Need|Prefer|Not|
|---|---|---|
|Read / write a file|`fs.readFile`, `fs.writeFile` (`node:fs/promises`)|`Bun.file()`, `Bun.write()`|
|Environment variables|`process.env`|`Bun.env`|
|Run a command|`execFile` / `spawn` from `node:child_process`, or a shell script|`` $`cmd` ``, `Bun.spawn()`|
|Sleep|`setTimeout` from `node:timers/promises`|`Bun.sleep()`|
|Hashing and digests|`node:crypto`, WebCrypto|`Bun.hash()`|
|Module path|`import.meta.dirname`, `import.meta.filename`|`import.meta.dir`, `import.meta.path`|
|HTTP server|`node:http`|`Bun.serve()`|

Every spelling in the middle column runs on both Bun 1.3 and Node 22. When a Bun API is the only
option, keep it in one place: `Bun.which` is called only in `$which`
(`packages/utils/src/which.ts`).

The rule licenses neither shelling out nor a new dependency. Use `fs.mkdir(dir, { recursive: true })`
rather than a spawned `mkdir -p`, and `$which("git")` rather than a spawned `which`.
`Bun.stringWidth()`, `Bun.wrapAnsi()`, `Bun.JSON5`, `Bun.JSONL` and `bun:sqlite` have no free
portable equivalent and stay.

Existing Bun code is correct and stays. Do not migrate it opportunistically, and do not widen a diff
to convert a file: use the portable spelling on the lines you already touch. The test runner stays on
`bun:test`.

Local conventions for the Bun and Node code that is here — namespace imports, the optional-path
helpers in `@veyyon/utils`, the stream readers, and the spawn patterns — are in
[`docs/internal/bun-surface.md`](docs/internal/bun-surface.md), with the counts and history behind
this policy.

## Generated Files

Never edit `packages/catalog/src/models.json`. It is generated from upstream sources by
`packages/catalog/scripts/generate-models.ts` and the descriptors and resolvers in
`packages/catalog/src/provider-models/`; a hand-edit is overwritten on the next regen.

Change the source instead:

- Resolution rules and per-id overrides → the resolver in
  `packages/catalog/src/provider-models/openai-compat.ts` (e.g. `createOpenCodeApiResolution`'s
  id-override map).
- Provider catalog entries (default model, discovery factory and flags) → `CATALOG_PROVIDERS` in
  `packages/catalog/src/provider-models/descriptors.ts`.
- Generator-level fixups (premium multipliers, codex pricing fallback, fallback models,
  post-processing) → `packages/catalog/scripts/generate-models.ts`.
- Thinking metadata and generated policies → `applyGeneratedModelPolicies` in
  `packages/catalog/src/model-thinking.ts`; model-id classification lives in
  `packages/catalog/src/identity/classify.ts`.

Regenerate with `bun run gen:models` and commit `models.json` with the source change. Test the
resolver or descriptor, not the bundled JSON, so the test survives upstream metadata shifts.

`bun run gen:models --providers=a,b` regenerates only the named providers and carries every other
provider's rows over from the committed snapshot. It covers a provider whose discovery needs a key a
full run does not have, and it states which providers it wrote. A commit that changes a shared
generation pass regenerates in full instead, because the carried-over rows never see that pass.

## Logging

Never use `console.log`/`error`/`warn` in the coding-agent package; it corrupts TUI rendering. Use
the logger:

```typescript
import { logger } from "@veyyon/utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs rotate in `~/.veyyon/profiles/<name>/logs/veyyon.YYYY-MM-DD.log`.

## TUI Sanitization

Sanitize every string a tool renderer displays. Raw content breaks rendering: tabs open visual
holes, long lines overflow, paths leak the home directory.

- Tabs to spaces with `replaceTabs()` (`@veyyon/tui` or `../tools/render-utils`).
- Truncate with `truncateToWidth()` / `ui.truncate()` using `TRUNCATE_LENGTHS`.
- Shorten paths with `shortenPath()`.
- Take preview limits from `PREVIEW_LIMITS`; no ad-hoc numbers.

Apply this to every render path: success output, diff content added and removed, streaming previews,
and error messages, which often embed file content (a patch failure message carries unmatched lines).

A tool-call preview has several render paths. Preview-only fields and partially streamed args must
work in all of them. Streamed argument buffers decode through `decodeStreamedToolArgs` /
`ToolArgsRevealController` (`modes/terminal/controllers/tool-args-reveal.ts`) on both the live event path and
transcript rebuilds; never spread provider-parsed `arguments` next to a raw `__partialJson`, because
parsed args lag the stream by a throttled parse window.

For the bash tool:

- The pending preview needs raw `partialJson`, not parsed `arguments`, or inline env assignments
  appear only when the JSON object closes.
- Preserve preview-only fields such as `__partialJson` through `event-controller.ts`, transcript
  rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`.
- `ToolExecutionComponent.#buildRenderContext()` must work before a result exists.
- Verify the live streaming path and the rebuilt transcript path separately. A fix in one does not
  fix the other.

## Argot (project shorthand)

Argot is the codec that lets the model write short `§handle` tokens, which veyyon expands before
anything outside the model's history sees them. The integration spec is
[`packages/argot/INTEGRATING.md`](packages/argot/INTEGRATING.md); read it rather than re-deriving it.
All codec logic — longest match, the boundary rule, a handle split across token deltas — lives in
argot. Never hand-roll handle logic here.

- Every seam is wired in `packages/coding-agent/src/argot-wire.ts`, the only veyyon module that
  touches the codec: `expandToolArguments` (tool args), `expandAssistantContent` (finished display),
  `createSubagentStreamDecoder` (the live streamed preview, feeding `StreamDecoder.push`/`flush` and
  never a raw delta), `expandSessionContext` (transcript, export, resume), and `expandSubagentReturn`
  (a subagent's result to its parent).
- A user never sees a raw `§handle`. That includes the live subagent HUD preview
  (`progress.recentOutput` in `task/executor.ts`). A raw handle in any display, tool, transcript, or
  parent return is a defect.
- A new place the model's text crosses out of its history is a new seam. Route it through an
  `argot-wire.ts` function, adding a thin delegate there if none fits.
- `test/argot-subagent-*.test.ts` drive the real executor and prove each seam with a negative control
  (revert the expand, the handle leaks). A new seam gets the same treatment.
- Argot's proof artifacts: the settings differential from `proof/scenes/settings-pointer.sh` carried
  in the pull request (off arm at the default, on arm with `SCENE_SETTINGS='argot.enabled: true'`) —
  off shows only the "Argot Shorthand" master toggle, on shows it plus Models, Dictionary Budget,
  Context Cutoff and Subagents — and the bench
  `packages/evals/suites/typescript-edit/argot-bench.ts`, which runs the edit tasks with encoding on
  and off and certifies the token delta. `test/argot-settings-e2e.test.ts` asserts every Argot
  setting end to end, including that the knobs are hidden while off. Keep all of it current.

## Commands

- Commit frequently: each logical chunk as its own commit once it stands alone and its gate is green.
  Pushing is separate and needs explicit approval.
- Stage only the paths you changed. `git add -A` is banned; this tree carries other lanes' in-flight
  work.
- Never `tsc`/`npx tsc`. Always `bun run check`.

Gate scripts (defined in the root `package.json`; run the narrowest one that covers the change):

|Command|What it does|
|---|---|
|`bun run check`|Type check TS **and** Rust in parallel (`check:ts` + `check:rs`). The release preflight runs this.|
|`bun run check:rs` / `lint:rs`|`cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings`. `--all-targets` makes these compile tests and benches too; without it a test file that does not build passes both gates and fails later in `test:rs`.|
|`bun run check:ts`|Workspace `tsc --noEmit` across every package. Runs no Biome despite the name.|
|`bun run check:tools`|`biome check`: formatting, import order, and error-level lint rules. CI gate.|
|`bun run lint` / `lint:ts`|`biome lint` only: no formatting, no import order. Advisory — fix real bugs, do not contort for style.|
|`bun run test`|Local TS test runner (`scripts/ci-test-ts.ts local`).|
|`bun run ci:test:ts:workspace`|The exact workspace test bucket CI runs.|
|`bun run ci:build:native`|Build the `veyyon_natives` addon — required before tests that touch native paths.|

`suspicious/noTemplateCurlyInString` flags a plain string containing `${...}`. A test that quotes
source text from another language (`install.sh`, generated PowerShell completions, a GitHub Actions
expression) trips it on the fixture's own bytes. Suppress those one site at a time with a
`biome-ignore` line naming what the `${...}` is, rather than disabling the rule for tests.

Commit conventions:

- One concern per commit. Stage only the paths you changed.
- Imperative, scoped subject: `polish(onboarding): …`, `fix: …`, `ci: …`, `test(agent): …`.
- No AI or assistant attribution trailers. Commit as the configured git user.
- The release commit's subject is exactly `chore: bump version to vX.Y.Z`. `checks.yml` keys its
  changelog exemption off that prefix. `scripts/release-cut.ts` writes it; never hand-craft it.

## Testing Guidance

The enforced rules live here; `docs/internal/testing.md` is the expanded reference (suites, buckets,
sandbox, isolation helpers) and owns everything this section does not restate.

Test the contract the system exposes, not the easiest internal detail to assert.

- Every test defends one concrete, externally observable contract: behavior, output shape, state
  transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract,
  do not add the test.
- No placeholder tests, tautologies, or "the code ran" assertions (`expect(true).toBe(true)`, bare
  `not.toThrow()`, non-empty string checks, length-grew checks, "prompt exists" checks).
- Prefer contract-level tests. Avoid asserting internal helper wiring, field assignment, singleton
  identity, incidental ordering, prompt boilerplate, or option forwarding unless another component
  depends on that exact detail.
- Do not duplicate coverage across abstraction levels. Drop the narrow unit test an integration test
  already proves.
- Tests must be full-suite safe, not only file-local safe. No long-lived file-wide mutation of
  `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer
  per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone and
  poisons later files is broken.
- Never `mock.module()`. It mutates the global module registry and leaks across files
  ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported
  module object: for a pass dependency, import the pass and spy on `.run`; for a package dependency,
  namespace-import and spy on the exported function.
- For lifecycle and stateful code, write one test per invariant or transition rather than several
  asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract. Do not
  instantiate error classes directly or inspect internal metadata.
- A smoke test is acceptable only when it catches a failure mode narrower tests miss. "Package boots"
  is not enough.
- Assert exact strings, ordering and formatting only when downstream code parses those bytes.
  Otherwise assert semantic content.
- Compile-time guarantees belong in type checks or type tests, not runtime placeholders.
- Never source-grep. A test that reads an implementation file (`.ts`, `.rs`, a build script) and
  asserts on its text — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`,
  `.not.toContain("oldName")`, "the comment must say X" — is banned: it breaks on a comment reflow or
  a rename and passes while the behavior is broken. Assert the observable contract instead, use the
  runtime smoke probe for wiring you cannot exercise in-process, and enforce a structural invariant
  (no value-import of X, no self-import) with a type test or a lint rule. Reading a file your code
  wrote — an apply-patch result, a generated bundle, a temp fixture — is behavior, not a source grep.
- Skip tests for tiny low-risk changes unless they protect a real contract or a regression-prone
  edge case.
- Prefer focused package-local verification for the changed area.

### Regression suites: close the class, not the incident

A fix is finished when this sentence is true of the suite you wrote:

> As long as this suite passes, this exact defect cannot happen again, AND no other member of its
> general class can happen either.

Two suites that fail the bar: the incident-only suite, which pins the one input from the report, and
the green-by-luck suite, which passes for a reason other than the one you think.

1. **Drive the production path.** Construct the real component, session, registry and tool, and reach
   the defect the way a user does. Mock only an external boundary you cannot run (a provider
   endpoint, the clock, a missing binary). A suite whose subject is a fake of the thing under test,
   or that asserts a spy was called, is not evidence.
2. **Enumerate the variant space from source at run time.** Sweep the registry, union, enum, exported
   table or directory. A hardcoded member list goes stale in silence.
3. **Fail by default on a new member.** Adding a provider, tool, agent, route, setting, error source
   or dialect turns the suite red until someone records a decision. Pin opt-outs by exact equality
   (`expect(optedOut).toEqual(["yield"])`), never by count and never loosely.
4. **A member that cannot be exercised is a hole.** Fix the harness until the sweep can construct it,
   and assert the unconstructable set is empty.
5. **Observe red, then mutation-gate every branch.** Re-inject the defect and watch the suite fail
   for the right reason. Then mutate each branch you claim to cover, one at a time, including the
   refactor a later reader would try; a mutation that stays green means the test is wrong. Mutate by
   editing the source and restoring it in the same step, proving the restore with
   `git diff --numstat`. Never `git checkout`, `revert`, or `stash` in this shared tree.
6. **Assert termination and bounds.** Anything with a deadline, retry, backoff, queue or stand-down
   gets an assertion that it ends and an assertion of the bound. A test that can only observe a wrong
   value cannot see a hang.
7. **Version anything persisted and test the stale copy.** Changing a cached, serialized or on-disk
   shape means a version bump plus a test that a stale entry is rejected rather than served.
8. **Say what the suite does not catch.** Open with a WHY comment naming the defect, the class it
   closes, and the gap it leaves.
9. **Try to break your own suite.** Describe a change that reintroduces the defect or a sibling and
   leaves the suite green; cover every one you find, and report which variants you tried to smuggle
   past the tests and whether each was caught.

Name the file after the behavior it defends, in prose
(`a-question-to-the-user-ends-the-turn.test.ts`), not after the module or the issue number.

### Backtests: replay the failure that was actually reported

A defect reported from a real run carries the one input nobody would have invented. Replay it. When a
fix comes from a session log, a crash trace, a provider transcript, a rollout capture, or a pasted
error, add a **backtest** — a test seeded with the recorded input that reproduces the reported
failure — alongside the ordinary functional and class-level tests above. The backtest proves the
report; the class-level suite proves the class. Neither replaces the other, and a backtest alone
never closes a defect.

**Sanitize the capture before it reaches a file.** A recorded input is somebody's private session, and
a fixture is published the moment it is committed. Strip, in the fixture and in every assertion,
comment and test name that quotes it:

- Absolute machine paths. Rewrite to a relative path or a neutral root (`/repo/src/app.ts`,
  `C:\\repo\\src\\app.ts`). No home directory, no username, no drive layout, no worktree name, no
  `/tmp` path, no operator directory.
- Host and account identity: hostnames, usernames, SSH aliases, IP addresses, MAC addresses, email
  addresses, GitHub logins, machine and profile names.
- Credentials and identifiers: API keys, bearer tokens, OAuth codes, refresh tokens, session ids,
  request ids, cookies, signed URLs. Replace with an obviously fake constant of the same shape, so
  the parser under test still sees a well-formed value.
- Content: prompts, file bodies, diffs, commit messages, error text and model output that carry the
  operator's own work or words. Keep the structural feature that triggers the defect and replace the
  rest with neutral text.

The defect lives in the SHAPE of the input — a truncation boundary, an unbalanced brace, a surrogate
pair split across a chunk, a header name, an ordering — never in whose data it was. Reduce the capture
to the smallest input that still reproduces, then sanitize what remains. A fixture that still needs
real content to reproduce is not ready to commit; say so rather than committing it.

Raw transcripts, chat logs and agent `.jsonl` rollouts are never committed, sanitized or not. A
backtest carries the minimized input those files revealed, in a fixture written for this test.

## Changelog

Entries go under `## [Unreleased]` in the owning package's `packages/<name>/CHANGELOG.md`, in these
sections: `### Breaking Changes` (first if present), `### Added`, `### Changed`, `### Fixed`,
`### Removed`.

- Keep entries concise: a single flat declarative sentence stating the exact user-visible change or fix. No narrative setup, filler, or multi-sentence paragraphs.
- Never write an entry into the repo-root `CHANGELOG.md` by hand. It is generated by
  `bun run changelog:root` from every package changelog, so an entry written there is deleted by the
  next render. The write path refuses when the root holds an unreleased entry the render does not
  produce, and states each one.
- Pushing to `main` directly is the one path that still regenerates the root by hand: the pre-push
  hook renders it and refuses a commit whose root is stale, so run `bun run changelog:root` and
  commit the result alongside the package bullet. A pull request does not, and CI no longer gates
  one on it — `.github/workflows/changelog-sync.yml` renders and commits the root after the merge.
- Never modify a released section (`## [0.12.2]`). Released sections are immutable.
- Do not flag changelog section order or formatting in reviews; the Release workflow runs
  `fix-changelogs`.
- Every publishable package owns a `CHANGELOG.md`. A package that is not published declares
  `"private": true`.
- There is no waiver. `[skip changelog]` does not exist. A change that touches shipped source gets a
  line, and a change with no user-facing effect gets a line saying so.

`bun run changelog:check` (the `changelog` CI job on every push to `main` and every PR) fails when a
change to a publishable package's shipped source lands without a bullet under that package's
`## [Unreleased]` section, and fails naming the file when a publishable package has no changelog at
all. Tests, fixtures, docs, `package.json` and `tsconfig*.json` are not shipped source. The release
bump commit is exempt. Run it locally with `CHANGELOG_BASE=origin/main bun run changelog:check`.

Attribution:

- Internal: `Fixed foo bar ([#123](https://github.com/santhreal/veyyon/issues/123))`.
- External: `Added feature X ([#456](https://github.com/santhreal/veyyon/pull/456) by [@username](https://github.com/username))`.

## Continuous Integration

Two workflows in `.github/workflows/` gate changes and releases. Their job layout and the cost rules
behind it are in [`docs/internal/repo-gates.md`](docs/internal/repo-gates.md).

`checks.yml` runs on every push to `main` and every PR: workspace type check and lint, Rust format
and clippy, secret scanning of the added commits, changelog coherence, global-state isolation on
changed suites, and the repo script gates. The Rust gate lives here and nowhere else; never add a
second copy to a native job.

`ci.yml` runs on `main`, PRs and release dispatches, entirely on GitHub-hosted runners. It compiles
the product and native addons, runs the full test matrix, and exercises the installers and CLI
runtime. At a `v*` release tag it also builds the per-platform binaries, verifies their SHA-256
sidecars and runtime smoke tests, publishes the GitHub release, and redeploys
`veyyon.dev/changelog`.

The installer end-to-end jobs (`install_methods`, `install_ps1_e2e`) run on pull requests and on the
release tag, and are skipped on an ordinary push to `main`; they gate `release_binary`. The monitors
of the published release (`install_binary_posix`, `install_ps1_binary`) run daily from
`published-release-monitor.yml`, which no push or PR can reach.
`scripts/install-methods-coverage.test.ts` fails if a monitor returns to the push path.

Before pushing, run `bun run check` and the relevant test bucket locally. Never weaken a test to pass
a gate.

## Distribution — GitHub only

Veyyon ships through exactly two channels:

1. `curl -fsSL https://get.veyyon.dev | sh` — the installer and the auto-updater both talk to
   **veyyon.dev**, which serves the prebuilt self-contained binary and links a short `vey` command.
   veyyon.dev propagates automatically from
   [GitHub Releases](https://github.com/santhreal/veyyon/releases).
2. A git checkout the user clones (`git clone`, then `bun run setup` / `bun dev`). The installer never
   creates it.

There is no npm package and there never will be, and no `cargo publish` yet. Never add, document, or
assume an npm, bun-global, Homebrew, mise, or crates.io install or update path for veyyon itself;
treat any such reference as a defect to remove. An extension may still `npm install` its own
dependencies — that is not veyyon's distribution.

## Releasing

Veyyon is a source fork of oh-my-pi (see [`UPSTREAM.md`](UPSTREAM.md)). The changelog carries
upstream's history; veyyon's own tags start at `v1.0.0`, and `release.ts` treats an empty tag set as
a `0.0.0` baseline so that baseline is reproducible. Contributor detail:
[`docs/internal/releasing.md`](docs/internal/releasing.md) and
[`docs/internal/deployment.md`](docs/internal/deployment.md).

```sh
bun run release:dry minor      # say what a cut would do. Writes nothing.
bun run release minor          # do it.
```

`bun run release <major|minor|patch|x.y.z>` bumps every public `package.json`, the root catalog, the
Rust workspace, the natives sentinel and the lockfiles, rolls each package's `## [Unreleased]` into a
dated section, regenerates the root changelog, and commits `chore: bump version to vX.Y.Z`. It then
shows the commit and tag and asks once; on yes it pushes `main`, waits for that SHA's checks, and
tags. It needs explicit approval to run because it pushes: the prompt is that approval, no flag
answers it in advance, and an agent never answers it. `release:dry` publishes nothing, which is why
it is non-interactive.

Only a tag publishes. A push, a green run, and a waiting `## [Unreleased]` bullet do not. The three
underlying moves, which every non-publishing exit prints and which you can finish by hand:

1. **Prepare locally** through the bump commit. Never pushes, never tags.
2. **Push to `main`.** The bump commit goes through main's ordinary CI. This publishes nothing.
3. **Tag the green commit**: `git tag vX.Y.Z && git push origin vX.Y.Z` starts the one CI run that
   builds, verifies and publishes.

The tag must name a commit that reached `main`, because `main` tested it before the tag existed.
`ci.yml` enforces it, and `scripts/release.ts verify-tag` refuses anything but `identical` or
`behind`, refuses a non-`vX.Y.Z` ref, refuses a tree whose version authorities disagree with the tag,
and refuses when the comparison cannot be established. Tagging an older `main` commit is expected
when `main` moved on during preparation.

## Maintenance

Full detail: [`docs/internal/deployment.md`](docs/internal/deployment.md).

The website is a static site under `website/`, deployed to Cloudflare Pages.

- `bun run site:build` regenerates `changelog.html` from `packages/coding-agent/CHANGELOG.md`
  (fork-aware: veyyon releases vs inherited oh-my-pi history), stages the install scripts, and runs a
  brand check that fails the build on a leaked old product name.
- `bun run site:deploy` builds and publishes to the `veyyon` Pages project. It needs
  `CLOUDFLARE_API_TOKEN` (`export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"`; the token is in
  `/credentials/.env`). `--dry-run` prints the command without deploying.
- Two Pages projects: `veyyon` serves `veyyon.dev`, and `veyyon-get` serves `get.veyyon.dev`, the
  install endpoint. Deploy the latter with `VEYYON_PAGES_PROJECT=veyyon-get bun run site:deploy`.
- `website/docs` is a symlink to `docs/handbook/book`. Rebuild it with `mdbook build` in
  `docs/handbook` before deploying a docs change.
- `site:build` stages gitignored copies of the installers as `website/install.{sh,ps1}`. The source
  of truth is `scripts/install.{sh,ps1}`; edit those.

`install.sh` resolves the platform, reads `github.com/santhreal/veyyon` `releases/latest`, downloads
`veyyon-<platform>-<arch>` plus its `.sha256`, and fails closed on a checksum mismatch. It covers
linux and darwin on x64 and arm64; Windows uses `install.ps1`. A release that ships only some
platforms 404s for the rest, so keep the asset set complete.
