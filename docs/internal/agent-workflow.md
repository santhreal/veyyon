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
  The row key carries lifecycle state: a finding or lane id is open, `DONE` is
  landed and verified, and `CLOSED` means no fix was needed.
- Every finding, an agent's own, a subagent's, a test failure, a doc drift, is
  appended **the moment it is found**. A finding that lives only in chat context
  is lost work.
- Rename a completed row to `DONE` only when it records a durable decision the
  next reader would otherwise revisit. Delete a routine fixed row; rename a
  withdrawn or disproved finding to `CLOSED` and record why.
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
3. **Gate.** Run each touched package's declared `check:types` script
   (`bun --cwd=packages/<name> run check:types`),
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
| Reading, editing, staging exact paths | `git commit` / `git push` to any remote (a releasable `main` push may release automatically) |
| Local typecheck, tests, `bun run check` | Manually dispatching the Release workflow |
| Background builds, benches, local installs | Website deploys (`bun run site:deploy` for `veyyon` and `bun run site:deploy:get` for `veyyon-get`) |
| Ledger + changelog `[Unreleased]` upkeep | npm publish, Homebrew, or direct GitHub release mutation |
| Docs under `docs/` and handbook sources | Opening/commenting on GitHub issues & PRs, any `gh` call against a public repo |

Approval is **per action**, not per session, one approved push does not
pre-approve the next. Outward GitHub actions run under the project's designated
account only (verify with `gh auth status` first).

## Shipping an update to production

Production has three coordinated surfaces (see [`deployment.md`](./deployment.md)):

**CLI binaries**, keep `main` release-ready: `bun run check` green and each
publishable change documented under its package's `[Unreleased]` section. After an
approved push, the Release workflow waits for exact-SHA CI, Checks, and Security.
If there is something releasable, it cuts the patch automatically, gates the bump
commit through Checks and Security, and dispatches the tagged publish pipeline.

For an approved manual cut, use the one operator command. It defaults to a patch
and accepts `major`, `minor`, or an explicit `x.y.z`:

```sh
bun run release
bun run release minor
```

**Website and install scripts**, `bun run site:build` locally at will because the
brand check is part of the gate. A matching push to `main`, and every release,
deploys both `veyyon.dev` and `get.veyyon.dev`. With approval, run both
`bun run site:deploy` and `bun run site:deploy:get` for an out-of-band deployment.
If handbook sources changed, run `mdbook build` in `docs/handbook` first.

## Verify like a user, not like a builder

A release is verified by the **shipped install path**, never a local `bun`/`cargo`
artifact: on a clean environment, uninstall any prior copy, run
`curl -fsSL https://get.veyyon.dev | sh` (or `install.ps1`), and exercise the
installed binary, subcommands, output formats, error paths. Checksum
verification failing closed, PATH wiring, and completions are part of the product
surface; a dev build proves none of them. Install-flow friction found this way is
a ledger row like any other bug.

## When something breaks

- Release failures: open the Release or tagged CI run in Actions; the recovery
  procedures live in [`docs/internal/runbooks/`](./runbooks/README.md).
- A bad deploy or release is rolled forward (fix + new cut), not force-pushed
  away, tags and published assets are immutable once installers can see them.
- Anything an agent cannot fix locally (expired credentials, runner outages,
  account-level Cloudflare/GitHub state) is a human-blocker: record it in the
  ledger with what was tried, and continue on other rows rather than stopping.

*Verified against `0eb8d74a3ecf60e1b2ec37c15e9255f2dbe310dc` on 2026-07-30.*
