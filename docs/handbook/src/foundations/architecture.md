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

## Subsystems

| Subsystem | Responsibility | Chapter |
| --- | --- | --- |
| Edit engine (`@veyyon/hashline`) | Default hashline edit path | [Edit engine](../edit/engine.md) |
| Sessions | Session trees, compaction | [Compaction & memory](../context/compaction-memory.md) |
| MCP | MCP client integration | [MCP](../architecture/mcp.md) |
| Config | Settings and profiles | [Config](../architecture/config.md) |
| Memory | off / local / mnemopi / hindsight | [Memory](../features/memory.md) |
| Goals | Goal cards and budgets | [Goal state](../context/goal-state.md) |

## Design rules

1. **One primary edit path.** Hashline is the default edit surface; alternate `edit.mode` values exist for compatibility.
2. **Explicit failures.** Invalid config, stale hashline tags, and denied actions return actionable errors to the operator or model. Denied tools do not auto-escalate permissions.

Tool-call argument repair (alias maps, strict unknown-key rejection, parse leniency) runs at the dispatch seam in `packages/coding-agent/src/repair/schema-repair.ts`. See [Repair](../repair/overview.md). Providers and models: [Providers](../models/providers.md).
