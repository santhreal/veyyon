# Settings

`veyyon` resolves settings from built-in defaults, a persistent global config file, optional project-local config, one-shot CLI overlays, and in-memory runtime overrides. Reach for project settings when one repository needs a different provider set, model role, tool policy, memory backend, or UI behavior than your global defaults, without touching your machine-wide configuration.

Settings are stored as plain YAML mappings. Every key, its type, default, and enum values come from the settings schema, and you can inspect or change any of them with `veyyon config` or the interactive `/settings` panel.

- For model/provider credentials, `.env` files, and the env-var table that resolves API keys, see [Providers](./providers.md).
- For custom model definitions in `models.yml`, see [Models](./models.md).
- For instruction files discovered into the agent context (`AGENTS.md`, `.veyyon/`, etc.), see [Context files](./context-files.md).
- For the full catalog of environment variables, see [Environment variables](./environment-variables.md).

## Where settings live

| Scope | Path | Read behavior | Write behavior |
|---|---|---|---|
| Global | `~/.veyyon/profiles/default/agent/config.yml` | The main persistent settings file for the active profile. Always loaded. | `/settings`, `veyyon config set`, and `veyyon config reset` write here. |
| Global legacy | `~/.veyyon/profiles/default/agent/settings.json` | Migrated into `config.yml` once, only when `config.yml` does not yet exist. | Not written after migration; the original is renamed to `settings.json.bak`. |
| Machine-global (all profiles) | `~/.veyyon/config.yml` | A small set of values shared by every profile: `defaultProfile` (which profile a bare `vey` launches) and `profileSharing` (whether provider credentials are shared across profiles). Read live. | The **Global** tab of `/settings`, or `veyyon profile default` for `defaultProfile`. These keys never land in a profile's own `config.yml`. |
| Project | `<cwd>/.veyyon/config.yml` (plus `.veyyon/settings.json`) | Loaded when the process working directory has a non-empty `.veyyon/`. | Read-only from settings commands; edit the file by hand. |
| Project legacy | `<cwd>/.veyyon/settings.json` | Still read; project `config.yml` is merged on top of it. | Not written by settings commands. |
| CLI overlay | Any file passed with `--config <file>` | Loaded after global and project settings, for that one process. Repeatable. | Never persisted. |
| Runtime overrides | In-memory only | Set by dedicated CLI flags (`--model`, `--approval-mode`, …) and feature env vars. | Never persisted. |

`VEYYON_CODING_AGENT_DIR` relocates the `~/.veyyon/profiles/default/agent` base directory. When it is set, the global `config.yml`, the auth store (`agent.db`), and everything else under the agent directory move with it. Use `veyyon config path` to print the active agent directory.

Native project settings are intentionally scoped to the process working directory's `.veyyon/` folder, settings discovery does **not** walk ancestor directories looking for the nearest `.veyyon/`. Other discovery providers (Claude, Codex, Gemini, Cursor, OpenCode) can also contribute project-level settings from their own files; those are read-only from `veyyon` settings commands and can be turned off by provider id (see [Provider and source disabling](#provider-and-source-disabling)).

## Config file formats

The global `config.yml` is always YAML. The generic config loader used for other files (for example `models.yml`) accepts `.yml`, `.yaml`, `.json`, and `.jsonc`:

- When a `.yml`/`.yaml` path is requested and only a sibling `.json` exists, it is migrated to YAML automatically (idempotent, once per process).
- `.json` and `.jsonc` configs are read as-is, with no migration.
- A file whose top level is not a mapping (a bare array or scalar) is treated as empty for persistent settings, and is a hard error for `--config` overlays.

## Reading and writing settings

Use the interactive `/settings` panel inside a session, or the `veyyon config` command from a shell. Both operate on the merged effective settings, and every persistent write lands in the **global** profile file, with one exception: the machine-global values on the **Global** tab (`defaultProfile`, `profileSharing`) write to `~/.veyyon/config.yml` so they apply to every profile.

```bash
veyyon config list                 # all settings with current effective values
veyyon config list --json          # same, machine-readable
veyyon config get theme.dark       # one value
veyyon config get theme.dark --json
veyyon config set compaction.enabled false
veyyon config set defaultThinkingLevel medium
veyyon config reset steeringMode   # restore a key to its schema default
veyyon config path                 # print the active agent directory
```

For users who want the full first-run animation on normal launches, set `startup.showSplash`:

```bash
veyyon config set startup.showSplash true
```

This only controls the startup splash animation. It does not rerun setup or change setup state, and `startup.quiet: true` still suppresses all startup chrome including the splash.

### Subcommands

| Command | Effect |
|---|---|
| `veyyon config list` | Print every setting grouped by tab, with its current value and type. `--json` emits an object keyed by setting path with `{ value, type, description }`. |
| `veyyon config get <key>` | Print the effective value of one key. Unknown keys exit non-zero. `--json` emits `{ key, value, type, description }`. |
| `veyyon config set <key> <value>` | Parse `<value>` against the key's schema type and write it to the global `config.yml`. |
| `veyyon config reset <key>` | Write the key's schema **default** back to the global config (this persists the default, it does not delete the key). |
| `veyyon config path` | Print the active agent directory (honors `VEYYON_CODING_AGENT_DIR`). |

`veyyon config` with no subcommand, or `--help`, prints the help and lists settings. The `--json` flag is accepted by `list`, `get`, `set`, and `reset`.

