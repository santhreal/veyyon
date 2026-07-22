# Development Rules

## Default Context

This repo contains multiple packages, but **`packages/coding-agent/`** is the primary focus. Unless otherwise specified, assume work refers to this package.

**Terminology**: When the user says "agent" or asks "why is agent doing X", they mean the **coding-agent package implementation**, not you (the assistant). The coding-agent is a CLI tool — questions about its behavior refer to code in `packages/coding-agent/`, not your current session.

### Package Structure

| Package                 | Description                                          |
| ----------------------- | ---------------------------------------------------- |
| `packages/ai`           | Multi-provider LLM client with streaming support     |
| `packages/catalog`      | Model catalog: bundled models.json, provider descriptors, model identity/classification |
| `packages/agent`        | Agent runtime with tool calling and state management |
| `packages/coding-agent` | Main CLI application (primary focus)                 |
| `packages/tui`          | Terminal UI library with differential rendering      |
| `packages/natives`      | Bindings for native text/image/grep operations       |
| `packages/stats`        | Local observability dashboard (`veyyon stats`)       |
| `packages/utils`        | Shared utilities (logger, streams, temp files)       |
| `crates/veyyon-natives`     | Rust crate for performance-critical text/grep ops    |

**Catalog import convention**: code in this repo imports catalog *values* (bundled models, model-thinking helpers, identity, descriptors, model manager/cache) from `@veyyon/catalog/<module>` — never via `@veyyon/ai`. The pi-ai barrel re-exports only the model/effort *types* its own signatures use (`Model`, `Api`, `ThinkingConfig`, `Effort`, …); type-only imports of those from `@veyyon/ai` are fine.

## GitHub

Unless user tells you exactly what to write:
- **Never comment on GitHub** (issues, PRs, discussions).
- **Never create issues on GitHub**.

## Proving a Feature (the 10-minute rule)

A feature is not done when the code compiles. It is done when you can prove it works, fast, with artifacts anyone can open. The test: **could you ship a demo, a settings differential, and a bench for this feature in ten minutes right now?** If the answer is no, the feature is not finished, no matter how much code it has.

**A proof is a differential, not a snapshot.** One picture of the feature sitting at its defaults proves nothing: it does not show that the knob does anything. Every proof contrasts two states of the same surface, the feature off and the feature on, and the reader sees exactly what changed. A single frame with no counterpart is a failed proof, no matter how good it looks.

**A settings change is permanent; an in-session change is ephemeral.** Know which one your feature is before you prove it. An ephemeral change is session-only and reverts (a theme hover-preview, a one-shot preview toggle): its differential is the live-vs-reverted view. A settings change is written to config and persists across restarts: its differential is off-vs-on across two launches, and the proof must show the value actually persisted, not just flashed on screen. Do not prove a permanent setting with an ephemeral snapshot, or the other way round.

Every user-facing feature update lands with three artifacts, all committed:

1. **A demo in `demos/` (or `assets/tapes/`).** A runnable script or recording that drives the real feature end to end, the way a user would reach it. Not a unit test, not a snippet in a comment. Someone should be able to run it and watch the feature do its job, and watch it behave differently with the feature off vs on.
2. **A settings differential: two screenshots, off and on.** Capture the settings screen with the feature off, then with it on, so the pair shows the knob is wired, not just declared in a defaults table. Seed each state deterministically (`veyyon config set <path> <value>` before recording) rather than by pressing a toggle whose keybinding may not land; drive both from one tape run through a small driver so the pair regenerates together. Store both next to the demo. **A degenerate pair — the two shots identical, or the "on" shot not actually on — is a failed proof; check the bytes differ and the values changed.**
3. **A bench with exact parity.** Measure the feature on and off against the same corpus, same inputs, same seed. Report the exact numbers. "Exact parity" means the off-arm reproduces the pre-feature baseline to the token or the millisecond, so any delta is attributable to the feature and nothing else. A bench that cannot reproduce its own baseline proves nothing.

Beyond the three artifacts, **assert every setting the feature adds actually works end to end** — the default is honored, each non-default value changes observable behavior, and an invalid value fails loud. A setting that appears in the defaults but never reaches behavior is a defect, the same class as a dead flag.

