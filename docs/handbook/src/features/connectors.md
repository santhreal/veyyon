# Connectors and Apps

> **Spec — not shipped:** provider-hosted **connectors** (`/apps`, `[apps]` config tables,
> account-gated app tools). Veyyon does not ship this subsystem today.

## What ships instead

Extend Veyyon with tools that are implemented and documented today:

| Integration | Purpose |
| --- | --- |
| [MCP](./mcp.md) | Attach MCP servers; tools appear as `mcp__…` with approval tiers |
| [Plugins](./plugins.md) | Install extensions; `veyyon plugin install …` |
| [Hooks](./hooks.md) | Event-driven automation in the agent loop |
| [Skills](./skills.md) | Bundled instructions and tool patterns |
| OAuth providers | `/login`, `/setup` / `/providers` for supported APIs |

Tool policy uses `tools.approvalMode` and `tools.approval.<tool>` — same machinery for bash, MCP, and custom tools (`docs/approval-mode.md`).

## Roadmap note

If provider-hosted connectors ship, they will add a feature flag, account discovery, an `/apps` UI, and
`[apps]` config. Until then, `apps` tables are not current behavior.

## See also

- [MCP setup](../using/mcp-setup.md)
- [Safety](../using/safety.md)
- [Plugins](./plugins.md)
