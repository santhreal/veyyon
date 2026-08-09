# Development Rules

## NEVER verify UI with tmux (BINDING — the user's explicit, repeated order)

Do not use tmux captures to judge, verify, or "live-verify" any visual change. Ever. The user has said this repeatedly and it keeps being violated. Why it fails: tmux renders on a pure-black default ground, strips or distorts styling in `capture-pane`, and hides exactly the class of bugs that matter (explicit dark background fills looked invisible in tmux and shipped as black slabs on the user's grey terminal — 2026-07-22). A tmux dump is not evidence; treating it as evidence has caused shipped regressions.

What counts as visual evidence instead:
1. **Real-render image proofs**: render the actual shipped component off-screen and rasterize to PNG on BOTH a grey ground (`#1e2127`-class) and a black ground, then look at the image. The tool is `scripts/demos/render-proof.ts`: it takes any renderer's ANSI on stdin and writes `<out>-grey.png` and `<out>-black.png`.

   ```sh
   bun scripts/demos/render-transcript-rail.ts --width 100 --ruler |
     bun scripts/demos/render-proof.ts --out /tmp/rail-after --width 100 --scale 3
   ```

   Write a small renderer under `scripts/demos/` for the surface you are changing (see `render-transcript-rail.ts` and `render-status-footline.ts`), constructing the REAL components rather than mock-ups. Take the pair BEFORE your change and again after, and compare all four images: an explicit dark fill is invisible on black and reads as a slab on grey, so one ground answers half the question. The tool reports any character it has no glyph for; add it to `scripts/demos/lib/glyphs.ts` when it matters to what you are proving, rather than reading the placeholder boxes as a rendering bug.
2. **String/ANSI assertions** in tests that pin exact bytes, colors, and widths.
3. **The user's own screenshots** are ground truth; when they contradict any other signal, they win.

Any background fill, color, spacing, or motion change verified only through tmux is UNVERIFIED and must not be called done.

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
| `packages/argot`        | Per-project shorthand vocabularies: lossless substitution codec over `AGENTS.dict`. Published standalone — depends on nothing in this repo |
| `packages/hashline`     | Line-anchored patch language the edit tool applies, with a pluggable filesystem backend |
| `packages/mnemopi`      | Local SQLite memory engine: triples, embeddings, recall |
| `packages/wire`         | Dependency-free collab wire types, so a browser or test client need not depend on coding-agent |
| `packages/tool-render`  | Shared React tool-call renderers for HTML export and collab-web |
| `packages/collab-web`   | Browser guest client and local relay for collab live sessions (private) |
| `packages/swarm-extension` | Swarm orchestration extension |
| `packages/metaharness`  | Benchmark runners, Harbor run storage, REST/SSE API, live dashboard (private) |
| `packages/deepswe-bench` | DeepSWE bench runner for performance-affecting changes (private) |
| `packages/typescript-edit-benchmark` | Edit-tool benchmark from TypeScript source mutations (private) |
| `packages/simulations`  | Deterministic offline simulations driving real subsystems end to end (private) |
| `crates/veyyon-natives`     | Rust crate for performance-critical text/grep ops    |

`packages/tsconfig.workspace.json` is shared TypeScript config, not a package: no `package.json`, no sources. `scripts/package-map-coverage.test.ts` fails when a directory under `packages/` carries a manifest and is missing from either table, so a new package cannot land undocumented.

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

1. **A demo under `assets/tapes/` (see [`.veyyon/skills/INDEX.md`](.veyyon/skills/INDEX.md)).** A VHS tape or recording that drives the real feature end to end, the way a user would reach it. Not a unit test, not a snippet in a comment. Use [record-demo](.veyyon/skills/record-demo/SKILL.md) for mechanics and [prove-feature](.veyyon/skills/prove-feature/SKILL.md) when the demo must show a Veyyon-unique capability. Someone should be able to run it and watch the feature do its job, and watch it behave differently with the feature off vs on.
2. **A settings differential: two screenshots, off and on.** Capture the settings screen with the feature off, then with it on, so the pair shows the knob is wired, not just declared in a defaults table. Seed each state deterministically (`veyyon config set <path> <value>` before recording) rather than by pressing a toggle whose keybinding may not land; drive both from one tape run through a small driver so the pair regenerates together. Store both next to the demo. **A degenerate pair — the two shots identical, or the "on" shot not actually on — is a failed proof; check the bytes differ and the values changed.**
3. **A bench with exact parity.** Measure the feature on and off against the same corpus, same inputs, same seed. Report the exact numbers. "Exact parity" means the off-arm reproduces the pre-feature baseline to the token or the millisecond, so any delta is attributable to the feature and nothing else. A bench that cannot reproduce its own baseline proves nothing.

Beyond the three artifacts, **assert every setting the feature adds actually works end to end** — the default is honored, each non-default value changes observable behavior, and an invalid value fails loud. A setting that appears in the defaults but never reaches behavior is a defect, the same class as a dead flag.

**An experimental feature that is off hides its dependent knobs completely.** When a feature is gated behind a master toggle and that toggle is off, the knobs that only matter when it is on must not appear in the settings screen at all — not greyed out, not inert, gone. Wire each dependent setting to a `ui.condition` that reads the master toggle; the setting itself is declared in `packages/coding-agent/src/config/settings-domains/<domain>.ts`, and the predicate it names is registered in `CONDITIONS` in `packages/coding-agent/src/modes/components/settings-defs.ts`. The selector hides any setting whose condition returns false. The off-vs-on screenshot pair is exactly what proves this: off shows only the master toggle, on shows the toggle plus its dependents. A dependent knob visible while the feature is off is a defect.

If a feature cannot meet this bar, it is experimental and must say so in its settings group, stay off by default, hide its dependent knobs while off, and carry a backlog row for the missing proof. Do not ship it as done.

## Agents are a cost ladder, not a taxonomy

There is no such thing as a specialist agent. `scout`, `reviewer`, `librarian`, `designer`, `sonic` and `task` are not job titles, and the model does not route by domain. The only axis separating them is how much reasoning, context and tool surface a piece of work needs, and therefore what it costs. The scope question is certainty rather than size: known edits across many files and several repositories are light work, one file of unknown work is heavy.

**Enabling or disabling an agent MUST change where work lands, not just what the prompt says.** Today it does not, and the mechanism is written up in [`docs/internal/task-agent-discovery.md`](docs/internal/task-agent-discovery.md) under "What the model is actually told, and why enablement is inert". Read that before touching the roster.

Two rules follow from it:

- **A row that changes no behavior is not a feature.** Before you add, rename, or re-describe an agent, name which spawns move to it and which move off it. If disabling it changes nothing but the prompt's token count, it does not ship.
- **Two agents that share a prompt body are one agent.** Never claim the system prompt distinguishes two agents without diffing the bodies the workers receive and the model each resolves to through `resolveSubagentModel`.

## Code Quality

- No `any` unless absolutely necessary.
- **NEVER use `ReturnType<>`** — use the actual type name.
- **NEVER use inline imports** — no `await import()`, no `import("pkg").Type` in type positions, no dynamic type imports. Always top-level.
- Check `node_modules` for external API types instead of guessing.
- **Dependency versions live in the catalog.** A third-party version that two or more packages share belongs in `workspaces.catalog` in the root `package.json`, and each of those packages writes `"react": "catalog:"` rather than a literal range. Adding a dependency a second package already uses means adding it to the catalog and repointing both. A dependency with exactly one consumer may keep a literal range: it has nothing to diverge from, and the catalog is there to stop divergence, not to list every leaf. Once a dependency is in the catalog, no package may restate its version, even a version that agrees today. Peer dependencies stay literal (a consumer outside this workspace cannot resolve `catalog:`) but must name the version the catalog resolves. `scripts/workspace-catalog-pins.test.ts` fails on all three mistakes. It cannot see a single-consumer literal, which is the one case it is not meant to catch.
- **Barrel exports**: prefer `export * from "./module"` over named re-exports, including `export type { ... } from`. In pure `index.ts` barrels, use star re-exports even for single-specifier cases. If stars create ambiguity, remove the redundant export path; do not keep duplicates.
- **Class privacy**: use ES `#private` fields; leave externally accessible members bare. **No `private`/`protected`/`public` keyword on fields or methods**, except on **constructor parameter properties** where TypeScript requires it (e.g. `constructor(private readonly session: ToolSession)`) and on a **private constructor**, which is the factory pattern and has no `#` spelling. A hook a subclass overrides drops the keyword and stays bare rather than becoming `#`, since a `#` member cannot be overridden. Enforced across every package by `scripts/class-privacy-is-the-hash.test.ts`, which carries a shrink-only allowlist for files a lane is editing right now.
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

## Bun (frozen surface, Rust is the direction)

Bun is the runtime and the test runner today. That is a fact about the present, not a preference to build on. The long-term direction for this project's tooling is Rust and Cargo: `crates/` is where capability keeps moving, and the TypeScript that stays should be as ordinary as possible so it is cheap to port or to retire. Everything below follows from that, and it is deliberately narrow.

### The rule: new code does not grow the Bun surface

Avoid Bun wherever it is avoidable. In new code, reach for the portable option first, in this order: the language itself, `node:*`, POSIX tooling, then Bun. A plain bash script that works is better than a Bun script that does the same job. A standard library call is better than a Bun-specific convenience. Choose a Bun API only when there is no reasonable portable equivalent, and say in a comment which equivalent was missing.

| Need                  | Prefer                                                            | Not                                   |
| --------------------- | ----------------------------------------------------------------- | ------------------------------------- |
| Read / write a file   | `fs.readFile`, `fs.writeFile` (`node:fs/promises`)                 | `Bun.file()`, `Bun.write()`           |
| Environment variables | `process.env`                                                      | `Bun.env`                             |
| Run a command         | `execFile` / `spawn` from `node:child_process`, or a shell script  | `` $`cmd` ``, `Bun.spawn()`           |
| Sleep                 | `setTimeout` from `node:timers/promises`                           | `Bun.sleep()`                         |
| Hashing and digests   | `node:crypto`, WebCrypto                                           | `Bun.hash()`                          |
| Module path           | `import.meta.dirname`, `import.meta.filename`                      | `import.meta.dir`, `import.meta.path` |
| HTTP server           | `node:http`                                                        | `Bun.serve()`                         |

Every spelling in the middle column runs unchanged on both Bun 1.3 and Node 22, so writing it that way costs nothing now and saves a rewrite later.

When a Bun API really is the only option, keep it in one place. `$which` in `packages/utils/src/which.ts` is the pattern: `Bun.which` is called there and nowhere else, so the tree depends on one repo helper rather than on hundreds of Bun call sites.

Two things this rule does not license:

- **It is not permission to shell out.** Spawning a process for something the standard library does in memory is worse on both counts, portability and cost. Use `fs.mkdir(dir, { recursive: true })`, never `mkdir -p` through a child process, and use `$which("git")` from `@veyyon/utils`, never a spawned `which`. "Prefer a bash script" is about how you write a new tool under `scripts/`, not about how application code touches the filesystem.
- **It is not permission to add a dependency.** `Bun.stringWidth()`, `Bun.wrapAnsi()`, `Bun.JSON5`, `Bun.JSONL`, and `bun:sqlite` have no free portable equivalent. Swapping them for npm packages trades one Bun call for supply-chain surface and, in the sqlite case, a native build. They stay.

### What is not changing

Bun appears in 5023 files: `bun:test` in 4564 of them, `Bun.env` in 1289, `Bun.file` in 1259, `Bun.write` in 1232. None of that is in scope, and the size is the reason.

- Do not migrate existing Bun code opportunistically. A drive-by rewrite of code that works is churn, and it is a merge conflict against whoever is actually working in that file.
- The test runner stays on `bun:test` for now. Moving off it is its own project with its own decision, not a side effect of someone else's patch.
- None of this is a deprecation. Existing `Bun.file`, `Bun.write`, and `Bun.env` calls are correct code and stay correct.

The rule governs new code, and code you are already rewriting for another reason. If you are rewriting a file anyway, use the portable spelling on the lines you touch and leave the rest alone. Do not widen a diff in order to convert a file.

### Working in the Bun code that is here

You will read and edit it every day, so the local conventions still matter.

**Node module imports.** Namespace imports for `node:fs`, `node:path`, `node:os`:

```typescript
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
```

An async-only file imports `node:fs/promises`. A file needing both sync and async imports `node:fs` and reaches async through `fs.promises.xxx`. Keep sync APIs out of async flows; use one only when a synchronous interface forces it.

**Paths that are allowed to be absent.** Go through `@veyyon/utils` (`readdirIfPresent`, `statIfPresent`, `pathExists` and its strict and quiet twins), not `fs.existsSync` and not `.catch(() => [])`. Pick by what should happen to a fault; the header of `packages/utils/src/fs-optional.ts` explains the four contracts. For a plain optional read, catch rather than probe first:

```typescript
import { isEnoent } from "@veyyon/utils";
try {
	return JSON.parse(await fs.readFile(configPath, "utf8"));
} catch (err) {
	if (isEnoent(err)) return null;
	throw err;
}
```

An existence check followed by a read is two syscalls and a race between them. Drop the check.

**Streams.** Use the readers in `@veyyon/utils`: `readPipeText` for a whole pipe, then `readLines`, `readJsonl`, `readSseEvents`. Write a manual reader loop only when the protocol needs one.

**Spawning.** Existing call sites use Bun Shell (`` $`cmd` ``) with `.cwd(dir)`, `.quiet()`, `.nothrow()`, and `.text()`, and reach for `Bun.spawn` / `Bun.spawnSync` for the long-running and streaming cases (LSP, kernels, SSE, JSON-RPC). Leave them as they are. In pipe mode the stream needs a cast:

```typescript
const child = Bun.spawn(["cmd"], { stdout: "pipe", stderr: "pipe" });
const reader = (child.stdout as ReadableStream<Uint8Array>).getReader();
```

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

Argot is the codec that lets the model write short `§handle` tokens; veyyon expands them to full text before anything outside the model's history sees them. **The complete integration spec lives in the `argot` package's [`INTEGRATING.md`](packages/argot/INTEGRATING.md) — read it, do not re-derive it.** All codec logic (longest match, the boundary rule, streaming a handle split across token deltas) lives in argot behind named functions. veyyon's job is only to call those functions at the seams; never hand-roll handle logic here.

- **Every seam is wired in one place: `packages/coding-agent/src/argot-wire.ts`.** It is the only veyyon module that touches the codec. The seams (argot's manual numbers them 1-6): `expandToolArguments` (tool args), `expandAssistantContent` (finished display), `createSubagentStreamDecoder` (the live streamed preview — feeds `StreamDecoder.push`/`flush`, never a raw delta), `expandSessionContext` (transcript/export/resume), and `expandSubagentReturn` (a subagent's result to its parent).
- **The contract is absolute: a user NEVER sees a raw `§handle`.** That includes the live subagent HUD preview (`progress.recentOutput` in `task/executor.ts`), which decodes streamed deltas through `createSubagentStreamDecoder`. A raw handle reaching any display, tool, transcript, or the parent is a defect, not a cosmetic issue.
- **Adding a new place the model's text crosses out of its history is adding a seam.** Route it through an `argot-wire.ts` function; if none fits, add one there (a thin delegate to `argot`), never a new codec call site scattered elsewhere.
- Tests: `test/argot-subagent-*.test.ts` drive the real executor and prove each seam with a negative control (revert the expand → the handle leaks). Any new seam gets the same treatment.
- **Argot meets the [10-minute proof rule](#proving-a-feature-the-10-minute-rule).** Its artifacts: the settings differential `assets/argot-settings-off.png` and `assets/argot-settings-on.png` (regenerated together by `scripts/demos/record-argot-settings.sh`, which seeds `argot.enabled` off then on with `config set` and records the single-state tape `assets/tapes/argot-settings.tape` twice) — off shows only the "Argot Shorthand" master toggle, on shows it plus the four dependent knobs (Models, Dictionary Budget, Context Cutoff, Subagents), proving the `argotEnabled` condition hides them while off; and the live bench `packages/typescript-edit-benchmark/src/argot-bench.ts` (runs the edit tasks with encoding on and off and certifies the token delta). Every Argot setting is asserted end to end in `test/argot-settings-e2e.test.ts` (the operator's value binds through the real `Settings` into the gate and the codec, and a disabled-vs-enabled test asserts the knobs are hidden while off). Keep all of these current when you touch Argot.

## Commands

- Commit frequently. Land each logical chunk as its own commit as soon as it stands on its own and its gate is green, rather than accumulating a large uncommitted tree. Waiting to be asked is not the rule; the working tree is not a staging area. Pushing is separate and still needs explicit approval.
- Stage only the paths you changed. This tree routinely carries other people's in-flight work, so `git add -A` is banned; a commit that sweeps up an unrelated lane is worse than no commit.
- Never use `tsc`/`npx tsc` — always `bun check`.

**Gate scripts** (defined in the root `package.json`; run the narrowest one that covers your change):

| Command | What it does |
| --- | --- |
| `bun run check` | Type check TS **and** Rust in parallel (`check:ts` + `check:rs`). The release preflight runs this. |
| `bun run check:rs` / `lint:rs` | `cargo fmt --check` and `cargo clippy --workspace --all-targets -D warnings`. `--all-targets` is what makes these compile tests and benches as well as libs and bins; without it a test file that does not build passes both gates and only fails later in `test:rs`. |
| `bun run check:ts` | Workspace `tsc --noEmit` across every package. Despite the name it runs no Biome. |
| `bun run check:tools` | `biome check`: formatting, import order, and error-level lint rules. CI gate. |
| `bun run lint` / `lint:ts` | `biome lint` only, so it sees neither formatting nor import order. Its warnings are advisory; fix real bugs, don't contort for style. |
| `bun run test` | Local TS test runner (`scripts/ci-test-ts.ts local`). |
| `bun run ci:test:ts:workspace` | The exact workspace test bucket CI runs. |
| `bun run ci:build:native` | Build the `veyyon_natives` addon — required before tests that touch native paths. |

`suspicious/noTemplateCurlyInString` flags a plain string containing `${...}`, on the theory you meant a template literal. A test that quotes source text from another language (`install.sh`, the generated PowerShell completions, a GitHub Actions expression) trips it on bytes that are the fixture itself. Suppress those one site at a time with a `biome-ignore` line naming what the `${...}` really is, rather than turning the rule off for tests: the rule still catches a genuinely missed template in the test's own code.

**Commit conventions:**
- Commit in **logical chunks**, one concern per commit — never one giant `git add -A`. Stage only the paths you changed.
- Subject line is imperative and scoped, e.g. `polish(onboarding): …`, `fix: …`, `ci: …`, `test(agent): …`.
- Do not add AI/assistant attribution trailers (no `Co-Authored-By: <model>`, no `Generated with …`). Commit as the configured git user only.
- The **release** commit is special. Its subject **must** be exactly `chore: bump version to vX.Y.Z`. `checks.yml` keys its changelog exemption off that prefix, because the bump commit drains every `## [Unreleased]` section by design. `scripts/release-cut.ts` writes it; never hand-craft it.

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

### Regression suites: close the class, not the incident (BINDING)

A fix is not finished when the reported symptom stops reproducing. It is finished when
you can say this sentence out loud about the suite you wrote, and defend it:

> As long as this suite passes, this exact defect cannot happen again, AND no other
> member of its general class can happen either.

If you cannot say that, the work is not done. Not "the reported case is covered", not
"mostly closed". Not done. Two failures below the bar have both shipped here:

- **The incident-only suite.** It pins the one input from the report. The next variant of
  the same mistake lands green, because the mechanism was fixed for the case someone had
  in mind and not for its siblings.
- **The green-by-luck suite.** It passes for a reason other than the one you think, so it
  stays green while the behavior is broken.

The rules that follow are what separate a suite that closes a class from one that
describes a bug report.

1. **Drive the production path, not a stand-in for it.** Construct the real component,
   the real session, the real registry, the real tool, and reach the defect the way a
   user reaches it. A mock is legitimate only at an external boundary you cannot run (a
   provider's HTTP endpoint, the clock, a missing binary); mocking the code that carries
   the bug proves the mock behaves, which nobody was worried about. A suite whose subject
   is a hand-rolled fake of the thing under test is not evidence, and neither is one that
   asserts a spy was called.
2. **Enumerate the variant space from source at run time.** Sweep the registry, the union
   type, the enum, the exported table, the directory. A hardcoded list of members goes
   stale in silence, which is the same as having no test: the member added next year is
   the one that breaks.
3. **Fail by default on a new member.** Adding a provider, tool, agent, route, setting,
   error source, or dialect must turn the suite RED until someone records a decision for
   it. Opt-outs are pinned by exact equality (`expect(optedOut).toEqual(["yield"])`),
   never counted and never matched loosely, so a second member cannot slip into the
   exemption.
4. **A member that cannot be exercised is a hole, not a pass.** If a sweep cannot
   construct one of the things it enumerates, fix the harness until it can and assert the
   unconstructable set is empty. Silently skipping the awkward member is how the class
   stays open.
5. **Observe RED, then mutation-gate every branch.** Re-inject the original defect and
   watch the suite fail for the right reason; a suite never seen red is an assumption.
   Then mutate each branch you claim to cover, one at a time, including the tempting
   refactor a later reader would try. A mutation that stays green means the TEST is
   wrong. Mutate by editing the source and restoring it in the same step, proving the
   restore with `git diff --numstat`; never `git checkout`, `revert`, or `stash` in this
   shared tree.
6. **Assert termination and bounds, not only values.** Anything with a deadline, retry,
   backoff, queue, or stand-down gets an assertion that it ends and an assertion of the
   bound. A test that can only observe a wrong value cannot see a hang.
7. **Version anything persisted and test the stale copy.** A cached, serialized, or
   on-disk shape resurrects fixed bugs after the fix ships. Changing such a shape means a
   version bump plus a test that a stale entry is rejected rather than served.
8. **Say what the suite does not catch.** Open with a WHY comment naming the defect, the
   class it closes, and the gap it leaves. The next reader needs to know where the fence
   ends.
9. **Try to break your own suite before you report it.** Describe a change that
   reintroduces the defect or a sibling and leaves the suite green. If you can describe
   even one, go back and cover it, then write down in your report which variants you
   tried to smuggle past your own tests and whether each was caught. A report that never
   attempted this has verified nothing.

Name the file after the behavior it defends, in prose
(`a-question-to-the-user-ends-the-turn.test.ts`,
`a-cell-cannot-run-a-tool-with-arguments-its-schema-rejects.test.ts`), not after the
module or the issue number. The filename is the contract; an issue number is a lookup.

## Changelog

Location: `packages/*/CHANGELOG.md` (per package).

**Format** — sections under `## [Unreleased]`:
- `### Breaking Changes` (first if present)
- `### Added`
- `### Changed`
- `### Fixed`
- `### Removed`

**Rules:**
- New entries always go under `## [Unreleased]` in the OWNING package's `packages/<name>/CHANGELOG.md`.
- **Never write an entry into the repo-root `CHANGELOG.md`.** It is generated from every package changelog by `bun run changelog:root`, so an entry written there is not a changelog entry: it is content the next regeneration deletes. The root is the file you open first and it reads as hand-written, which is exactly why this keeps happening — 23 entries across several packages were written there and would have been lost. The write path now refuses when the root holds an unreleased entry the render does not produce, and names each one, so the deletion can no longer be silent.
- Never modify already-released sections (e.g., `## [0.12.2]`) — they are immutable.
- Don't flag changelog section order or formatting in reviews or PRs — the Release workflow runs `fix-changelogs` and normalizes everything automatically.

**Enforced (`changelog` CI job on every push to `main` and every PR).** `bun run changelog:check` fails when a change to a publishable package's shipped source lands without a bullet under that package's `## [Unreleased]` section. It runs on the direct-to-main push (base: the branch tip before the push) as well as on PRs, because changes land directly on `main` here; a PR-only gate would never fire and shipped source would reach releases undocumented. This is what makes releases safe to cut at any time: a change can never land without reaching the changelog. Tests, fixtures, docs, `package.json`, and `tsconfig*.json` are not "shipped source" and never trigger it. The release bump commit (`chore: bump version to ...`) is exempt. Run it locally before pushing with `CHANGELOG_BASE=origin/main bun run changelog:check`.
- Every publishable package must own a `CHANGELOG.md`. A package with none used to be skipped by the gate, which meant its source shipped with nothing checking it at all, and two packages sat that way for several releases before anyone noticed. The gate now fails and names the file to create. A package that is genuinely not published says so with `"private": true` in its `package.json`.
- **There is no escape hatch, and removing it is the point.** `[skip changelog]` used to waive a change, and a bare marker waived the entire push, so one throwaway housekeeping commit switched the gate off for every package beside it. The scoped spelling failed differently: it was easier to type than a sentence, so it became the standing answer to "this is only a refactor" and thousands of commits reached releases with a changelog that does not describe them. If a change touches shipped source, it gets a line. A change with genuinely no user-facing effect gets a line saying that, which costs less than the argument and is what makes the rest of the file worth reading.

**Attribution:**
- Internal (from issues): `Fixed foo bar ([#123](https://github.com/santhreal/veyyon/issues/123))`.
- External contributions: `Added feature X ([#456](https://github.com/santhreal/veyyon/pull/456) by [@username](https://github.com/username))`.

## Continuous Integration

Two public workflows run in `.github/workflows/`. Both gate changes and releases.

### `checks.yml` — the fast public gate (every push to `main` + every PR)

Runs on GitHub-hosted runners and validates workspace type checking and linting,
Rust formatting and clippy, secret scanning of the commits the change adds,
changelog coherence, changed-suite global-state isolation, and the TypeScript test
suite.

The Rust gate lives HERE and nowhere else. `cargo fmt --all -- --check` answers in
seconds, and it used to run only inside `ci.yml`'s native matrix, behind an
artifact lookup, a toolchain install and a runner queue: a rewrapped doc comment
turned main red about 70 minutes into a run and skipped all seven TypeScript test
jobs behind it. Do not add a second copy to a native job.

To keep it green before you push: run `bun run check` and the relevant test bucket
locally. Never weaken a test to pass (Laws 6 & 9).

### `ci.yml` — the public build + runtime gate (`main`, PRs, and release dispatches)

Runs entirely on GitHub-hosted runners (`ubuntu-22.04`, `macos-14`, and the OS
matrix — no self-hosted dependency). It compiles the product and native addons,
runs the full test matrix, and exercises the installers and CLI runtime. When
dispatched at a `v*` release tag (see below), the same workflow additionally builds
the per-platform binaries, verifies their SHA-256 sidecars and runtime smoke tests,
then publishes the **GitHub release** and redeploys `veyyon.dev/changelog`. That is
the whole published surface — see Distribution.

## Distribution — GitHub only (no npm, ever; no cargo yet)

Veyyon ships through **exactly two** channels and no others:

1. **`curl -fsSL https://get.veyyon.dev | sh`** — the installer and the auto-updater both
   talk to **veyyon.dev**, which serves the prebuilt, self-contained binary and links a
   short `vey` command. veyyon.dev **propagates automatically from GitHub Releases**
   (`github.com/santhreal/veyyon/releases`), which is the upstream it mirrors; a user or
   the running binary only ever reaches veyyon.dev.
2. **A git checkout you clone yourself** (`git clone`, then `bun run setup` / `bun dev`)
   for contributors and anyone who wants to drive the workspace. The installer never
   creates this checkout. The user clones it, into a directory the user picks.

There is **no npm package and there never will be**. There is **no `cargo publish`
yet** (maybe one day; not now). Do not add, document, or assume an npm / bun-global /
Homebrew / mise / crates.io install or update path for veyyon itself — treat any such
reference as a defect to remove. The install/update endpoint is **veyyon.dev**; the
upstream source of "what versions exist" is the **GitHub Releases** it propagates from;
the only install methods are the release **binary** (served via veyyon.dev) and a
source **checkout**. (Extensions and the SDK are a separate matter: an extension may
still `npm install` its own dependencies — that is not veyyon's own distribution.)

## Releasing

> Full contributor detail: [`docs/internal/releasing.md`](docs/internal/releasing.md)
> and [`docs/internal/deployment.md`](docs/internal/deployment.md). This section is the
> operational summary.

`veyyon` is a source fork of oh-my-pi (see `UPSTREAM.md`). The changelog carries
upstream's release history; **veyyon's own release process is the flow below**, and a
release is only real once it is a tagged commit **and** a published GitHub release that
`install.sh` can resolve.

### How a release happens

Two commands, and the tag one of them cuts at the end is the only thing that
publishes. Nothing on `main` cuts a tag on its own: not a push, not a green CI
run, not a waiting `## [Unreleased]` bullet.

```sh
bun run release:dry minor      # say what a cut would do. Writes nothing.
bun run release minor          # do it.
```

`bun run release <major|minor|patch|x.y.z>` bumps every public `package.json`, the
root catalog, the Rust workspace, the natives sentinel and the lockfiles, rolls
each package's `## [Unreleased]` into a dated section, regenerates the root
changelog, and commits `chore: bump version to vX.Y.Z`. It then shows the commit
and tag it is about to publish and asks once. On yes it pushes `main`, waits for
that exact SHA's checks, and tags only once they are green.

**It still needs explicit approval to run**, because it pushes. The prompt is
where that approval is given, there is no flag that answers it in advance, and
an agent never answers it. `release:dry` is the non-interactive mode, and it is
non-interactive precisely because it publishes nothing.

Three underlying moves, which you can always finish by hand and which every
non-publishing exit prints:

1. **Prepare locally.** Everything above through the bump commit. Never pushes,
   never tags.
2. **Push to main.** The bump commit goes through main's ordinary CI like any
   other commit. This publishes nothing.
3. **Tag the green commit.** `git tag vX.Y.Z && git push origin vX.Y.Z` starts the
   one CI run that builds, verifies and publishes.

The tag must name a commit that reached `main`, and that is the whole safety
argument: `main` tested it before the tag existed. `ci.yml` enforces it.
`scripts/release.ts verify-tag` compares the tagged commit against `main` and
refuses anything but `identical` or `behind`, refuses a non-`vX.Y.Z` ref, refuses a
tree whose version authorities disagree with the tag, and refuses when the
comparison cannot be established at all. Tagging an older `main` commit is fine and
expected when `main` moved on during preparation.

There is no release controller, no `release.yml`, no dispatch inputs, and no nonce
correlation. Preparation is local and inspectable; publication is one tag push.

### The veyyon release line starts at `1.0.0`

The inherited oh-my-pi changelog history remains below the fork notice, but veyyon
tags started at `v1.0.0`. `release.ts` treats an empty tag set as a `0.0.0` baseline,
which keeps that identity reproducible if the tag set is rebuilt. Current releases
continue monotonically from that veyyon-owned baseline.

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
- `site:build` stages copies of the installers under `website/` as `install.{sh,ps1}`.
  They are build artifacts, gitignored, and exist only so the Pages project can serve
  them. The source of truth is `scripts/install.{sh,ps1}`. Edit those, not the copies.

### Install endpoints

`install.sh` resolves the platform, reads `github.com/santhreal/veyyon`
`releases/latest`, downloads `veyyon-<platform>-<arch>` plus its `.sha256`, and
**fails closed** on a checksum mismatch. It covers linux (x64/arm64) and darwin
(x64/arm64); Windows uses `install.ps1`. A release that ships only some platforms
will 404 for the rest — keep the release asset set complete.