**An experimental feature that is off hides its dependent knobs completely.** When a feature is gated behind a master toggle and that toggle is off, the knobs that only matter when it is on must not appear in the settings screen at all — not greyed out, not inert, gone. Wire each dependent setting to a `ui.condition` that reads the master toggle (see `CONDITIONS` in `settings-defs.ts`); the selector hides any setting whose condition returns false. The off-vs-on screenshot pair is exactly what proves this: off shows only the master toggle, on shows the toggle plus its dependents. A dependent knob visible while the feature is off is a defect.

If a feature cannot meet this bar, it is experimental and must say so in its settings group, stay off by default, hide its dependent knobs while off, and carry a backlog row for the missing proof. Do not ship it as done.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`).
- **Promises**: use `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- **Prompts**: never build prompts in code (no inline strings, template literals, or concatenation). Prompts live in static `.md` files; use Handlebars for dynamic content. Import them via `import content from "./prompt.md" with { type: "text" }` — not `readFile`.
- **Worker scripts**: workers re-enter the CLI entrypoint; never spawn separate worker entry modules. `cli.ts` declares itself as the worker host at startup (`declareWorkerHostEntry()` from `@veyyon/utils/env`) and dispatches hidden argv selectors (`__omp_worker_stats_sync`, `__omp_worker_tab`, `__omp_worker_js_eval`, `__omp_worker_tiny_inference`) before loading the command registry. Spawn sites use:
  ```ts
  import { workerHostEntry } from "@veyyon/utils";
  const hostEntry = workerHostEntry();
  const worker = hostEntry
  	? new Worker(hostEntry, { type: "module", argv: ["__omp_worker_<name>"] })
  	: new Worker(new URL("./<worker>.ts", import.meta.url).href, { type: "module" });
  ```
  When the process was started from the veyyon CLI — source `cli.ts`, npm-bundle `dist/cli.js`, or compiled binary — `workerHostEntry()` is `Bun.main` and the worker re-enters the single entry module, so no per-worker `--compile` entrypoints or bundle entries exist. Outside a CLI host (`bun test`, SDK embedding, standalone `veyyon-stats`) it returns `null` and the direct-module fallback loads the worker source. New worker kinds MUST add their selector to the dispatch table in `cli.ts` and keep the fallback branch.
  History: `with { type: "file" }` only copied the entry as a raw asset (workers crashed silently in compiled binaries — issues #1011, #1027), and the later literal-path + extra-entrypoint pattern required keeping spawn literals and two build scripts in sync (issue #1150). The smoke probe below is the live validation of this contract.
  Validate any new worker with the dedicated smoke probe: `veyyon --smoke-test` spawns the stats sync worker and the tiny-model subprocess, pings them, and exits — it's wired into `ci:test:smoke` and `scripts/install-tests/run-ci.sh` so binary, source-link, and tarball installs all exercise it. Add a sibling smoke if the new worker is on a different module graph.

## Bun Over Node

Use Bun APIs where they provide a cleaner alternative; fall back to `node:*` only for what Bun doesn't cover. **Never spawn shell commands for operations with proper APIs** (e.g., don't `Bun.spawnSync(["mkdir", "-p", dir])` — use `mkdirSync`).

### Quick reference

| Operation       | Use                                       | Not                             |
| --------------- | ----------------------------------------- | ------------------------------- |
| File read/write | `Bun.file()`, `Bun.write()`               | `readFileSync`, `writeFileSync` |
| Spawn process   | `` $`cmd` ``, `Bun.spawn()`               | `child_process`                 |
| Sleep           | `Bun.sleep(ms)`                           | `setTimeout` promise            |
| Binary lookup   | `$which("git")` from `@veyyon/utils` | `spawnSync(["which", "git"])`   |
| HTTP server     | `Bun.serve()`                             | `http.createServer()`           |
| SQLite          | `bun:sqlite`                              | `better-sqlite3`                |
| Hashing         | `Bun.hash()`, `Bun.password.*`, WebCrypto | `node:crypto`                   |
| Path resolution | `import.meta.dir`, `import.meta.path`     | `fileURLToPath` dance           |
| JSON5           | `Bun.JSON5.parse()` / `.stringify()`      | `json5` package                 |
| JSONL           | `Bun.JSONL.parse()` / `.parseChunk()`     | `text.split("\n").map(JSON.parse)` |
| String width    | `Bun.stringWidth()`                       | `get-east-asian-width`, custom  |
| Text wrapping   | `Bun.wrapAnsi()`                          | custom ANSI-aware wrappers      |

