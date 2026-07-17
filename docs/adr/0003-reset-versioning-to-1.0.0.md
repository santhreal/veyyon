# 0003. Reset veyyon's release line to 1.0.0 above the fork point

- **Status:** accepted
- **Date:** 2026-07-16

## Context

The fork ([ADR 0001](0001-fork-from-oh-my-pi.md)) inherited oh-my-pi's per-package
changelogs — ~641 version entries up to `16.5.2`. But veyyon had never cut a release:
zero `v*` tags, zero `chore: bump version to` commits, zero published GitHub releases.
`16.5.2` was simply the upstream commit the fork was taken from. Presenting those
entries as veyyon's own release history is misleading, and none of the `@veyyon/*`
packages were on npm, so any version number was available.

## Decision

veyyon's own release line starts at `1.0.0`. The inherited entries stay in the
changelogs behind a fork-notice marking everything at or below `16.5.2` as upstream
history. `release.ts` treats "no tags" as a `0.0.0` baseline so the first
`bun run release 1.0.0` cuts cleanly.

## Consequences

- A clean, honest identity: veyyon's changelog and versions describe veyyon, with
  upstream history clearly separated (in the CHANGELOGs and on the website changelog).
- A visible discontinuity from `16.x` to `1.0.0`. Acceptable because nothing consumed
  the `16.x` numbers (no published releases, no npm).
- The website changelog generator and `release.ts` had to be made fork-aware.

## Alternatives considered

- **Continue from `16.5.3`.** Rejected: implies veyyon *is* oh-my-pi at 16.x and keeps
  conflating the two histories.
- **Leave the changelog as-is.** Rejected: it reads as ~641 veyyon releases that never
  happened.
