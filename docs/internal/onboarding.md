# Contributor onboarding

From a clone to a merged change. [`DEVELOPMENT.md`](../../packages/coding-agent/DEVELOPMENT.md)
is the map of the code; this is the path through it.

## Prerequisites

- **Bun** (the version in `package.json` `packageManager` and the
  `oven-sh/setup-bun` pin, currently 1.3.14). veyyon is Bun-first; do not
  substitute Node.
- **Rust** (the pinned `nightly-2026-04-29` toolchain in
  `rust-toolchain.toml`). It is required by `bun run check` and by the fuller
  `bun run setup`, even for an otherwise TypeScript-only change.
- Git, and a POSIX shell. macOS/Linux are the primary dev targets.

## Bootstrap

```
git clone https://github.com/santhreal/veyyon
cd veyyon
bun install
bun --cwd=packages/coding-agent run gen:tool-views
bun run hooks:install
```

`hooks:install` points `core.hooksPath` at the tracked `.githooks/` directory,
which activates its `pre-push` hook. Git tracks the hook file, but it does not
activate a repository-specific custom hooks directory automatically, so this is
a one-time command per clone. `bun run setup` activates it as part of the fuller
bootstrap.

## Run from source

```
bun packages/coding-agent/src/cli.ts         # add a prompt or subcommand as args
```

This runs the CLI straight from TypeScript after the bootstrap code-generation
step above; it does not require a binary build. Do **not** dogfood a `cargo` or
`bun build` artifact when validating the install flow; that is the shipped
installer's job (see [deployment.md](deployment.md)).

## The gate

Run before every push:

```
bun run check        # typecheck, TS and Rust (this is the release gate)
bun run test         # the local test suite
bun run check:tools  # biome: formatting, import order, and lint rules (CI gate)
bun run lint         # biome lint + clippy with warnings denied
```

`check` runs the TypeScript and Rust checks; `test` runs the local test suite.
Neither command runs biome. Biome splits into two halves, and they are gated differently.

`check:tools` runs `biome check`, which is formatting, import organization, and
the lint rules that are set to error. CI runs it, so an unformatted file or an
unorganized import list fails the build. Run `bun run fmt` to format, or
`bun run fix:tools` to apply Biome fixes, including its `--unsafe` fixes, to
changed files.

Biome diagnostics configured as warnings are the advisory half, visible through
`bun run lint`. Fix a warning that points at a real bug; do not contort code for
a style-only one. Clippy is not advisory: `lint:rs` and the `check:rs` release
gate both use `-D warnings`.

If your change touches native paths, build the addon first: `bun run ci:build:native`.
Testing rules and anti-patterns: [testing.md](testing.md).

### The pre-push hook

The `pre-push` hook activated above runs `bun run check:ts` and refuses the
push when it fails. It takes about 15 seconds on a warm cache.

It checks each pushed ref-tip SHA, not your working tree. That matters because
this tree usually has in-flight work in it, and a hook that typechecked
uncommitted files would block pushes over half-written code that is not going
anywhere. Each distinct pushed local SHA is checked out into a throwaway
worktree that shares the repo's `node_modules`, so the answer matches what CI
will say for that ref tip.

It exists because a type error reaching `main` is not one branch's problem. CI
checks the same thing, but only after the push, and by then every open pull
request is red against a broken base and no one's CI result means anything. A
half-committed rename left 64 errors on `main` on 2026-07-24 and did exactly
that to every open port PR.

Two ways past it, both deliberate and both visible:

```
git push --no-verify                      # skip every hook for this push
VEYYON_SKIP_PREPUSH=1 git push            # skip only the typecheck
```

Use them for a work-in-progress branch that is not `main`. If `bun` is not on
your `PATH` the hook refuses rather than passing the push through, because a
hook that quietly does nothing is worse than no hook: everyone believes they
are covered.

## Where to start

| You want to change… | Start at |
| --- | --- |
| A CLI command / TUI behavior | `packages/coding-agent/src/`, see DEVELOPMENT.md's source map |
| A tool (read, bash, edit, grep) | `packages/coding-agent/src/` tools + `docs/internal/*-tool-runtime.md` |
| A provider / model | `packages/ai`, `packages/catalog`, and [adding-a-provider.md](adding-a-provider.md) |
| A Rust hot path | `crates/` + [natives-architecture.md](natives-architecture.md) |
| The website / docs | `website/`, `docs/handbook/src/`, this `docs/internal/` tree |

## Conventions

Read the repo [`AGENTS.md`](../../AGENTS.md), it's the enforced convention set (Bun-
over-Node, no silent fallbacks, one home per value, commit style, the changelog
format). Match the surrounding code.

## Opening a pull request

Pull requests are open to everyone, see [CONTRIBUTING.md](../../CONTRIBUTING.md).
Open the PR against `main`. Put your change under the affected package's
`## [Unreleased]` changelog section, keep the PR description short (what broke, the
fix), and make sure `bun run check` and the tests pass. CI, the security suite, and
the automated review run before a maintainer reviews it.

*Verified against `0eb8d74a3ecf60e1b2ec37c15e9255f2dbe310dc` on 2026-07-30.*
