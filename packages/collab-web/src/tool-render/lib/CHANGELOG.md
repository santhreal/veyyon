# Changelog — @veyyon/tool-render (closed)

> **Closed history.** These renderers were the `@veyyon/tool-render` package, versioned on its own
> line, until they became `packages/collab-web/src/tool-render/lib`. The entries below are that
> package's release history and the version numbers are its own; they never described
> `@veyyon/collab-web`. Nothing is added here — a change to these files goes under `## [Unreleased]`
> in [`packages/collab-web/CHANGELOG.md`](../../../CHANGELOG.md).
>
> The package also shipped for several releases without a changelog, so the release gate skipped it:
> a publishable package with no `CHANGELOG.md` was simply not checked. Entries start at 1.0.38 rather
> than being backfilled from git.

## [1.2.0] - 2026-08-23

### Breaking Changes

- The minimum supported Bun runtime is now 1.4.0.

### Changed

- A running tool card builds its streaming tail incrementally. It re-stripped the whole accumulated output on every arrival and then sliced the last 2048 characters, so a 1MiB stream delivered as 256 arrivals scanned 128MiB and grew from 0.23ms per arrival to 2.30ms; it now scans 1MiB total at a flat 0.09ms (211.7ms to 27.2ms overall). The displayed text is unchanged, including for bytes that arrive mid-sequence, and `PartialTail` retains only the visible window plus a sequence that has not closed — a rewound or restarted buffer starts over rather than concatenating two runs.

## [1.0.47] - 2026-08-13

### Changed

- The ask renderer strips the ` (Recommended)` marker through `@veyyon/wire` instead of its own copy of the string, so a change to the marker in the TUI that writes it cannot leave this renderer showing it as part of the user's answer.
- The `github` renderer classifies check runs and reads issue references through `@veyyon/utils/github-check-run`, the same owner the terminal renderer uses, instead of its own conclusion tables. Those tables had drifted from the terminal ones, so a queued job showed here as an unknown state while the terminal showed it as pending, and a conclusion taught to one view was not taught to the other.
- A todo board whose every task has closed renders as one `Todo list done` line in the `--tv-ok` colour instead of the full board, matching the terminal card. The status vocabulary and the "is this board finished" question both come from `@veyyon/wire` rather than this package's own copy, so the export and the terminal cannot disagree about whether a plan finished, and a status neither knows reads as open work.
- The job rows read the `<task-result>` envelope through `@veyyon/wire` rather than this package's own copy of the pattern, so a settled subagent job cannot preview raw markup here while the terminal previews the answer. The envelope's shape is the task-summary prompt's, and one reader is now the only thing that has to keep up with it.

## [1.0.38] - 2026-07-31

### Added

- Shared HTML and collaboration transcript rendering for `argot_load`, `argot_unload`, `checkpoint`, `rewind`, `learn`, `memory_edit`, and `set_cwd`. These calls now show the project root and handle count, the report that survives a rewind, skill creation or update details, exact memory mutations, and working-directory changes instead of falling through to generic JSON.
