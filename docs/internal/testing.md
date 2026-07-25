# Testing

How to run the suites and how to write a test that earns its place. The rules here are
the enforced ones from the repo `AGENTS.md`, expanded for contributors.

## Running

From the repo root (or `--cwd=packages/coding-agent` for package-local runs):

| Command | What runs |
| --- | --- |
| `bun run check` | The gate: type check (TS + Rust) and lint, in parallel. Run this before every push. |
| `bun run check:ts` | Biome + `tsc --noEmit` across every package. |
| `bun run test` | The local TS test runner (`scripts/ci-test-ts.ts local`). |
| `bun run test:ts` | Full local TypeScript suite (`local-ts`). |
| `bun run ci:test:ts:workspace` | The exact workspace bucket CI runs. |
| `bun run ci:build:native` | Build the `veyyon_natives` addon, required before tests that touch native paths. |

Native/integration tests need the addon built first (`ci:build:native`); the CI test
jobs download a prebuilt addon artifact instead.

### Buckets (`scripts/ci-test-ts.ts`)

| Mode | Contents |
| --- | --- |
| `workspace` | Fast packages (hashline, wire, utils, catalog, ai, agent) + script gates |
| `native` | natives, tui, typescript-edit-benchmark |
| `coding-agent-singleton` | Settings / global-state suites (one process; do not chunk) |
| `coding-agent-ui` | TUI/interactive suites (chunk size 5; ghostty GC ceiling) |
| `coding-agent-runtime` | Session, RPC, SDK, MCP, extensions |
| `coding-agent-native` | Tools, bash, browser, sqlite, spawn |
| `coding-agent-heavy` | All coding-agent buckets |
| `local` / `local-ts` | Full local TS (+ Rust for `local`) |

New tests join these buckets by path and content markers in `ci-test-ts.ts`. Do not invent a second runner.

## Quality bar (SQLite-grade)

The goal is not a large case count. The goal is a suite that catches silent semantic
breaks. Headcount is a byproduct of covering real contracts.

SQLite-style rules:

1. **Every bug is permanent.** A fixed failure becomes a named regression with exact
   asserts. Prefer a corpus row over a one-off buried in an unrelated file.
2. **Positive + negative twin.** Every rule has a case that must fire and a sanitized
   twin that must not.
3. **Adversarial before happy-path padding.** Hostile inputs, partial streams, mid-op
   abort, colliding tags, wrong cwd, denied approval, broken frames, unicode/CRLF.
4. **Assert truth, not shape.** Exact bytes, codes, ids, paths, counts. Ban
   `!is_empty()`, bare `not.toThrow()`, "something happened."
5. **Call shipped APIs.** Drive exported product functions. Do not re-implement the
   unit under test inside the test file.
6. **No theater.** No source-grep tests, no cases that exist only to raise counts, no
   random fuzz farms as the expansion strategy. Property/fuzz only when they encode a
   **named product invariant** with fixed seeds and real asserts.

A case ships only if you can name the contract in one sentence, assert exact values,
and it would fail if the engine returned empty success or the wrong file/frame.

## What a test must do

A test defends one **concrete, externally observable contract**, a behavior, output
shape, state transition, error mapping, or a regression-prone parsing boundary. If you
can't name the contract, don't add the test.

Assert real values. `expect(true).toBe(true)`, a bare `not.toThrow()`, a non-empty
check, or a "length grew" check proves nothing and is banned. Assert the file, line,
value, exit code, or output bytes that actually matter.

### Depth for shipped surfaces

For a user-visible or wire-visible surface, land all of:

1. **Positive truth** — exact expected values
2. **Negative twin** — sanitized case must not fire
3. **Boundary** — empty, max, EOF/BOF, unicode, CRLF/LF
4. **Adversarial** — hostile input, concurrent mutation, mid-stream abort, partial frames
5. **Cross-module** — real A → real B when the surface spans packages
6. **E2E** — real CLI/RPC when the surface is operator-facing

