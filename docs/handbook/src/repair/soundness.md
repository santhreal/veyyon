# Soundness and telemetry

> **Status: Partial.** Veyyon emits usage and session statistics, and the repair seam is shipped; the
> bounded repair telemetry and proptest soundness guarantees are **Spec — not shipped**.

## Shipped observability

- `/stats` and `veyyon stats` — usage dashboards when enabled
- Session token accounting on the status line (`token_*`, `context_pct`, `cost`)
- Structured logging via the coding-agent logger

## Target

When the bounded repair telemetry ships:

- Every repair attempt records `(model, tool, outcome)` with fixed cardinality
- Optional file sink for repair shape fingerprints (not metric labels)
- Property tests over parse/repair generators (no panics; repaired JSON strict-validates)

See [Observability](../observability/overview.md) for what exists today.
