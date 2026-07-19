# Configuration

This page groups settings by what you are trying to do. For provider and sign-in setup, see [Models and providers](./models.md) and [Authentication](./authentication.md). For the full list of every key, see the repository's `docs/settings.md`.

## Where settings live

Settings are YAML mappings. Persistent settings live in `config.yml`; custom model providers live in
`models.yml`; MCP servers live in `mcp.json`.

| Scope | Path | Notes |
| --- | --- | --- |
| Global | `~/.veyyon/profiles/default/agent/config.yml` | The main persistent file. `/settings` and `veyyon config set` write here. |
| Project | `<repo>/.veyyon/config.yml` | Loaded when the cwd has a non-empty config dir. Edit by hand. |
| CLI overlay | any file passed with `--config <file>` | Process-local, repeatable, never persisted. |

Precedence, low to high:

```text
defaults  <-  global config  <-  project config  <-  --config overlays  <-  runtime flags
```

Read and write from a shell with `veyyon config`:

```console
$ veyyon config list                    # all settings with effective values
$ veyyon config get tools.approvalMode
$ veyyon config set compaction.strategy snap
$ veyyon config path                     # print the active agent directory
```

`/settings` does the same inside a live session. Keys must match a schema path exactly
(`theme.dark`, not `theme`).

## Pick models and providers

Three explicit model slots, each set on its own:

| Goal | What to set |
| --- | --- |
| Choose the model you talk to | `--model` / `/model` (persisted as `modelRoles.default`) |
| Model for spawned subagents | `subagent.model` |
| Model for context compaction | `compaction.model` |
| Named model assignments (optional) | `modelRoles`, per profile (settings → Models → Roles) |
| Add a local or BYOK provider | a `providers:` entry in `models.yml` (see [Models](./models.md)) |

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
modelRoles:
  default: openai/gpt-5           # interactive model (persisted default)
  smol: openai/gpt-4.1-mini
  task: deepseek/deepseek-chat
subagent:
  model: deepseek/deepseek-chat   # optional; overrides modelRoles.task
compaction:
  model: openai/gpt-5-mini        # optional; else inherit interactive
```

`/model` changes the interactive model (persists to `modelRoles.default` when saved as default). `/status` shows effective models. Role list and Ctrl+P cycling: [Models, roles, and profiles](./roles-and-profiles.md).

## Stay safe (approvals)

| Goal | What to set |
| --- | --- |
| When Veyyon asks before acting | `tools.approvalMode`: `plan`, `ask`, `auto-edit`, `yolo` (default); legacy `always-ask`/`write` accepted |
| Per-tool policy | `tools.approval`: map a tool to `allow` / `deny` / `prompt` |
| Advisor review pass | `advisor.enabled` + `modelRoles.advisor` |

```yaml
tools:
  approvalMode: auto-edit
  approval:
    bash: prompt
    read: allow
```

Per run, `--approval-mode <mode>` and `--auto-approve` / `--yolo` override the mode. There is no
separate OS shell sandbox, the approval mode is the only boundary; see
[Approvals](../features/sandbox.md) and [Safety](./safety.md).

## Run unattended or in CI

| Goal | What to pass |
| --- | --- |
| Non-interactive one-shot | `veyyon --approval-mode auto-edit "…"` (prompt as arg or piped stdin) |
| Force `tools.approvalMode: yolo` for the run | `--yolo` |
| Temporary settings for one run | `--config ./ci-settings.yml` (repeatable) |

Lifecycle automation inside sessions uses [hooks](../features/hooks.md).

## Control context, memory, and compaction

Compaction compresses older history instead of truncating it. Common keys:

| Goal | What to set |
| --- | --- |
| Auto-compaction threshold | `compaction.thresholdPercent` (also `compaction.thresholdTokens`) |
| Compaction type | `compaction.strategy`: `handoff` or `snap` (schema default `snap`) |
| Compaction model | `compaction.model` (unset = interactive model) |
| Cross-session memory backend | `memory.backend`: `off` (default), `local`, `hindsight`, `mnemopi` |

```yaml
compaction:
  thresholdPercent: 80
  strategy: handoff
  model: openai/gpt-5-mini

memory:
  backend: mnemopi
```

See [Compaction and project memory](../context/compaction-memory.md) and
[Memory](../features/memory.md).

## Restrict tools for a repo or role

Deny a tool with per-tool policy, or disable a built-in tool entirely:

```yaml
tools:
  approval:
    bash: deny
    edit: deny

bash:
  enabled: false
```

Plan mode and agent definitions can narrow the tool set further. Enforcement removes the tool from both
the model-visible set and the dispatch registry.

## Profiles

Each profile is `~/.veyyon/profiles/<name>/agent/` (including `default`). Activate with `--profile <name>` (`-p` is `--print`, not profile), `VEYYON_PROFILE`, or TUI `/profile` (relaunch).

```console
$ veyyon --profile work
$ # edit ~/.veyyon/profiles/work/agent/config.yml
```

See [Profiles](../features/profiles.md), [File locations](../reference/file-locations.md).

## Wire MCP servers and hooks

MCP servers are configured as JSON, not in `config.yml`:

In `~/.veyyon/profiles/default/agent/mcp.json` (JSON is strict, no comments):

```json
{
  "mcpServers": {
    "database": {
      "type": "stdio",
      "command": "node",
      "args": ["/path/to/db-mcp-server/index.js"]
    }
  }
}
```

Hooks: TypeScript modules under project/profile hook paths (`pi.on(...)`). See [Hooks](../features/hooks.md), [Task guides](./task-guides.md). MCP: [MCP](../features/mcp.md).

## Related

- [Getting started](./getting-started.md)
- [Task guides](./task-guides.md)
- [Safety](./safety.md): `tools.approvalMode` (default `yolo`)
- [Extending](./extending.md)
- [CLI](../reference/cli.md)