### Value parsing

`veyyon config set` parses the value string according to the target key's schema type. The string is trimmed first.

| Type | Accepted input | Notes |
|---|---|---|
| boolean | `true`, `false`, `yes`, `no`, `on`, `off`, `1`, `0` | Case-insensitive. Anything else is rejected. |
| number | Any finite JavaScript number | `Infinity`/`NaN` are rejected. |
| enum | One of the key's allowed values | Must match exactly; the error lists the valid values. |
| array | A JSON array | e.g. `'["anthropic","openai"]'`. Must parse and be an array. |
| record | A JSON object | e.g. `'{"bash":"prompt"}'`. Must parse and be a non-array object. |
| string | Stored as given (trimmed) | Multi-word values are joined with spaces. |

Keys must match a real schema path exactly. There is no shorthand, set `theme.dark`, not `theme`.

### Where writes go

`veyyon config set`, `veyyon config reset`, `/settings`, and any runtime settings change all write to the global `config.yml` under the active agent directory. They never write to `<cwd>/.veyyon/config.yml`. To create a project-local override, edit that file directly (see [Project-local config](#project-local-config)). Saves are debounced and re-read the file under a lock, so external edits made while a session is open are preserved. The machine-global keys on the **Global** tab (`defaultProfile`, `profileSharing`) are the exception: they write to `~/.veyyon/config.yml` instead of the active agent directory, and are read live so an external edit to that file is reflected without a restart.

## Precedence

From lowest to highest priority, the effective value of a setting is built as:

```text
built-in defaults  <-  global config  <-  project config  <-  CLI overlays  <-  runtime overrides
```

From highest to lowest:

1. **Runtime overrides**: dedicated CLI flags and feature env vars applied in memory for the current process: `--model`, `--smol`, `--slow`, `--plan`, `--approval-mode`, `--auto-approve`/`--yolo`, `--hide-thinking`, `--advisor`, `--no-pty`, `--api-key`, and protocol-mode defaults. Never persisted.
2. **CLI config overlays**: each `--config <file>`; later overlay files override earlier ones.
3. **Project settings**: `<cwd>/.veyyon/settings.json` then `<cwd>/.veyyon/config.yml` (and contributions from other discovery providers at project level).
4. **Global settings**: `~/.veyyon/profiles/default/agent/config.yml`.
5. **Built-in defaults**: from the settings schema.

A key that is unset at every layer resolves to its schema default at read time.

### Environment overrides

Environment variables are **not** a single settings layer. Each is read by the feature that owns the value, usually as a per-machine override or fallback, and is never written back to `config.yml`. The ones that map directly onto a setting:

| Env var | Overrides setting | Notes |
|---|---|---|
| `VEYYON_SMOL_MODEL` | `modelRoles.smol` | Also exposed as `--smol`. |
| `VEYYON_SLOW_MODEL` | `modelRoles.slow` | Also exposed as `--slow`. |
| `VEYYON_PLAN_MODEL` | `modelRoles.plan` | Also exposed as `--plan`. |
| `VEYYON_NO_PTY=1` | (disables PTY bash) | Equivalent to `--no-pty` for the process. |
| `VEYYON_PY` | `eval.py` | `VEYYON_PY=0` disables the Python eval backend. |
| `VEYYON_JS` | `eval.js` | `VEYYON_JS=0` disables the JavaScript eval backend. |
| `VEYYON_TINY_DEVICE` | `providers.tinyModelDevice` | ONNX execution provider for local tiny models. |
| `VEYYON_TINY_DTYPE` | `providers.tinyModelDtype` | ONNX precision for local tiny models. |
| `VEYYON_AUTH_BROKER_URL` | `auth.broker.url` | Env value takes precedence over config. |
| `VEYYON_AUTH_BROKER_TOKEN` | `auth.broker.token` | Env value takes precedence over config. |
| `VEYYON_CODING_AGENT_DIR` | (relocates agent dir) | Moves `config.yml`, `agent.db`, and the whole agent base. |

Provider API keys are resolved separately (stored auth, OAuth, `models.yml`, environment, and `.env` files); see [Providers](./providers.md) and the full [Environment variables](./environment-variables.md) reference.

## Merge rules

Layers are combined with a deep merge:

- **Objects are deep-merged**: keys present only in a lower layer are kept; keys present in a higher layer override.
- **Scalars and arrays are replaced wholesale** by the higher-precedence layer. A higher layer's array does not append to a lower layer's array.

Use nested YAML mappings for dotted setting paths:

```yaml
theme:
  dark: titanium
  light: light

tools:
  approvalMode: auto-edit
  approval:
    bash: prompt
    read: allow
```

### Worked example: global vs. project

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
tools:
  approvalMode: auto-edit
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - gemini

# <repo>/.veyyon/config.yml
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

Effective settings inside `<repo>`:

```yaml
tools:
  approvalMode: auto-edit   # kept from global (object deep-merge)
  approval:
    bash: allow         # overridden by project
    read: allow         # kept from global
disabledProviders:
  - groq                # project array REPLACES the global array
```

Array replacement is the most common surprise: the project's `disabledProviders` does not extend the global list, it becomes the entire list for that project. The same applies to `enabledModels`, `cycleOrder`, `extensions`, and every other array-typed setting.

## Project-local config

Create `<repo>/.veyyon/config.yml` when a repository needs its own settings:

```yaml
# <repo>/.veyyon/config.yml
modelRoles:
  default: anthropic/claude-sonnet-4-5
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high

tools:
  approvalMode: auto-edit
  approval:
    bash: prompt

compaction:
  strategy: snap
  thresholdTokens: 150000     # compact past 150k tokens, on any model

theme:
  dark: titanium
```

Keep secrets out of committed project config unless your repository policy allows it. Prefer environment variables, stored auth, an auth broker, or an untracked `--config` overlay for credentials.

### One-shot overlays

Use `--config` for a temporary layer that should not persist:

```bash
veyyon --config ./local/ci-settings.yml "check this failure"
veyyon --config ./base.yml --config ./experiment.yml "try this model"
```

Overlay paths are resolved relative to the process working directory (and `~` is expanded). Each overlay must parse as a YAML mapping; a missing file, invalid YAML, or a top-level array/scalar is a hard error, it does **not** silently fall back to lower-precedence settings.

## Path-scoped arrays

Two array settings, `enabledModels` and `disabledProviders`, accept path-scoped entries in addition to bare strings, so a single global config can behave differently per directory:

```yaml
enabledModels:
  - claude-sonnet-4-5            # applies everywhere
  - path: ~/work/high-context
    models:
      - anthropic/claude-opus-4-5

disabledProviders:
  - ollama                       # applies everywhere
  - paths:
      - ~/projects/sensitive
      - ~/clients/acme
    providers:
      - anthropic
      - openai
```

Bare string entries apply everywhere. A scoped entry applies when the current working directory **is** the configured path or is **under** it. `~` expands to your home directory and relative paths are resolved before matching.

Accepted **path** keys (any of them, combined): `path`, `paths`, `pathPrefix`, `pathPrefixes`.

Accepted **value** keys:

- `models` (for `enabledModels`) or `providers` (for `disabledProviders`)
- `values` or `items` (for either setting)

Only string values are kept; malformed scoped entries are ignored. Path scoping is resolved **after** the layer merge, so it reads the final effective array.

## Provider and source disabling

`disabledProviders` is a single shared id namespace that gates two different subsystems, before any credential check:

| Entry kind | Example ids | Effect |
|---|---|---|
| Model providers | `anthropic`, `openai`, `gemini`, `groq`, `ollama`, `openrouter` | Removes those backends from model selection, even when credentials are available. See [Providers](./providers.md). |
| Discovery sources | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents-md` | Stops that source from contributing context files, MCP servers, commands, skills, hooks, tools, prompts, or settings. See [Context files](./context-files.md). |

Most provider-control use cases list model provider ids. Disabling the `claude` discovery source is different from disabling the `anthropic` model provider, one stops Claude-format config discovery, the other stops the Anthropic model backend.

Because arrays replace rather than append, a project that sets `disabledProviders` must list the complete desired set:

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# <repo>/.veyyon/config.yml: inside this repo ONLY groq is disabled
disabledProviders:
  - groq
```

The default is an empty array (nothing disabled). For the two subsystems' provider ids and ordering, see [Providers](./providers.md) and [Context files](./context-files.md).

## Settings catalog

Every key below is defined in the settings schema; `veyyon config list` shows the full set with current values. Defaults and enum values are taken from the schema. Settings that accept an env or flag override are noted; those overrides are process-local and not persisted.

### Models

`modelRoles`, `modelTags`, and `cycleOrder` work together. Role values may carry a thinking suffix (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). The same suffix works on `subagent.model` and `compaction.model`, so any model slot can run at a chosen effort.

In the settings model pickers (`/settings`, or `/model` for the interactive model), picking a model that supports thinking efforts opens a second step where you choose the effort. The choice is stored as the `:level` suffix on that slot's selector and persists with the active profile. A model with no thinking efforts skips the step and stores the bare selector. Choosing the first row, `(model default thinking)`, stores no suffix and lets the model use its own default. The settings rows show a stored effort as a readable ` · high` rather than the raw `:high` token. To change the effort of the model you are talking to, use the `/thinking` command (its alias is `/effort`), or cycle it with Shift+Tab and toggle it with Ctrl+T.

The **interactive** model (main conversation) is persisted as **`modelRoles.default`**. That key is a legacy storage name: it is hidden from role pickers and stripped from `cycleOrder` on load. Selectable built-in roles: `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`.

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5   # interactive model (persisted default)
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: gemini/gemini-3-pro-preview
  plan: anthropic/claude-opus-4-5
  task: deepseek/deepseek-chat
  advisor: anthropic/claude-sonnet-4-5:medium

cycleOrder:
  - smol
  - slow

subagent:
  model: deepseek/deepseek-chat:high     # optional; overrides modelRoles.task when set; :effort optional

compaction:
  model: openai/gpt-5-mini               # optional; else inherits interactive; may carry :effort

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `modelRoles` | record | `{}` | Role name → model id. Interactive model uses key `default` (hidden in UI). Selectable built-ins: `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `task`, `advisor`. `tiny` is used for lightweight background tasks when set, else `@smol`. Launch: `--model` (interactive), `--smol`, `--slow`, `--plan`; advisor via `modelRoles.advisor` + `advisor.enabled` / `--advisor`. |
| `modelTags` | record | `{}` | Custom role/tag metadata; can introduce additional roles. |
| `modelProviderOrder` | array | `[]` | Preferred provider order when a model id is ambiguous. |
| `cycleOrder` | array | `["smol","slow"]` | Roles cycled by the model switcher (`app.model.cycleForward`, often Ctrl+P). The entry `default` is dropped on load. |
| `subagent.model` | string | unset | Task subagent model; unset inherits interactive; when set overrides `modelRoles.task`. May carry a `:effort` suffix (an explicit suffix wins over the agent's own default). |
| `compaction.model` | string | unset | Compaction model; unset inherits interactive. May carry a `:effort` suffix, applied on every compaction pass. |
| `enabledModels` | array | `[]` | Allow-list of models; supports [path-scoped entries](#path-scoped-arrays). Empty means all available models. |
| `disabledProviders` | array | `[]` | Disabled model/discovery providers; supports path-scoped entries. See [above](#provider-and-source-disabling). |
| `includeModelInPrompt` | boolean | `true` | Include the active model name in the system prompt. |

See [Models](./models.md) for the `models.yml` schema and custom-provider definitions. Handbook: [Models, roles, and profiles](./handbook/src/using/roles-and-profiles.md) (under `docs/handbook/src/using/`).

### Advisor

The advisor is a second model that reviews each completed turn and can inject advice into the primary session. Assign a model with `modelRoles.advisor`, then enable it with `advisor.enabled`, `/advisor on`, or by launching with the `--advisor` flag.

See [Advisor and WATCHDOG.md](./advisor-watchdog.md) for runtime behavior, `WATCHDOG.md` discovery, and bounded catch-up semantics.

| Key | Type | Default | Notes |
|---|---|---|---|
| `advisor.enabled` | boolean | `false` | Enable the advisor runtime when `modelRoles.advisor` resolves to an available model. |
| `advisor.subagents` | boolean | `false` | Also enable advisor runtimes for spawned task/eval subagents. |
| `advisor.syncBacklog` | enum | `off` | Bounded advisor catch-up delay: `off`, `1`, `3`, or `5`. The primary waits up to 30 seconds only while advisor backlog is at or above the threshold. |
| `advisor.immuneTurns` | number | `3` | After a `concern`/`blocker` interrupts, route further concerns/blockers as non-interrupting asides for this many completed primary turns. |

### Thinking

```yaml
defaultThinkingLevel: high
hideThinkingBlock: false
thinkingBudgets:
  minimal: 1024
  low: 2048
  medium: 8192
  high: 16384
  xhigh: 32768
  max: 32768
```

| Key | Type | Default | Values |
|---|---|---|---|
| `defaultThinkingLevel` | enum | `high` | `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`. Override per run with `--thinking`. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output. `--hide-thinking` sets it for the run (display only). |
| `thinkingBudgets.minimal` | number | `1024` | Token budget for the `minimal` level. |
| `thinkingBudgets.low` | number | `2048` | Token budget for `low`. |
| `thinkingBudgets.medium` | number | `8192` | Token budget for `medium`. |
| `thinkingBudgets.high` | number | `16384` | Token budget for `high`. |
| `thinkingBudgets.xhigh` | number | `32768` | Token budget for `xhigh`. |
| `thinkingBudgets.max` | number | `32768` | Token budget for `max`. |

### Sampling

A value of `-1` means "use the provider/model default", `veyyon` does not send that parameter.

| Key | Type | Default | Notes |
|---|---|---|---|
| `temperature` | number | `-1` | Sampling temperature. |
| `topP` | number | `-1` | Nucleus sampling. |
| `topK` | number | `-1` | Top-K sampling. |
| `minP` | number | `-1` | Minimum-probability cutoff. |
| `presencePenalty` | number | `-1` | Presence penalty. |
| `repetitionPenalty` | number | `-1` | Repetition penalty. |
| `tier.openai` | enum | `none` | `none`, `auto`, `default`, `flex`, `scale`, `priority`. Sent as `service_tier` for OpenAI / OpenAI-Codex and OpenAI-family OpenRouter models. |
| `tier.anthropic` | enum | `none` | `none`, `priority`. `priority` realizes fast mode on supported direct Claude models (ignored on Bedrock/Vertex and via OpenRouter). |
| `tier.google` | enum | `none` | `none`, `flex`, `priority`. Gemini API sends it in the body; Vertex sends `priority` via header (`flex` is a no-op on Vertex). |
| `tier.subagent` | enum | `inherit` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the spawned model's family; `inherit` tracks the main agent. |
| `tier.advisor` | enum | `none` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the advisor model's family. |
| `personality` | enum | `default` | `default`, `friendly`, `pragmatic`, `none`. |

### Retry and fallback

```yaml
retry:
  enabled: true
  maxRetries: 10
  baseDelayMs: 500
  maxDelayMs: 300000
  modelFallback: true
  fallbackRevertPolicy: cooldown-expiry
  fallbackChains:
    # Any role without an explicit chain inherits the "default" chain.
    default:
      - anthropic/claude-opus-4-5
      - openai/gpt-5.5
      - google/gemini-3-pro
    # Per-role chains override the default (roles from `modelRoles`,
    # including custom roles). Selectors accept an optional thinking
    # suffix, e.g. openai/gpt-5.5:low.
    smol:
      - openai/gpt-5.5-mini
      - anthropic/claude-haiku-4-5
    # Model-selector keys (any key containing "/") attach the chain to the
    # model itself: it applies whenever that model is active, no matter
    # which role it is assigned to, and survives role reassignment.
    google/gemini-3-pro:
      - google-vertex/gemini-3-pro
    # A `provider/*` KEY covers every model of a provider: current or
    # future. A `provider/*` ENTRY keeps the failing model's id and swaps
    # the provider: google-antigravity/x -> google/x -> google-vertex/x.
    # Ids missing on the target provider are skipped (near-miss ids resolve
    # fuzzily); exact model keys override the wildcard for a specific model.
    google-antigravity/*:
      - google/*
      - google-vertex/*
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `retry.enabled` | boolean | `true` | Retry transient provider errors. |
| `retry.maxRetries` | number | `10` | Max retries per request. |
| `retry.baseDelayMs` | number | `500` | Initial backoff. |
| `retry.maxDelayMs` | number | `300000` | Backoff ceiling (5 min). |
| `retry.modelFallback` | boolean | `true` | Fall back to another model when one is unavailable. |
| `retry.fallbackChains` | record | `{}` | Maps roles, model selectors, or `provider/*` wildcards to ordered fallback selectors. Keys containing `/` are model-oriented and win over roles: `provider/model-id` matches that exact model, `provider/*` matches every model of the provider. A `provider/*` *entry* keeps the failing model's id and swaps the provider. The `default` chain covers every assigned role without its own chain. Unknown models/providers or malformed chains are reported as config warnings at startup. |
| `retry.fallbackRevertPolicy` | enum | `cooldown-expiry` | `cooldown-expiry` returns to the primary model once its suppression window ends; `never` stays on the fallback until switched manually. |

When the active model keeps failing (429s, quota walls, provider outages) and `retry.modelFallback` is on, the session picks the chain that owns the failing model, by specificity: an exact `provider/model-id` key, then a `provider/*` wildcard, then the current role's chain, then `default`. It skips models whose selectors are still cooling down and switches for the rest of the turn. Subagents get their own per-spawn chains when their agent definition lists multiple model patterns, the first resolvable pattern is primary and the rest become its fallbacks; there is no `agent:<name>` key in `fallbackChains`.

### Tools and approvals

```yaml
tools:
  approvalMode: yolo          # default
  approval:
    bash: prompt
    edit: allow
  discoveryMode: auto
  maxTimeout: 0
  intentTracing: true
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `tools.approvalMode` | enum | `yolo` | Canonical: `plan` (read auto; write/exec ask; plan-mode semantics), `ask` (read auto; write/exec ask), `auto-edit` (read+write auto; exec ask), `yolo` (all tiers auto). Legacy aliases still accepted: `always-ask` → `ask`, `write` → `auto-edit`. Override per run with `--approval-mode` / `--auto-approve` / `--yolo`. |
| `tools.approval` | record | `{}` | Per-tool policy keyed by tool name; each value is `allow`, `deny`, or `prompt`. e.g. `veyyon config set tools.approval '{"bash":"prompt"}'`. |
| `tools.discoveryMode` | enum | `auto` | `auto`, `off`, `mcp-only`, `all`. Controls dynamic tool discovery. |
| `tools.essentialOverride` | array | `[]` | Tool names kept available even when tools are narrowed. |
| `tools.maxTimeout` | number | `0` | Max tool runtime in seconds; `0` = no cap. |
| `tools.intentTracing` | boolean | `true` | Record per-call intent strings. |
| `tools.outputMaxColumns` | number | `768` | Per-line byte cap for streaming output; `0` disables. |
| `tools.artifactSpillThreshold` | number | `50` | KB of tool output above which output spills to an artifact. |
| `tools.artifactHeadBytes` | number | `20` | KB of head kept inline on spill; `0` = tail-only. |
| `tools.artifactTailBytes` | number | `20` | KB of tail kept inline on spill. |
| `tools.artifactTailLines` | number | `500` | Max tail lines kept inline on spill. |

Individual built-in tools are toggled by their own keys, e.g. `bash.enabled`, `launch.enabled`, `eval.py`, `eval.js`, `glob.enabled`, `grep.enabled`, `fetch.enabled`, `browser.enabled`, `astEdit.enabled`, `astGrep.enabled`, `web_search.enabled`, `inspect_image.enabled`.

### Shell, eval, and LSP

```yaml
bash:
  enabled: true
  autoBackground:
    enabled: false
    thresholdMs: 60000
  stallDetection:
    enabled: false
    stallMs: 30000

eval:
  py: true
  js: true

python:
  kernelMode: session       # session, per-call
  interpreter: ""

lsp:
  enabled: true
  lazy: true
  diagnosticsOnWrite: true
  diagnosticsOnEdit: false
  formatOnWrite: false
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `bash.enabled` | boolean | `true` | Enable the bash tool. |
| `launch.enabled` | boolean | `true` | Enable the launch tool for shared long-running project processes. |
| `bash.autoBackground.enabled` | boolean | `false` | Auto-background long-running commands. |
| `bash.autoBackground.thresholdMs` | number | `60000` | Max wall-clock time a bash call runs in the foreground before it is moved to a background job. Frees the model and protects the prompt cache. Fires on elapsed time even while output streams. `0` backgrounds immediately. |
| `bash.stallDetection.enabled` | boolean | `false` | Watch for a bash call that stops producing output; background it and tell the model it may be stuck so it can cancel a truly hung command. Recommends, never force-kills. |
| `bash.stallDetection.stallMs` | number | `30000` | Idle time (no new output) before a bash call is treated as possibly stuck. Measures quiet output, not total run time. |
| `eval.py` | boolean | `true` | Python eval backend. `VEYYON_PY=0` disables for the process. |
| `eval.js` | boolean | `true` | JavaScript eval backend. `VEYYON_JS=0` disables for the process. |
| `python.kernelMode` | enum | `session` | `session` (persistent kernel) or `per-call`. |
| `python.interpreter` | string | `""` | Path to a Python interpreter; empty = auto-detect. |
| `lsp.enabled` | boolean | `true` | Language-server integration. `--no-lsp` disables for the run. |
| `lsp.lazy` | boolean | `true` | Start servers on demand. |
| `lsp.diagnosticsOnWrite` | boolean | `true` | Run diagnostics after a write. |
| `lsp.diagnosticsOnEdit` | boolean | `false` | Run diagnostics after an edit. |
| `lsp.formatOnWrite` | boolean | `false` | Format files on write. |
| `lsp.diagnosticsDeduplicate` | boolean | `true` | Collapse duplicate diagnostics. |
| `shellPath` | string | _(unset)_ | Override the shell binary used by bash. |

### Files: editing and reading

```yaml
edit:
  mode: hashline            # apply_patch, hashline, patch, replace
  fuzzyMatch: true
  fuzzyThreshold: 0.95
  blockAutoGenerated: true

read:
  defaultLimit: 300
  toolResultPreview: false
  summarize:
    enabled: true
    prose: false
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `edit.mode` | enum | `hashline` | `apply_patch`, `hashline`, `patch`, `replace`. |
| `edit.fuzzyMatch` | boolean | `true` | Allow fuzzy anchor matching. |
| `edit.fuzzyThreshold` | number | `0.95` | Similarity threshold for fuzzy matching. |
| `edit.blockAutoGenerated` | boolean | `true` | Refuse to edit generated/lockfile-like files. |
| `edit.streamingAbort` | boolean | `false` | Abort on streaming edit mismatch. |
| `read.defaultLimit` | number | `300` | Default line count for `read` without a selector. |
| `read.summarize.enabled` | boolean | `true` | Structural summaries for code reads. |
| `read.summarize.prose` | boolean | `false` | Summarize prose files too. |
| `read.toolResultPreview` | boolean | `false` | Inline preview of tool results. |
| `readLineNumbers` | boolean | `false` | Show plain line numbers. |

### Context, compaction, and memory

```yaml
contextPromotion:
  enabled: false

compaction:
  enabled: true
  strategy: snap              # handoff | snap (schema default)
  midTurnEnabled: true        # check thresholds between tool-loop provider requests
  thresholdTokens: -1         # absolute token trigger, model-independent (-1 = use the percent below)
  thresholdPercent: -1        # legacy percent-of-window trigger (-1 = provider/reserve default)
  remoteEnabled: true

memory:
  backend: off                # off, local, hindsight, mnemopi
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `contextPromotion.enabled` | boolean | `false` | Promote to a larger-context model on overflow instead of compacting. |
| `compaction.enabled` | boolean | `true` | Automatic conversation compaction. |
| `compaction.midTurnEnabled` | boolean | `true` | Check thresholds at safe mid-turn tool-loop boundaries before the next provider request. |
| `compaction.strategy` | enum | `snap` | `handoff` (LLM handoff summary / new session transfer) or `snap` (snapcompact dense image archive; no LLM call for the archive path). |
| `compaction.model` | string | unset | Model for handoff/LLM compaction; unset inherits interactive (`modelRoles.default`). |
| `compaction.thresholdTokens` | number | `-1` | Absolute token trigger, model-independent: compact when context exceeds this many tokens. The primary knob (`/settings` -> Compaction Threshold). Wins over `thresholdPercent` when `> 0`. If it exceeds the current model's window it is honored up to `contextWindow - 1` and you get a one-time warning. `-1` = use the percent below. |
| `compaction.thresholdPercent` | number | `-1` | Legacy percent-of-window trigger; ignored when `thresholdTokens > 0`. `-1` = reserve/provider default. |
| `compaction.remoteEnabled` | boolean | `true` | Allow remote compaction service. |
| `memory.backend` | enum | `off` | `off`, `local`, `hindsight`, `mnemopi`. Each backend has its own `hindsight.*` / `mnemopi.*` / `memories.*` tuning keys. |
| `autolearn.enabled` | boolean | `false` | Experimental: after the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills under `~/.veyyon/profiles/default/agent/managed-skills`. Enables the `manage_skill` tool (and `learn` when a memory backend is active). |
| `autolearn.autoContinue` | boolean | `false` | When `autolearn.enabled`, auto-run one capture turn at stop (uses extra tokens). Off = a passive reminder rides your next turn. |
| `autolearn.minToolCalls` | number | `5` | Only nudge after a turn that used at least this many tools. |

`compaction` has additional tuning keys (idle compaction, supersede/drop heuristics) visible in `veyyon config list`. See [Compaction](./compaction.md) for the full strategy reference.

### Appearance and terminal

```yaml
theme:
  dark: titanium
  light: light
symbolPreset: unicode        # unicode, nerd, ascii
colorBlindMode: false

statusLine:
  preset: default            # default, minimal, compact, full, nerd, ascii, custom
  separator: powerline-thin
  transparent: false
  showHookStatus: true

terminal:
  showImages: true
images:
  autoResize: true
  blockImages: false
tui:
  hyperlinks: auto           # off, auto, always
```

| Key | Type | Default | Values |
|---|---|---|---|
| `theme.dark` | string | `titanium` | Theme used on a dark terminal background. |
| `theme.light` | string | `light` | Theme used on a light terminal background. |
| `symbolPreset` | enum | `unicode` | `unicode`, `nerd`, `ascii`. |
| `colorBlindMode` | boolean | `false` | Use blue instead of green for diff additions. |
| `showHardwareCursor` | boolean | `true` | Show the terminal hardware cursor. |
| `statusLine.preset` | enum | `default` | `default`, `minimal`, `compact`, `full`, `nerd`, `ascii`, `custom`. |
| `statusLine.separator` | enum | `powerline-thin` | `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`. |
| `statusLine.sessionAccent` | boolean | `true` | Tint the editor border with the session color. |
| `statusLine.transparent` | boolean | `false` | Use the terminal background for the status line. |
| `statusLine.showHookStatus` | boolean | `true` | Show hook status messages. |
| `terminal.showImages` | boolean | `true` | Render images inline (when the terminal supports it). |
| `images.autoResize` | boolean | `true` | Resize large images for model compatibility. |
| `images.blockImages` | boolean | `false` | Never send images to providers. |
| `tui.hyperlinks` | enum | `auto` | `off`, `auto`, `always`. |

For a custom status line, set `statusLine.preset: custom` and configure `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions`.

### Interaction

| Key | Type | Default | Values |
|---|---|---|---|
| `steeringMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`. How queued steering messages are delivered. |
| `followUpMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`. |
| `interruptMode` | enum | `immediate` | `immediate`, `wait`. |
| `doubleEscapeAction` | enum | `tree` | `branch`, `tree`, `none`. |
| `autoResume` | boolean | `false` | Auto-resume the most recent session in the cwd. |
| `ask.timeout` | number | `0` | Seconds before an `ask` prompt times out; `0` = no timeout. (Legacy ms values are migrated to seconds.) |
| `ask.notify` | enum | `on` | `on`, `off`. |

### Providers and services

```yaml
providers:
  webSearch: auto
  image: auto
  fetch: auto
  webSearchGeminiModel: gemini-2.5-flash
  tinyModel: online
  tinyModelDevice: default
  tinyModelDtype: default
  openaiWebsockets: auto
  openrouterVariant: default
  kimiApiFormat: anthropic

provider:
  appendOnlyContext: auto    # auto, on, off

exa:
  enabled: true
  enableSearch: true
  enableResearcher: false
  enableWebsets: false

searxng:
  endpoint: https://search.example.com
  token: SEARXNG_TOKEN
```

| Key | Type | Default | Values / notes |
|---|---|---|---|
| `providers.webSearch` | enum | `auto` | `auto` plus the configured search providers (`perplexity`, `gemini`, `anthropic`, `codex`, `zai`, `exa`, `jina`, `kagi`, `tavily`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`). |
| `providers.webSearchGeminiModel` | string | _(unset)_ | Gemini model ID for Google Search grounding when `web_search` uses Gemini; defaults to `gemini-2.5-flash`, overridden by `GEMINI_SEARCH_MODEL`. |
| `providers.image` | enum | `auto` | `auto`, `openai`, `antigravity`, `xai`, `gemini`, `openrouter`. |
| `providers.fetch` | enum | `auto` | `auto`, `native`, `trafilatura`, `lynx`, `parallel`, `jina`. |
| `providers.tinyModel` | enum | `online` | `online` or a local model (`lfm2-350m`, `qwen3-0.6b`, `gemma-270m`, `qwen2.5-0.5b`, `lfm2-700m`). |
| `providers.tinyModelDevice` | enum | `default` | ONNX execution provider for local tiny models. Overridden by `VEYYON_TINY_DEVICE`. |
| `providers.tinyModelDtype` | enum | `default` | ONNX precision for local tiny models. Overridden by `VEYYON_TINY_DTYPE`. |
| `providers.openaiWebsockets` | enum | `auto` | `auto`, `off`, `on`. |
| `providers.openrouterVariant` | enum | `default` | `default`, `nitro`, `floor`, `online`, `exacto`. |
| `providers.kimiApiFormat` | enum | `anthropic` | `openai`, `anthropic`. |
| `provider.appendOnlyContext` | enum | `auto` | `auto`, `on`, `off`. |
| `exa.enabled` | boolean | `true` | Enable Exa integration. |
| `exa.enableSearch` | boolean | `true` | Exa search. |
| `exa.enableResearcher` | boolean | `false` | Exa researcher. |
| `exa.enableWebsets` | boolean | `false` | Exa websets. |
| `searxng.endpoint` | string | _(unset)_ | SearXNG instance URL. |
| `searxng.token` | string | _(unset)_ | SearXNG token; also `searxng.basicUsername`/`searxng.basicPassword`/`searxng.categories`/`searxng.language`. |
| `auth.broker.url` | string | _(unset)_ | Auth-broker URL. Overridden by `VEYYON_AUTH_BROKER_URL`. |
| `auth.broker.token` | string | _(unset)_ | Auth-broker token. Overridden by `VEYYON_AUTH_BROKER_TOKEN`. |

Provider credentials and custom model definitions are configured separately, see [Providers](./providers.md) and [Models](./models.md).

### Global (all profiles)

These keys live in the machine-wide `~/.veyyon/config.yml`, not a profile's own config, and are edited on the **Global** tab of `/settings`. They are read live, so an external edit to that file takes effect without a restart.

| Key | Type | Default | Values / notes |
|---|---|---|---|
| `defaultProfile` | string | `default` | Which profile a bare `vey` launches when `--profile` and `VEYYON_PROFILE` are unset. Also settable with `veyyon profile default [name]`; setting it back to `default` clears the override. |
| `profileSharing` | boolean | `true` | When `true`, every profile reads one machine-wide provider credential store (`~/.veyyon/shared-auth/agent.db`). Set `false` to give each profile its own private credentials. See [Providers](./providers.md). |

### Other groups

`veyyon config list` exposes many more grouped settings, including: `task.*` (subagent concurrency, isolation, model overrides), `skills.*` and `commands.*` (discovery toggles), `mcp.*`, `github.*`, `async.*`, `goal.*`, `loop.*`, `todo.*`, `magicKeywords.*`, `ttsr.*` (time-traveling stream rules), `display.*`, `startup.*`, `share.*`, `collab.*`, `stt.*`/`tts.*`, `memories.*`/`hindsight.*`/`mnemopi.*` (memory backends), and `bashInterceptor.*`. Each follows the same type/default rules shown above.

## Legacy migration

`veyyon` migrates older config shapes automatically. None of these require action; they are listed so you know what changes you may see in `config.yml`.

### Startup migration to `config.yml`

When `~/.veyyon/profiles/default/agent/config.yml` does not exist, startup builds it once from legacy sources, then writes the result:

1. `~/.veyyon/profiles/default/agent/settings.json` (renamed to `settings.json.bak` after a successful migration).
2. Settings persisted in `agent.db`.

After `config.yml` exists, these legacy sources are no longer consulted. The generic config loader also performs `.json` -> `.yml` migration for other config files when only the `.json` form is present.

### Field-level migrations

Applied whenever raw settings are loaded (global, project, overlays, and runtime overrides):

| Old | New |
|---|---|
| `queueMode` | `steeringMode` |
| `ask.timeout` in milliseconds (value `> 1000`) | seconds (divided by 1000) |
| flat `theme: "<name>"` string | `theme.dark` / `theme.light` (slot chosen by luminance; built-in `light`/`dark` are dropped to use defaults) |
| `task.isolation.enabled: true/false` | `task.isolation.mode: auto/none` |
| `task.simple` | removed |
| legacy `task.isolation.mode` (`worktree`, `fuse-overlay`, `fuse-projfs`) | `rcopy`, `overlayfs`, `projfs` |
| `lastChangelogVersion` | moved to a marker file and stripped from `config.yml` |

## Troubleshooting

### A project setting is not taking effect

- Start `veyyon` from the directory that contains `.veyyon/config.yml`. Settings discovery only checks the current working directory's `.veyyon/`, not ancestor directories.
- Ensure `.veyyon/` is non-empty; empty config directories are ignored.
- Confirm the file is valid YAML and its top level is a mapping.
- Run `veyyon config get <key>` from that directory to see the effective value.
- Remember that `--config` overlays and runtime flags override project config.

### A global array disappeared in a project

Arrays replace; they do not append. If a project sets `disabledProviders`, `enabledModels`, `cycleOrder`, `extensions`, or any other array, include the **complete** desired value in the project layer, the global array is fully replaced.

### A provider is still available after editing config

- Check whether you disabled the model provider id (e.g. `anthropic`) or a discovery source id (e.g. `claude`): they are different namespaces with different effects.
- Check for a project (or overlay) `disabledProviders` array replacing your global one.
- Credentials can still come from environment variables, `.env`, OAuth, stored auth, or `models.yml`; disabling a provider blocks selection regardless, but verify you edited the right layer. See [Providers](./providers.md).
- Restart the session if the model list was already initialized.

### `veyyon config set` changed the wrong file

`veyyon config set` and `veyyon config reset` always write the global `config.yml` under the active agent directory. Run `veyyon config path` to print it. For project-local settings, edit `<repo>/.veyyon/config.yml` directly.

### `veyyon config reset` did not remove my key

`reset` writes the schema **default** value into the global config, it persists the default rather than deleting the key. To stop overriding a project value from global config, delete the key from `~/.veyyon/profiles/default/agent/config.yml` by hand.

### A `--config` overlay fails at startup

`--config` files are process-local YAML mappings. A missing file, invalid YAML, or a top-level array/scalar is a hard error, it does not silently fall back to lower-precedence settings. Fix the path or contents.

### An environment variable beats my config

Some settings (model roles, eval backends, tiny-model device/precision, auth broker, PTY) are overridable by env vars or CLI flags for per-machine convenience, and those take precedence over `config.yml`. Unset the variable or drop the flag to let the persisted value win. See [Environment overrides](#environment-overrides) and [Environment variables](./environment-variables.md).

### `veyyon config set <key>` says "Unknown setting"

Keys must match a schema path exactly, with no shorthand. Use `theme.dark`, not `theme`. Run `veyyon config list` to see every valid key.