Complex multi-step paths (prompt → tool → steer → abort → resume, multi-file edit
batches, RPC id correlation) outrank more happy-path clones of the same function.
Named invariants (apply-then-inverse, id echo rules) beat volume.

## Isolation (required)

A test that only passes alone is broken. Suites that touch Settings, `process.env`,
`VEYYON_*`, profiles, agent dir, or project dir **must** use:

```ts
import { beginSettingsTest, restoreSettingsTestState } from "./helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeEach(() => {
  settingsState = beginSettingsTest();
});

afterEach(() => {
  restoreSettingsTestState(settingsState);
  settingsState = undefined;
});
```

`restoreSettingsTestState` restores env, rebuilds dir state from env
(`__resetDirsFromEnvForTests`), re-applies agent dir / profile / project dir (and
`process.cwd()` via `setProjectDir`), clears the Settings singleton, and restores TUI
tight mode. Prefer this over hand-rolled `resetSettingsForTest` + partial env cleanup.

Spawned CLIs must use `hermeticSpawnEnv()` so children never read or migrate the
developer’s real `~/.veyyon`.

Contract tests for the helper itself live in
`packages/coding-agent/test/helpers/settings-test-state.test.ts`.

### Assert every root, not the one you happened to redirect

An isolation assertion only proves the one path it names. This has now caused
three separate incidents, each with the same shape: a suite redirected one root,
asserted that root, passed for months, and wrote real user data through a
different root the whole time.

There are three roots, and they move independently:

| Root | What lives there | Lever that moves it |
| --- | --- | --- |
| Config root | settings, profiles, agent storage, `shared-auth/agent.db`, `gpu_cache.json` | `VEYYON_CONFIG_DIR` |
| Cache root | argot dictionaries and other regenerable caches | `XDG_CACHE_HOME` |
| Agent dir | one profile's storage inside the config root | `setAgentDir` |

Two traps follow from that table:

- `XDG_CACHE_HOME` moves the cache and nothing else. A suite that redirects only
  the cache still writes settings and agent storage to the real config root.
- `setProfile` and `setAgentDir` name a subdirectory of whichever config root is
  active. They do not move the root, so on their own they only change where under
  your real home the writes land.

So redirect what the code under test actually resolves, then prove each one:

```ts
process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), tempRoot);
process.env.XDG_CACHE_HOME = path.join(tempCache, "cache");
__resetDirsFromEnvForTests();
setProfile(TEST_PROFILE);

// Proof, not intention. Check every root the code can reach, not just the first.
for (const [label, resolved] of [
  ["config root", path.resolve(getAgentDir())],
  ["cache root", path.resolve(getArgotCacheDir())],
] as const) {
  if (path.relative(tempRoot, resolved).startsWith("..")) {
    throw new Error(`${label} not isolated: ${resolved} is outside ${tempRoot}`);
  }
}
```

Run the suite bare (`bun test path/to/suite.test.ts`, without the runner) before
you trust it. The runner hands every child a sandboxed `HOME`, which hides a
missing redirect; running bare uses your real home and is the only way to see the
isolation actually hold.

## Real user data is off limits (three layers)

Your tests must never write to the real `~/.veyyon`. That directory holds working
OAuth credentials, settings, and session transcripts, and damaging it costs a real
person real logins. Three layers enforce this, and none of them require you to
remember anything.

### Why the obvious approach does not work

You will be tempted to isolate a suite like this:

```ts
beforeEach(() => {
  process.env.HOME = temporaryDirectory; // does nothing
});
```

Bun resolves `os.homedir()` once, when the process starts. Assigning
`process.env.HOME` afterwards changes the environment variable and nothing else,
so every config path still resolves under the real home. A suite that did exactly
this opened the real credential store and wrote three fabricated rows into it, and
every one of its assertions passed while it happened. `os.userInfo().homedir`
follows `HOME` too, so there is no in-process way back to the real home once it
has been redirected.

The levers that do work are:

