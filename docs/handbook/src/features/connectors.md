# Connectors and Apps

Veyyon does not ship provider-hosted connectors — account-gated app integrations wired through a
provider's own connector store. Extend it with the integrations below instead.

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

If provider-hosted connectors ship, they will add a feature flag, account discovery, and connector
configuration. Until then, use MCP, plugins, and hooks; `apps` connector tables are not current behavior.

## See also

- [MCP setup](../using/mcp-setup.md)
- [Safety](../using/safety.md)
- [Plugins](./plugins.md)