### Process execution

Prefer Bun Shell (`` $`cmd` ``) for simple commands:

```typescript
import { $ } from "bun";

const result = await $`git status`.cwd(dir).quiet().nothrow();
if (result.exitCode === 0) {
	const text = result.text();
}

$`do-stuff ${tmpFile}`.quiet().nothrow(); // fire and forget
```

Methods: `.quiet()`, `.nothrow()`, `.text()`, `.cwd(path)`.

Use `Bun.spawn`/`Bun.spawnSync` only for: long-running processes (LSP, kernels), streaming stdin/stdout/stderr (SSE, JSON-RPC), or process control (signals, kill, complex lifecycle).

When using `pipe` mode, cast the stream:
```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

### Node module imports

Always use **namespace imports** for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

- Async-only file → `node:fs/promises`.
- Needs both sync and async → `node:fs`, then `fs.promises.xxx` for async.

### File I/O

Prefer Bun:
```typescript
const text = await Bun.file(path).text();
const data = await Bun.file(path).json();
await Bun.write(path, data); // auto-creates parent dirs
```

Use `node:fs/promises` for directory ops (`fs.mkdir`, `fs.rm`, `fs.readdir`) — Bun has no native directory APIs. Avoid sync APIs in async flows; use sync only when forced by a synchronous interface.

**Anti-patterns:**
- `existsSync`/`readFileSync`/`writeFileSync` in async code → `Bun.file()` APIs.
- `mkdir(dirname(path), …)` before `Bun.write(path, …)` → redundant; `Bun.write` handles it.
- `if (await file.exists()) { await file.json() }` → two syscalls plus race. Use try-catch with `isEnoent`:
  ```typescript
  import { isEnoent } from "@veyyon/utils";
  try {
  	return await Bun.file(path).json();
  } catch (err) {
  	if (isEnoent(err)) return null;
  	throw err;
  }
  ```
- Multiple `Bun.file(path)` handles for the same path (including across `checkX`/`loadX` helpers).
- `Buffer.from(await Bun.file(x).arrayBuffer())` → `await fs.readFile(path)`.
- Existence check + try-catch around the same read → drop the existence check.

### Streams

Prefer centralized helpers:
```typescript
import { readStream, readLines } from "./utils/stream";
const text = await readStream(child.stdout);
for await (const line of readLines(stream)) { /* ... */ }
```
Manual reader loops only when the protocol requires it (SSE, streaming JSON-RPC).

### Misc

- **Sleep**: `await Bun.sleep(ms)`, never `new Promise(r => setTimeout(r, ms))`.
- **Password hashing**: `Bun.password.hash(pw, "bcrypt")` / `Bun.password.verify(pw, hash)`.
- **String width**: `Bun.stringWidth(text, { countAnsiEscapeCodes?: false })`.
- **Wrapping**: `Bun.wrapAnsi(text, width, { wordWrap, hard, trim })`.

## Generated Files

**NEVER edit `packages/catalog/src/models.json` directly.** It is generated from upstream sources (models.dev, provider catalog discovery, OpenCode docs) by `packages/catalog/scripts/generate-models.ts` and the descriptors/resolvers in `packages/catalog/src/provider-models/`. Hand-edits get overwritten on the next regen.

To change an entry, fix the source:
- **Resolution rules / per-id overrides** → relevant resolver in `packages/catalog/src/provider-models/openai-compat.ts` (e.g. `createOpenCodeApiResolution`'s id-override map).
- **Provider catalog entries** (default model, discovery factory/flags) → the `CATALOG_PROVIDERS` table in `packages/catalog/src/provider-models/descriptors.ts`.
- **Generator-level fixups** (premium multipliers, codex pricing fallback, fallback models, post-processing) → `packages/catalog/scripts/generate-models.ts`.
- **Thinking metadata / generated policies** → `packages/catalog/src/model-thinking.ts` (`applyGeneratedModelPolicies`); model-id classification (family/version parsing) lives in `packages/catalog/src/identity/classify.ts`.

Regenerate with `bun run gen:models` and commit `models.json` alongside the source change. Add a regression test against the **resolver/descriptor**, not the bundled JSON, so it survives upstream metadata shifts.

## Logging

**NEVER use `console.log`/`error`/`warn`** in the coding-agent package — it corrupts TUI rendering. Use the centralized logger:

```typescript
import { logger } from "@veyyon/utils";

