# Upstream and fork provenance

Veyyon is a source fork of **oh-my-pi** (`can1357/oh-my-pi`), MIT licensed.
This document explains what "fork" means in practice for this repository,
what changed, and where the legal notices live. It is a provenance map, not
a license grant — see `LICENSE` for the license text and `NOTICE` for
third-party attribution.

## What was forked

- The TypeScript/Bun agent loop, TUI, and mode system (`packages/coding-agent`,
  `packages/agent`, `packages/tui`, `packages/ai`, `packages/catalog`, and
  most of `packages/*`).
- The Rust native hot paths (`crates/pi-grep`, `crates/pi-pty`,
  `crates/pi-shell`, `crates/hashline`-adjacent natives, and others under
  `crates/`), including their vendored third-party dependencies under
  `crates/vendor/`.
- The prompt/agent model, hashline edit engine, mnemopi memory system, and
  provider catalog that oh-my-pi shipped — these are the reasons this
  project forked oh-my-pi rather than starting from scratch (see
  `BACKLOG.md` notes).

This repository's git remotes reflect that lineage directly:

```
origin    https://github.com/santhreal/veyyon.git
upstream  https://github.com/can1357/oh-my-pi.git
```

## What changed (rebrand + product direction)

Veyyon started as a rebrand of oh-my-pi — name, brand constants, config
directory, npm scope, splash/theme, emoji removal, settings simplification
(tracked as `R1`-`R8` in `BACKLOG.md`, all done) — and has since diverged
with its own product direction (model-selection/compaction redesign, docs
handbook, perf work) tracked in the same ledger. It is not a drop-in
resync target: changes here are not intended to be upstreamed, and upstream
oh-my-pi changes are not automatically pulled in.

This repository's history in this tree is a single squashed snapshot
(`git log` shows one commit at the time of writing); it does not carry
oh-my-pi's original commit history. The `upstream` remote above is the
canonical place to compare current oh-my-pi behavior against Veyyon's if a
specific reconciliation is needed — this document intentionally does not
assert a pinned upstream commit hash it cannot verify.

## Where the legal notices live

- `LICENSE` — Veyyon's own license (MIT), which is also the license under
  which oh-my-pi's incorporated MIT code is used.
- `NOTICE` — third-party attribution for code vendored or adapted under
  licenses other than plain MIT-via-`LICENSE` (Apache-2.0 wire types,
  Apache-2.0 generated bundles), plus pointers to crate-level notices.
- `crates/pi-shell/NOTICE` — crate-scoped attribution for a specific
  adapted algorithm (RTK, MIT); kept in place rather than merged into the
  root file so it stays next to the code it describes.
- `crates/vendor/*/LICENSE` — per-crate upstream license files for vendored
  Rust dependencies; authoritative for that code.
- `docs/handbook/src/acknowledgements.md` — the human-readable, prose
  version of this provenance for handbook readers; kept reconciled with
  this file and `NOTICE`.

## Non-goals

This file does not track ordinary runtime dependency licenses declared in
`package.json` / `Cargo.toml` and resolved via `bun.lock` / `Cargo.lock` —
those are managed by the package managers and audited separately. It only
covers code that is forked, vendored, or adapted directly into this
repository's source tree.
