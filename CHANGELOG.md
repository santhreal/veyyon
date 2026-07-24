# Changelog

## [Unreleased]

### Fixed

- The Windows binary is now built as a modern (AVX2) Bun target instead of baseline. Baseline Windows standalone builds crash in the Bun runtime at startup before any Veyyon code runs (oven-sh/bun#32684), which made every published `veyyon-windows-x64.exe` exit with a segmentation fault on launch. The modern target requires a CPU with AVX2 (Intel Haswell 2013 / AMD Excavator 2015 or newer).

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
