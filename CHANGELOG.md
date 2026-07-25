# Changelog

## [Unreleased]

### Added

- Added `TUI#onSelectionAttempt`, called when a left press and a release land in different cells outside the pinned footer while the engine holds the mouse. Capturing the mouse is what lets the wheel scroll the transcript, and it also takes plain drag-select away from the terminal, so hosts can now explain a drag that selected nothing instead of leaving it silent.
- Added the scroll position to the right edge of a frozen transcript region: a dim one-column groove with a bright thumb, composited through the same cell-accurate path overlays use. It sits in the region that scrolled, so a host's pinned footer renders byte-identically whether the view is frozen or following.

### Changed

- Thinking effort now has one persisted home: `defaultEffort`, a per-profile list of model to effort rows edited at `/settings` → Model → Default Effort. A row keyed by a model selector applies to that model, and a `*` row applies to every model without one. It replaces the profile-wide `defaultThinkingLevel` enum, which is still read so an existing config keeps working: with no `*` row, that value becomes it. Effort resolves in one documented order (session choice, then an explicit `:level` on the role's selector, then the model's row, then the `*` row, then the model's default) owned by `config/effort-resolver.ts` rather than written inline at each call site.
- `/thinking` and its `/effort` alias now change the current session only and print where the saved default lives. They used to rewrite the profile-wide default while the cycle keybinding did not, so the same change stuck or evaporated depending on how you made it, and there was no way to try an effort without keeping it.

### Fixed

- Fixed a mouse drag over the transcript doing nothing without a word of explanation. Scroll isolation holds the mouse so the wheel scrolls the transcript with the prompt pinned, which means selecting is shift+drag, and that tradeoff was stated only in a settings description. The first swallowed drag now names shift+drag, `/copy`, and `tui.scrollIsolation=false`, and a gated tip says the same before you hit it.
- Fixed the composer being replaced by a scroll readout while reading history: the contextual chip row under the prompt was overwritten with "N rows up / click to go to the bottom" whenever the transcript was frozen, so scrolling up during a run silently removed the `esc interrupt` chip. Scroll position is now drawn on the right edge of the transcript by the renderer, and the composer zone renders the same bytes whether the view is frozen or following.
- Fixed Task subagents calling MCP tools through a rebuilt raw request, which bypassed the source tool's harness-intent stripping, local-URL resolution and reconnect retry, and marked MCP-backed tools non-strict so the server owns validation.
- Fixed a configured `modelRoles.default` on a discovery provider being replaced at startup by an unrelated authenticated provider's default, when a cold catalog cache meant the role could not yet resolve.
- Fixed `session_stop` extension hooks running when a prompt was aborted or the session was disposed, so an abort could still trigger stop-hook work and its continuation state.
- Fixed a provider error being pinned behind the plan review overlay, which left the error invisible and the input unusable until the plan was answered.
- Fixed the `tools.maxTimeout` ceiling being ignored whenever a tool call omitted `timeout`, so a configured global cap did not bound a tool running on its default budget.
- Fixed isolated branch merge-back rejecting committed agent edits when the parent had unrelated uncommitted changes in the same file; dirty-baseline blobs are now seeded into the parent object database and replayed with a 3-way synthetic-tree apply ([#40](https://github.com/santhreal/veyyon/issues/40)).
- Fixed Esc aborting an ongoing agent turn instead of overlapping TTS playback, leaving speech uninterruptible.
- Fixed the remapped TypeBox compatibility shim omitting `Type.Unsafe`, which crashed extensions such as `vey-mcp-adapter` when they registered tools from raw MCP input schemas.
- **Auth Gateway Models**: Fixed `/v1/models` endpoint returning ambiguous bare model IDs when multiple providers register the same model name. Model IDs are now correctly advertised with their `provider/` prefix (e.g., `anthropic/shared-model`) and duplicate entries from the resolver map are deduplicated.
- Fixed GPT-5.6 Codex SKUs (`gpt-5.6-{sol,terra,luna}`) losing ~75K of usable context when the Codex discovery endpoint actively reports `context_window: 272000`: discovery now floors these SKUs at the 372K hard capacity instead of only substituting it when the field is absent, so the runtime dynamic value no longer overwrites the bundled pin.
- Fixed the in-process `rm` builtin treating an empty path operand as the shell working directory, so `rm -rf ""` recursively deleted the current directory instead of rejecting the operand. An empty operand reached `veyyon_uutils_ctx::resolve`, which joins `""` onto the cwd and yields the cwd itself; the builtin now rejects empty operands before resolution, matching GNU `rm` (ENOENT, silent under `-f`) and leaving the cwd untouched (Closes #51).
- Fixed the pinned composer scrolling off screen when reading history back: scroll isolation held the wheel only while the composed frame overflowed the viewport, and a virtualized transcript (the coding agent's) drops committed rows from its frame on every quiet frame, so the gate closed, the wheel went to the terminal, and the whole window scrolled with the prompt in it. Wheel capture now arms while anything sits above the window, including rows already on the new scroll tape.
- Fixed scroll-back depth being limited to the commit lag (a few rows) rather than the session. The engine records every prepared row it lets scroll off on a bounded scroll tape (`scrollTapeRows`, `setScrollTapeCap`, default 20k rows) and scrolls a snapshot of the tape plus the live frame, so a frozen view reaches the first row of the session and cannot be shifted by a transcript dropping rows underneath it.

## [1.0.37] - 2026-07-24

### Fixed

- `veyyon update` now updates source installs for real: it fast-forwards the checkout, reinstalls dependencies, and regenerates build artifacts, instead of refusing with advice to run `git pull` yourself.
- A source checkout missing its generated tool-views bundle (any freshly pulled or cloned checkout) no longer dies at launch with a raw module-resolution error: the launcher regenerates the bundle before starting, and fails with the exact fix command if it cannot.
- The setup wizard now paints its own pure-black ground across the full frame (splash, scene transitions, and outro), so the launch sequence looks the same on every terminal background instead of inheriting the terminal's color.
- The Windows binary is now built as a modern (AVX2) Bun target instead of baseline. Baseline Windows standalone builds crash in the Bun runtime at startup before any Veyyon code runs (oven-sh/bun#32684), which made every published `veyyon-windows-x64.exe` exit with a segmentation fault on launch. The modern target requires a CPU with AVX2 (Intel Haswell 2013 / AMD Excavator 2015 or newer).
- `REM` no longer deletes a file whose content drifted from the section tag. A whole-file delete is now the strictest op about the content tag (it was the most lenient: empty edits took the position-stable path and deleted through drift with only a soft warning), so a stale or fabricated tag can no longer discard edits the model never saw. The delete is refused with a mismatch error that forces a re-read, matching how an anchored edit on a drifted file behaves.
- `MV DEST` no longer silently overwrites an existing destination file. A move onto a different existing file is refused during prepare (aborting the whole batch before any write), so a wrong or hallucinated destination can no longer destroy the user's work. A rename that only respells one file (case-only on a case-insensitive volume, or through a symlink) is still allowed, matched by device+inode identity rather than by path string.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
