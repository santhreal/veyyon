# Autonomous agent workflow: working the repo and shipping updates

How an autonomous coding agent (Claude Code, or any harness pointed at this repo)
works this codebase continuously and gets its work into production. The rules of
the road live in the repo [`AGENTS.md`](../../AGENTS.md); the release and deploy
mechanics live in [`releasing.md`](./releasing.md) and [`deployment.md`](./deployment.md).
This page is the loop that ties them together: queue → change → gate → ship → verify.

## The work queue

`BACKLOG.md` at the repo root is the **single task ledger**. It is gitignored
(review-only, machine-local) and is the source of truth for open work across
sessions and context resets:

- Row shape: `id | affected files | problem | acceptance criteria | status`.
- Every finding, an agent's own, a subagent's, a test failure, a doc drift, is
  appended **the moment it is found**. A finding that lives only in chat context
  is lost work.
- Fixed rows are flipped to `done` with a one-line record of the change, in place.
  There is exactly one ledger and one plan; never a second notes/findings/report
  file, never a competing roadmap.

An agent starting a session reads the ledger first, claims a slice of open rows
that doesn't collide with other active sessions, and drains it.

## The change loop

1. **Read before editing.** Open the actual code; never patch from a guess or a
   summary. `rg -n` for definitions and duplicate candidates before adding any
   helper, constant, or list, if an owner exists, import it (one definitional
   home per value/behavior).
2. **Edit in batches.** Land a coherent unit (a refactor, a module, a test suite),
   not one-line dribbles. Don't run the full gate after every tiny edit, batch,
   then gate.
3. **Gate.** Typecheck the touched packages (`bunx tsc --noEmit` per package),
   run the targeted test slice (`bun test <files>`), then the repo gate
   (`bun run check`) before anything is considered done. Website changes must
   pass `bun run site:build`'s brand check. New behavior gets proving tests that
   assert real values; a failing contract test is a finding, never a test to
   weaken.
4. **Run long gates in the background.** Fire builds/tests with the harness's
   background execution and keep editing the next non-colliding unit; reconcile
   when the result lands. A final full reconcile at the end of a drive catches
   anything an intermediate build missed.
5. **Record.** Flip the ledger row (or append a new one for anything discovered
   en route), and put user-visible changes under the affected package's
   `## [Unreleased]` changelog section *as part of the same unit*, the release
   flow finalizes whatever sits there, so an unrecorded change ships silently
   undocumented.

## Shared-tree discipline

Multiple agent sessions (and the human) work one tree concurrently. Dirty files
and half-finished edits belong to someone; treat them as live work:

- **Additive git only.** Stage exactly the paths you touched (`git add <paths>`,
  never `git add -A`). Never revert, hard-reset, `checkout --`/`restore`, clean,
  or stash-drop anything you didn't author this session.
- `main` only; no branches unless the human asks.
- Lane splits are respected absolutely: if a surface is owned by another lane
  (e.g. the TUI visual lane), findings there go into the ledger for the owner,
  not into edits.

## What ships autonomously vs. what needs the human

The boundary is **outward visibility**. Everything machine-local is autonomous;
everything that leaves the machine is gated on explicit per-action approval.

| Autonomous (no approval needed) | Human-gated (explicit approval, every time) |
| --- | --- |
| Reading, editing, staging exact paths | `git commit` / `git push` to any remote |
| Local typecheck, tests, `bun run check` | Cutting a release (`bun run release …`) |
| Background builds, benches, local installs | Website deploys (`bun run site:deploy`, both Pages projects) |
| Ledger + changelog `[Unreleased]` upkeep | npm publish, Homebrew, GitHub Releases (CI does these, but the tag push that triggers them is human-gated) |
| Docs under `docs/` and handbook sources | Opening/commenting on GitHub issues & PRs, any `gh` call against a public repo |

Approval is **per action**, not per session, one approved push does not
pre-approve the next. Outward GitHub actions run under the project's designated
account only (verify with `gh auth status` first).

## Shipping an update to production

Production is two independent surfaces (see [`deployment.md`](./deployment.md)):

**CLI binaries**, the agent's steady-state job is keeping `main` *release-ready*:
green `bun run check`, changelogs current under `[Unreleased]`, ledger drained.
The actual cut is one human-approved command:

```
bun run release <version|major|minor|patch>
```

`release.ts` bumps, finalizes changelogs, checks, commits
`chore: bump version to vX.Y.Z`, tags, atomically pushes, and watches CI.
Release-shaped runs route to GitHub-hosted runners, so the cut does not depend on
the self-hosted fleet. If the watch is interrupted, `bun run release watch`
re-attaches to CI for the current commit.

**Website**, `bun run site:build` locally at will (the brand check is part of the
gate); `bun run site:deploy` only with approval. If handbook sources changed,
`mdbook build` in `docs/handbook` first; if the install scripts changed, deploy
the `veyyon-get` project too.

## Verify like a user, not like a builder

A release is verified by the **shipped install path**, never a local `bun`/`cargo`
artifact: on a clean environment, uninstall any prior copy, run
`curl -fsSL https://get.veyyon.dev | sh` (or `install.ps1`), and exercise the
installed binary, subcommands, output formats, error paths. Checksum
verification failing closed, PATH wiring, and completions are part of the product
surface; a dev build proves none of them. Install-flow friction found this way is
a ledger row like any other bug.

## When something breaks

- Release CI failures: re-attach with `bun run release watch`; the recovery
  procedures live in [`docs/internal/runbooks/`](./runbooks/README.md).
- A bad deploy or release is rolled forward (fix + new cut), not force-pushed
  away, tags and published assets are immutable once installers can see them.
- Anything an agent cannot fix locally (expired credentials, runner outages,
  account-level Cloudflare/GitHub state) is a human-blocker: record it in the
  ledger with what was tried, and continue on other rows rather than stopping.

*Verified against `a49ff74` on 2026-07-21.*
