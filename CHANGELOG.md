# Changelog

## [Unreleased]

### Security

- The self-updater now verifies a downloaded release binary against its published `.sha256` sidecar before installing it, the same fail-closed integrity gate the `curl` and PowerShell installers already enforce. Previously `veyyon update` and the automatic startup update downloaded and swapped the binary with only a post-install `--version` check, which catches a wrong-version binary but not a corrupted or tampered same-version one. A missing, unparseable, or mismatched checksum now aborts the update and removes the partial download instead of installing something unverified.

### Fixed

- A failed release-binary download now reports the URL, the HTTP status, the requested version, and the missing asset instead of the bare `Download failed: Not Found`. A 404 explains that the version may not exist or its build for your platform was not published and points at `veyyon update --check`; a 403/429 gives the rate-limit retry hint. This most helps installing a specific older version, where a mistyped or unpublished version previously failed with no clue what went wrong.

## [1.0.33] - 2026-07-24

### Fixed

- A `keybindings.yml`/`.json` that parses cleanly but is not a mapping (a top-level sequence or a bare scalar) is now quarantined and left at defaults instead of silently corrupting the user's map. Such a file previously reduced a scalar to an empty map and turned a sequence into bogus index-keyed bindings, which the migration writer then persisted over the original file. A blank or comments-only file still loads as an empty config with no complaint.
- A settings file that parses cleanly but is not a mapping (a top-level YAML sequence, a bare scalar, or a string) is now preserved and reported instead of silently discarded. The loader previously collapsed any non-mapping root to an empty config with no signal, so a mis-edited settings file erased the user's whole configuration invisibly. Such a file is now quarantined and surfaced through `quarantinedFiles`, exactly like an unparseable one, while a blank or comments-only file stays silent as a legitimately empty config.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
