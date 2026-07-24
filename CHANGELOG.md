# Changelog

## [Unreleased]

## [1.0.27] - 2026-07-24

### Fixed

- The install script now adds `veyyon` to your PATH in a file that a new shell actually reads on macOS. A macOS Terminal window opens a login `bash` shell, which reads `~/.bash_profile` (then `~/.bash_login`, `~/.profile`) and not `~/.bashrc`, so the previous PATH line written to `~/.bashrc` never took effect and `veyyon` stayed off PATH after install. The installer now writes to the correct login-shell file on macOS and keeps using `~/.bashrc` on Linux.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
