# Changelog

## [Unreleased]

### Added

- Every GitHub Release now includes a "What changed" section that groups the commits since the previous release by type (Features, Fixes, Performance, and so on). Releases used to show only the hand-written changelog bullets, so a release with dozens of real commits could ship with a one-line body; the summary is derived from the commit history, so each release reflects its actual work with no manual curation.
- `veyyon` now suggests the closest subcommand when you mistype one, so a bare typo no longer falls through to a paid prompt.
- Added the `/yolo` command, which removes every approval prompt for the rest of the session, including per-tool prompt overrides and a tool's own approval prompt. An explicit deny and a plan-mode mutation block are still hard denials. Enabling it in the TUI requires a danger confirmation and shows a persistent red indicator (composer border, gutter glyph, and a `YOLO` marker on the status line).
- Added the `--dangerously-skip-permissions` launch flag, which starts a session in the same full approval bypass as `/yolo`.
- Added the `/thinking` command (with `/effort` as an alias) and an interactive effort picker, and an effort step in the settings model-role picker so a picked model shows its effort as a readable `· high`.
- Added per-model thinking effort for the `compaction.model` and `subagent.model` settings. The effort is stored with the model selector and applied at run time; compaction now applies each candidate model's configured effort instead of always using the session effort.
- `/profile` and `/profiles` now open an interactive picker that lists every profile (the active one marked) with switch, create, rename, and delete actions. The full verb set is available too: `/profile <name>`, `switch`, `new`/`create`, `rename <old> to <new>`, `rm`/`remove`/`delete` (with a confirmation), and `list`.
- Skill discovery now loads skills only from the active profile's agent directory instead of scanning across the machine. Foreign providers (claude, codex, opencode, and so on) stay registered for onboarding import but no longer contribute skills to a session.
- Creating a profile now seeds an `AGENTS.md` for it, and instruction loading uses exactly three instruction layers by default.
- Sessions now support a per-profile working directory, an agent `setCwd`, and a `cwd` input on the task tool.
- The goal status line now always shows the token readout, adds a progress bar and percent once a budget is set, animates the goal icon while the agent streams, and recolors to a warning once you pass 90% of the budget.
- `tiny-models list` now shows whether each model is downloaded and how much disk its cache uses, and `--json` carries `downloaded` and `cachedBytes`.

### Changed

- The compaction threshold is now an absolute token count (`compaction.thresholdTokens`) instead of a percent of the model window, so it behaves the same on every model. The percent knob stays as a fallback. When the configured amount exceeds the current model's window it is honored up to one below the window and you get a one-time warning, never a silent reinterpretation.
- The updater now uses a GitHub-only update path, and a release is auto-cut only when a changelog entry is waiting.
- Only alabaster is presented in the theme picker while the light-theme slab class (painted surfaces leaking onto mismatched terminal grounds, misaligned gutter-outside-paint geometry, OSC 133 zone tints) awaits a rework. The other built-in themes stay embedded and renderable for theme work through the gallery (`getAvailableThemes({ includeHidden: true })`); `theme.dark` and `theme.light` now default to alabaster, and `tui.paintGround` defaults to `always` so the ground stays coherent on every terminal. Tracked in https://github.com/santhreal/veyyon/issues/29.
- The run clock is unified across the session, model effort is merged into the display, and the scroll-to-bottom indicator is now clickable. The footline badge slot now eases open and closed.
- Removed the remaining `vey` and `.omp` references from user-visible surfaces now that the shipped binary is `veyyon`: the login hint, menus, the ssh list, the terminal title, the mcp schema, the ttsr help, the autolearn prompt, and log names. Legacy environment aliases such as `VEYYON_CONFIG_DIR` and `OMP_MCP_TIMEOUT_MS` still work so existing setups do not break.

### Removed

