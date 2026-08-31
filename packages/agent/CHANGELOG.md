# Changelog

## [Unreleased]

### Changed
- Free functions, consts, and types extracted from `src/append-only-context.ts` into companion `src/append-only-context-helpers.ts`.
- Free functions, consts, and types extracted from `src/run-collector.ts` into companion `src/run-collector-helpers.ts`.
- Free functions, consts, and types extracted from `src/agent.ts` into companion `src/agent-helpers.ts`.
- Free functions, consts, and types extracted from `src/agent.ts` into companion `src/agent-helpers.ts`.
- Removed export keyword from 22 functions across agent-loop, compaction, run-collector, and telemetry subsystems that were used locally but never imported by any other module.
- `estimateTokensUncached` sums token counts directly in the walk callback instead of collecting fragments into a temporary array.
- `pruneToolOutputs` inlines useless-result detection into the main scan loop, eliminating a separate `collectUselessResults` pass and its intermediate `Set`.
- `hasSubstantiveToolResultContent` uses a regex test instead of `trim().length` to avoid allocating a trimmed string.
- `estimateTokens` mutates the existing WeakMap cache slot in place instead of spreading the cached object on every cache miss.
- `elideTailToolResults` estimates the replacement message directly instead of spreading it into a new object for `estimateTokens`.
