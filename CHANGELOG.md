# Changelog

## [Unreleased]

### Fixed

- Error messages no longer show a doubled `Error:` prefix. A failure while adding, removing, updating, installing, uninstalling, linking, or toggling a plugin or marketplace, applying a personality, or changing the Mermaid rendering setting now reads `Failed to …: <reason>` instead of `Failed to …: Error: <reason>`.

## [1.0.35] - 2026-07-24

### Changed

- `veyyon update` now prints `Checksum verified` after it validates a downloaded binary against its published `.sha256` sidecar, so you can see the integrity check ran and passed rather than only hearing about it when it fails. This matches the `verified sha256` confirmation the `curl` installer already prints. The automatic startup update stays silent to avoid corrupting the session UI.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
