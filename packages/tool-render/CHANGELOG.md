# Changelog

> This package shipped for several releases without a changelog, so the release gate skipped it: a publishable package with no `CHANGELOG.md` is simply not checked. Entries start here rather than being backfilled from git, and the gate covers this package from now on.

## [Unreleased]

### Breaking Changes

- `countLines`, `parseReadArgs`, `parseReadDetails`, `parseWriteArgs` and `parseWriteDetails` are `@veyyon/utils/fs-tool-args`; the package no longer exports them.
- `num` is gone: the finite-number read is `finiteNumber` from `@veyyon/utils`, which `util` re-exports beside `isRecord`; `str` is defined in and exported from `util`, and the `scalars` module is removed.
- `ViewAdapter.resolveSymbol(symbol)` takes the key only and returns `undefined` for a key the host has no glyph for; `StatusRowProps.emblem.element` is present exactly when the glyph resolved.

### Added

- Added a `vibe` renderer covering `vibe_spawn`, `vibe_send`, `vibe_wait`, `vibe_kill` and `vibe_list`, so a non-terminal host draws screen state, per-op summaries and output tails instead of raw JSON.

### Changed

- `stripControlSequences`, `CANONICAL_SYMBOLS`, `safeHref`, the status, tone and diff-side class tables and the markdown helpers are exported from `view-core` only; `util` and `ViewRenderer` no longer re-export them. Rendered output is unchanged.
- Consolidated React tool-call rendering to consume canonical ToolExecutionDisplay and ToolView view models directly from wire and view contracts.
- HTML tool renderers share argument, parse-error and eval-cell formatting while retaining tool-specific image and metadata handling.
- Array copies that allocated with a spread now use `.slice()`, `.concat()` or `Array.from()`. No user-visible behavior changes.
- Argot cards share body layout, search cards share result adaptation, and runtime cards share operation dispatch without changing rendered output.
- `replaceTabs` is the `@veyyon/utils/tab-width` function rather than a second copy; rendered output is unchanged.
- The `task` renderer lifts the missing-yield warning out of the output preview under both its current spelling, `SYSTEM WARNING: Agent exited without calling yield tool`, and the `Subagent` spelling a session file recorded before it.
- `genericRenderer` is exported once, through the `generic` module, instead of also being re-exported by the registry. No user-visible behavior changes.
- React list keys are derived from each item's own identity (id, path, label or text) through a `keyed` helper instead of the array index; rendered output is unchanged.
- `react` and `react-dom` are named as literal `19.2.7` peer dependencies so a consumer outside the workspace resolves them; the version is the one the workspace catalog pins.
- `CANONICAL_SYMBOLS` is `@veyyon/view`'s `UNICODE_SYMBOLS`, the table the terminal's plain preset draws from, so a card that names `tool.edit` draws `✎` in every host; the web-only status subset it was before is gone.
- The `read` summary shows the path and its selector only; `limit` is the directory entry cap, not a line window, so no `:A-B` is derived from it.

### Fixed

- Tool summary formatting resolves its string conversion helper before normalizing whitespace and truncating output.
- Shared HTML and React view adapters preserve symbol glyphs and render unknown symbol identifiers as text.
- Compact tool card headers omit repeated tool labels while preserving operation suffixes and unrelated titles.
- Restored field and badge parity across consolidated React tool descriptors for launch, job, bash, read, write, edit, set_cwd, generate_image, inspect_image, search, and memory tools.
- A tool whose `ToolView` renderer threw is drawn by its own React descriptor, or by the generic arguments-and-output card when it has none; the exception's text was shown as the card body.
- A symbol, emblem or notice mark key no host has draws the span's text, or nothing, never the key itself.

## [1.3.0] - 2026-08-28

### Added

- Added `ThemeToggle` component to shared React renderers for cycling system, light, and dark theme preferences.

### Changed

- Unified `search` renderer handles canonical `{ type, input }` schemas across files, text, and structure search with nested `{ type, result }` metrics and malformed-input guards. Retired search tool aliases and registry entries for glob, grep, find, and ast_grep are removed.

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
