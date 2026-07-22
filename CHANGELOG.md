# Changelog

## [Unreleased]

### Removed

- The `snap` compaction strategy (the experimental image-archive engine that rendered discarded history to bitmap frames) and its `@veyyon/snapcompact` package. `compaction.strategy` now offers two pure-LLM strategies, `summary` (the new default) and `handoff`. Sessions compacted by the old engine still open without loss: their archived plaintext source re-attaches to the compaction summary as recovered text, and the next compaction folds it into a normal LLM summary. A stored `snap` strategy value normalizes to `summary` on load.

### Fixed

- Fixed duplicated thinking/answer paragraphs sprayed into native terminal scrollback mid-stream. On the first delta after a streaming rebuild (e.g. the answer block appearing next to the thinking block), the smooth-reveal pacer restarted at zero for a Markdown child that already displayed hundreds of characters, momentarily collapsing its rows; the transcript's committed scrollback prefix diverged and, with `tui.scrollbackRebuild` off (the default), the re-anchor appended a second copy into history. A takeover reveal now seeds at the already-displayed length, so revealed text only ever grows within a block; a genuine rewrite still restarts from zero.
- Fixed a turn that errors before any streaming begins (the provider rejects the request at setup: unsupported thinking effort, bad model id, auth) dying silently in the TUI — no working line, no banner, no clue. The pre-stream error now pins the same banner above the editor as a mid-stream failure.
- Fixed the `AgentSession` constructor storing the configured thinking level unclamped against the session's model. A persisted `high` landing on a reasoning model with no controllable effort surface (e.g. `devin/swe-1-6`) threw `requireSupportedEffort` at the first stream of every turn; the constructor now clamps via `resolveThinkingLevelForModel`, mirroring the session-restore path (`off` preserved, supported levels kept, dial-less models forward no effort).
- Changing the working directory mid-session with `/cwd` or the agent's `set_cwd` tool now re-roots the whole session, not just the filesystem cwd. Project settings, plugins, slash commands, capabilities, the ssh tool, and the system-prompt project framing reload for the new directory, matching `/move` (minus relocating the session file). Previously only tools moved and the rest of the session stayed pinned to the original project.

## [1.0.12] - 2026-07-21

### Added

- Shared provider credentials across profiles. You sign in to a provider once and every profile reuses that login, so switching profiles no longer means re-authenticating. A machine-wide `profileSharing` toggle (default on) controls it; turn it off to keep each profile's credentials private.
- A Global tab in `/settings` for machine-wide options (the default profile and credential sharing), backed by `~/.veyyon/config.yml`. Every configuration value is now visible and editable in the interactive settings UI and stays in sync with the config files, with no restart needed after an external edit.
- Per-profile working directory. Each profile remembers its own working directory, the agent can change it with `setCwd`, and tasks accept a `cwd` input.
- `/yolo` command and a `--dangerously-skip-permissions` launch flag for a full-session permission bypass.
- `/thinking` command (with a `/effort` alias) and an interactive effort picker, plus per-model thinking effort on the compaction and subagent model roles.
- An interactive `/profile` picker with the full verb set. New profiles seed an `AGENTS.md`, and skills load only from the active profile.
- Argot wire compression for tool traffic, gated by a model allowlist and a context-size cutoff so it only engages where it helps.
- Every launched subagent's model is shown across all agent surfaces.

### Changed

- The install and update channel is the `curl` script, which pulls the signed GitHub release binaries. npm publishing is now opt-in and off by default.
- By default the agent loads exactly three instruction layers.
- The compaction threshold is an absolute token amount, independent of the active model.
- Compaction runs a lossless dedup pass on every strategy, and oversized or redundant tool results spill to a recoverable artifact instead of riding along in context on every later turn.
- Config files (`config.yml`, `keybindings.yml`, `ssh.json`, `mcp.json`) are written atomically and serialized across processes, so an interrupted save can no longer corrupt them.

### Fixed

- Oversized or timed-out Bash and grep output is bounded inline and offloaded to an artifact, instead of carrying the full buffer in every later turn.
- Outbound tool-call ids are canonicalized per provider for compatibility, and wire paths are relativized under session roots.
- Compaction now counts retained custom and branch tokens in the keepRecent budget, and cuts past the crossing entry when keeping everything would dead-end.
- Settings values cycle with click-then-choose rather than Left/Right.
- Many fail-closed hardening fixes: grep on an unreadable directory, malformed plugin and marketplace manifests, unreadable context files, and project-settings discovery warnings now surface loudly instead of being swallowed, and CLI usage errors exit with the correct code.
- The sign-in success page text sits below the sun mark, not over it.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