- The OSC 133 prompt-zone markers around user messages. Terminals that paint prompt zones (Ghostty class) drew them as an uncontrolled background block over the message, the dark slab on titanium in operator screenshots. Multiplexer prompt grouping never justified a painted region veyyon does not own.

### Fixed

- `plugin doctor` now reports ok for the fresh-install state (no plugins directory, manifest, or `node_modules` yet) instead of reporting a defect before any plugin is installed.
- The no-model and no-key messages now give clearer guidance, pointing at `/login` and `veyyon setup`.
- The CLI now fails fast on a non-TTY interactive session or empty stdin, and consumes a piped prompt instead of hanging.
- The setup wizard now runs on first install only, never on update.
- `veyyon update` now prunes stale package-cache entries left under a previous brand name, which it had skipped because the cache directory and manifest names disagreed.
- Base URLs that end in a doubled slash (`http://x//`) now normalize the same as every other URL, closing a per-provider divergence.
- An unreadable context file (a `CLAUDE.md` or `AGENTS.md` that exists but cannot be read) now warns loudly with its path and error code instead of silently vanishing from the system prompt. A missing file stays silent, as before.
- A malformed plugin or marketplace manifest, a malformed project settings file, a malformed `--plugin-dir` manifest, and a failed legacy-settings migration now each warn loudly instead of being swallowed and treated as absent.
- An unreadable scan root (wrong permissions) now fails loudly instead of being scanned as empty, so a skills, rules, or extensions directory with bad permissions no longer vanishes with no signal.
- grep now prints a loud notice when a regex pattern is demoted to a literal match instead of silently falling back.
- `veyyon read` now exits non-zero when it cannot deliver a file's content (a binary file, a binary archive entry, or a failed document conversion) while still printing the guidance hint, so a script can tell a refusal from a success.
- Oversized `bash` output from a timed-out or aborted command now spills to an artifact instead of being dropped, reusing one sink artifact across the timeout and abort paths.
- External text in generated markdown tables is now escaped, and markdown links are routed through one paren-safe builder, so scraped titles and links with parentheses no longer truncate or break the table. Applies across the web, scrapers, markit, and metaharness paths.
- `markit` now keeps numeric EPUB metadata instead of dropping it, and renders very large tables without hitting the argument-spread ceiling.
- Web content now decodes `&amp;` last, so a doubly-encoded entity resolves one level instead of over-decoding.
- Date-time validation now requires the RFC 3339 shape, accepts any-length fractional seconds, and range-bounds the time components. typebox string length is counted in code points rather than UTF-16 units, `multipleOf` is validated float-safely, and a string pattern is compiled once with invalid patterns failing cleanly.
- Model-controlled and dynamic argument keys are now handled prototype-safely, so a key named after a prototype member (such as `__proto__` or `constructor`) can no longer corrupt tool arguments, header maps, or lookup-set membership.
- `veyyon install` never resets over local checkout edits and back-fills a profile `AGENTS.md`; `--smoke-test` now forces the core native addon to load so the smoke test exercises the real path.
- A relative subagent working directory is now resolved against the parent session instead of being rejected.
- The recent-sessions list now has a deterministic recency order.
- The Codex `apply_patch` path no longer silently hides a partial application, and `apply_patch` marker paths are trimmed so the write lands on the approved path.
- `argot` handles are now understood after a mid-session load, and the `argot_load` advice is gated on `argot.enabled` rather than on an active argot session.
- Makefiles are now detected by basename in language detection.
- Fixed several TUI layout regressions: a blank hole in the transcript live region, the composer shortcut band losing its fixed one-row height, and the transcript viewer and composer band drifting off the shared left rail.

## [1.0.23] - 2026-07-24

### Fixed

- Fixed a file move during an edit (the hashline `MV` op) deleting the file instead of renaming it when the destination resolved to the same file as the source: the two paths differed only by case on a case-insensitive filesystem, or the destination was a symlink pointing back at the source. The move now detects that both paths are one underlying file and skips the delete, so the edited content is preserved.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
