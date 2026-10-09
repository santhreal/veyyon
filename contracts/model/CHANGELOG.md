# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Changed

- The `toolSchemaFlavor` documentation lists api.kimi.ai among the hosts that select `"moonshot-mfjs"` automatically; the type is unchanged.

## [1.5.0] - 2026-09-18

### Added

- `Model.longContextCost` declares the second rate card a model bills at once its prompt crosses `inputThreshold` tokens.
- `@veyyon/model` states the model and message vocabulary: the `Model` row with its thinking config and the `Effort` ladder, the `Message` envelope with its content blocks and the streamed `AssistantMessageEvent` union, the `ToolCallMetrics` and `AssistantTurnMetrics` study records, and the service-tier vocabulary. A provider implements a stream and a host reads a turn without importing the catalog that resolves the model or the client that drives it. The package has no dependencies.
