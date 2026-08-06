# Changelog

> This package shipped for several releases without a changelog, so the release gate skipped it: a publishable package with no `CHANGELOG.md` is simply not checked. Entries start here rather than being backfilled from git, and the gate covers this package from now on.

## [Unreleased]

### Changed

- The ask renderer strips the ` (Recommended)` marker through `@veyyon/wire` instead of its own copy of the string, so a change to the marker in the TUI that writes it cannot leave this renderer showing it as part of the user's answer.

## [1.0.38] - 2026-07-31

### Added

- Shared HTML and collaboration transcript rendering for `argot_load`, `argot_unload`, `checkpoint`, `rewind`, `learn`, `memory_edit`, and `set_cwd`. These calls now show the project root and handle count, the report that survives a rewind, skill creation or update details, exact memory mutations, and working-directory changes instead of falling through to generic JSON.
