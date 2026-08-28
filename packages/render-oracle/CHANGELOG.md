# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- New package: the terminal renderer defect oracle, holding the virtual terminal, frame capture, state-relative invariant detectors, the fuzz driver and the replayable defect corpus.
- `defaultImageTheme` test fixture, so no suite hand-rolls an image theme.

### Changed

- The package exposes a single entry point. Deep subpath imports are no longer resolvable, so consumers import `@veyyon/render-oracle` and nothing beneath it.
- Every renderer regression test moved into this package, replacing copies previously spread across `tui` and `coding-agent`.
