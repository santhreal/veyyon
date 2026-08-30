# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/view` states the host-agnostic tool view model: `ToolView`, `StatusRowView`, `TextBlockView`, `ViewSpan`, `ViewTone`, `ViewStatus` and `ToolViewRenderer`. A tool returning one of these describes its output without importing a terminal component or receiving a theme, so any host can draw it. The package has no dependencies.
- `ToolViewContext` states the disclosure state a host passes to a view renderer, so a tool can show a shorter summary collapsed and its full output expanded without naming a host.
- `FramedBlockView` states a framed panel: a `StatusRowView` header, an optional `ViewStatus` the host reads for the rail colour, and `ViewSection`s of `ViewLine`s, so a tool describes a card without negotiating a width.
- `StatusRowView.emblem` names a symbol a host resolves from its own registry, falling back to the row's status icon when the host has no such symbol.
- `ToolViewRenderer.renderResult` receives the call arguments alongside the result, so a card whose header states the operation still states it when the call failed and returned no details.
