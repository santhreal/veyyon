# Task guides

Short, goal-shaped recipes for common jobs. Each guide points at the deeper feature pages; use those
when you need full schemas or edge cases.

Related references: [Hooks guide](../features/hooks-guide.md), [Non-interactive mode](../features/exec.md),
[MCP](../features/mcp.md), [Skills](../features/skills.md), [Memory](../features/memory.md),
[Branching](../features/branching.md), [Sandbox](../features/sandbox.md).

---

## Automate a check on every edit (hooks)

Goal: every time the agent finishes an edit, run a deterministic check and fail closed when it breaks.

The shipped hook model is a **TypeScript module** discovered under `.veyyon/hooks/` (project) or
`~/.veyyon/profiles/default/agent/hooks/` (user). The module exports a factory that registers handlers with `pi.on(...)`.

```ts
// .veyyon/hooks/post-edit-check.ts
export default (pi) => {
  pi.on("tool_result", async (event) => {
    if (!/^(edit|write)$/.test(event.toolName)) return;
    // run your check (spawn a test/linter); return { block, reason } from tool_call to deny
  });
};
```

The Bun runtime imports the module at startup; restart (or `/reload-plugins`) to pick up changes. See
[Hooks guide](../features/hooks-guide.md) for the event names and handler contract.

---

## Run a bounded task from a script or CI

Use `veyyon --print` (`-p`) when the trigger lives outside the agent (pre-commit, CI, `entr`, `watchexec`):

```console
$ veyyon -p --approval-mode auto-edit \
    "Run the focused tests for the files changed in the last commit and fail if any regress"
```

The prompt can be an argument or piped on stdin. `auto-edit` auto-approves writes and still prompts on exec; `--yolo` auto-approves all tiers (use only on disposable runners). JSON event streams: `--json`. For review, pass a review prompt to `-p`, or use the passive advisor (`--advisor`) in the TUI. See [Non-interactive mode](../features/exec.md).

---

## Give the agent a new tool (MCP or skills)

Goal: teach Veyyon a capability you do not want to bake into the binary.

### Choose the surface

| Need | Use |
| --- | --- |
| Talk to an external system (DB, SaaS, browser bridge) over a protocol | MCP server |
| Package reusable instructions, scripts, and examples as data | Skill (`SKILL.md`) |

### Path 1: add an MCP server

Add it from the TUI, which writes `mcp.json` for you:

```text
/mcp add
```

Or edit `~/.veyyon/profiles/default/agent/mcp.json` (user) / `.veyyon/mcp.json` (project) directly:

```json
{
  "mcpServers": {
    "database": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/db-mcp-server/index.js"],
      "env": { "DB_PATH": "/var/data/app.db" }
    }
  }
}
```

Confirm discovery with `/mcp` (or `/mcp list`), then ask the agent to use the new tool by name. If the
server needs OAuth, run `/mcp reauth <name>`. Details: [MCP](../features/mcp.md),
[MCP setup](./mcp-setup.md).

### Path 2: author a skill

Create a skill directory in user or project scope, for example
`~/.veyyon/profiles/default/agent/skills/audit-config/SKILL.md` (or `.veyyon/skills/…` in a repo):

```markdown
---
name: audit-config
description: Audit Veyyon config.yml for unsafe approval and tool-policy combinations.
metadata:
  short-description: Config safety audit
---

# Audit config

When asked to audit configuration:
1. Read the active config.yml and any project overrides.
2. Flag `yolo` approval paired with broad tool allow-lists on untrusted repos.
3. Prefer concrete remediations over generic advice.
```

Restart or open a new session so skill discovery picks it up. Skills are data, you can version them in
git and share them without shipping a new `veyyon` build. Prefer a skill when the "tool" is mostly
prompting and local scripts; prefer MCP when the capability is a long-lived external process. See
[Skills](../features/skills.md).

---

## Share context across sessions (memory and branching)

Goal: keep decisions, conventions, and alternate explorations available without pasting transcripts by
hand.

### Memory: carry guidance into new threads

Cross-session memory is off by default. Turn on a backend with `memory.backend` in `config.yml`:

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
memory:
  backend: mnemopi        # off (default), local, hindsight, mnemopi
```

Operate it from the TUI with `/memory` (`/memory stats`, `/memory diagnose`). Keep memory on for repos
where conventions matter; leave it `off` for throwaway scratch sessions. See [Memory](../features/memory.md).

### Branching: explore without losing the main line

Use the session tree when you need parallel context *inside* one problem.

| Intent | Command |
| --- | --- |
| Inspect the tree / jump to a prior turn | `/tree` |
| Copy history into a new session from a user message | `/fork` |

Typical flow: reach a decision point, `/fork` to try an alternate approach, continue on the
branch that works. Full behavior: [Branching](../features/branching.md) and [Sessions](./sessions.md).

### Memory vs branching

- **Memory** stores durable facts across sessions when a backend is enabled.
- **Branching** forks live transcript context for the current problem.
- Branch to explore; use memory for decisions that should outlive one session.

---

## See also

- [Configuration](./configuration.md) for the keys these guides touch
- [Examples](./examples.md) for prompt-shaped tasks
