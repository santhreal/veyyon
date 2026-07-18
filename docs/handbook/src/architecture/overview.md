# Architecture overview

Veyyon is a **Bun/TypeScript** coding agent (fork of oh-my-pi) with Rust hot paths (`@veyyon/hashline`,
native grep, PTY). The shipped CLI binary is **`veyyon`**. There is no separate app-server daemon in
the product surface.

## The request path

```text
prompt ──► veyyon
              │
              ▼
         AgentSession turn loop
              │
              ▼
         model stream + tool calls
              │
              ▼
         tool handlers (read, bash, edit, …) ──► results back to model
```

Interactive mode runs in the TUI. Non-interactive work uses `veyyon` with a prompt or subcommands such
as `commit`, `grep`, and `models`.

## Subsystem map

| Area | Responsibility | Handbook |
| --- | --- | --- |
| Sessions | JSONL trees, resume, fork, compact | [Sessions](../using/sessions.md) |
| Edit | Hashline patches (default) | [Edit engine](../edit/engine.md) |
| Approvals | Approval-mode gating on tool tiers | [Approvals](./sandbox.md) |
| Config | Layered `config.yml`, profiles | [Config](./config.md) |
| MCP | External tool servers | [MCP](./mcp.md) |
| Providers | Model registry + auth | [Providers](./providers.md) |
| Memory | off / local / mnemopi / hindsight | [Memory](../features/memory.md) |

Not part of the product surface: a standalone exec-server process or a separate backends.toml catalog. The table above is the subsystem map.