logger.error("MCP request failed", { url, method });
logger.warn("Theme file invalid, using fallback", { path });
logger.debug("LSP fallback triggered", { reason });
```

Logs go to `~/.veyyon/logs/veyyon.YYYY-MM-DD.log` with automatic rotation.

## TUI Sanitization

All text displayed in tool renderers must be sanitized. Raw content (file contents, error messages, tool output) breaks terminal rendering: tabs → visual holes, long lines → overflow, paths → leak home directory.

**Rules:**
- **Tabs → spaces** via `replaceTabs()` (from `@veyyon/tui` or `../tools/render-utils`).
- **Truncate** lines with `truncateToWidth()` / `ui.truncate()`. Use `TRUNCATE_LENGTHS` constants.
- **Shorten paths** with `shortenPath()` (replaces home with `~`).
- **Preview limits** from `PREVIEW_LIMITS`. No ad-hoc numbers.

**Apply to every render path**, not just the happy one:
- Success output (file previews, command output, search results).
- **Error messages** — these often embed file content (e.g., patch failure messages include unmatched lines). If a message contains file content, it needs `replaceTabs()`.
- Diff content (added and removed).
- Streaming previews.

### Streaming tool previews

Tool-call previews can have **multiple render paths**. If you add preview-only fields or depend on partially streamed args, update every path — not only the final renderer. Streamed argument buffers decode into display args via `decodeStreamedToolArgs` / `ToolArgsRevealController` (`modes/controllers/tool-args-reveal.ts`); both the live event path and transcript rebuilds must go through them — never spread provider-parsed `arguments` next to a raw `__partialJson` (parsed args lag the stream by a throttled parse window).

For the bash tool specifically:
- The pending preview may need raw `partialJson`, not just parsed `arguments`. Parsed args lag until a JSON object closes, which makes inline env assignments appear only at the end.
- Preserve preview-only fields (e.g. `__partialJson`) through `event-controller.ts`, transcript rebuilds in `ui-helpers.ts`, and merged call/result rendering in `tool-execution.ts`. Missing one path causes inconsistent previews.
- `ToolExecutionComponent.#buildRenderContext()` for bash must work even before a result exists — the renderer uses call args plus render context to show the command preview while streaming.
- Verify both live streaming and rebuilt transcript paths after any bash preview change. A fix in one path does not fix the other.

## Argot (project shorthand)

Argot is the codec that lets the model write short `§handle` tokens; veyyon expands them to full text before anything outside the model's history sees them. **The complete integration spec lives in the `argot` package's [`INTEGRATING.md`](../../../libs/context/argot/INTEGRATING.md) — read it, do not re-derive it.** All codec logic (longest match, the boundary rule, streaming a handle split across token deltas) lives in argot behind named functions. veyyon's job is only to call those functions at the seams; never hand-roll handle logic here.

