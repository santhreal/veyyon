# Changelog

## [Unreleased]

### Changed

- `veyyon update` now prints `Checksum verified` after it validates a downloaded binary against its published `.sha256` sidecar, so you can see the integrity check ran and passed rather than only hearing about it when it fails. This matches the `verified sha256` confirmation the `curl` installer already prints. The automatic startup update stays silent to avoid corrupting the session UI.

## [1.0.34] - 2026-07-24

### Fixed

- `veyyon update --check --force` on an already-up-to-date install now reports `Up to date at X; --force would reinstall it` instead of printing `Forcing reinstall of X` and then exiting without reinstalling anything. Check mode installs nothing, so the message now matches what the command actually does.
- A failed release-binary download now reports the URL, the HTTP status, the requested version, and the missing asset instead of the bare `Download failed: Not Found`. A 404 explains that the version may not exist or its build for your platform was not published and points at `veyyon update --check`; a 403/429 gives the rate-limit retry hint. This most helps installing a specific older version, where a mistyped or unpublished version previously failed with no clue what went wrong.

### Security

- The self-updater now verifies a downloaded release binary against its published `.sha256` sidecar before installing it, the same fail-closed integrity gate the `curl` and PowerShell installers already enforce. Previously `veyyon update` and the automatic startup update downloaded and swapped the binary with only a post-install `--version` check, which catches a wrong-version binary but not a corrupted or tampered same-version one. A missing, unparseable, or mismatched checksum now aborts the update and removes the partial download instead of installing something unverified.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
