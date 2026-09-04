# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added

- `@veyyon/tool` states what a tool declares and returns: `ToolSpec` with its examples, the `ToolTier` and `ToolApproval` vocabulary, `ToolResult` and `ToolUpdateCallback`. A tool declares itself without importing the loop that schedules it or the host that prompts for approval. The package imports the message content blocks from `@veyyon/model`, type-only, and nothing else.
