# Safety you can see

Veyyon acts on your machine, so the boundary it acts within is visible and its
failures are loud. When it cannot honor a safety rule, a schema, a config file, or a
tool contract, it stops and says so rather than degrading silently — a silent
fallback is treated as a bug.

## What this means in practice

- File writes and commands run through the approval mode you set.
- Tool output records truncation instead of hiding it.
- Bad config fails with context instead of falling back silently.
- Repair abstains when the schema does not prove a safe fix.
- Observability records coarse, bounded signals without logging secrets.

## Why it works this way

A boundary that weakens without telling you is hard to work in. Veyyon instead
surfaces what it did, what it refused, and what it could not prove, so you can act on
that in a real repository.

## Where the details live

- [Configuration](../using/configuration.md) explains the knobs.
- [Soundness and telemetry](../repair/soundness.md) explains repair refusal and signals.
- [Observability](../observability/overview.md) explains runtime signals.
- [Architecture at a glance](../foundations/architecture.md) explains the boundaries.