- Set `HOME` in a **spawned** process's environment, which it reads before its own
  resolver runs. Use `hermeticSpawnEnv()` for this.
- Point the app's own override, `VEYYON_CONFIG_DIR`, at a temporary directory. It
  is joined onto the home directory, so a relative path back out of the home lands
  the whole config root in your temp directory.
- Use `XDG_CACHE_HOME` and friends for cache and state paths.

### Layer one: every test child gets a disposable home

`scripts/ci-test-ts.ts` spawns each test process with `HOME` pointing at a fresh
temporary directory, and passes the real config root down in
`VEYYON_TEST_REAL_CONFIG_ROOT`. Because config, credential, and session paths are
all built from `os.homedir()`, a child started this way cannot name real data at
all. This applies to the whole suite without any suite opting in.

### Layer two: the tripwire refuses the write

`packages/utils/test/helpers/real-data-tripwire.ts` is loaded as a `preload`, so it
runs in every test process before any test module. It throws on any attempt to
modify a path inside the real config root, naming the path and explaining the trap
above.

Bun reads `bunfig.toml` from the current directory only, so the preload is
delivered three ways: the root `bunfig.toml` for runs at the repository root, a
one-line pointer in each package's `bunfig.toml` for runs inside a package, and an
explicit `--preload` on every command the runner spawns. Only the pointer repeats;
the tripwire itself has one home.

It covers what prevention cannot: a hardcoded absolute path, a suite that restores
the real `HOME` in `afterEach`, and a bare `bun test path/to/file`. It wraps
mutating `node:fs` calls and also `bun:sqlite`, because the original damage went
through SQLite's native file handling and never touched a single `fs` function.
Reads are allowed, since reading real data is at worst untidy.

If you trip it, fix your test. Do not weaken the tripwire.

Note that the patch rewrites the `node:fs` exports, so it only binds for modules
that import `fs` after it loads. If you write a test that deliberately probes a
real path, check `__tripwire.isGuarded(fs.writeFileSync)` first and refuse to probe
when it is false. Otherwise a late-loaded tripwire turns your probe into the very
write it was meant to prevent.

### Layer three: the runner proves nothing changed

Before the suite runs, the runner records every file under the real config root
with its size and modification time, and checks again afterwards. Any created,
modified, or deleted file fails the run and names the paths, even when every test
passed, because a green suite that damaged real credentials is the worst possible
outcome to report as success.

Logs, session transcripts, and caches are excluded, since a veyyon session you have
open writes to them constantly and reporting that would train everyone to ignore
the check. What stays watched is the surface whose loss is unrecoverable:
credential stores, the global config, the install id, and the per-profile
databases.

### Writing a suite that touches app paths

Isolate through `VEYYON_CONFIG_DIR`, then verify the path the app actually resolved
before you write to it:

```ts
import { assertIsolatedAppPath } from "@veyyon/utils/test/helpers/destructive-guard";

process.env.VEYYON_CONFIG_DIR = path.relative(os.homedir(), temporaryRoot);
__resetDirsFromEnvForTests();
assertIsolatedAppPath(getAgentDir(), "my-suite");
```

Guard the resolved value, not the value you expected. The difference between those
two is the entire incident.

## Running the suite without melting the machine

The runner is sequential by default: one chunk at a time. Each chunk is a
`bun test` process that spawns children of its own, so fanning out to every core
multiplies into hundreds of processes and drove the load average past 80 on a
workstation, making it unusable while the run proceeded. If you want fanout, ask
for it explicitly with `VEYYON_TEST_CONCURRENCY=8` (or `all`), and prefer that on a
machine you are not using for anything else.

## Fixtures and regression corpus

Prefer data-driven cases over copy-pasted `it` bodies. Closing a bug should add a
**corpus row** (or a dedicated regression suite that asserts exact values), not only a
narrative comment.

