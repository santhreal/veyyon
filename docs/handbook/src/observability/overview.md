# Observability

> **Status: Partial.** Usage stats (`veyyon stats`, `/usage`) exist; OpenTelemetry metric export is **Spec — not
> shipped**.

## Shipped

- **Status line** token and cost segments during interactive sessions
- **`veyyon stats`** (CLI) and `/usage` (TUI) — usage dashboards (`@veyyon/stats` when enabled)
- **Structured logging** in the coding-agent logger
- **Repair telemetry:** the repair seam is shipped, but bounded repair counters are not yet active (see [Soundness and telemetry](../repair/soundness.md))

## Target telemetry (Spec — not shipped)

When OTEL export is wired, metrics should use bounded label sets and fail loud on misconfigured
exporters.

For session-level debugging: `/dump`, `/context`, `/debug`, and `veyyon grep` test harnesses.
