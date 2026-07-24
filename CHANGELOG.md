# Changelog

## [Unreleased]

## [1.0.31] - 2026-07-24

### Fixed

- The `apply_patch` default filesystem now commits crash-atomically. The interactive editor already wrote through the crash-atomic LSP path, but the default filesystem behind programmatic and SDK `apply_patch` callers still used a truncate-then-stream `Bun.write`, so a crash mid-write could leave the target file truncated. Create, update, and move writes through the default now write a sibling temp and rename it over the target, preserving an existing file's permission bits.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
