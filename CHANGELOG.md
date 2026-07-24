# Changelog

## [Unreleased]

## [1.0.37] - 2026-07-24

### Fixed

- `veyyon update` now updates source installs for real: it fast-forwards the checkout, reinstalls dependencies, and regenerates build artifacts, instead of refusing with advice to run `git pull` yourself.
- A source checkout missing its generated tool-views bundle (any freshly pulled or cloned checkout) no longer dies at launch with a raw module-resolution error: the launcher regenerates the bundle before starting, and fails with the exact fix command if it cannot.
- The setup wizard now paints its own pure-black ground across the full frame (splash, scene transitions, and outro), so the launch sequence looks the same on every terminal background instead of inheriting the terminal's color.
- The Windows binary is now built as a modern (AVX2) Bun target instead of baseline. Baseline Windows standalone builds crash in the Bun runtime at startup before any Veyyon code runs (oven-sh/bun#32684), which made every published `veyyon-windows-x64.exe` exit with a segmentation fault on launch. The modern target requires a CPU with AVX2 (Intel Haswell 2013 / AMD Excavator 2015 or newer).

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
