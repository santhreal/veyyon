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
- The Rust native hot paths, including their vendored third-party dependencies
  under `crates/vendor/`. The crates were renamed after the fork, so the paths
  here are the current ones: search lives in `crates/veyyon-grep-kernel` and
  `crates/veyyon-uu-grep`, the shell and its output minimizer in
  `crates/veyyon-shell`, and the PTY and the rest of the N-API surface in
  `crates/veyyon-natives`. The hashline edit engine is TypeScript and lives in
  `packages/hashline`, not in a crate.
- The prompt/agent model, hashline edit engine, mnemopi memory system, and
  provider catalog that oh-my-pi shipped. These are the reasons this project
  forked oh-my-pi rather than starting from scratch.

The canonical repositories record that lineage:

```
Veyyon     https://github.com/santhreal/veyyon.git
oh-my-pi   https://github.com/can1357/oh-my-pi.git
```

## What changed (rebrand + product direction)

Veyyon began with a rebrand of oh-my-pi: the name, brand constants, config
directory, package scope, splash and theme, emoji removal, and settings
simplification. Since the fork, this repository has changed the prompt and
context contract, model effort and subsystem routing, compaction, credential
and session storage, tool and extension architecture, worker operations,
native kernels, and documentation. The README [Provenance](README.md#provenance)
section separates the inherited foundation from those Veyyon-owned contracts.

Veyyon is not a drop-in resync target. Changes here are not assumed to belong
upstream, and upstream changes are not pulled automatically.

This repository's history begins with one imported snapshot rather than
oh-my-pi's individual pre-fork commits. Commits after that snapshot record
Veyyon's work. Use the `upstream` remote to compare current oh-my-pi behavior
with Veyyon when you reconcile a specific change. The
[porting guide](docs/internal/porting-from-pi-mono.md) records verified sync
markers and intentional divergences.

## Where the legal notices live

- `LICENSE` — Veyyon's own license (MIT), which is also the license under
  which oh-my-pi's incorporated MIT code is used.
- `NOTICE` — third-party attribution for code vendored or adapted under
  licenses other than plain MIT-via-`LICENSE` (Apache-2.0 wire types,
  Apache-2.0 generated bundles), plus pointers to crate-level notices.
- `crates/veyyon-shell/NOTICE` — crate-scoped attribution for a specific
  adapted algorithm (RTK, MIT); kept in place rather than merged into the
  root file so it stays next to the code it describes.
- `crates/vendor/*/LICENSE` — per-crate upstream license files for vendored
  Rust dependencies; authoritative for that code.
- `docs/handbook/src/acknowledgements.md` — the human-readable, prose
  version of this provenance for handbook readers; kept reconciled with
  this file and `NOTICE`.

## Staying current: the port pipeline

Upstream keeps merging fixes after the fork point, so the repo runs an
automated port pipeline. It has two halves:

1. The radar (`.github/workflows/upstream-radar.yml`, every 30 minutes)
   mirrors newly merged upstream fixes and performance corrections. It also
   mirrors feature additions whose touched files avoid every architecture-owned
   surface in `scripts/upstream-port-policy.json`. This is a conservative
   candidate screen, not an assertion that the feature belongs in veyyon.
   Refactors, chores, and upstream product or infrastructure direction remain
   excluded. Documentation-only feature diffs are excluded; documentation
   accompanying an implementation does not block an otherwise clean candidate.
   Fixes touching a diverged surface still enter semantic triage with
   a warning so the underlying bug can be adapted to veyyon's design.
2. veybot (`python/veybot`) watches the `upstream-port` label. It prepares each
   port in its own worktree and opens exactly one candidate pull request that
   closes the tracking issue. The issue body is evidence only; the execution
   contract lives in veybot's own prompts, starting at
   `python/veybot/src/prompts/kickoff_port_upstream.md`. When a candidate's
   checks go red veybot repairs that branch in place, at most
   `VEYBOT_CI_MAX_REPAIRS` times per head commit, and never by weakening a
   gate.

veybot never merges a pull request, never enables auto-merge, and never pushes
to the default branch. No merge path exists anywhere in its tree, and that
absence is the guarantee that makes it safe to run unattended. An issue
carrying only `upstream-port` is queued; once a candidate is open, the pull
request is the state a human reviews.

`RADAR_MAX_ISSUES` is an advisory burst threshold, not a truncation limit.
The runner creates every eligible issue it found in the current lookback window
because it has no separate durable queue for deferred PRs.

### Reviewing a candidate port

Prove the fix before you merge it. Run the ported test, revert the source
change, and confirm the test fails; restore it and confirm the test passes. A
ported test that passes both ways is testing nothing, which is easy to ship
when the fix is someone else's and the mechanism is unfamiliar. Ports #6217,
#6226, #6233 and #6296 were each landed after checking the test in both
directions.

Add the cases the port left out while you are there. An upstream fix arrives
with the one test that reproduces its bug and rarely with the negative twin:
#6296 gained coverage for the per-tool floor still winning over the global cap
and for `0` meaning no cap, and #6233 gained proof that the discovery pass it
adds to startup stays off the path an ordinary launch takes.

Read the whole diff, not the title. A porting agent works from a clone that
goes stale while it runs, and reconciling that clone in its own favour quietly
reverses commits that landed meanwhile. It is invisible in the title and nearly
invisible in review: PR #184 was titled a one-file IME composition fix, and its
diff reverted the port manager, the radar, four workflows and 180 rendered
handbook pages. `neverPorted` in `scripts/upstream-port-policy.json` lists the
paths a port has no business authoring, which is the checklist to read that
diff against.

## Non-goals

This file does not track ordinary runtime dependency licenses declared in
`package.json` / `Cargo.toml` and resolved via `bun.lock` / `Cargo.lock` —
those are managed by the package managers and audited separately. It only
covers code that is forked, vendored, or adapted directly into this
repository's source tree.
