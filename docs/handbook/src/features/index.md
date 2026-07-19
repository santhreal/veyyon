# Features

This chapter is the hub for Veyyon's features. It groups them into the interactive surfaces you work with directly, the modes and extensions that change how the agent runs, and a short list of recipes.

## Interactive surfaces

These are the parts of the TUI you touch every session:

- [Status line and multi-agent UI](./cockpit.md) covers the status segments, `/cockpit`, jobs, and the swarm view.
- [Keybindings](./keybindings.md) covers the chords and Vim mode.
- The composer gives you prompt history, `@` and `/` completion, and `Esc` to interrupt. See [Quickstart](../using/quickstart.md) and [Keybindings](./keybindings.md).
- [Web search](./web-search.md) covers searching from inside a session.

## Modes and extensions

These change how the agent runs, or add new capabilities:

| Feature | What it adds |
| --- | --- |
| [Plan mode, goals, and vibe](./plan-mode.md) | Engine modes that plan, pursue an objective, or direct workers |
| [Skills](./skills.md) | Reusable, on-demand instructions |
| [Plugins](./plugins.md) | Packaged extensions |
| [Hooks](./hooks.md) | TypeScript modules that run on events with `pi.on(...)` |
| [MCP](./mcp.md) | Model Context Protocol servers and tools |
| [Branching](./branching.md) | Forking a session into parallel lines of work |
| [Memory](./memory.md) | Project-scoped recall across sessions |
| [Profiles](./profiles.md) | Isolated config, sessions, and state per name |
| [Personalities](./personalities.md) | Named voice and behavior presets |
| [Speech](./speech.md) | Text-to-speech output |
| [Export and import](./export-import.md) | Moving sessions in and out |
| [Connectors](./connectors.md) | Third-party app integrations |
| [Approvals](./sandbox.md) | The approval-mode boundary in depth |
| [Code review](./review.md) | Reviewing branches, commits, and uncommitted work |
| [Non-interactive mode](./exec.md) | Running Veyyon from a script |

## Recipes

For worked examples, see the [Task guides](../using/task-guides.md). For the full command and setting reference, see [Reference](../reference/index.md).
