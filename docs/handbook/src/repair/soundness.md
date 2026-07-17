# Soundness and telemetry

> **Status: Mostly shipped.** Repair outcome telemetry records `(model, tool, outcome)` end to end;
> the repair shape-fingerprint file sink and generator-based property tests remain **Spec — not
> shipped**.

## Shipped observability

- **Repair outcome telemetry** — when schema repair acts on a tool call, the outcome is persisted on
  the tool result in the session record (`repairStatus: "repaired" | "unrepairable"`; absent means
  repair did not act). The stats pipeline lifts it into the `tool_calls` table and the
  `veyyon stats` dashboard shows repaired/refused counts per tool and per `(tool, model)` — fixed
  cardinality by construction: three outcomes, real tool names, real model ids.
- `/usage` and `veyyon stats` — usage dashboards when enabled
- Session token accounting on the status line (`token_*`, `context_pct`, `cost`)
- Structured logging via the coding-agent logger
- A conformance suite over the repair cascade (`test/repair/schema-repair.test.ts`) asserting
  repaired arguments strict-validate against the tool schema

## Target

Still spec:

- Optional file sink for repair shape fingerprints (not metric labels)
- Randomized property tests over parse/repair generators (no panics; repaired JSON strict-validates
  on arbitrary inputs) — today's conformance suite is case-based, not generative

See [Observability](../observability/overview.md) for what exists today.
