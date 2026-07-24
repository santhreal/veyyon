# Changelog

## [Unreleased]

## [1.0.23] - 2026-07-24

### Fixed

- Fixed a file move during an edit (the hashline `MV` op) deleting the file instead of renaming it when the destination resolved to the same file as the source: the two paths differed only by case on a case-insensitive filesystem, or the destination was a symlink pointing back at the source. The move now detects that both paths are one underlying file and skips the delete, so the edited content is preserved.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