| Location | Use |
| --- | --- |
| `packages/coding-agent/test/corpus/regressions/*.json` | Named contract rows `{ id, contract, surface, tags, input, expect }` |
| `packages/coding-agent/test/corpus/regressions.runner.test.ts` | Dispatches rows to shipped APIs |
| `packages/coding-agent/test/helpers/corpus-loader.ts` | Load/validate corpus (rejects missing expect / weak contract text) |
| `packages/<pkg>/test/fixtures/` | Local JSON/JSONL/TOML tables for one package |
| `packages/coding-agent/test/fixtures/workspaces/` | Multi-file trees for edit/grep/glob/hashline |
| `packages/hashline/test/*` | Model for pure contract + adversarial multi-file suites |
| `packages/coding-agent/test/rpc-command-contracts.test.ts` | RPC frame id/parse/background contracts (no provider keys) |
| `crates/*/tests/fixtures/` | Shared inputs for native crate tests |

Corpus row requirements: non-empty `id`, a real one-sentence `contract`, a `surface`
the runner knows, and exact `expect`. Shape-only rows fail at load time.

Name files and ids for the **behavior** (`list-limit-equals-ceiling`,
`rpc-unknown-command-drops-id`), never for an implementation strategy or port.

## Suite map (where contracts live)

| Domain | Primary home |
| --- | --- |
| Hashline parse/apply/recovery | `packages/hashline/test/` |
| Agent loop / compaction | `packages/agent/test/` |
| Provider streams / codecs | `packages/ai/test/` |
| Catalog identity | `packages/catalog/test/` |
| Session orchestration | `packages/coding-agent/test/agent-session-*.test.ts` |
| Tools | `packages/coding-agent/test/tools/`, `test/core/` |
| RPC / SDK | `packages/coding-agent/test/rpc*.ts`, `sdk-*.test.ts` |
| Settings | `packages/coding-agent/test/settings*.test.ts` + helper |
| TUI | `packages/tui/test/`, `coding-agent/test/modes/` |
| Natives | `packages/natives/test/`, `crates/veyyon-*/` |
| Install / binary smoke | `scripts/install-tests/`, `veyyon --smoke-test` |
| Regression corpus | `packages/coding-agent/test/corpus/regressions/` |

## Anti-patterns (these fail review)

- **Source-grep tests.** A test that reads an implementation file and asserts on its
  *text* (`expect(src).toContain("someCall()")`, `.not.toContain("oldName")`, "the
  comment says X") tests how code looks, not what it does. Assert the observable
  contract instead; enforce structural invariants with a type test or a lint rule.
- **`mock.module()`.** It mutates the global module registry and leaks across files
  ([oven-sh/bun#12823](https://github.com/oven-sh/bun/issues/12823)). Use `spyOn` on the
  imported module object, with `vi.restoreAllMocks()` in `afterEach`.
- **Full-suite-unsafe mutation.** No long-lived changes to `Bun.*`, `process.platform`,
  `process.env`, or `Bun.env` when a narrower `spyOn` seam exists. A test that passes
  alone but poisons later files is broken.
- **Weakening a test to make it pass.** A failing contract test is a finding about the
  code, not the test. Fix the code.
- **Duplicated coverage.** If an integration test already proves the behavior, drop the
  narrower unit test that restates it through mocks.
- **UI chunk bloat.** Do not force more UI suites into one process than the bucket’s
  chunk size allows (ghostty GC aborts).
- **Volume theater.** Do not add cases to raise counts. Prefer one adversarial twin over
  a hundred random inputs with weak asserts.
- **Re-implementing the unit under test.** Drive the shipped export; the corpus runner
  is a dispatcher, not a second engine.

## Depth by risk

Scale coverage to what the code does. A shipped rule or user-visible surface wants the
positive case, a negative twin, adversarial/boundary inputs, and an e2e path when the
surface is operator-facing. A tiny low-risk change doesn't need a test unless it
protects a real contract or fixes a regression-prone edge.

Wiring you can't exercise in-process (worker spawn, install flow) is covered by the
runtime smoke probe (`veyyon --smoke-test`) and the install-test scripts, not by a
source grep.

*Verified against tree on 2026-07-21.*
