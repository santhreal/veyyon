# Changelog

## [Unreleased]

### Fixed

- The inline TUI no longer paints backgrounds by default, so nothing renders as a colored slab on a terminal whose background differs from the theme: the user-message bubble, custom/skill/hook message cards, tool-state tints, the composer band, and the status line all inherit the terminal's own background. The status line's painted bar is still available by turning off the new `statusLine.transparent` default, and a theme can still declare an explicit `composerBg`.
- Every built-in theme is presented again. The temporary alabaster-only picker is reverted along with its `tui.paintGround: always` default, which repainted the terminal's background color on launch; `tui.paintGround` is back to `auto` (paint only when it cannot produce a visible seam) and the dark/light defaults are back to `titanium`/`light`.

### Added

- Added a `systemPrompt.sectionOverrides` setting that swaps individual banner sections of the default system prompt (`conventions`, `role`, `runtime`, `toolPolicy`, `executionWorkflow`, `deliveryContract`) for an experiment while leaving every other section, and every settings-gated block in it, byte-for-byte untouched. This is the safe way to vary one region of the prompt: unlike a whole-prompt override it cannot freeze a snapshot that stops responding to settings or silently drop a settings-gated section (for example the delegation block that renders only when delegation is on). An unknown section name, a replacement that drops its section banner, and combining an override with a custom whole-prompt template each fail loudly rather than silently.

## [1.0.36] - 2026-07-24

### Fixed

- Error messages no longer show a doubled `Error:` prefix. A failure while adding, removing, updating, installing, uninstalling, linking, or toggling a plugin or marketplace, applying a personality, or changing the Mermaid rendering setting now reads `Failed to …: <reason>` instead of `Failed to …: Error: <reason>`.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
