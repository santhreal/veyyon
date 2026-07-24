# Changelog

## [Unreleased]

## [1.0.30] - 2026-07-24

### Fixed

- A file move that overwrites an existing destination is now crash-atomic and mode-preserving, matching the edit/write path. The destination was previously written with a truncate-then-stream `Bun.write`, so a crash mid-move could corrupt the file being overwritten; it now writes a sibling temp and renames it over the destination, carrying the destination's permission bits forward.
- Edits and writes now commit crash-atomically. The file was previously written with a truncate-then-stream `Bun.write`, so a crash, `SIGINT`, out-of-memory kill, or full disk mid-write could leave your source file truncated or empty. It now writes a sibling temp file and renames it over the target, so an interrupted write leaves either the whole old file or the whole new one. The existing file's permission bits (including a script's executable bit) are preserved across the write, and a write through a symlink keeps the symlink and updates its target.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
