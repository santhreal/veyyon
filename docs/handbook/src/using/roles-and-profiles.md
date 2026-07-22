# Models, roles, and profiles

## Concepts

| Concept | Meaning |
| --- | --- |
| **Interactive model** | The model used for the main conversation. Chosen with `/model` or `--model`. Persisted under `modelRoles.default` (legacy key name; not a selectable “role” in the UI). |
| **Role** | A named model assignment for a kind of work (`smol`, `plan`, `task`, …). Configured in `modelRoles` / settings → Model → Roles. |
| **Slot overrides** | `subagent.model` and `compaction.model`, dedicated destinations that override the corresponding role or inherit the interactive model when unset. |
| **Profile** | User config tree at `~/.veyyon/profiles/<name>/` (including `default`). |

## Interactive model

- Set live with `/model` or the model picker; set for a run with `--model <provider/id>`.
- On “set as default” / persist paths, the value is stored as **`modelRoles.default`** in the active profile’s `config.yml`.
- There is no separate top-level `model:` settings key in the schema. Prefer the picker or `modelRoles.default` in config.

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
modelRoles:
  default: anthropic/claude-sonnet-5   # interactive model (persisted default)
  smol: openai/gpt-4.1-mini
  slow: anthropic/claude-opus-4-5:high
  plan: anthropic/claude-sonnet-5
  task: deepseek/deepseek-chat
  advisor: anthropic/claude-sonnet-5:medium
```

Role values may include a thinking suffix (`:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`).

## Built-in roles

From `packages/coding-agent/src/config/model-roles.ts`:

| Role id | UI name | Notes |
| --- | --- | --- |
| `default` | (hidden) | Storage key for the interactive model only; not shown in role pickers or default `cycleOrder` |
| `smol` | Fast | Cheap / fast work; `--smol` or env `VEYYON_SMOL_MODEL` |
| `slow` | Thinking | Heavier reasoning; `--slow` or env `VEYYON_SLOW_MODEL` |
| `vision` | Vision | Multimodal work |
| `plan` | Architect | Plan mode; `--plan` or env `VEYYON_PLAN_MODEL` |
| `designer` | Designer | Design-oriented work |
| `commit` | Commit | Commit / changelog generation |
| `tiny` | Tiny | Lightweight background (titles, classifiers); else falls back toward `@smol` |
| `task` | Subtask | Task subagents unless `subagent.model` is set |
| `advisor` | Advisor | Advisor runtime; unset uses thinking-model chain |

Custom role names can appear via `modelRoles`, `modelTags`, or `cycleOrder` entries.

Unset selectable roles **inherit the live interactive model** at use time (except `advisor`, which uses its own chain when unset).

## Slot overrides

| Setting | Effect |
| --- | --- |
| `subagent.model` | Model for task subagents. Unset → inherit interactive. When set, overrides `modelRoles.task`. |
| `compaction.model` | Model for compaction/handoff. Unset → inherit interactive. |

```yaml
subagent:
  model: deepseek/deepseek-chat
compaction:
  model: openai/gpt-5-mini
  strategy: handoff
  thresholdPercent: 80
```

## Cycling roles (Ctrl+P)

`cycleOrder` lists which **roles** the model switcher cycles (`app.model.cycleForward` / `cycleBackward`, default chords often Ctrl+P / Shift+Ctrl+P).

- Schema default: `["smol", "slow"]` (see `DEFAULT_CYCLE_ORDER`).
- The string `default` is **stripped** from `cycleOrder` on load; the interactive model is not cycled as a role entry.
- Scoped models (`--models` / enabled model list) can also drive cycling when configured.

```yaml
cycleOrder:
  - smol
  - slow
  - plan
```

## Profiles

Every profile including `default`:

```text
~/.veyyon/profiles/<name>/agent/   # config.yml, sessions, MCP, skills, …
```

Global `~/.veyyon/config.yml` holds cross-profile keys such as `defaultProfile`.  
Activate: `--profile`, `VEYYON_PROFILE`, `veyyon profile default <name>`, TUI `/profiles` picker or `/profile <name>` (relaunch).  
See [Profiles](../features/profiles.md), [File locations](../reference/file-locations.md).

## Approvals

`tools.approvalMode`: `plan` | `ask` | `auto-edit` | `yolo` (schema default `yolo`).  
Aliases: `always-ask` → `ask`, `write` → `auto-edit`.  
See [Approvals](../features/sandbox.md).

## Related

- [Models and providers](./models.md)
- [Settings: models](../../../settings.md) (repo `docs/settings.md`)
- [Compaction](../context/compaction-memory.md)
