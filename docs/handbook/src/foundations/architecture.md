# Architecture at a glance

Veyyon ships as the **`veyyon`** CLI (Bun + TypeScript, Rust helpers). This chapter maps subsystems;
each has a handbook page and matching engineering notes under `docs/`.

## The request path

```text
            ┌──────────────────────────────────────────────────────────────┐
prompt ──► │  veyyon (packages/coding-agent)                              │
            │    │                                                          │
            │    ▼                                                          │
            │  AgentSession turn loop                                      │
            │    │   model stream → tools (read, bash, edit, …)            │
            │    ▼                                                          │
            │  hashline / handlers ──► filesystem (approval-gated)         │
            └──────────────────────────────────────────────────────────────┘
```

## Subsystems that matter

| Subsystem | Responsibility | Chapter |
| --- | --- | --- |
| Edit engine (`@veyyon/hashline`) | Default hashline edit path | [Edit engine](../edit/engine.md) |
| Sessions | Session trees, compaction | [Compaction & memory](../context/compaction-memory.md) |
| MCP | MCP client integration | [MCP](../architecture/mcp.md) |
| Config | Settings and profiles | [Config](../architecture/config.md) |
| Memory | mnemopi / local memory | [Memory](../features/memory.md) |
| Goals | Goal cards and budgets | [Goal state](../context/goal-state.md) |

## Design rules

1. **Prefer one obvious path.** Hashline is the default edit surface; alternate `edit.mode` values
   exist for compatibility.
2. **Fail loud.** Invalid config, stale hashline tags, and denied actions surface actionable
   errors. No silent fallback to weaker behavior.

> **Spec — not shipped:** the full ordered repair rule cascade (alias maps, strict unknown-key
> rejection, per-`(model,tool,shape)` telemetry), an app-server or exec-server daemon, and a Tier-B
> `backends.toml` catalog as a separate subsystem. Provider and model configuration is documented in
> [Providers](../models/providers.md) against the shipped provider registry. Basic schema repair on
> tool calls is shipped today as a TypeScript module at the tool-dispatch seam
> (`packages/coding-agent/src/repair/schema-repair.ts`) — see [Repair](../repair/overview.md).
