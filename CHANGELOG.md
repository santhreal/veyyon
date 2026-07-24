# Changelog

## [Unreleased]

## [1.0.28] - 2026-07-24

### Fixed

- The Windows installer no longer destroys local edits in the source checkout. A source update ran `git reset --hard`, and uninstall deleted the checkout outright, so local edits under `~/.veyyon/src` (an edited `AGENTS.md`) were lost. It now commits any local changes to a `veyyon-local-<timestamp>` branch before updating, moves an existing tree aside to `<dir>.bak-<timestamp>` instead of deleting it before a fresh clone, and refuses to delete a checkout that holds unpushed work on uninstall. This matches the protection the POSIX installer already had.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
