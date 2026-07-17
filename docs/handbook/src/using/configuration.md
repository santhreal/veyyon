# Configuration

Veyyon is configurable without being fussy. Defaults are sensible; change only what you care about.
This page is organized by **goal**, not by alphabetized key name. For provider setup see
[Models and providers](./models.md) and [Authentication](./authentication.md). For the full settings
catalog, precedence rules, and every key's type and default, see `docs/settings.md`.

## Where settings live

Settings are YAML mappings. Persistent settings live in `config.yml`; custom model providers live in
`models.yml`; MCP servers live in `mcp.json`.

| Scope | Path | Notes |
| --- | --- | --- |
| Global | `~/.veyyon/agent/config.yml` | The main persistent file. `/settings` and `veyyon config set` write here. |
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
$ veyyon config set compaction.type snap
$ veyyon config path                     # print the active agent directory
```

`/settings` does the same inside a live session. Keys must match a schema path exactly
(`theme.dark`, not `theme`).

## Pick models and providers

Three explicit model slots, each set on its own:

| Goal | What to set |
| --- | --- |
| Choose the model you talk to | `--model` / `/model` (saved as `model`) |
| Model for spawned subagents | `subagent.model` |
| Model for context compaction | `compaction.model` |
| Named model assignments (optional) | `modelRoles`, per profile (settings → Models → Roles) |
| Add a local or BYOK provider | a `providers:` entry in `models.yml` (see [Models](./models.md)) |

```yaml
# ~/.veyyon/agent/config.yml
model: openai/gpt-5               # interactive
subagent:
  model: deepseek/deepseek-chat
compaction:
  model: openai/gpt-5-mini
```

`/model` changes only the interactive model. `/status` shows every effective model. `default` is not a
model — nothing falls back through a default slot.

## Stay safe (approvals and sandbox)

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
separate OS shell sandbox — the approval mode is the only boundary; see
[Approvals and autonomy](../features/sandbox.md) and [Safety](./safety.md).

## Run unattended or in CI

| Goal | What to pass |
| --- | --- |
| Non-interactive one-shot | `veyyon --approval-mode auto-edit "…"` (prompt as arg or piped stdin) |
| Auto-approve everything (trusted only) | `--yolo` |
| Temporary settings for one run | `--config ./ci-settings.yml` (repeatable) |

Lifecycle automation inside sessions uses [hooks](../features/hooks.md).

## Control context, memory, and compaction

Compaction summarizes older history instead of truncating it. It has exactly three settings:

| Goal | What to set |
| --- | --- |
| Auto-compaction threshold | `compaction.thresholdPercent` |
| Compaction type | `compaction.strategy`: `handoff` or `snap` |
| Compaction model | `compaction.model` (unset = your interactive model) |
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

## Use profiles for different kinds of work

A **profile** relocates the user agent directory so you can keep separate settings, sessions, MCP, and
skills for different work (for example `work` vs `bounty`) while sharing one `veyyon` binary. With
`--profile <name>` active, `~/.veyyon/agent/…` resolves to `~/.veyyon/profiles/<name>/agent/…`.

```console
$ veyyon --profile work
$ # edit ~/.veyyon/profiles/work/agent/config.yml
```

Activate with `--profile <name>` (no short form — `-p` is `--print`), or `VEYYON_PROFILE=<name>` (legacy `OMP_PROFILE` /
`PI_PROFILE`). Profiles are chosen at process start; there is no `/profile` switch mid-session. See
[Profiles](../features/profiles.md).

> **Spec — not shipped:** self-contained `<name>.config.yml` profile files (a full environment per
> file, `[profiles.<name>]` tables). Veyyon relocates the agent directory and reads `config.yml` under
> it.

## Wire MCP servers and hooks

MCP servers are configured as JSON, not in `config.yml`:

In `~/.veyyon/agent/mcp.json` (JSON is strict — no comments):

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

Hooks are discovered from `hooks/pre/*` and `hooks/post/*` under a config dir. Recipes:
[Task guides](./task-guides.md). Schemas: [MCP](../features/mcp.md), [Hooks](../features/hooks.md).

## Where to go next

- [Getting started](./getting-started.md) runs Veyyon with the defaults.
- [Task guides](./task-guides.md) for hooks, MCP/skills, and memory/branching recipes.
- [Safety](./safety.md) for how approval mode and the sandbox affect real tool use.
- [Extending](./extending.md) for tools, skills, and extension data.
- [CLI reference](../reference/cli.md) for flags.
