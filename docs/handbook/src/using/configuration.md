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

## Save tokens with project shorthand (Argot, experimental)

A project accumulates long strings that recur in its work: file paths, import
roots, canonical build commands. Argot lets the model write a short handle in
their place. The handle is `§` followed by a name, for example `§dbconn`. veyyon
expands every handle back to its full text before anything outside the model's
own history sees it, so tools receive the real string and the display shows the
real string. The short handle is what stays in the conversation, which is where
the token saving comes from.

Turn it on with one setting:

```yaml
argot:
  enabled: true
```

The default is `false`. You do not write or commit any dictionary. When Argot is
on, veyyon builds the shorthand for you: it reads the project's files (the ones
git tracks, or a walk of the tree for a project with no git that carries a
`.argot` marker), proposes handles for the strings that would save the most
tokens, and keeps the result in a local cache under its own config directory.
Nothing is written to the working tree, so there is no file for a pull request
to pick up. The cache regenerates as the project moves (keyed on the git commit),
and it grows monotonically: a handle the model has already been taught keeps its
exact meaning, so text that used a handle always expands. At the start of a
session veyyon teaches the model the handles it generated by listing them in the
system prompt.

### Choose which models write shorthand

Enabling Argot alone does not make any model write handles. You also list the
models allowed to do so:

```yaml
argot:
  enabled: true
  models:
    - anthropic/claude-opus-4
```

A model on this list is taught the notation; a model left off never is. The list
is empty by default, so turning Argot on without naming a model stays inert. This
lets you keep shorthand on for a model you trust to recall the dictionary and off
for one you are still measuring. Expansion never depends on this list: a handle
already written expands whatever model is active, so switching models never
leaves a raw handle behind.

### Stop shorthand in a large context

Recall of the dictionary degrades as a conversation grows. To bound that risk,
stop teaching shorthand once the context passes a token threshold:

```yaml
argot:
  enabled: true
  models:
    - anthropic/claude-opus-4
  disableAboveTokens: 400000
```

Past the threshold the model writes in full instead of risking a garbled handle.
Handles written earlier still expand losslessly, because the cutoff stops only
the teaching, never the expansion. The default is `-1`, which never stops on
size.

The generated cache is per project and local to your machine. To rebuild it from
scratch, delete the project's cache directory under veyyon's config root; the
next session regenerates it.

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

## Set the default working directory

Each profile can pin a default session working directory so launches from `$HOME`
(or any other directory) still root tools at the right project:

| Goal | What to set |
| --- | --- |
| Per-profile default cwd | `session.workdir` (absolute or `~`-relative path) |
| One-shot override for this launch | `--cwd <path>` |

Launch precedence for the session cwd, highest first:

```text
explicit --cwd  >  session.workdir  >  process cwd
```

```yaml
# ~/.veyyon/profiles/work/agent/config.yml
session:
  workdir: ~/src/veyyon
```

```console
$ veyyon config set session.workdir ~/src/veyyon
$ veyyon --cwd /tmp/scratch          # wins over session.workdir for this run
```

`session.workdir` must resolve to an existing directory; a relative path or a
missing directory fails launch rather than falling back silently. Mid-session
overrides via the agent `set_cwd` tool or `/cwd` are session-scoped only: they
re-root the live session and never write `session.workdir`. Persist a new
default with `veyyon config set` or `/settings`.

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