- **Every seam is wired in one place: `packages/coding-agent/src/argot-wire.ts`.** It is the only veyyon module that touches the codec. The seams (argot's manual numbers them 1-6): `expandToolArguments` (tool args), `expandAssistantContent` (finished display), `createSubagentStreamDecoder` (the live streamed preview — feeds `StreamDecoder.push`/`flush`, never a raw delta), `expandSessionContext` (transcript/export/resume), and `expandSubagentReturn` (a subagent's result to its parent).
- **The contract is absolute: a user NEVER sees a raw `§handle`.** That includes the live subagent HUD preview (`progress.recentOutput` in `task/executor.ts`), which decodes streamed deltas through `createSubagentStreamDecoder`. A raw handle reaching any display, tool, transcript, or the parent is a defect, not a cosmetic issue.
- **Adding a new place the model's text crosses out of its history is adding a seam.** Route it through an `argot-wire.ts` function; if none fits, add one there (a thin delegate to `argot`), never a new codec call site scattered elsewhere.
- Tests: `test/argot-subagent-*.test.ts` drive the real executor and prove each seam with a negative control (revert the expand → the handle leaks). Any new seam gets the same treatment.
- **Argot meets the [10-minute proof rule](#proving-a-feature-the-10-minute-rule).** Its artifacts: the settings differential `assets/argot-settings-off.png` and `assets/argot-settings-on.png` (regenerated together by `scripts/demos/record-argot-settings.sh`, which seeds `argot.enabled` off then on with `config set` and records the single-state tape `assets/tapes/argot-settings.tape` twice) — off shows only the "Argot Shorthand" master toggle, on shows it plus the four dependent knobs (Models, Dictionary Budget, Context Cutoff, Subagents), proving the `argotEnabled` condition hides them while off; and the live bench `packages/typescript-edit-benchmark/src/argot-bench.ts` (runs the edit tasks with encoding on and off and certifies the token delta). Every Argot setting is asserted end to end in `test/argot-settings-e2e.test.ts` (the operator's value binds through the real `Settings` into the gate and the codec, and a disabled-vs-enabled test asserts the knobs are hidden while off). Keep all of these current when you touch Argot.

## Commands

- NEVER commit unless asked.
- Never use `tsc`/`npx tsc` — always `bun check`.

**Gate scripts** (defined in the root `package.json`; run the narrowest one that covers your change):

| Command | What it does |
| --- | --- |
| `bun run check` | Type check TS **and** Rust in parallel (`check:ts` + `check:rs`). The release preflight runs this. |
| `bun run check:ts` | Biome + workspace `tsc --noEmit` across every package. |
| `bun run lint` / `lint:ts` | Biome lint (advisory; fix real bugs, don't contort for style). |
| `bun run test` | Local TS test runner (`scripts/ci-test-ts.ts local`). |
| `bun run ci:test:ts:workspace` | The exact workspace test bucket CI runs. |
| `bun run ci:build:native` | Build the `veyyon_natives` addon — required before tests that touch native paths. |

**Commit conventions** (only when the user asks you to commit):
- Commit in **logical chunks**, one concern per commit — never one giant `git add -A`. Stage only the paths you changed.
- Subject line is imperative and scoped, e.g. `polish(onboarding): …`, `fix: …`, `ci: …`, `test(agent): …`.
- Do not add AI/assistant attribution trailers (no `Co-Authored-By: <model>`, no `Generated with …`). Commit as the configured git user only.
- The **release** commit is special: its subject **must** be exactly `chore: bump version to vX.Y.Z` — CI keys the never-cancel release concurrency group off that subject (#2564). `bun run release` writes it for you; never hand-craft it.

## Testing Guidance

Test the contract the system exposes — not the easiest internal detail to assert.

- Every new test must defend one **concrete, externally observable contract**: behavior, output shape, state transition, error mapping, or a regression-prone parsing boundary. If you cannot name the contract, do not add the test.
- No placeholder tests, tautologies, or "the code ran" assertions (`expect(true).toBe(true)`, bare `not.toThrow()`, non-empty string checks, length-grew checks, "prompt exists" checks without semantic assertion).
- Prefer contract-level tests over implementation details. Avoid asserting internal helper wiring, field assignment, singleton identity, incidental ordering, prompt boilerplate, or passthrough option forwarding unless another component depends on that exact detail.
- Don't duplicate coverage across abstraction levels. If an integration test already proves the behavior, drop the narrower unit test that restates it through mocks.
- Tests **must be full-suite safe**, not just file-local safe. No long-lived file-wide mutations of `Bun.*`, `process.platform`, `process.env`, or `Bun.env` when a narrower seam exists. Prefer per-test `vi.spyOn(...)` with `vi.restoreAllMocks()` in `afterEach`. A test that passes alone but poisons later files is broken.
- **Never use `mock.module()`**. Bun's `mock.module()` mutates the global module registry and leaks across files ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the imported module object instead. For pass deps, import the pass and spy on `.run`. For package deps, namespace-import and spy on the exported function.
- For lifecycle/stateful code, prefer one test per invariant or transition over several tiny tests asserting one field each from the same transition.
- For error handling, trigger the real failure path and assert the surfaced contract — don't instantiate error classes directly or inspect internal metadata.
- Smoke tests are acceptable only when they catch a failure mode narrower tests would miss. "Package boots" or "command starts" alone is not enough.
- Assert exact strings, ordering, and formatting only when downstream code parses or depends on the exact bytes. Otherwise assert semantic content.
- Compile-time guarantees → type checks/type tests, not runtime placeholders.
- **Never source-grep.** A test that reads an implementation file (`.ts`/`.rs`/build script) and asserts on its *text* — `expect(src).toContain("someCall()")`, `.toMatch(/import .../)`, `.not.toContain("oldName")`, or "comment must say X" — is banned. It tests how code *looks*, not what it *does*: it breaks on harmless refactors (comment reflow, rename, import reorder) and passes while the behavior is broken. Assert the observable contract instead (run the code, check output/state/error), use the runtime smoke probe for wiring you cannot exercise in-process, and enforce structural invariants (no value-import of X, no self-import) with a type test or a lint/biome rule — never a string scan of the source. (Reading a file your code *wrote* — apply-patch result, generated bundle, temp fixture — and asserting on that output is fine; that is behavior, not a source grep.)
- Don't add tests for tiny low-risk changes unless they protect a real contract or fix a regression-prone edge case.
- Prefer focused package-local verification for the changed area.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:
- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**
- New entries always go under `## [Unreleased]`.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — `bun run release` runs `fix-changelogs` which normalizes everything automatically.

**Enforced (`changelog` CI job on every PR).** `bun run changelog:check` fails a PR that changes a publishable package's shipped source without adding a bullet to that package's `## [Unreleased]` section. This is what makes releases safe to cut at any time: a feature can never merge without reaching the changelog. Tests, fixtures, docs, `package.json`, and `tsconfig*.json` are not "shipped source" and never trigger it. Run it locally before pushing with `CHANGELOG_BASE=origin/main bun run changelog:check`.
- Escape hatch for a change with genuinely no user-facing effect (a pure internal refactor): put `[skip changelog]` in a commit message to waive the whole PR, or `[skip changelog: <package>]` (bare name, dir, or `@veyyon/<name>`) to waive one package. The waiver lives in git history, so it is a conscious, reviewable decision, never a silent skip.

**Attribution:**
- Internal (from issues): `Fixed foo bar ([#123](https://github.com/santhreal/veyyon/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/santhreal/veyyon/pull/456) by [@username](https://github.com/username))`.

## Continuous Integration

Two workflows run in `.github/workflows/`. Know which one gates your change.

### `checks.yml` — the public gate (every push to `main` + every PR)

Runs on GitHub-hosted runners so it works on the public repo without the self-hosted
runners the release pipeline needs. Three jobs, all of which must be green:

1. **Lint & type check** — `bun run check:ts` then `bun run lint:ts`.
2. **TypeScript tests** — `bun run ci:test:ts:workspace`.
3. **Secret scan (keyhog)** — pinned keyhog binary scans the tree; fails on any *new*
   secret (the committed `.keyhog-baseline.json` suppresses known public OAuth client
   IDs and test fixtures). It gates on keyhog's exit-code semantics, not a binary
   exclude-list — see the header comment in `checks.yml`.

To keep it green before you push: run `bun run check` and the relevant test bucket
locally. Never weaken a test or the baseline to pass (Laws 6 & 9).

### `ci.yml` — the build + release pipeline (`main` pushes and release tags)

Runs entirely on GitHub-hosted runners (`ubuntu-22.04`, `macos-14`, and the OS
matrix — no self-hosted dependency). On an ordinary `main` push it builds/caches the
native addons and runs the full test matrix. When `HEAD` carries a `v*` release tag
(see below), the same run additionally builds the per-platform binaries, then
publishes: **GitHub release** (all binaries + `.sha256`), **npm** packages, and the
**Homebrew** formula.

## Releasing

> Full contributor detail: [`docs/internal/releasing.md`](docs/internal/releasing.md)
> and [`docs/internal/deployment.md`](docs/internal/deployment.md). This section is the
> operational summary.

`veyyon` is a source fork of oh-my-pi (see `UPSTREAM.md`). The changelog carries
upstream's release history; **veyyon's own release process is the flow below**, and a
release is only real once it is a tagged commit **and** a published GitHub release that
`install.sh` can resolve.

### How a release happens

1. Ensure every change since the last release sits under each affected package's
   `## [Unreleased]` changelog section (per-package `packages/*/CHANGELOG.md`).
2. From a clean `main`, run `bun run release <version|major|minor|patch>`.

`scripts/release.ts` then, in order: verifies you're on clean `main` and the version
is greater than the latest tag → bumps every public `package.json` + root catalog
`@veyyon/*` entries → bumps the Rust workspace version, `veyyon-natives` sentinel, and
regenerates lockfiles → normalizes and finalizes changelogs (`[Unreleased]` → the new
version, adds a fresh `[Unreleased]`) → runs `bun run check` → commits
`chore: bump version to vX.Y.Z` → tags and **atomically** pushes `main` + the tag (by
commit sha, to survive tag-pruning maintenance) → watches CI until the release jobs
pass. Use `bun run release watch` to re-attach to CI for the current commit.

The tagged push is what makes `ci.yml` build the binaries and publish. After it's
green, `curl -fsSL https://get.veyyon.dev | sh` (which reads
`github.com/santhreal/veyyon` `releases/latest`) installs the new version. Verify with
a real install on a clean machine, not just a `cargo`/`bun` build.

### The first veyyon release is `1.0.0`

The repo carries **no `v*` tags** yet — only the inherited oh-my-pi changelog history
(see the fork notice atop each `CHANGELOG.md`). `release.ts` treats the absence of tags
as a `0.0.0` baseline, so `bun run release 1.0.0` (equivalently `release major`) cuts
the first release cleanly instead of aborting on `git describe`. Package `version`
fields sit at the `16.5.2` fork point until then; the release run flips every public
package, the Rust workspace, and the `veyyon-natives` sentinel to `1.0.0` in one atomic
commit. Before running it, add a short "First veyyon release" summary under each
changed package's `## [Unreleased]` so the generated `## [1.0.0]` entry isn't empty.

## Maintenance

Routine operational tasks and where their single source of truth lives. Full detail
lives in [`docs/internal/deployment.md`](docs/internal/deployment.md).

### Website (veyyon.dev)

Static site under `website/`, deployed to Cloudflare Pages.

- **Build**: `bun run site:build` — regenerates `changelog.html` from the real
  `packages/coding-agent/CHANGELOG.md` (fork-aware: veyyon releases vs inherited
  oh-my-pi history), stages the install scripts, and runs a brand check that fails
  the build on a leaked old product name.
- **Deploy**: `bun run site:deploy` — builds, then publishes to the `veyyon` Pages
  project. Needs `CLOUDFLARE_API_TOKEN` (`export CLOUDFLARE_API_TOKEN="$CF_PAGES_API_TOKEN"`;
  the token lives in `/credentials/.env`). `--dry-run` builds and prints the command
  without deploying.
- **Two Pages projects**: `veyyon` serves `veyyon.dev`; `veyyon-get` serves
  `get.veyyon.dev`, the `curl -fsSL https://get.veyyon.dev | sh` install endpoint.
  Deploy the latter with `VEYYON_PAGES_PROJECT=veyyon-get bun run site:deploy`.
- **Handbook**: `website/docs` is a symlink to `docs/handbook/book`; rebuild it with
  `mdbook build` in `docs/handbook` before deploying if the docs changed.
- The staged `website/install.sh` / `install.ps1` are build artifacts — the source of
  truth is `scripts/install.{sh,ps1}`. Edit those, not the copies.

### Install endpoints

`install.sh` resolves the platform, reads `github.com/santhreal/veyyon`
`releases/latest`, downloads `veyyon-<platform>-<arch>` plus its `.sha256`, and
**fails closed** on a checksum mismatch. It covers linux (x64/arm64) and darwin
(x64/arm64); Windows uses `install.ps1`. A release that ships only some platforms
will 404 for the rest — keep the release asset set complete.
