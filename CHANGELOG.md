# Changelog

## [Unreleased]

## [1.0.29] - 2026-07-24

### Fixed

- The CLI no longer hangs while printing a fatal error whose cause chain forms a cycle. A wrapped error whose `cause` pointed back at itself (directly or through another error) made the cause walk loop forever; it now stops at the first repeat and notes the circular reference.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
