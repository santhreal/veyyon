# Changelog

## [Unreleased]

## [1.0.33] - 2026-07-24

### Fixed

- A `keybindings.yml`/`.json` that parses cleanly but is not a mapping (a top-level sequence or a bare scalar) is now quarantined and left at defaults instead of silently corrupting the user's map. Such a file previously reduced a scalar to an empty map and turned a sequence into bogus index-keyed bindings, which the migration writer then persisted over the original file. A blank or comments-only file still loads as an empty config with no complaint.
- A settings file that parses cleanly but is not a mapping (a top-level YAML sequence, a bare scalar, or a string) is now preserved and reported instead of silently discarded. The loader previously collapsed any non-mapping root to an empty config with no signal, so a mis-edited settings file erased the user's whole configuration invisibly. Such a file is now quarantined and surfaced through `quarantinedFiles`, exactly like an unparseable one, while a blank or comments-only file stays silent as a legitimately empty config.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
