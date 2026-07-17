# Testing

How to run the suites and how to write a test that earns its place. The rules here are
the enforced ones from the repo `AGENTS.md`, expanded for contributors.

## Running

From the repo root (or `--cwd=packages/coding-agent` for package-local runs):

| Command | What runs |
| --- | --- |
| `bun run check` | The gate: type check (TS + Rust) and lint, in parallel. Run this before every push. |
| `bun run check:ts` | Biome + `tsc --noEmit` across every package. |
| `bun run test` | The local TS test runner. |
| `bun run ci:test:ts:workspace` | The exact workspace bucket CI runs. |
| `bun run ci:build:native` | Build the `pi_natives` addon — required before tests that touch native paths. |

Native/integration tests need the addon built first (`ci:build:native`); the CI test
jobs download a prebuilt addon artifact instead.

## What a test must do

A test defends one **concrete, externally observable contract** — a behavior, output
shape, state transition, error mapping, or a regression-prone parsing boundary. If you
can't name the contract, don't add the test.

Assert real values. `expect(true).toBe(true)`, a bare `not.toThrow()`, a non-empty
check, or a "length grew" check proves nothing and is banned. Assert the file, line,
value, exit code, or output bytes that actually matter.

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

## Depth by risk

Scale coverage to what the code does. A shipped rule or user-visible surface wants the
positive case, a negative twin, adversarial/boundary inputs, and — where it applies —
property tests, a differential check against a reference, a perf benchmark, and an e2e
run through the real CLI. A tiny low-risk change doesn't need a test unless it protects
a real contract or fixes a regression-prone edge.

Wiring you can't exercise in-process (worker spawn, install flow) is covered by the
runtime smoke probe (`veyyon --smoke-test`) and the install-test scripts, not by a
source grep.

*Verified against `7ca44d3` on 2026-07-17.*
