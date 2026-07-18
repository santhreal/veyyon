# Contributor onboarding

From a clone to a merged change. [`DEVELOPMENT.md`](../../packages/coding-agent/DEVELOPMENT.md)
is the map of the code; this is the path through it.

## Prerequisites

- **Bun** (the version in `package.json` `packageManager` / the `oven-sh/setup-bun`
  pin — currently 1.3.x). veyyon is Bun-first; don't substitute Node.
- **Rust** (stable) — only needed if you build the native addon or touch `crates/`.
- Git, and a POSIX shell. macOS/Linux are the primary dev targets.

## Bootstrap

```
git clone https://github.com/santhreal/veyyon
cd veyyon
bun install
```

## Run from source

```
bun packages/coding-agent/src/cli.ts         # add a prompt or subcommand as args
```

This runs the CLI straight from TypeScript — no build step. Do **not** dogfood a
`cargo`/`bun build` artifact when validating the install flow; that's the shipped
installer's job (see [deployment.md](deployment.md)).

## The gate

Run before every push:

```
bun run check        # types + lint, TS and Rust
bun run test         # the local test suite
```

If your change touches native paths, build the addon first: `bun run ci:build:native`.
Testing rules and anti-patterns: [testing.md](testing.md).

## Where to start

| You want to change… | Start at |
| --- | --- |
| A CLI command / TUI behavior | `packages/coding-agent/src/` — see DEVELOPMENT.md's source map |
| A tool (read, bash, edit, grep) | `packages/coding-agent/src/` tools + `docs/internal/*-tool-runtime.md` |
| A provider / model | `packages/ai`, `packages/catalog`, and [adding-a-provider.md](adding-a-provider.md) |
| A Rust hot path | `crates/` + [natives-architecture.md](natives-architecture.md) |
| The website / docs | `website/`, `docs/handbook/src/`, this `docs/internal/` tree |

## Conventions

Read the repo [`AGENTS.md`](../../AGENTS.md) — it's the enforced convention set (Bun-
over-Node, no silent fallbacks, one home per value, commit style, the changelog
format). Match the surrounding code.

## Opening a pull request

Pull requests are open to everyone — see [CONTRIBUTING.md](../../CONTRIBUTING.md).
Open the PR against `main`. Put your change under the affected package's
`## [Unreleased]` changelog section, keep the PR description short (what broke, the
fix), and make sure `bun run check` and the tests pass. CI, the security suite, and
the automated review run before a maintainer reviews it.

*Verified against `7ca44d3` on 2026-07-17.*
