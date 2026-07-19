# Tools, skills, and extension data

## Tools

Built-in tools (read, grep, glob, edit, bash, …) run through the agent loop under `tools.approvalMode` and related policy. Edit paths share hashline verification. Catalog: [Tools reference](../reference/tools.md).

## Skills

Filesystem skill packages (e.g. `SKILL.md` trees) discovered under project and profile skill dirs. Invalid or unmet dependencies surface load errors. See [Skills](../features/skills.md).

## Plugins

`veyyon plugin` / marketplaces install bundles of skills, MCP, hooks, and related assets. See [Plugins](../features/plugins.md).

## MCP

External tools via Model Context Protocol: client config in `mcp.json` (user profile and/or project). See [MCP](../features/mcp.md).

## Hooks

TypeScript modules with `pi.on(...)`, not JSON command tables. See [Hooks](../features/hooks.md).

## Related

- [Configuration](./configuration.md): approval mode and settings paths
- [Mechanisms](../why/innovations.md)
