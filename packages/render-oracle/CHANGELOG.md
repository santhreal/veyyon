# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- New package: the terminal renderer defect oracle, holding the virtual terminal, frame capture, state-relative invariant detectors, the fuzz driver and the replayable defect corpus.
- `defaultImageTheme` test fixture, so no suite hand-rolls an image theme.
- `findViewportHoles` and `findStrandedChrome` decide the two blank-space defect classes from the frame's own state, taking no size threshold: a hole is a blank run with paint on both sides, and chrome is stranded when a painted row sits below it.

### Changed

- The package exposes a single entry point. Deep subpath imports are no longer resolvable, so consumers import `@veyyon/render-oracle` and nothing beneath it.
- Every renderer regression test moved into this package, replacing copies previously spread across `tui` and `coding-agent`.
- The prompt-visibility and virtual-scroll footer checks read the footer placement the renderer produced instead of re-deriving it, so a footer taller than the viewport is judged against the rows the renderer painted.
- The anti-yank scroll check exempts an op the engine redrew: a committed-prefix divergence erases native scrollback and replays the frame by design, moving the reader's offset and the rows above it, so the rebuilt history is now compared against the committed record instead of being read as a stray write.
