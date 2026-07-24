# Changelog

## [Unreleased]

## [1.0.25] - 2026-07-24

### Fixed

- Editing a file that starts with a UTF-8 BOM no longer strips the BOM. The `old_text`/`new_text` edit mode read the file through a decoder that silently drops a leading BOM and then wrote the file back without it; it now recovers the BOM from the raw bytes, so the marker survives the edit (line endings were already preserved).

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
