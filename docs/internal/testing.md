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
