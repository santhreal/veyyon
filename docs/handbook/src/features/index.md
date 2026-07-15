# Features

Veyyon's features are split into two groups: everyday interactions you use while working, and power-user customization tools that shape how the agent behaves.

## Everyday features

- [Cockpit](./cockpit.md) customizes the status line and monitors multi-agent work; a terminal title composer and TUI pet are spec only.
- [Keybindings](./keybindings.md) remaps shortcuts and toggles Vim mode in the composer.
- Composer conveniences (prompt history, `@` / `/` completion, empty-state hints, Esc interrupt) are documented in [Quickstart](../using/quickstart.md#composer-conveniences) and [Keybindings](./keybindings.md).
- [Web search](./web-search.md) lets the model look up current information from the web.

## Power features

- [Plan mode](./plan-mode.md) plans complex changes through grounded conversation before editing code.
- [Skills](./skills.md) are reusable capabilities defined on the filesystem and shared across projects.
- [Plugins](./plugins.md) bundle skills, MCP servers, hooks, apps, and TUI customizations from marketplaces.
- [Hooks](./hooks.md) run commands or inject context in response to lifecycle events.
- [MCP](./mcp.md) connects Veyyon to external tools and data sources via the Model Context Protocol.
- [Branching](./branching.md) explores alternative paths by forking, cloning, or branching the session tree.
- [Memory](./memory.md) collects guidance and decisions from past runs to keep future threads consistent.
- [Profiles](./profiles.md) bundle and switch between groups of configuration settings.
- [Personalities](./personalities.md) changes the agent's communication style without changing its capabilities.
- [Export and import](./export-import.md) saves sessions to files and migrates settings from Claude Code.
- [Connectors](./connectors.md) reach provider-hosted apps and data sources behind your account.

## Task-oriented guides

Feature pages are reference-shaped. For goal-shaped recipes that stitch hooks, exec, MCP,
skills, plugins, memory, and branching together, start with
[Task guides](../using/task-guides.md).

## Where to go next

For command and file reference, see the [Reference](../reference/index.md) chapter. For how Veyyon is designed, see [Foundations](../foundations/thesis.md).
