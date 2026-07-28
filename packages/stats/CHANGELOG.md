# Changelog

## [Unreleased]

### Changed

- The session parser takes its service-tier helpers from `@veyyon/ai/types`, the module that declares them, rather than from the `@veyyon/ai` entry point. This package reads session files off disk; it has no use for a provider, and it was loading all 363 modules of one to normalize a tier string. `parser.ts` went from 366 modules to 103, and `db.ts` and `sync-worker.ts` followed it down to 105 and 104.
- Classifies advisor transcripts through `@veyyon/utils/session-file` instead of declaring `"__advisor.jsonl"` here. This package cannot import the coding agent that writes the file, so the two spellings could only ever drift apart, and the result would have been a wrong count rather than an error: advisor transcripts silently counted as ordinary subagent sessions.
- `Usage` is now re-exported from `@veyyon/catalog` instead of declared here. The local copy had
  the same five counters and the same `cost` object and nothing else, but sessions are written
  against the catalog type, so the fields it omitted (`orchestration`, `reasoningTokens`, `cttl`,
  `server`) were sitting in the data and invisible to every reader in this package. The name and
  the import path are unchanged.
- `SessionHeader` is now `SessionLogHeader`, and its `version` is optional. It was declared required
  while the writer declares `version?: number` because v1 sessions do not have one, so a v1 header
  read through this type handed the caller a `number` that is `undefined` at runtime. Nothing in this
  package reads the field yet, which is why it never surfaced. The old name is kept as a renamed
  export.
- `SessionEntry` is now `SessionLogEntry`. It was one of three types of that name across the
  workspace, and the widest: its `{ type: string }` arm is there so a log line the parser does not
  model is not a parse failure, which also means a value typed from here satisfies far less than the
  host's entry union or the wire subset a guest renders. The new name says what it is, one line of a
  session JSONL log as this parser sees it. The old name is kept as a renamed export.
- The theme store moved into `@veyyon/utils` as `createThemeStore`, shared with the collab client, which carried a byte-identical copy of the same ~90 lines. Only the storage key and the React binding stay here. See the Fixed note above for the divergence the two copies had.
- `hasBillableCost` now comes from `@veyyon/catalog`, which carried an identical copy in its model generator. The generator uses it to decide whether an OpenAI entry may donate its pricing to the matching Codex entry, and the dashboard uses it to decide whether to trust a bundled price at all, so the two answers had to agree about the same numbers while being written twice.
- The session-transcript walk moved into `@veyyon/utils` as `visitJsonlBytes`, so the dashboard and every other reader share one byte-level JSONL walker. The copy here was a fourth JSONL reader, and it had drifted: it dropped an unparseable line with no report at all, while both string-based readers in utils had one, and every total on the dashboard is a sum over the lines that parsed. A line holding only a carriage return is no longer counted as a lost record, because there is nothing in it to lose. Throughput is unchanged on the path the parser takes: 331 MB/s against the old loop's 311 over a 63 MB corpus (`scripts/bench-jsonl-bytes.ts`).

### Fixed

