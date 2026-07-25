# Changelog

## [Unreleased]

### Fixed

- Fixed Enter submitting the collab-web composer while an IME composition was still open, so the keystroke sent a half-composed message instead of confirming the candidate ([#6229](https://github.com/can1357/oh-my-pi/issues/6229)).
- Fixed a configured `modelRoles.default` on a discovery provider being replaced at startup by an unrelated authenticated provider's default, when a cold catalog cache meant the role could not yet resolve ([#6233](https://github.com/can1357/oh-my-pi/issues/6233)).
- Fixed `session_stop` extension hooks running when a prompt was aborted or the session was disposed, so an abort could still trigger stop-hook work and its continuation state ([#6226](https://github.com/can1357/oh-my-pi/issues/6226)).
- Fixed a provider error being pinned behind the plan review overlay, which left the error invisible and the input unusable until the plan was answered ([#6217](https://github.com/can1357/oh-my-pi/issues/6217)).
- Fixed the `tools.maxTimeout` ceiling being ignored whenever a tool call omitted `timeout`, so a configured global cap did not bound a tool running on its default budget ([#6296](https://github.com/can1357/oh-my-pi/issues/6296)).
- Fixed isolated branch merge-back rejecting committed agent edits when the parent had unrelated uncommitted changes in the same file; dirty-baseline blobs are now seeded into the parent object database and replayed with a 3-way synthetic-tree apply ([#40](https://github.com/santhreal/veyyon/issues/40)).
- Fixed Esc aborting an ongoing agent turn instead of overlapping TTS playback, leaving speech uninterruptible.
- Fixed the remapped TypeBox compatibility shim omitting `Type.Unsafe`, which crashed extensions such as `vey-mcp-adapter` when they registered tools from raw MCP input schemas.

## [1.0.37] - 2026-07-24

### Fixed

- `veyyon update` now updates source installs for real: it fast-forwards the checkout, reinstalls dependencies, and regenerates build artifacts, instead of refusing with advice to run `git pull` yourself.
- A source checkout missing its generated tool-views bundle (any freshly pulled or cloned checkout) no longer dies at launch with a raw module-resolution error: the launcher regenerates the bundle before starting, and fails with the exact fix command if it cannot.
- The setup wizard now paints its own pure-black ground across the full frame (splash, scene transitions, and outro), so the launch sequence looks the same on every terminal background instead of inheriting the terminal's color.
- The Windows binary is now built as a modern (AVX2) Bun target instead of baseline. Baseline Windows standalone builds crash in the Bun runtime at startup before any Veyyon code runs (oven-sh/bun#32684), which made every published `veyyon-windows-x64.exe` exit with a segmentation fault on launch. The modern target requires a CPU with AVX2 (Intel Haswell 2013 / AMD Excavator 2015 or newer).

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
