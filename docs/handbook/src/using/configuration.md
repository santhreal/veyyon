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
$ veyyon config set compaction.strategy summary
$ veyyon config path                     # print the active agent directory
```

`/settings` does the same inside a live session. Keys must match a schema path exactly
(`theme.dark`, not `theme`).

### Session Working Directory (`session.workdir` vs `set_cwd`)

- **Persistent Profile Default (`session.workdir`)**: Configures the default working directory for a profile across all future sessions. Set interactively via `/settings` (Interaction › Profile) or in `~/.veyyon/profiles/<profile>/agent/config.yml`.
- **Ephemeral Session Re-root (`set_cwd` tool / `/set_cwd`)**: Re-roots the active session's working directory temporarily. It never writes `session.workdir`.
- **Prompt Cache Protection**: Working directory changes mid-session update path resolution, but the rendered System Prompt header (`<workstation>`) remains frozen until context compaction. Mutating system prompt headers mid-session prior to compaction invalidates LLM prefix prompt caches, causing 100% cache-miss token inflation.
### When a settings file has a syntax error

If you edit a config file by hand and leave it with invalid YAML, veyyon cannot
read it. It tells you at startup, names the file, and runs the session on
defaults for whatever that file held:

```text
Could not read your settings, so this session is using defaults for them:
  ~/.veyyon/profiles/default/agent/config.yml
    original kept at ~/.veyyon/profiles/default/agent/config.yml.corrupt
```

Your original file is copied to `<name>.corrupt` before anything else touches it,
so nothing is lost.

The most common cause is a value containing a colon. YAML reads that second colon
as the start of a nested mapping, so this line is invalid:

```text
statusLine: time: %H:%M
```

Quoting the value fixes it:

```yaml
statusLine: "time: %H:%M"
```

Fix the syntax in the original file, or copy the preserved file back over it and
edit from there.

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
| Compaction type | `compaction.strategy`: `summary` or `handoff` (schema default `summary`) |
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

The default is `false`. You do not write or commit any dictionary, and veyyon
does not guess which project you mean: the agent decides. When Argot is on and
the model is allowed to write shorthand (see the next section), the system
prompt teaches it the notation and gives it two tools, `argot_load` and
`argot_unload`. Starting work in a project, the agent calls `argot_load` on that
folder. veyyon resolves the folder to its project root (the nearest `.git`, or a
`.argot` marker for a project with no git), reads the project's files (the ones
git tracks, or a walk of the tree for a `.argot` project), proposes handles for
the strings that would save the most tokens, and keeps the result in a local
cache under its own config directory. In a monorepo the agent loads the one
package it works in, not the repo root. Loading reads a project tree and writes
the cache, so in the approval-gated autonomy modes veyyon asks before running
it and shows the resolved root; unloading never needs approval, because it only
teaches less and every handle already written keeps expanding.

Nothing is written to the working tree, so there is no file for a pull request
to pick up. Each cache entry is immutable and named by the content it was built
from (the git commit for a git project, or a signature of the file listing for a
project with a `.argot` marker). A new commit reads a new entry, built from the
new tree; the old entry is never rewritten. Nothing depends on a handle keeping
its name across states, because veyyon expands every handle before it reaches the
saved transcript, so an entry never has to agree with an older one. Once the
agent has loaded a project, veyyon lists its handles in the system prompt, and
the model writes them from then on. A session where the agent never loads
anything simply writes full strings, exactly as if Argot were off.

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

### Size the dictionary

The generated dictionary is packed under a token budget: handles are added in
value order until the next one would breach it, so the budget decides how many
strings earn shorthand. A larger budget teaches more handles, which gives the
model more chances to save tokens in its writing, but it also makes the notation
preamble longer every turn. A smaller budget keeps the preamble cheap and teaches
only the most central strings. Set it with `argot.tokenBudget`:

```yaml
argot:
  enabled: true
  models:
    - anthropic/claude-opus-4
  tokenBudget: 2000
```

The default is `1000`. Changing the budget generates a new dictionary: the cache
key folds in the budget, so an entry built under one budget is never reused for
another, and the old entry is left in place. A value that is not a positive
number is rejected and the default is used, so a bad setting never quietly
produces an empty dictionary.

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

### Choose how subagents start

A subagent (a child veyyon spawns for a task) can start with its own shorthand,
or none. Set that with `argot.subagents`:

```yaml
argot:
  enabled: true
  models:
    - anthropic/claude-opus-4
  subagents: fresh
```

The three values are:

- `off` (the default): a subagent gets no shorthand. It reads full text and
  writes full text.
- `fresh`: a subagent gets its own shorthand session and loads the project of
  its own task through `argot_load`, independent of the parent. Use this when a
  subagent works a different project than its parent, for example a parent in a
  monorepo and a child scoped to one crate.
- `inherit`: a subagent starts from a copy of the parent's loaded shorthand, so it
  writes the parent's handles from its first turn.

This setting only trades tokens; it never changes what the agents agree on. Every
agent expands its own output before it reaches a tool, the saved transcript, a
prompt it hands to a child, or the result it returns to a parent, so a handle
never crosses between a parent and a child in either direction. A subagent that
starts with no shorthand is already correct: it simply writes in full. That is why
`off` is a safe default and the other two are optimizations.

The generated cache is per project and local to your machine. To rebuild it from
scratch, delete the project's cache directory under veyyon's config root; the
next `argot_load` regenerates it.

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
re-root the live session (the cwd, and with it the project settings, plugins,
slash commands, capabilities, ssh tool, and system-prompt project framing) and
never write `session.workdir`. Persist a new default with `veyyon config set` or
`/settings`.

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
