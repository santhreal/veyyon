# Changelog

## [Unreleased]

### Breaking Changes

- `StreamOptions.cursorRules` and the exported `CursorRuleInput` type are removed, and `buildCursorRules` takes only the system prompt: the Cursor provider builds exactly one request-context rule, the assembled prompt.

### Added

- `ToolCallLoopGuard` detects consecutive redundant reads of unchanged files whose requested line ranges are already fully present in recent context, steering runaway exploration loops while preserving prompt cache prefixes.
- Added Command Code API-key login through the Studio Provider page, with validation against its Provider API, and Nous Research Portal OAuth device login with rotating refresh tokens and short-lived inference JWTs.
- `explain(error)` in `@veyyon/ai/error/flags` returns the classification id together with the names of the rules that produced it, and every classification rule states a name.
- Added `nous-research-api-key`, a second way into Nous Research that takes a key pasted from the Portal instead of running the device flow, validated against the inference API and stored as the same `nous-research` credential.

### Changed
- Free functions, consts, and types extracted from `cache/policy.ts`, `error/classes.ts`, and `dialect/fenced-thinking.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `auth-broker/refresher.ts` and `dialect/thinking.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `error/oauth.ts` and `dialect/qwen3.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `registry/oauth/devin.ts` and `providers/openai-codex/response-handler.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `utils/stream-markup-healing.ts` into companion `utils/stream-markup-healing-helpers.ts`.
- Free functions, consts, and types extracted from `dialect/gemma.ts` into companion `dialect/gemma-helpers.ts`.
- Free functions, consts, and types extracted from `dialect/gemini.ts`, `providers/pi-native-client.ts`, and `error/provider.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `dialect/kimi.ts` into companion `dialect/kimi-helpers.ts`.
- Free functions, consts, and types extracted from `dialect/pi-native.ts`, `dialect/harmony.ts`, and `registry/oauth/google-oauth-shared.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `auth-broker/client.ts` and `registry/oauth/gitlab-duo-workflow.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `src/providers/mock.ts` and `src/dialect/anthropic.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `src/dialect/deepseek.ts` and `src/dialect/glm.ts` into companion `src/dialect/deepseek-helpers.ts` and `src/dialect/glm-helpers.ts`.
- Free functions, consts, and types extracted from `src/registry/oauth/gitlab-duo.ts` and `src/registry/oauth/openai-codex.ts` into companion `*-helpers.ts` files.
- Free functions, consts, and types extracted from `src/providers/anthropic-client.ts` into companion `src/providers/anthropic-client-helpers.ts`.
- Free functions, consts, and types extracted from `src/providers/anthropic-client.ts` into companion `src/providers/anthropic-client-helpers.ts`.
- Removed export keyword from 328 functions across providers, registry, dialect, error, stream, and utils subsystems that were used locally but never imported by any other module.
- `EventStream` async iterator uses `Promise.withResolvers()` instead of `new Promise((resolve, reject) => ...)`.
- `buildToolResultBlock` combines image hoisting and text filtering into a single pass, eliminating an intermediate array from `.filter()`.
- `convertContentBlocks` and `isEmptyToolResultWireContent` use regex tests instead of `trim().length` to avoid string allocations.
- `normalizeExtraBetas`, `buildAnthropicSystemBlocks`, `buildSystemPrompt` (anthropic-messages-server), and `buildSystemPrompt` (amazon-bedrock) collect results in a single loop instead of chaining `.map().filter()`.
- `convertMessages` in `anthropic.ts` uses regex tests instead of `trim().length` for all blank-content checks in the message conversion loop, eliminating string allocations on every request.
- `openai-completions-helpers.ts`, `openai-completions.ts`, `openai-responses-codec.ts`, `openai-responses-codec-helpers.ts`, `openai-shared-helpers.ts`, and `openai-reasoning-fallback.ts` use regex tests instead of `trim().length` for blank-content checks in message conversion, streaming, and error formatting paths.
- `google-shared-helpers.ts` and `amazon-bedrock-helpers.ts` use regex tests instead of `trim().length` for blank-content checks in message conversion loops.
- `transform-messages.ts` and `openai-prompt-cache.ts` use regex tests instead of `trim().length` for tool call validation and prompt cache breakpoint checks.
