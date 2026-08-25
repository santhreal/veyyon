# Renderer defect oracle

Rendering defects reach operators as screenshots. Each one is then diagnosed by hand, reproduced by
hand, and pinned by a hand-written test. This document specifies the work that replaces that loop.

The randomized render-stress harness already exists and already does most of it. Read
`packages/tui/test/render-stress-harness.ts` before this document: it drives randomized operation
sequences against a real TUI over a Ghostty WASM virtual terminal, checks several fidelity oracles
against a shadow commit ledger, and ships a delta-debugging reducer in
`packages/tui/test/render-stress-reducer.ts`.

Three properties keep it from catching the defects that reach operators.

## 1. The sweep does not run

`packages/tui/test/render-stress.test.ts:27` reads:

```ts
const SKIP_IN_CI = Boolean(Bun.env.CI);
```

The sweep spawns one `bun` subprocess per scenario, each compiling Ghostty WASM, so the full pool is
too slow for the pull-request path. It therefore runs only when a contributor runs it by hand, which
is close to never. A harness that does not run finds nothing.

## 2. No oracle observes the composer zone

`pinnedFooter`, `composer` and `PinnedFooter` appear nowhere in the harness. Every oracle it has
compares viewport rows and scrollback rows against a shadow ledger, over synthetic components.

The pinned footer is where the reported defects appear: a second composer painted partway up the
screen while the real one stays at the bottom, chrome text written onto a row that still holds tool
output, output continuing below the status line. None of those violate a viewport-fidelity oracle
that never models a footer, so the harness reports a clean sweep while the screen is wrong.

## 3. A found failure does not become a test

The current path from a failure to a committed regression:

1. The scenario fails and its operation log is written to a scratch file
   (`render-stress-harness.ts:3629`).
2. `render-stress-reducer.ts:102` shrinks the log, writes `<name>.reduced.json` beside it, and
   prints the path.
3. A contributor reads the path, decides what the failure means, and hand-writes a
   `{ template, seed }` row into `REGRESSION_REPLAYS` (`render-stress-harness.ts:39`) with a prose
   comment, or hand-writes a named test file.

Steps 1 and 2 are automatic. Step 3 is not, and step 3 is the one that turns a finding into
permanent coverage.

## Specification

### Composer-zone oracles

Extend the harness with a scenario trait that mounts a real pinned footer, then assert, after every
operation:

- Exactly one composer prompt row exists in the terminal grid.
- No grid row contains both transcript text and chrome text.
- The pinned footer occupies exactly the bottom `n` physical rows, where `n` is measured from the
  grid rather than read back from the engine's own ledger.
- No row of the footer appears anywhere above the footer region.
- Output rows never appear below the last footer row.

An oracle that reads its expectation from the same counter the engine used to paint proves nothing.
Each of these measures the grid.

The footer must be the real component, not a synthetic stand-in. `mountComposerZone` in
`packages/coding-agent/src/modes/components/composer-chrome.ts` is the production entry point, so
the scenario that mounts it belongs on the coding-agent side of the harness seam while the oracles
stay in `packages/tui`.

### Automatic promotion

On failure the harness writes a case file into a committed corpus directory, keyed by the hash of
the reduced operation sequence so a rediscovery overwrites rather than duplicates. Each case
records the template, the seed, the reduced operation sequence, the oracle that failed, and the
observed and expected grids.

A separate always-on test replays every case in the corpus. It is deterministic, needs no
subprocess pool, and runs on every pull request. A case enters the corpus red and leaves the
contributor to either fix the engine or record why the case is invalid; a corpus entry with no
recorded decision fails the suite.

This preserves the property `REGRESSION_REPLAYS` has today, that a specific
`(scenario, seed)` reproduction stays in the always-on suite, without requiring anyone to
transcribe it.

### Running the sweep

The full pool stays off the pull-request path. It runs on a schedule against `main`, with a fixed
wall-clock budget rather than a fixed scenario count, and any failure it finds lands in the corpus
above, which is what makes the finding survive into the pull-request path.

## What this does not cover

The oracles above measure the grid the emitter produced. They do not measure colour, styling, or
image placement, and they do not observe a terminal that disagrees with Ghostty. A defect visible
only as a wrong colour, or only on one terminal emulator, stays outside this harness and still
arrives as a screenshot.
