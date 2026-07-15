# Safety and honesty you can see

Veyyon is useful because it can act. That only works if the boundary is visible and the results are
honest.

The harness is designed to fail loudly when it cannot honor a safety rule, a schema, a config file, or a
tool contract. Silent degradation is treated as a product bug.

## What improves

- File writes and commands run through approval and sandbox policy.
- Tool output records truncation instead of hiding it.
- Bad config fails with context instead of falling back silently.
- Repair abstains when the schema does not prove a safe fix.
- Observability records coarse, bounded signals without logging secrets.

## Why it matters

An agent that silently weakens its boundary is hard to trust. An agent that tells you exactly what it did,
what it refused, and what it could not prove is much easier to use in a real repository.

## Where the details live

- [Configuration](../using/configuration.md) explains the knobs.
- [Soundness and telemetry](../repair/soundness.md) explains repair refusal and signals.
- [Observability](../observability/overview.md) explains runtime signals.
- [Architecture at a glance](../foundations/architecture.md) explains the boundaries.