- Pasted terminal output no longer leaks into the behavior metrics as the user's prose.
  `user-metrics.ts` stripped escape sequences with a local `/\x1b\[[0-9;]*m/g`, which accepts only a
  CSI whose parameters are digits and semicolons and whose final byte is a letter. It missed
  private-mode sequences (`ESC [ ?25l`, which brackets almost every interactive program's output),
  colon subparameters, intermediate bytes, non-alphabetic finals, and OSC entirely, so a pasted
  hyperlink left its whole target in the prose and a long one alone could push a message past the
  three-line threshold that zeroes every signal. The strip now goes through
  `@veyyon/utils/strip-ansi`, which owns the grammar, and it runs FIRST rather than last: the URL
  rule is greedy to the next whitespace, so an OSC 8 target ran through its own terminator and took
  the first word of the user's sentence with it. `stripStructuredContent` is exported so the
  contract can be asserted on the prose body, which is the only place most of these leaks are
  visible at all.
- A sessions directory that cannot be read no longer looks like a user who has never run a session.
  Both session listers answered every failure with an empty list, so a permissions problem on the
  sessions directory, or on one project's folder inside it, produced a dashboard reporting zero of
  everything: `syncAllSessions` sees an empty file list, returns early, and reports success having
  read nothing. An ABSENT directory still returns empty in silence, because that is what a fresh
  install is. A directory that is there and unreadable is now reported through the same log the
  unparseable-line reporter uses and with the same framing, naming the path and the underlying error,
  and the sync continues with what it could read so one unreadable project cannot blank the whole
  dashboard. A session file that cannot even be examined is reported the same way instead of being
  counted as a completed file by the progress bar.
- The dashboard failed to start when the browser blocks storage. It read the saved theme from `localStorage` behind a `typeof localStorage === "undefined"` check, and blocked storage does not make the property undefined: in Safari private browsing and under a blocked-storage policy, touching it THROWS. The read ran while the module was being evaluated, so the throw took the whole bundle down instead of costing a remembered preference. The theme now comes from the shared store below, which treats storage as best effort: your choice applies for the session even when it cannot be saved.

## [16.4.7] - 2026-07-12

### Fixed

- Fixed a `SQLITE_CONSTRAINT_NOTNULL` crash (`messages.stop_reason`) aborting the entire session sync when a persisted assistant message lacks a `stopReason`. Malformed entries — missing stop reason, token counts, or message timestamp — are now coerced at the parser boundary, and entries with no usage or model attribution are skipped instead of failing the batch insert.

## [16.4.2] - 2026-07-10

### Fixed

- Fixed a crash during stats synchronization on legacy session entries that lack a cost breakdown by falling back to catalog pricing when available.

## [16.3.9] - 2026-07-06

### Changed

- Refined behavior metrics to significantly reduce false positives in profanity, yelling, and anguish detection by excluding technical terms (e.g., "dummy", "trash", "garbage"), neutral punctuation (e.g., dot runs), and single-word capitalization (e.g., filenames or environment variables).
- Re-categorized frustration interjections (such as "ugh", "argh", and "grr") from profanity to anguish.
- Improved negation and blame detection to exclude determiners (e.g., "no auto start") and compounds (e.g., "no-op") while adding support for phrases like "why did you" and "makes no sense".
- Added sad emoticons as a signal for anguish while excluding code-like patterns.
- Triggered a one-time automatic re-ingestion of sessions on the next database sync to apply the updated metrics.

## [16.3.7] - 2026-07-05

### Changed

- Optimized session-entry lookup and file reading performance by caching file metadata to avoid repeated full-file scans.

## [16.3.1] - 2026-07-02

### Added

- Added a Tools tab to the `omp stats` dashboard (`/#/tools`): per-tool call counts, error rates, result/argument payload sizes, per-model breakdown, and a stacked calls-over-time chart. Token and cost columns attribute each invoking turn's real provider usage evenly across that turn's tool calls. Existing databases re-parse sessions once on the next sync to backfill historical tool calls.

## [16.2.7] - 2026-06-30

### Fixed

- Improved premium request calculation accuracy by correctly accounting for specific model families.

## [16.2.6] - 2026-06-29

### Fixed

- Fixed application crashes and Bun aborts on macOS and when parsing large stats session files, including during `omp --smoke-test` runs, by utilizing a more resilient serial parser and lenient line scanner.

## [16.2.3] - 2026-06-28

### Added

- Support for parsing named advisor transcripts using the `__advisor.<slug>.jsonl` naming convention.

## [16.2.0] - 2026-06-27

### Added

- Added a Gain tab to the `omp stats` dashboard (`/#/gain`) to display snapcompact token-savings with project scoping from synced session folders.

## [16.1.17] - 2026-06-24

### Fixed

- Stats sync counted the same provider request multiple times when a forked or branched session file copied the parent's entries verbatim. Inserts now skip rows whose `(entry_id, timestamp)` already exists under a different `session_file`, and a one-shot migration on the next `omp stats` run collapses any pre-existing duplicates ([#3370](https://github.com/can1357/oh-my-pi/issues/3370)).

## [16.1.15] - 2026-06-22

### Added

- Added token usage breakdown by agent type (Main, Subagents, Advisor) to the overview dashboard

## [16.0.10] - 2026-06-18

### Changed

- Updated description of moderated content categories to use more inclusive terminology

### Fixed

- Wide data tables (Requests, Errors, Overview, Projects) overflowed the page horizontally at narrow-desktop widths (768-1023px): the `.stats-table-desktop-only` wrapper used for mobile-card tables lacked the `overflow-x: auto` containment that `.stats-table-container` already has. They now scroll within their own bounds instead of spilling the page body.

## [16.0.5] - 2026-06-17

### Added

- New Projects view summarizing usage, cost, and reliability per project folder (backed by the existing `/api/stats/folders` endpoint).
- System-aware light/dark theme toggle — follows the OS by default, and an explicit choice persists across reloads.

### Changed

- Redesigned the local stats dashboard with an OMP-themed product shell, dedicated per-section views, accessible loading/empty/error states, and flicker-free navigation between screens and time ranges.

### Fixed

- The 1h time-range chart rendered an empty/single-point line; it now buckets at 5-minute granularity for a real trend.

## [15.13.3] - 2026-06-15

### Changed

- Renamed `__veyyon_stats_sync_worker` to `__veyyon_worker_stats_sync`.

## [15.13.1] - 2026-06-15

### Fixed

- Dropped `git` from the profanity list so normal repository mentions no longer count as profanity

## [15.12.4] - 2026-06-13

### Fixed

- Fixed the stats dashboard's SQLite init never setting `PRAGMA busy_timeout`, so a concurrent `omp` startup hitting WAL recovery could crash `initDb()` with `SQLITE_BUSY` instead of waiting through it. The busy handler is now installed before `PRAGMA journal_mode=WAL` ([#2421](https://github.com/can1357/oh-my-pi/issues/2421)).

## [15.11.0] - 2026-06-10

### Added

- Added support for prebuilt npm bundle mode via `PI_BUNDLED`, allowing the stats server to use an embedded dashboard bundle in packaged CLI distributions

### Fixed

- Fixed handling of legacy `embedded-client.generated.txt` placeholder content so it is treated as missing archive instead of being decoded into invalid bytes
- Fixed ENOENT handling while scanning dashboard source/build directories so missing `client/` or `dist/client` trees no longer crash startup

## [15.10.11] - 2026-06-10

### Changed

- Bundled-model lookups (`getBundledModel`, `GeneratedProvider`) now import from the new `@oh-my-pi/pi-catalog` package instead of the `@oh-my-pi/pi-ai` barrel, which no longer re-exports catalog values
- The session-sync worker re-enters the host CLI entry (`workerHostEntry()` + `__veyyon_stats_sync_worker` argv selector) when running inside omp — source, npm bundle, or compiled binary — and keeps loading its own `sync-worker.ts` module directly for standalone `omp-stats`, bun test, and SDK hosts

## [15.1.6] - 2026-05-19

### Fixed

- Fixed `omp stats` crashing on first session sync in published `omp-{linux,darwin,windows}-*` binaries with `BuildMessage: ModuleNotFound resolving "./packages/stats/src/sync-worker.ts"`; the release build script now lists the stats sync, browser tab, and JS eval workers as explicit `--compile` entrypoints so Bun emits them into bunfs, matching the dev build script and the AGENTS.md worker spawn contract. ([#1150](https://github.com/can1357/oh-my-pi/issues/1150))

## [15.1.0] - 2026-05-15

### Fixed

- Fixed incremental `parseSessionFile(path, fromOffset)` losing the active service tier when resuming past a `service_tier_change` entry, so priority OpenAI replies appended after the offset are now credited with `premiumRequests: 1` (regression introduced by 13f59162e which stopped folding priority-tier into per-message premium counts)

## [15.0.1] - 2026-05-14

### Breaking Changes

- Raised the minimum required Bun version to >=1.3.14 in package metadata

### Changed

- Changed the "Premium Reqs" dashboard card to also include OpenAI priority service-tier requests (`serviceTier: "priority"`), counting each as 1 premium request alongside GitHub Copilot premium calls. Pre-existing sessions are backfilled on the next `omp stats` run: a one-shot `premium_requests_priority_v1` sentinel wipes `file_offsets` so every session re-parses, and `insertMessageStats` now `UPSERT`s `premium_requests` (other columns untouched) using the `service_tier_change` entries already in the session log to retroactively credit priority traffic.

## [14.9.9] - 2026-05-12

### Added

- Added separate input-token and output-token totals to the overview dashboard cards.

### Fixed

- Fixed `omp stats` in compiled binaries by using the serial sync path instead of spawning a raw file-asset worker that cannot import bundled parser code.
- Fixed behavior backfills after failed compiled-binary sync attempts by marking the backfill sentinel only after a successful full sync.

## [14.9.7] - 2026-05-12

### Breaking Changes

- Broke backward compatibility of behavior stats fields by replacing `yellingSentences`/`dramaRuns` with `yelling`/`anguish` and adding `negation`, `repetition`, `blame` in query result types and persisted `user_messages` schema

### Added

- Added `SyncOptions` to `syncAllSessions` with `onProgress` and `workers` to optionally show per-file sync progress and tune parser concurrency
- Added new frustration behavior metrics (`negation`, `repetition`, `blame`) plus a `frustration` aggregate in behavior charts, model tables, and summary cards

### Changed

- Changed sync ingestion to parse session files through a worker pool while applying parsed results and database writes on the main thread
- Changed behavior analysis to strip code blocks, XML/URLs, quoted lines, and placeholders before scoring and to suppress signals on long structured messages
- Changed dashboard metrics labels and totals to the new signal names, including replacing the old three-signal totals with `yelling`, `profanity`, `anguish`, and `frustration`
- Changed sync output to print a live terminal progress indicator while processing session files

### Fixed

- Fixed user-message attribution so assistant model/provider links are backfilled during incremental sync instead of being left unknown
- Fixed word-boundary regex handling in profanity detection so matching now works as intended in normal prose

## [14.9.5] - 2026-05-12

### Added

- Added time range selection options (1h, 24h, 7d, 30d, 90d, All) to the dashboard header and bound them to reloading statistics for the selected window
- Added a **Behavior** dashboard page that tracks user yelling (CAPS), profanity, and dramatic punctuation (`!!!` / `???`) per day, with by-model comparisons mirroring the cost page
- Added a per-model behavior table to the **Behavior** page mirroring the Models table: sortable rows of CAPS / profanity / drama hits per model with sparkline trend and an expandable per-model breakdown chart
- Added optional `range` query parameter support on stats endpoints to retrieve metrics scoped to a requested time window

### Changed

- Changed the Costs dashboard summary to report totals, average per day, and top model for the selected time range instead of a fixed 30-day window and removed the previous-30-day trend comparison
- Changed behavior metrics ingestion to compute yelling from user message sentence-level uppercase ratios, filtering out short uppercase fragments so the behavior data is attributed to messages more accurately
- Removed per-chart 14/30/90 day pickers on Costs and Behavior pages so every page obeys the single time-range selector in the header
- Changed dashboard and stats queries to return data from the selected time window instead of always using all-time aggregates
- Changed the default displayed range in the UI/API to last 24h
- Added support for returning all data when `range=all` is requested

### Fixed

- Fixed handling of unknown `range` values by falling back to the last 24h instead of returning unscoped data
- Fixed `omp stats` failing to build the client on globally-installed installs by promoting `tailwindcss` from `devDependencies` to `dependencies` (the client build runs at runtime)

## [14.5.4] - 2026-04-28

### Fixed

- Fixed GPT cost reporting by deriving missing OpenAI Codex costs from the model catalog and backfilling existing zero-cost rows.

## [13.6.0] - 2026-03-03

### Fixed

- Include subtask session files in usage stats ([#250](https://github.com/can1357/oh-my-pi/issues/250))

## [1.0.24] - 2026-07-24

### Added

- Request details now carry their turn context instead of showing a lone reply.

### Fixed

- The browser bundles now deep-import their format and error helpers, keeping the Bun-mixed `@veyyon/utils` barrel out of the browser graph so the bundle stays browser-safe.

## [1.0.14] - 2026-07-23

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [1.0.13] - 2026-07-23

### Removed

- The Gain tab (`/#/gain`) and its snapcompact token-savings aggregator, following removal of the `snap` compaction strategy.
