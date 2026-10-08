# Connectors and Apps

Veyyon does not ship provider-hosted connectors: app integrations that require a provider account
and install through that provider's connector store. Extend Veyyon with MCP, plugins, hooks, and skills instead.

## What ships instead

Extend Veyyon with tools that are implemented and documented today:

| Integration | Purpose |
| --- | --- |
| [MCP](./mcp.md) | Attach MCP servers; tools appear as `mcp__…` with approval tiers |
| [Plugins](./plugins.md) | Install extensions; `veyyon plugin install …` |
| [Hooks](../reference/hooks.md) | Event-driven automation in the agent loop |
| [Skills](../reference/skills.md) | Bundled instructions and tool patterns |
| OAuth providers | `/login` and `/setup` for supported APIs; `/providers` manages the accounts you have |

Tool policy uses `tools.approvalMode` and `tools.approval.<tool>`, same machinery for bash, MCP, and custom tools (`docs/handbook/src/reference/approval-mode.md`).

Veyyon has no provider-hosted connector store and no `apps` connector table.
Use MCP, plugins, hooks, and skills for integrations.

## See also

- [MCP setup](../using/mcp-setup.md)
- [Safety](../using/safety.md)
- [Plugins](./plugins.md)
