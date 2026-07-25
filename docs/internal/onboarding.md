# Contributor onboarding

From a clone to a merged change. [`DEVELOPMENT.md`](../../packages/coding-agent/DEVELOPMENT.md)
is the map of the code; this is the path through it.

## Prerequisites

- **Bun** (the version in `package.json` `packageManager` / the `oven-sh/setup-bun`
  pin, currently 1.3.x). veyyon is Bun-first; don't substitute Node.
- **Rust** (stable): only needed if you build the native addon or touch `crates/`.
- Git, and a POSIX shell. macOS/Linux are the primary dev targets.

## Bootstrap

```
git clone https://github.com/santhreal/veyyon
cd veyyon
bun install
bun run hooks:install
```

`hooks:install` points `core.hooksPath` at the tracked `.githooks/` directory,
which installs a `pre-push` hook that typechecks the tree you are about to
push. Git does not track hooks itself, so this is a one-time command per clone.
`bun run setup` runs it for you as part of the fuller bootstrap.

## Run from source

```
bun packages/coding-agent/src/cli.ts         # add a prompt or subcommand as args
```

This runs the CLI straight from TypeScript, no build step. Do **not** dogfood a
`cargo`/`bun build` artifact when validating the install flow; that's the shipped
installer's job (see [deployment.md](deployment.md)).

## The gate

Run before every push:

```
bun run check        # typecheck, TS and Rust (this is the release gate)
bun run test         # the local test suite
bun run check:tools  # biome: formatting, import order, and lint rules (CI gate)
bun run lint         # biome lint + clippy, advisory
```

`check` typechecks and runs the tests that gate a release; it does not run
biome. Biome splits into two halves, and they are gated differently.

`check:tools` runs `biome check`, which is formatting, import organization, and
the lint rules that are set to error. CI runs it, so an unformatted file or an
unorganized import list fails the build. Run `bun run fmt` to format, or
`bun run fix:tools` to apply the safe fixes to what you changed.

The advisory half is everything biome reports as a warning, which you see with
`bun run lint`. Fix a warning that points at a real bug; do not contort code for
a style-only one. Clippy is advisory in the same way.

If your change touches native paths, build the addon first: `bun run ci:build:native`.
Testing rules and anti-patterns: [testing.md](testing.md).

### The pre-push hook

The `pre-push` hook installed above runs `bun run check:ts` and refuses the
push when it fails. It takes about 15 seconds on a warm cache.

It checks the commit you are pushing, not your working tree. That matters
because this tree usually has in-flight work in it, and a hook that typechecked
uncommitted files would block pushes over half-written code that is not going
anywhere. Each pushed commit is checked out into a throwaway worktree that
shares the repo's `node_modules`, so the answer matches what CI will say.

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

*Verified against `ce7c4c68` on 2026-07-25.*
