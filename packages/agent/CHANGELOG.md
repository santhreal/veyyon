# Changelog

## [Unreleased]

### Changed
- Free functions, consts, and types extracted from `src/append-only-context.ts` into companion `src/append-only-context-helpers.ts`.
- Free functions, consts, and types extracted from `src/run-collector.ts` into companion `src/run-collector-helpers.ts`.
- Free functions, consts, and types extracted from `src/agent.ts` into companion `src/agent-helpers.ts`.
- Free functions, consts, and types extracted from `src/agent.ts` into companion `src/agent-helpers.ts`.
- Removed export keyword from 22 functions across agent-loop, compaction, run-collector, and telemetry subsystems that were used locally but never imported by any other module.
