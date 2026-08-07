# Settings

`veyyon` resolves settings from built-in defaults, a persistent profile config file, a small machine-global file, one-shot CLI overlays, and in-memory runtime overrides. When one repository needs a different provider set, model role, tool policy, or UI behavior than your profile defaults, use a `--config` overlay or a path-scoped array (see [Path-scoped arrays](#path-scoped-arrays)); both are covered below.

A repository never configures the agent. A checked-in `.veyyon/config.yml` or `.veyyon/settings.json` in a working tree is not read, because a repository is content you may not have written. The only files a project contributes are context files (`AGENTS.md` / `CLAUDE.md`), which are prose the model reads, not settings; see [Context files](./context-files.md).

Settings are stored as plain YAML mappings. Every key, its type, default, and enum values come from the settings schema, and you can inspect or change any of them with `veyyon config` or the interactive `/settings` panel.

- For model/provider credentials, `.env` files, and the env-var table that resolves API keys, see [Providers](./providers.md).
- For custom model definitions in `models.yml`, see [Models](./models.md).
- For instruction files discovered into the agent context (`AGENTS.md`, `.veyyon/`, etc.), see [Context files](./context-files.md).
- For the full catalog of environment variables, see [Environment variables](./environment-variables.md).

## Where settings live

| Scope | Path | Read behavior | Write behavior |
|---|---|---|---|
| Profile | `~/.veyyon/profiles/<name>/agent/config.yml` | The main persistent settings file for the active profile. Always loaded. | `/settings`, `veyyon config set`, and `veyyon config reset` write here. |
| Profile legacy | `~/.veyyon/profiles/<name>/agent/settings.json` | Migrated into `config.yml` once, only when `config.yml` does not yet exist. | Not written after migration; the original is renamed to `settings.json.bak`. |
| Machine-global (all profiles) | `~/.veyyon/config.yml` | A small set of values shared by every profile: `defaultProfile` (which profile a bare `vey` launches), `profileSharing` (whether provider credentials are shared across profiles), and the auth-broker keys `authBrokerUrl` / `authBrokerToken`. Read live. | The **Global** tab of `/settings`, or `veyyon profile default` for `defaultProfile`. These keys never land in a profile's own `config.yml`. |
| CLI overlay | Any file passed with `--config <file>` | Loaded after the profile config, for that one process. Repeatable. | Never persisted. |
| Runtime overrides | In-memory only | Set by dedicated CLI flags (`--model`, `--approval-mode`, …) and feature env vars. | Never persisted. |

`VEYYON_CODING_AGENT_DIR` relocates the `~/.veyyon/profiles/default/agent` base directory. When it is set, the global `config.yml`, the auth store (`agent.db`), and everything else under the agent directory move with it. Use `veyyon config path` to print the active agent directory.

There is no project layer. Settings discovery reads home directories only: the active profile's agent directory and the machine-global `~/.veyyon/config.yml`. A `.veyyon/` directory inside a working tree is never consulted for settings, whatever it contains.

## Config file formats

The global `config.yml` is always YAML. The generic config loader used for other files (for example `models.yml`) accepts `.yml`, `.yaml`, `.json`, and `.jsonc`:

- When a `.yml`/`.yaml` path is requested and only a sibling `.json` exists, it is migrated to YAML automatically (idempotent, once per process).
- `.json` and `.jsonc` configs are read as-is, with no migration.
- A file whose top level is not a mapping (a bare array or scalar) is treated as empty for persistent settings, and is a hard error for `--config` overlays.

### Nested and flat keys

A setting can be written either way, and the two mean the same thing:

```yaml
subagent:
  model: openai/gpt-5

subagent.model: openai/gpt-5   # the same setting
```

The nested form is the one this documentation uses and the one every write from
`/settings` and `veyyon config set` produces. A flat key is expanded into the nested
form when the file is read, so you can type it either way.

Two rules cover the corners:

- If a setting is written **both** ways, the nested value wins, the flat key is
  dropped from the file the next time it is written, and a warning names both values.
- A key this build does not know is left exactly as written, whether or not it has
  dots in it. That keeps a config usable across versions and alongside other tools.

## Reading and writing settings

Use the interactive `/settings` panel inside a session, or the `veyyon config` command from a shell. Both operate on the merged effective settings, and every persistent write lands in the **global** profile file, with one exception: the machine-global values on the **Global** tab (`defaultProfile`, `profileSharing`) write to `~/.veyyon/config.yml` so they apply to every profile.

```bash
veyyon config list                 # all settings with current effective values
veyyon config list --json          # same, machine-readable
veyyon config get theme.dark       # one value
veyyon config get theme.dark --json
veyyon config set compaction.enabled false
veyyon config set compaction.model anthropic/claude-haiku-4-5
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
| `veyyon config reset <key>` | Remove the key from the profile `config.yml`, so the schema default (or an overlay or runtime value) applies again. Reset deletes the key; it does not write the default into the file. |
| `veyyon config path` | Print the active agent directory (honors `VEYYON_CODING_AGENT_DIR`). |
| `veyyon config init-xdg` | Create the XDG data/state/cache directories Veyyon uses on Linux/macOS. |

A setting that has been replaced by another is **retired**: it stays readable and settable so an existing config keeps working, and the migration on load can read it, but `veyyon config list` leaves it out and `veyyon config get`/`set` name the key that governs the behavior now. The retired keys today are `compaction.thresholdTokens` and `compaction.thresholdPercent` (replaced by `compaction.threshold`) and `defaultThinkingLevel` (replaced by `defaultEffort`).

`veyyon config` with no subcommand is an alias for `veyyon config list`; `--help` prints the help. The `--json` flag is accepted by `list`, `get`, `set`, and `reset`.

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

`veyyon config set`, `veyyon config reset`, `/settings`, and any runtime settings change all write to the `config.yml` under the active agent directory. To vary behavior per repository, use a `--config` overlay or a path-scoped array (see [Path-scoped arrays](#path-scoped-arrays)); a `.veyyon/config.yml` inside a repository is never read. Saves are debounced and re-read the file under a lock, so external edits made while a session is open are preserved. The machine-global keys on the **Global** tab (`defaultProfile`, `profileSharing`) are the exception: they write to `~/.veyyon/config.yml` instead of the active agent directory, and are read live so an external edit to that file is reflected without a restart.

`/settings` shows the effective value from the full precedence chain. A row
supplied by a `--config` file or a runtime override names that source beside
the value and is read-only. Change the owning source instead.
This prevents an accepted-looking profile edit from remaining hidden until the
higher layer disappears.

**Default Model** is intentionally profile-owned. If `--model` or another
higher layer selects a different active model, the row shows both the saved
profile model and the active override. Editing the row changes the model used
by the next session; it does not replace the current session override.

Within one open panel, each category remembers its last selected row. Switch to
another sidebar category and back to resume where you left off. If a condition
hides that row, the panel selects the nearest available setting instead.

## Precedence

From lowest to highest priority, the effective value of a setting is built as:

```text
built-in defaults  <-  profile config  <-  CLI overlays  <-  runtime overrides
```

From highest to lowest:

1. **Runtime overrides**: dedicated CLI flags and feature env vars applied in memory for the current process: `--model`, `--smol`, `--slow`, `--plan`, `--approval-mode`, `--auto-approve`/`--yolo`, `--hide-thinking`, `--advisor`, `--no-pty`, `--api-key`, and protocol-mode defaults. Never persisted.
2. **CLI config overlays**: each `--config <file>`; later overlay files override earlier ones.
3. **Profile settings**: `~/.veyyon/profiles/<name>/agent/config.yml`.
4. **Built-in defaults**: from the settings schema.

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
  approvalMode: ask-command
  approval:
    bash: prompt
    read: allow
```

### Worked example: profile vs. overlay

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
tools:
  approvalMode: ask-command
  approval:
    bash: prompt
    read: allow
disabledProviders:
  - anthropic
  - openai
  - gemini

# ./ci-overrides.yml, passed with --config
tools:
  approval:
    bash: allow
disabledProviders:
  - groq
```

Effective settings for that process:

```yaml
tools:
  approvalMode: ask-command   # kept from the profile (object deep-merge)
  approval:
    bash: allow         # overridden by the overlay
    read: allow         # kept from the profile
disabledProviders:
  - groq                # the overlay array REPLACES the profile array
```

Array replacement is the most common surprise: the overlay's `disabledProviders` does not extend the profile list, it becomes the entire list for that process. The same applies to `enabledModels`, `cycleOrder`, `extensions`, and every other array-typed setting.

## Per-repository settings

A repository cannot carry its own settings: a checked-in `.veyyon/config.yml` is not read, because a working tree is content you may not have written. Two mechanisms cover what project config used to do:

- **`--config` overlays** apply a file you choose to one process, so a per-repo launcher or alias can pass the repo's overlay explicitly:

```bash
veyyon --config ./local/repo-settings.yml "check this failure"
veyyon --config ./base.yml --config ./experiment.yml "try this model"
```

Overlay paths are resolved relative to the process working directory (and `~` is expanded). Each overlay must parse as a YAML mapping; a missing file, invalid YAML, or a top-level array/scalar is a hard error, it does **not** silently fall back to lower-precedence settings. Keep the overlay file out of commits if it holds anything private.

- **Path-scoped arrays** let one profile config behave differently per directory; see below.

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
| Model providers | `anthropic`, `openai`, `google`, `groq`, `ollama`, `openrouter` | Removes those backends from model selection, even when credentials are available. See [Providers](./providers.md). |
| Discovery sources | `native`, `claude`, `codex`, `gemini`, `github`, `opencode`, `cursor`, `agents`, `agents-md` | Stops that source from contributing context files, MCP servers, commands, skills, hooks, tools, prompts, or settings. See [Context files](./context-files.md). |

Most provider-control use cases list model provider ids. Disabling the `claude` discovery source is different from disabling the `anthropic` model provider, one stops Claude-format config discovery, the other stops the Anthropic model backend.

Because arrays replace rather than append, an overlay that sets `disabledProviders` must list the complete desired set:

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
disabledProviders:
  - anthropic
  - openai

# ./ci-overrides.yml, passed with --config: for that process ONLY groq is disabled
disabledProviders:
  - groq
```

The default is an empty array (nothing disabled). For the two subsystems' provider ids and ordering, see [Providers](./providers.md) and [Context files](./context-files.md).

## Settings catalog

Every key below is defined in the settings schema; `veyyon config list` shows the full set with current values. Defaults and enum values are taken from the schema. Settings that accept an env or flag override are noted; those overrides are process-local and not persisted.

### Models

`modelRoles`, `modelTags`, and `cycleOrder` work together. Role values may carry a thinking suffix (`:off`, `:auto`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). The same suffix works on `subagent.model` and `compaction.model`, so any model slot can run at a chosen effort.

A suffix on a role use overrides the role's stored suffix. For example, if `modelRoles.slow` is `anthropic/claude-opus-5:low`, then `@slow:high` resolves to `anthropic/claude-opus-5:high`, not a double-suffixed model id.

When you pick a role, subagent, or compaction model in `/settings`, Veyyon opens a separate effort step only if that model exposes configurable effort. The first row, **Model default**, stores no suffix. The remaining rows contain `auto`, `off` when the model permits it, and only the model's catalog-defined effort variants. For example, a low/high Gemini model does not show medium or xhigh. A fixed-reasoning model skips the effort step. The **Default Model** picker is deliberately model-only: it stores a bare selector, and **Default Effort** is the one UI surface for its saved effort. Providers sometimes publish effort tiers as separate upstream model IDs. Veyyon collapses effort-only siblings into one logical model and routes the selected effort to the correct upstream ID.

`compaction.model` and `subagent.model` are ordered chains. The first entry is the primary model and later entries are fallbacks. Enter edits the highlighted position, **Add fallback** appends a position, and Delete removes only the highlighted position. The settings rows show a stored effort as ` · high` instead of the raw `:high` suffix.

The model you are working with (the main conversation) is persisted as **`modelRoles.default`**. That slot is not a selectable role: it is hidden from role pickers and stripped from `cycleOrder` on load. In the code it has one name, `DEFAULT_MODEL_SLOT`, and `interactive` is accepted as an alias for it wherever a role is passed. Selectable built-in roles: `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `advisor`. There is no `task` role: the model your subagents run lives in [Subagents](#subagents), which is its one owner.

```yaml
modelRoles:
  default: anthropic/claude-sonnet-4-5   # interactive model (persisted default)
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  vision: gemini/gemini-3-pro-preview
  plan: anthropic/claude-opus-4-5
  advisor: anthropic/claude-sonnet-4-5:medium

cycleOrder:
  - smol
  - slow

subagent:
  model: deepseek/deepseek-chat:high     # optional; unset means subagents inherit your model; :effort optional

compaction:
  model: openai/gpt-5-mini               # optional; else inherits your current model; may carry :effort

modelProviderOrder:
  - anthropic
  - openai

enabledModels:
  - claude-sonnet-4-5
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `modelRoles` | record | `{}` | Role name → model id. Interactive model uses key `default` (hidden in UI). Selectable built-ins: `smol`, `slow`, `vision`, `plan`, `designer`, `commit`, `tiny`, `advisor`. `tiny` is used for lightweight background tasks when set, else `@smol`. Launch: `--model` (interactive), `--smol`, `--slow`, `--plan`; advisor via `modelRoles.advisor` + `advisor.enabled` / `--advisor`. |
| `modelTags` | record | `{}` | Custom role/tag metadata; can introduce additional roles. |
| `modelProviderOrder` | array | `[]` | Preferred provider order when a model id is ambiguous. |
| `cycleOrder` | array | `["smol","slow"]` | Roles cycled by the model switcher (`app.model.cycleForward`, often Ctrl+P). The entry `default` is dropped on load. |
| `enabledModels` | array | `[]` | Allow-list of models; supports [path-scoped entries](#path-scoped-arrays). Empty means all available models. |
| `disabledProviders` | array | `[]` | Disabled model/discovery providers; supports path-scoped entries. See [above](#provider-and-source-disabling). |
| `includeModelInPrompt` | boolean | `false` | Include the active model name in the system prompt. Off by default: the name sits in the cached prefix, so switching models re-prefills the whole block. |

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

Effort has one persisted home: the `defaultEffort` list, per profile. A row keyed
by a model selector applies to that model; the `*` row applies to every model
without its own. `/effort` (and its `/thinking` alias) changes only the current
session and prints where the saved default lives, so trying an effort never
rewrites your default.

The retired `defaultThinkingLevel` is consulted only when the `defaultEffort` key is absent. Once `defaultEffort` is present, its object is authoritative, including `{}` and a set of model-specific rows with no `*` fallback. Removing the **Any Model** row therefore keeps every unmatched model on its native default instead of resurrecting a legacy profile-wide value.

Choose **Default** in the session effort picker to clear the temporary override.
Veyyon then applies an explicit `:level` on the active selector, the active
model's saved row, the `*` row, or the model default according to the precedence
below. Switching models re-evaluates these sources. A temporary session choice
remains in force until you clear it.

Effort is resolved in this order, highest first:

1. the current session's choice, from `/effort`, `/thinking`, or the cycle keybinding
2. an explicit `:level` on the selector a role resolved through, e.g. `modelRoles.plan: anthropic/claude-opus-5:xhigh`
3. the `defaultEffort` row for the model about to run
4. the `defaultEffort` `*` row
5. the model's own default, when nothing above is set


```yaml
defaultEffort:
  "*": high
  anthropic/claude-haiku-4-5: low
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
| `defaultEffort` | record | `{}` | Effort per model, applied when a run does not ask for one. Keys are model selectors (`anthropic/claude-opus-5`) or `*` for any model; values are `minimal`, `low`, `medium`, `high`, `xhigh`, `max`, `auto`, or `off`. Edit it in `/settings` → Model → Default Effort. |
| `defaultThinkingLevel` | enum | `high` | Retired in favour of `defaultEffort`'s `*` row. It is read only when the replacement `defaultEffort` key is absent, so an existing profile migrates without overriding an explicitly empty or model-only list. No settings row of its own. |
| `hideThinkingBlock` | boolean | `false` | Hide thinking blocks in output. `--hide-thinking` sets it for the run (display only). |
| `thinkingBudgets.minimal` | number | `1024` | Token budget for the `minimal` level. |
| `thinkingBudgets.low` | number | `2048` | Token budget for `low`. |
| `thinkingBudgets.medium` | number | `8192` | Token budget for `medium`. |
| `thinkingBudgets.high` | number | `16384` | Token budget for `high`. |
| `thinkingBudgets.xhigh` | number | `32768` | Token budget for `xhigh`. |
| `thinkingBudgets.max` | number | `32768` | Token budget for `max`. |

### Sampling

These settings are unset by default, and unset means the key is absent from `config.yml`: `veyyon` then does not send that parameter and the provider uses its own default. Every number you write is sent as written, including negatives: `presencePenalty: -1` and `repetitionPenalty: -0.5` both reach the provider. In `/settings` the unset state is the row labelled `Default`, and choosing it removes the key rather than storing a value.

Earlier versions stored `-1` to mean unset, which made `-1` itself impossible to configure. Your global config is migrated once: a `-1` on one of these keys is dropped, and the config records that the migration ran (`settingsMigrationVersion`), so a `-1` you set afterwards is kept. A `--config` overlay is never rewritten and is read as written, so a `-1` there is the value `-1`.

Set a negative value from the command line the way you would any other:

```bash
veyyon config set presencePenalty -1
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `temperature` | number | _(unset)_ | Sampling temperature. `0` is deterministic. |
| `topP` | number | _(unset)_ | Nucleus sampling. |
| `topK` | number | _(unset)_ | Top-K sampling. |
| `minP` | number | _(unset)_ | Minimum-probability cutoff. |
| `presencePenalty` | number | _(unset)_ | Presence penalty. Negative values, including `-1`, are sent as written. |
| `repetitionPenalty` | number | _(unset)_ | Repetition penalty. Values below `1` encourage repetition and are sent as written. |
| `tier.openai` | enum | `none` | `none`, `auto`, `default`, `flex`, `scale`, `priority`. Sent as `service_tier` for OpenAI / OpenAI-Codex and OpenAI-family OpenRouter models. |
| `tier.anthropic` | enum | `none` | `none`, `priority`. `priority` realizes fast mode on supported direct Claude models (ignored on Bedrock/Vertex and via OpenRouter). |
| `tier.google` | enum | `none` | `none`, `flex`, `priority`. Gemini API sends it in the body; Vertex sends `priority` via header (`flex` is a no-op on Vertex). |
| `tier.subagent` | enum | `inherit` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the spawned model's family; `inherit` tracks the main agent. |
| `tier.advisor` | enum | `none` | `inherit`, `none`, `auto`, `default`, `flex`, `scale`, `priority`. Applied to the advisor model's family. |
| `personality` | string | `default` | Communication style rendered into the system prompt. Built in: `default`, `friendly`, `pragmatic`, `none`. Not a closed set: add your own with `~/.veyyon/personalities/<name>.md`, or `.veyyon/personalities/<name>.md` in a project. |

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
  approvalMode: auto          # default
  approval:
    bash: prompt
    edit: allow
  discoveryMode: auto
  maxTimeout: 0
  intentTracing: true
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `tools.approvalMode` | enum | `auto` | Canonical: `plan` (read auto; write asks with an active plan-mode session, otherwise write/exec denied), `ask` (nothing auto; every tier asks, reads included), `ask-command` (read+write auto; exec ask), `auto` (all tiers auto, with the per-tool, working-directory, credential and critical-call guards still asking), `yolo` (all tiers auto). Legacy aliases still accepted: `always-ask` → `ask`, `write` and `auto-edit` → `ask-command`. Override per run with `--approval-mode` / `--auto-approve` / `--yolo`. |
| `tools.approval` | record | `{}` | Per-tool policy keyed by tool name; each value is `allow`, `deny`, or `prompt`. e.g. `veyyon config set tools.approval '{"bash":"prompt"}'`. |
| `tools.discoveryMode` | enum | `auto` | `auto`, `off`, `mcp-only`, `all`. `all` hides non-essential built-ins and first-party heavyweight tools such as `generate_image` until the discovery search activates them. |
| `tools.essentialOverride` | array | `[]` | Tool names kept available even when tools are narrowed. |
| `tools.maxTimeout` | number | `0` | Max tool runtime in seconds; `0` = no cap. |
| `tools.intentTracing` | boolean | `true` | Record per-call intent strings. |
| `tools.outputMaxColumns` | number | `768` | Per-line byte cap for streaming output; `0` disables. |
| `tools.artifactSpillThreshold` | number | `50` | KB of tool output above which output spills to an artifact, for every tool including the streaming ones (bash, eval, ssh, interactive shell). The result keeps a window plus the `artifact://` id that reads the full text back. |
| `tools.artifactHeadBytes` | number | `20` | KB of head kept inline on spill; `0` = tail-only. |
| `tools.artifactTailBytes` | number | `20` | KB of tail kept inline on spill. |
| `tools.artifactTailLines` | number | `500` | Max tail lines kept inline on spill. |

Individual built-in tools are toggled by their own keys, e.g. `bash.enabled`, `launch.enabled`, `eval.py`, `eval.js`, `glob.enabled`, `grep.enabled`, `fetch.enabled`, `browser.enabled`, `astEdit.enabled`, `astGrep.enabled`, `web_search.enabled`, `inspect_image.enabled`.

### Subagents

Everything about spawned agents lives here, under `subagent.`: whether this session
delegates at all, which agent types it may use, what model and effort they run, and
the limits and isolation they run under. In `/settings` it is the **Subagents** tab.

#### Three settings, three different questions

Subagents are governed by three settings, and mixing them up is the usual source of
confusion, so read this table before you change anything. Each one answers a question
the other two cannot.

| Setting | The question it answers | Default |
|---|---|---|
| `subagent.enabled` | May this session use subagents **at all**? | `true` |
| `subagent.delegation` | Is the model **encouraged** to fan work out, and how hard? | `preferred` |
| `subagent.agents` | **Which** agents may it use? | `task` only |

Read them top to bottom. `subagent.enabled` is the master switch: turn it off and
there are no subagents, the `task` tool is not built, and the other two settings stop
mattering. Leave it on and `subagent.delegation` decides how much the prompt pushes,
while `subagent.agents` decides what there is to push work to.

**Turning delegation down does not forbid delegation.** This is the distinction that
matters most. `subagent.delegation: allowed` means the model still has the `task`
tool and will still spawn a subagent when that is the sensible move; it simply is not
asked to. The only setting that takes the ability away is `subagent.enabled`. If you
want subagents gone, set that one, not this one.

```yaml
subagent:
  enabled: true                # master switch; false removes subagents entirely
  delegation: preferred        # allowed | preferred | required
  model: openai/gpt-5:high     # optional; unset means inherit your model
  thinkingLevel: medium        # optional; unset means inherit your effort
  agents:
    scout:
      enabled: true            # let the model choose the scout
    reviewer:
      enabled: true
      model: anthropic/claude-opus-4-5   # this agent only
  maxConcurrency: 32
  isolation:
    mode: none
```

Out of the box you get one agent type, the general-purpose worker, and the prompt
encourages fanning work out to it. The bundled specialists (`scout`, `reviewer`,
`designer`, `librarian`, `sonic`) ship disabled: each one you enable adds its
description to every request, so you pay for the ones you actually use and nothing
else. They stay listed while disabled, each with a line saying what it is for, so you
can see what is available before you turn anything on.

#### Subagents on or off

`subagent.enabled` is a boolean and it is the only kill switch. When it is `false`:

- the `task` tool is not built, so the model cannot spawn anything;
- every delegation instruction leaves the system prompt;
- `subagent.delegation` and `subagent.agents` are still stored, still editable, and
  take effect again the moment you turn this back on.

Earlier releases spelled this as `subagent.delegation: off`, which made one setting
answer two questions: whether subagents existed, and how hard to push them. An
existing `delegation: off` is migrated to `enabled: false` with `delegation` left at
its default, because "off" was how you turned subagents off.

#### Delegation

`subagent.delegation` sets how hard this session pushes work out. It never removes
the ability to delegate; for that, see `subagent.enabled` above.

| Value | Behavior |
|---|---|
| `allowed` | The tool is offered and nothing asks for it. The model delegates when it judges that delegation helps. |
| `preferred` | The default. The prompt asks the model to fan substantial work out rather than doing it alone. |
| `required` | The same, plus a first-turn reminder that delegation is the default here. |

#### What the model is told to delegate

The prompt does not carry a fixed list of delegable work. **The agents you enable are
the instruction.** That is the whole mechanism, and it is why the Agents table is a
delegation setting rather than a cosmetic one.

With only the worker enabled, the guidance is about splitting execution across
parallel workers and keeping bulk reading out of your session's context. Nothing tells
the model to send research to a `scout` it cannot spawn, and nothing tells it to send
a review to a `reviewer` that does not exist. Enable the `reviewer` and you have said
reviews are delegable here; the prompt then names it. Enable the `scout` and bulk
exploration becomes something it is told to route away from its own context.

This is also the answer to "why did it delegate my audit?". If a specialist for that
work is enabled, the model has been told the work is delegable. If none is, and it
still fans out, that is a prompt bug rather than a settings question: file it.

**Context preservation, not a cheaper model.** A subagent usually runs the same model
you are on (see [Which model a subagent runs](#which-model-a-subagent-runs)). What
delegation buys is a separate context window: bulk reading, wide searches, and long
tool output stay out of your session and come back as a summary. Nothing about
delegation implies the subagent is less capable than you.

#### When the two settings disagree

`subagent.delegation` and the Agents table are one question with two answers, and one
resolver reads both. If you disable every agent there is nothing to delegate to, so
the strength you pick has no effect until you enable at least one: the prompt stops
asking for delegation, the first-turn reminder is not injected, and both agent
surfaces say so in a line above the table. If `subagent.enabled` is off, the same line
says that instead, because turning agents on would change nothing until you turn
subagents back on. Neither setting is hidden behind the other: you need all three
while setting up a session, but none pretends the others do not exist.

#### Agents

`subagent.agents` holds one row per agent, keyed by agent name. One surface edits it
rather than hand-written config: the **Agents** row in `/settings` → Subagents, which
lists every discovered agent with the model it resolves to and opens one agent at a
time to set its state. `/agents` used to carry a second copy of the same table, so the
same two facts had two homes that had to be kept in step; it is the live picture now
and configures nothing.

An agent is either enabled or disabled. There is no third state:

| `enabled` | Meaning |
|---|---|
| absent | The shipped default: the worker and every agent you wrote yourself are enabled, the bundled specialists are disabled. |
| `true` | Enabled. The agent is listed in the `task` tool description, and the model may choose it. |
| `false` | Disabled. The model may not choose it, and a spawn that tries is refused with the setting named. |

#### What "disabled" governs, and what it does not

Disabling an agent stops **the model** from choosing it. It does not stop **you**.

That distinction is the whole rule, and it is worth stating plainly because an earlier
version of veyyon got it wrong. There used to be a middle state, shown as "not offered
but still runs when named", which meant a row could read as off while the agent went on
running. Nobody could tell what the switch did. Enabled now means the model may pick the
agent on its own initiative, disabled means it may not, and that is all it means.

Slash commands are you asking, so they are unaffected. Running `/review` is a request
for a review, not a suggestion that the model consider reviewing, so `/review` spawns
its `reviewer` even though `reviewer` ships disabled. A command declares the agents its
prompt names, and that declaration is granted for that one turn only:

| Command | Agent it names | Works with the agent disabled |
|---|---|---|
| `/review` | `reviewer` | yes |

Two limits keep this narrow. The grant lasts for the turn the command starts and no
longer, so the model cannot reach a disabled agent on the next turn. And it comes from
the command's own definition, not from anything computed while the command runs, so the
list above is the complete list. If you ask for an agent in plain prose instead of
through a command ("use the scout agent"), that is the model choosing, and a disabled
scout is refused.

A row carries whether the agent is enabled and how deep it may nest its own spawns. It
does **not** carry a model or an effort: those have one owner, described next.

#### Which model a subagent runs

Three things can name the model a subagent runs. The first one that names a model wins:

1. `subagent.model`: the blanket model for every subagent.
2. the agent definition's own `model:` frontmatter, for an agent you wrote.
3. otherwise the subagent inherits the model you are working with.

There is no per-agent model row. There was one, above the blanket setting, and it is
the reason this section used to have four layers: the agent editor showed a Model row
and an Effort row for one agent while `subagent.model` and `subagent.thinkingLevel`
showed the same two facts for all of them, and the two screens could disagree on
screen. A `subagent.agents.<name>.model` or `.thinkingLevel` still sitting in a config
is ignored, and named once in the log with the setting that replaced it, rather than
being honored invisibly or dropped in silence.

None of the bundled agents pin a model, so on a fresh install every subagent runs the
model you are looking at. Change `subagent.model` and they all move together. To give
one agent its own model, write it in that agent's own `model:` frontmatter, which is
where an agent's identity already lives.

A configured value that matches no available model does **not** fall through to the
next layer. The spawn is refused and the message names the setting to fix, because a
silent fall-through is indistinguishable from your setting having no effect.

Effort works the same way, through `subagent.thinkingLevel`. The levels offered are the
ones the model in scope actually exposes, so a model that routes effort through
separate model ids offers **Inherit** alone and says so, rather than listing levels it
would reject. A value that names no level (from a hand-written config) is reported with
the setting and the accepted levels, then ignored. It is never rounded to a
neighbouring effort: running at an effort you did not choose costs money and would not
show up anywhere.

The Agents table names, for the selected agent, the model it will run on and the
setting that decided, and the agent editor repeats it as a read-only line pointing at
**Subagent Model** and **Subagent Effort**. What decided is visible, in one place, so
an agent running something you did not expect is a question you can answer.

#### The two views in `/agents`

`/agents` opens the Agent Control Center, which is about a run in progress and
configures nothing. Move between its two views with the left and right arrows, with
`tab`, or by clicking a name in the strip at the top of the card:

| View | What it answers |
|---|---|
| Live | Which agents exist right now, what type each one is (`reviewer`, `scout`, the definition it was spawned from), and what it is doing. Agents from earlier runs of the session appear too, marked `parked`. Press `enter` on a row, or click it, to open that agent's session in the main view: you read its transcript and can type to it, and `esc` returns you to your own session. Press `x` to stop an agent. |
| Comms | The agent-to-agent messages, streaming as they are sent, including the ones that failed to reach their recipient and why. Long messages are folded to their first few lines with a count of what was hidden; `ctrl+o` unfolds them. |

Live only ever lists agents that exist in this session, so a disabled specialist
cannot appear there: it was never spawned. Which agents the model may choose, and
what each one runs on, is configured in the Agents row of this tab.

`/cockpit` and `/hub` are aliases of `/agents`, as are the `app.agents.hub` and
`app.session.observe` keys and a double-tap of the left arrow on an empty composer.
They used to open a separate screen with its own roster, which meant two answers to
"which agents are running" that could disagree.

| Key | Type | Default | Notes |
|---|---|---|---|
| `subagent.enabled` | boolean | `true` | The master switch. `false` removes subagents entirely: no `task` tool, no delegation guidance. See above. |
| `subagent.delegation` | enum | `preferred` | `allowed`, `preferred`, `required`. How hard the prompt pushes; it never removes the ability to delegate. See above. |
| `subagent.agents` | record | `{}` | One row per agent: `enabled`, `maxNestedSpawnDepth`. Edit in the Agents row of the Subagents tab. Model and effort are not per-agent; see `subagent.model`. |
| `subagent.model` | modelChain | unset | Models for every subagent that has no model of its own, tried in order, written as a comma-separated string or as a YAML list: the later entries are used when a run errors on the one in use. Unset means inherit: subagents follow the model you are working with. May carry a `:effort` suffix, and an explicit suffix wins over the agent's own default. A pattern that matches no model refuses the spawn rather than falling through to the next entry. |
| `subagent.thinkingLevel` | string | unset | Blanket subagent effort, picked from the levels the model in scope exposes. Unset or **Inherit** passes the current session's effective effort into the child. It does not ask the provider to choose `auto`. |
| `subagent.batch` | boolean | `true` | Batch shape for the `task` tool: one call, many items. |
| `subagent.maxConcurrency` | number | `32` | Subagents running at once. |
| `subagent.maxNestedSpawnDepth` | number | `0` | Nested levels that subagents may spawn. Direct children receive no `task` tool at `0`; an agent-specific override may raise the limit. |
| `subagent.maxRuntimeMs` | number | `0` | Hard per-subagent wall-clock limit in ms; `0` disables it. |
| `subagent.idleTtlMs` | number | `300000` | How long a finished subagent stays live before parking. The default is 5 minutes for every model and provider. Set a positive millisecond value to override it. `0` keeps idle agents live until exit. Parking closes the live session but retains its transcript for revival. |
| `subagent.softRequestBudget` | number | `200` | Requests after which a subagent is asked to wrap up; `0` disables the guard. |
| `subagent.softRequestBudgetNotice` | boolean | `true` | Inject that wrap-up notice once. |
| `subagent.showResolvedModelBadge` | boolean | `true` | Show each subagent's resolved model, and what decided it, on the task widget and the agent surfaces. |
| `subagent.enableLsp` | boolean | `false` | Let subagents use the `lsp` tool. |
| `subagent.isolation.mode` | enum | `none` | Filesystem isolation backend for subagents. See [Safety](./handbook/src/using/safety.md). |
| `subagent.isolation.merge` | enum | `patch` | How isolated changes come back: `patch` or `branch`. |
| `subagent.isolation.commits` | enum | `generic` | Commit message style for nested repo changes. |

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

ruby:
  kernelMode: session       # session, per-call

julia:
  kernelMode: session       # session, per-call

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
| `bash.autoBackground.enabled` | boolean | `true` | Auto-background long-running commands. You can also background the running command yourself with the composer's background key, whatever this is set to. |
| `bash.autoBackground.thresholdMs` | number | `300000` | Max wall-clock time a bash call runs in the foreground before it is moved to a background job. Frees the model and protects the prompt cache. Fires on elapsed time even while output streams. `0` backgrounds immediately. |
| `bash.stallDetection.enabled` | boolean | `false` | Watch for a bash call that stops producing output; background it and tell the model it may be stuck so it can cancel a truly hung command. Recommends, never force-kills. |
| `bash.stallDetection.stallMs` | number | `30000` | Idle time (no new output) before a bash call is treated as possibly stuck. Measures quiet output, not total run time. |
| `eval.py` | boolean | `true` | Python eval backend. `VEYYON_PY=0` disables for the process. |
| `eval.js` | boolean | `true` | JavaScript eval backend. `VEYYON_JS=0` disables for the process. |
| `python.kernelMode` | enum | `session` | `session` (persistent kernel) or `per-call`. |
| `ruby.kernelMode` | enum | `session` | Same choice for Ruby cells: keep one kernel per session, or start and shut down a kernel for each cell. |
| `julia.kernelMode` | enum | `session` | Same choice for Julia cells. A fresh Julia kernel recompiles, so `per-call` trades startup time for a clean slate. |
| `python.interpreter` | string | `""` | Path to a Python interpreter; empty = auto-detect. |
| `lsp.enabled` | boolean | `false` | Language-server integration. Opt in; `--no-lsp` disables it for a run where config turned it on. |
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


### Automatic tool issue reports

Auto QA records a model's report when a built-in tool behaves differently from its contract. Recording
is local to the active profile. Automatic upload is a separate setting and is off by default.

```yaml
dev:
  autoqa: true
  autoqaPush:
    enabled: false
    endpoint: https://veyyon.dev/api/grievances
```

Turn on **Auto QA** to create reports in the profile's `autoqa.db`. Turn on
**Auto-upload Grievances** to send new and queued reports to the collector at `veyyon.dev`. You can
leave automatic upload off and inspect the queue with `veyyon grievances`. Running
`veyyon grievances push` is an explicit one-time upload and does not change the profile toggle.

Each profile owns its own recording and upload settings. The install identifier in an uploaded batch
is shared across profiles so the collector can make a retried local row idempotent. It contains no
hostname or username.

### Context, compaction, and memory

```yaml
contextPromotion:
  enabled: false

compaction:
  enabled: true
  strategy: summary           # the sole compaction strategy
  midTurnEnabled: true        # check thresholds between tool-loop provider requests
  threshold: auto             # auto | 85% (of the model's window) | 170000 (tokens, any model)

memory:
  backend: off                # off, local, hindsight, mnemopi
```

| Key | Type | Default | Notes |
|---|---|---|---|
| `contextPromotion.enabled` | boolean | `false` | Promote to a larger-context model on overflow instead of compacting. |
| `compaction.enabled` | boolean | `true` | Automatic conversation compaction. |
| `compaction.midTurnEnabled` | boolean | `true` | Check thresholds at safe mid-turn tool-loop boundaries before the next provider request. |
| `compaction.strategy` | enum | `summary` | The sole strategy. It rewrites old history into an in-place LLM summary. Stored legacy values migrate to `summary`; use `/handoff` for an explicit new-session transfer. |
| `compaction.model` | modelChain | unset | Models for LLM compaction, tried in order, written as a comma-separated string or as a YAML list; unset inherits the model you are working with (`modelRoles.default`). Each may carry a `:effort` suffix, applied on every compaction pass. A candidate that is unauthenticated, or whose window cannot hold the summary, is skipped and the next one runs. |
| `compaction.modelFallbackStrategy` | enum | `auto` | What to try after `compaction.model` runs out. `auto` also tries the main model, each model role, then the largest-window model available. `configured-only` stops at the models you listed and fails with the reason. Compacting on anything but your first choice is reported in the session, once per reason. |
| `compaction.threshold` | string | `auto` | When auto-compaction triggers, with the unit in the value: `auto` uses `contextWindow - max(15% of contextWindow, reserveTokens)`; `85%` is a percent of the current model's window, so the trigger moves with the model; `170000` is an absolute token amount, the same trigger on every model. An absolute amount larger than the current model's window is honored up to `contextWindow - 1` and you get a one-time warning. Set it in `/settings` -> Model -> Auto-Compaction Threshold. |
| `compaction.thresholdTokens` | number | `-1` | Retired, replaced by `compaction.threshold`. A value `> 0` in your global config is rewritten to `threshold: <amount>` on load and this key is dropped, so your trigger point does not change. Write an absolute amount as `threshold: 170000`. |
| `compaction.thresholdPercent` | number | `-1` | Retired, replaced by `compaction.threshold`. A value `> 0` is rewritten to `threshold: <percent>%` on load (the token amount above wins when both are set) and this key is dropped. Write a percent as `threshold: 85%`. |
| `compaction.remoteEndpoint` | string | unset | Optional summarizer endpoint for the `summary` strategy. It must return summary text, which is stored exactly like a locally generated summary. It is a transport, not a third strategy. |
| `memory.backend` | enum | `off` | `off`, `local`, `hindsight`, `mnemopi`. Each backend has its own `hindsight.*` / `mnemopi.*` / `memories.*` tuning keys. |
| `autolearn.enabled` | boolean | `false` | Experimental: after the agent stops, nudge it to capture lessons to memory and create/enhance isolated managed skills under `~/.veyyon/profiles/default/agent/managed-skills`. Enables the `manage_skill` tool (and `learn` when a memory backend is active). |
| `autolearn.autoContinue` | boolean | `false` | When `autolearn.enabled`, auto-run one capture turn at stop (uses extra tokens). Off = a passive reminder rides your next turn. |
| `autolearn.minToolCalls` | number | `5` | Only nudge after a turn that used at least this many tools. |
| `session.instrumentation` | enum | `off` | How densely a run records study records on the session file, for after-the-fact analysis and backtesting. Graded: `off` stores nothing extra; `basic` adds wall-clock (start, end, duration, and time-to-first-token for model turns); `rich` adds output weight (result bytes/tokens) and per-turn throughput (tokens/sec); `ultra` adds an arguments fingerprint, cache read/write tokens, reasoning tokens, and upstream provider. It records BOTH per-tool-call metrics (`message.metrics`) AND per-model-turn metrics and the exact request params sent (`message.turnMetrics` / `message.request`). The `dev` profile preset (`veyyon profile new dev --from dev`) sets this to `ultra`. See [the session instrumentation reference](./internal/session.md#session-instrumentation-structured-analysis) for the on-disk field tables and jq recipes. |

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
| `statusLine.separator` | enum | `pipe` | `powerline`, `powerline-thin`, `slash`, `pipe`, `block`, `none`, `ascii`. |
| `statusLine.sessionAccent` | boolean | `true` | Tint the editor border with the session color. |
| `statusLine.transparent` | boolean | `true` | Use the terminal's own background for the status line instead of the theme's `statusLineBg`. Powerline end caps are dropped while transparent, because they need a contrasting fill to bridge into the surrounding terminal. |
| `statusLine.showHookStatus` | boolean | `true` | Show hook status messages. |
| `terminal.showImages` | boolean | `true` | Render images inline (when the terminal supports it). |
| `images.autoResize` | boolean | `true` | Resize large images for model compatibility. |
| `images.blockImages` | boolean | `false` | Never send images to providers. |
| `tui.hyperlinks` | enum | `auto` | `off`, `auto`, `always`. |
| `tui.scrollIsolation` | boolean | `false` | Mouse wheel scrolls the transcript while the prompt stays pinned at the bottom of the window, with the scroll position drawn on the right edge of the transcript (`/settings` → Appearance → Display, Advanced). Scrolling back reaches the whole session, not just what is on screen. Off by default: turning it on means veyyon holds the mouse to read wheel events, and your terminal's own drag-to-select stops working while it does. With it on you select using shift+drag, or with `/copy`, which picks text or code from the conversation without the mouse. With it off the wheel drives the terminal's native scrollback, the whole window scrolls with it including the prompt, and selection behaves as it does in any other program. |

For a custom status line, set `statusLine.preset: custom` and configure `statusLine.leftSegments`, `statusLine.rightSegments`, and `statusLine.segmentOptions`. See the [status line reference](./handbook/src/features/cockpit.md#status-line) for the full list of segment IDs.

One segment is worth calling out: `profile` shows the active profile name (`work`, `rec`, a client sandbox) so you always know which profile's config, sessions, and keys are live. It hides on the built-in `default` profile, so a vanilla status line is unchanged, and every built-in preset already includes it.

### Interaction

| Key | Type | Default | Values |
|---|---|---|---|
| `steeringMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`. How queued steering messages are delivered. |
| `followUpMode` | enum | `one-at-a-time` | `all`, `one-at-a-time`. |
| `interruptMode` | enum | `immediate` | `immediate`, `wait`. |
| `doubleEscapeAction` | enum | `tree` | `branch`, `tree`, `none`. |
| `autoResume` | boolean | `false` | Auto-resume the most recent session in the cwd. |
| `ask.timeout` | number | `0` | Seconds before an `ask` prompt times out; `0` = no timeout. Values above `1000` are read as milliseconds from an older config and divided by 1000, so `1000` seconds is the longest timeout you can set. A rewrite is reported in the log with both values. |
| `ask.notify` | enum | `on` | `on`, `off`. |
| `session.workdir` | string | unset | Per-profile default working directory. When you launch without an explicit `--cwd`, the session starts here. Precedence: an explicit `--cwd` wins, then this setting, then the directory you launched from. Use an absolute or `~`-relative path; a relative path or a missing directory makes launch fail loudly (no silent fallback). Set it in `/settings` (**Interaction** tab, **Profile** group, "Default Working Directory") or with `veyyon config set session.workdir /path/to/project`; clear it with `veyyon config set session.workdir ""`. This is a per-profile default that persists across sessions. It is distinct from `/cwd set` (and the agent's `set_cwd` tool), which re-root the live working directory for the current session only and write nothing to your profile. Note: if you launch from your bare home directory with no `--cwd`, no `--allow-home`, and this setting unset, veyyon relocates the session to a scratch directory (`~/tmp`, then `/tmp`) and prints a one-line notice saying so; set `session.workdir` to a real project directory to land there instead. |

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
| `providers.webSearch` | enum | `auto` | `auto` plus the configured search providers (`perplexity`, `gemini`, `anthropic`, `codex`, `xai`, `zai`, `exa`, `tinyfish`, `jina`, `kagi`, `tavily`, `firecrawl`, `brave`, `kimi`, `parallel`, `synthetic`, `searxng`, `startpage`, `duckduckgo`, `ecosia`, `google`, `mojeek`, `public`). |
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

The auth-broker keys (`auth.broker.url` / `auth.broker.token`) live in the machine-wide global config, not a profile's own file; see [Global (all profiles)](#global-all-profiles).

Provider credentials and custom model definitions are configured separately, see [Providers](./providers.md) and [Models](./models.md).

### Global (all profiles)

These keys live in the machine-wide `~/.veyyon/config.yml`, not a profile's own config, and are edited on the **Global** tab of `/settings`. They are read live, so an external edit to that file takes effect without a restart.

Two of these have a different name depending on how you reach them: `config set` and `/settings` take the schema path, and the value is stored under a nested key in the file. Both names are given below.

| Setting key (`config set`) | Stored as | Type | Default | Values / notes |
|---|---|---|---|---|
| `defaultProfile` | `defaultProfile` | string | `default` | Which profile a bare `vey` launches when `--profile` and `VEYYON_PROFILE` are unset. Also settable with `veyyon profile default [name]`; setting it back to `default` clears the override. |
| `profileSharing` | `profileSharing` | boolean | `true` | When `true`, every profile reads one machine-wide provider credential store (`~/.veyyon/shared-auth/agent.db`). Set `false` to give each profile its own private credentials. See [Providers](./providers.md). |
| `authBrokerUrl` | `auth: { broker: { url } }` | string | _(empty)_ | Auth-broker base URL, shown as **Auth Broker URL** on the Global tab. The legacy flat `"auth.broker.url"` key is still read and is rewritten to the nested form on the next save. `VEYYON_AUTH_BROKER_URL` still wins over config. |
| `authBrokerToken` | `auth: { broker: { token } }` | string | _(empty)_ | Auth-broker bearer token, shown as **Auth Broker Token**. Write-only in `/settings`: a stored token renders as a mask and is never echoed; enter a new value to replace it, leave the mask to keep it, or clear the field to delete it. `VEYYON_AUTH_BROKER_TOKEN` still wins over config. |

### Every other setting

The sections above are the settings worth explaining at length. For the complete list, see the [settings reference](./settings-reference.md): every setting that appears in `/settings`, with its key, type, default, and what it does, grouped exactly as the tabs are. That page is generated from the schema, so it cannot fall behind the code; the narrative here is the part written by hand.

`veyyon config list` shows the same set with your current values.

## Legacy migration

`veyyon` migrates older config shapes automatically. None of these require action; they are listed so you know what changes you may see in `config.yml`.

### Startup migration to `config.yml`

When `~/.veyyon/profiles/default/agent/config.yml` does not exist, startup builds it once from legacy sources, then writes the result:

1. `~/.veyyon/profiles/default/agent/settings.json` (renamed to `settings.json.bak` after a successful migration).
2. Settings persisted in `agent.db`.

After `config.yml` exists, these legacy sources are no longer consulted. The generic config loader also performs `.json` -> `.yml` migration for other config files when only the `.json` form is present.

### Field-level migrations

Applied whenever raw settings are loaded (profile config, `--config` overlays, and runtime overrides):

| Old | New |
|---|---|
| `queueMode` | `steeringMode` |
| `ask.timeout` in milliseconds (value `> 1000`) | seconds (divided by 1000), and the rewrite is logged with both values |
| flat `theme: "<name>"` string | `theme.dark` / `theme.light` (slot chosen by luminance; built-in `light`/`dark` are dropped to use defaults) |
| `task.isolation.enabled: true/false` | `subagent.isolation.mode: auto/none` |
| `task.simple` | removed |
| legacy `task.isolation.mode` (`worktree`, `fuse-overlay`, `fuse-projfs`) | `rcopy`, `overlayfs`, `projfs` |
| `task.eager` (`default` / `preferred` / `always`, or a boolean) | `subagent.delegation` (`allowed` / `preferred` / `required`) |
| `task.batch`, `task.maxConcurrency`, `task.maxRecursionDepth`, `task.maxRuntimeMs`, `task.softRequestBudget`, `task.softRequestBudgetNotice`, `task.showResolvedModelBadge`, `task.enableLsp` | the same names under `subagent.` |
| `task.agentIdleTtlMs` | `subagent.idleTtlMs` |
| `task.isolation.*` | `subagent.isolation.*` |
| `task.disabledAgents` | one row per agent in `subagent.agents` |
| `task.agentModelOverrides` | dropped, and each override is named in the log. Per-agent models no longer exist: `subagent.model` (with `subagent.thinkingLevel`) is the one owner, and an agent that needs its own model says so in its own `model:` frontmatter. A `subagent.agents.<name>.model` or `.thinkingLevel` left in a config is ignored and reported the same way. |
| `modelRoles.task` | `subagent.model` (the `task` role is retired) |
| `lastChangelogVersion` | moved to a marker file and stripped from `config.yml` |
| `collapseChangelog` | removed; startup no longer prints release notes, so there is nothing to collapse. Use `startup.updateNotice` to control the one-line notice that replaced it. |

## Troubleshooting

### A `.veyyon/config.yml` in a repository is ignored

That is the rule, not a malfunction: a working tree never configures the agent, so a checked-in settings file is not read. Move the values into your profile config, pass them for one run with `--config <file>`, or use a path-scoped array for `enabledModels` / `disabledProviders`.

### An array from my profile disappeared under an overlay

Arrays replace; they do not append. If an overlay sets `disabledProviders`, `enabledModels`, `cycleOrder`, `extensions`, or any other array, include the **complete** desired value in the overlay, the profile array is fully replaced.

### A provider is still available after editing config

- Check whether you disabled the model provider id (e.g. `anthropic`) or a discovery source id (e.g. `claude`): they are different namespaces with different effects.
- Check for an overlay `disabledProviders` array replacing your profile one.
- Credentials can still come from environment variables, `.env`, OAuth, stored auth, or `models.yml`; disabling a provider blocks selection regardless, but verify you edited the right layer. See [Providers](./providers.md).
- Restart the session if the model list was already initialized.

### `veyyon config set` changed the wrong file

`veyyon config set` and `veyyon config reset` always write the `config.yml` under the active agent directory. Run `veyyon config path` to print it.

### `veyyon config reset` removed my global override

That is what reset does: it deletes the key from the profile `config.yml` so the schema default (or an overlay or runtime value) applies. To keep a custom value, run `veyyon config set <key> <value>` again.

### A `--config` overlay fails at startup

`--config` files are process-local YAML mappings. A missing file, invalid YAML, or a top-level array/scalar is a hard error, it does not silently fall back to lower-precedence settings. Fix the path or contents.

### An environment variable beats my config

Some settings (model roles, eval backends, tiny-model device/precision, auth broker, PTY) are overridable by env vars or CLI flags for per-machine convenience, and those take precedence over `config.yml`. Unset the variable or drop the flag to let the persisted value win. See [Environment overrides](#environment-overrides) and [Environment variables](./environment-variables.md).

### `veyyon config set <key>` says "Unknown setting"

Keys must match a schema path exactly, with no shorthand. Use `theme.dark`, not `theme`. Run `veyyon config list` to see every valid key.
