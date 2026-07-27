# Models, roles, and profiles

## Concepts

| Concept | Meaning |
| --- | --- |
| **Default model** | The model used for the main conversation, and the one a new session starts on. Chosen with `/model` or `--model`, or in `/settings` under Model. Persisted under `modelRoles.default`, which is a slot rather than a selectable role, so it does not appear in role pickers. |
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
| `tiny` | Tiny | Lightweight background work: titles, classifiers |
| `advisor` | Advisor | Advisor runtime |

Custom role names can appear via `modelRoles`, `modelTags`, or `cycleOrder` entries.

Unset selectable roles, `advisor` included, **inherit the live interactive model** at use time. No role carries a built-in model chain: a role you have not set names no model of its own, so nothing you did not choose ends up running.

A caller may still ask for several roles in order. Title generation, for example, asks for `tiny`, then `commit`, then `smol`, and takes the first one you have set. That order belongs to the caller, not to the role: `tiny` does not fall back to `smol`, the title generator prefers `tiny` and accepts `smol`. If you have set none of them, the whole list is unset and the caller inherits the interactive model like any other unset role.

There is no `task` role. The model your subagents run is set in the Subagents settings area, which owns that decision on its own; see [Settings: Subagents](../../../settings.md#subagents).

To return an assigned role or slot to its unset state, open its picker in `/settings` and choose the first row, `(inherit main model)` (the default model's picker reads `(auto-select on launch)`). Del or Backspace with an empty search does the same.

## Slot overrides

| Setting | Effect |
| --- | --- |
| `subagent.model` | Model for every subagent that has no model of its own. Unset → inherit interactive. A per-agent model in `subagent.agents` wins over it. |
| `compaction.model` | Model for compaction/handoff. Unset → inherit interactive. |

```yaml
subagent:
  model: deepseek/deepseek-chat
compaction:
  model: openai/gpt-5-mini
  strategy: handoff
  threshold: "80%"
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

### Instruction Files: Global vs Per-Profile (`AGENTS.md`)

Veyyon discovers exactly **two user-level instruction layers** before every session:

1. **Global User Layer (`~/.veyyon/AGENTS.md`)**: Applies across EVERY profile and workspace. Reserved for cross-profile standing rules.
2. **Active Profile Layer (`~/.veyyon/profiles/<profile_name>/...`)**: Applies ONLY to the active profile. Scanned in **descending priority order** (first match wins; exactly 1 file loaded per profile to prevent duplication):
   1. `~/.veyyon/profiles/<name>/agent/AGENTS.md` (Highest)
   2. `~/.veyyon/profiles/<name>/AGENTS.md`
   3. `~/.veyyon/profiles/<name>/agent/agent.md`
   4. `~/.veyyon/profiles/<name>/agent.md` (Lowest)

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
