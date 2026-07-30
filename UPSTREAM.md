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
  provider catalog that oh-my-pi shipped — these are the reasons this
  project forked oh-my-pi rather than starting from scratch (see
  `BACKLOG.md` notes).

This repository's git remotes reflect that lineage directly:

```
origin    https://github.com/santhreal/veyyon.git
upstream  https://github.com/can1357/oh-my-pi.git
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
2. The manager (`scripts/jules-port-manager.ts`, run from a local cron with
   the Jules API keys) dispatches each queued issue as a Jules session. The
   issue body is evidence-only. The execution contract lives in
   `scripts/jules-port.prompt.md`, with the resume nudge in
   `scripts/jules-nudge.prompt.md`. Jules must map upstream behavior to local
   owners, establish an observable negative control, prove the result, and
   audit the complete `origin/main...HEAD` range. It ends with either
   `PR-READY: <URL>` or `NOT-APPLICABLE: <reason>`. A ready PR remains
   unmerged and awaits CI plus human review.
3. Landing happens locally, not on GitHub. `bun scripts/jules-port-manager.ts
   land` audits each open port PR, merges only the selected clean candidates
   into local `main`, and stops there so you can run the gate before pushing.

An issue's labels are its pipeline position: none beyond `upstream-port`
means queued, `jules-dispatched` means a session is in flight,
`port-pr-open` means a PR is awaiting review, and `port-review` /
`port-blocked` mean a human is needed. `bun scripts/jules-port-manager.ts
status` prints the live picture; the script's header comment documents the
commands, knobs, and markers.

### Why landing is local

Your working tree is the canonical copy of veyyon and GitHub mirrors it, so
nobody presses the merge button on github.com. `land` fetches each port PR,
merges it into the local `main` with `--no-ff`, and leaves the push to you.
Keeping the PR's head commit in the merge is what makes this work in both
directions: once you push that `main`, GitHub sees the head commit reachable
from the base and marks the PR merged on its own, so the mirror ends up
correct without ever becoming a second source of truth.

Run it on `main`. Uncommitted work in the tree is fine, which matters because
the canonical tree nearly always has some: `land` refuses only a staged index,
since the commit that closes a merge would take the whole index and ship your
half-staged edit inside a port. Per PR it also skips any port whose files
overlap paths you have uncommitted changes in, naming them.

That overlap check is what makes running on a dirty tree safe, so it is
deliberately broad. It reads `git status --porcelain --untracked-files=all`
rather than `git diff`, because a file you created and never committed exists
in no git object and could not be recovered if something wrote over it, and
`git diff` does not report untracked files at all. It is re-read before each
PR rather than once per run, since every merge that lands changes the tree.
Both matter because the quarantine step writes the working tree directly.

```
bun scripts/jules-port-manager.ts land          # audit and merge all clean port PRs
bun scripts/jules-port-manager.ts land 197 202  # only these
bun scripts/jules-port-manager.ts land --push   # merge, then push
```

### What land refuses, and why

A Jules session works from a clone that goes stale while it runs. When it
reconciles by merging `main` and resolving in its own favour, the PR quietly
reverses commits that landed while it worked, which is invisible in the title
and nearly invisible in review: PR #184 was titled a one-file IME composition
fix and its diff reverted the port manager, the radar, four workflows and 180
rendered handbook pages. So `land` audits the diff before merging anything.

- **Whole-tree reverts** are refused outright. `neverPorted.owned` in
  `scripts/upstream-port-policy.json` lists the paths that belong to main and
  no port authors; hitting `refuseThreshold` of them at once means the branch
  is reverting main wholesale. Filtering such a diff is not enough, because
  the same staleness also reverts ordinary source files that no path list can
  recognise. The PR stays open and its issue goes to `port-review`.
- **Coverage deletion** is refused. A port that removes more test lines than
  it adds has done the opposite of its job, and CI cannot catch it because a
  smaller suite still passes.
- **Session noise** is quarantined, not refused. Lockfiles that a session's
  older bun rewrote, and scratch helpers left at the repo root, are reset to
  main's content inside the merge commit and named in the log. The fix lands;
  the noise never enters history. A path that main already tracks is restored
  from `HEAD`; one the session invented is removed. Which of the two applies is
  decided by looking the path up in `HEAD`, not by attempting one and falling
  back to the other on failure, and a failure of either aborts the merge and
  refuses the PR rather than committing a half-reset tree.

The same rules are stated in the session prompt, so most PRs never hit them.
The audit is the backstop for when the prompt is not enough.

### Landing a refused port by hand

A refused PR is not a rejected fix. The refusal is about the branch, and the
fix inside it is usually fine, so the way to land one is to take the source
and leave the branch behind:

```
git fetch origin pull/<N>/head:refs/jules-port/<N> --force
git diff HEAD...refs/jules-port/<N> -- <the source and test paths only>  > /tmp/<N>.patch
git apply --check /tmp/<N>.patch && git apply /tmp/<N>.patch
```

List the paths explicitly rather than excluding the bad ones. A stale branch
reverts files no exclusion list anticipates, and naming what you want is the
only filter that cannot miss.

Then prove the fix before committing it. Run the ported test, revert the source
change, and confirm the test fails; restore it and confirm the test passes. A
ported test that passes both ways is testing nothing, which is easy to ship
when the fix is someone else's and the mechanism is unfamiliar. Ports #6217,
#6226, #6233 and #6296 were each landed this way after their branches were
refused, and each one's test was checked in both directions.

Add the cases the port left out while you are there. An upstream fix arrives
with the one test that reproduces its bug and rarely with the negative twin:
#6296 gained coverage for the per-tool floor still winning over the global cap
and for `0` meaning no cap, and #6233 gained proof that the discovery pass it
adds to startup stays off the path an ordinary launch takes.

Finally, close the PR referencing the commit that landed its fix, so the
upstream issue does not get ported a second time.

## Non-goals

This file does not track ordinary runtime dependency licenses declared in
`package.json` / `Cargo.toml` and resolved via `bun.lock` / `Cargo.lock` —
those are managed by the package managers and audited separately. It only
covers code that is forked, vendored, or adapted directly into this
repository's source tree.
