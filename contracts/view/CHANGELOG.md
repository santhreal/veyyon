# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/view` states the host-agnostic tool view model: `ToolView`, `StatusRowView`, `TextBlockView`, `ViewSpan`, `ViewTone`, `ViewStatus` and `ToolViewRenderer`. A tool returning one of these describes its output without importing a terminal component or receiving a theme, so any host can draw it. The package has no dependencies.
