# Models, roles, and profiles

## Concepts

| Concept | Meaning |
| --- | --- |
| **Default model** | The model used for the main conversation, and the one a new session starts on. Chosen with `/model` or `--model`, or in `/settings` under Model. Persisted under `modelRoles.default`, which is a slot rather than a selectable role, so it does not appear in role pickers. |
| **Role** | A named model assignment for a kind of work (`smol`, `plan`, `advisor`, and others). Configure it in `modelRoles` or Settings → Model → Roles. |
| **Slot override** | `subagent.model` or `compaction.model`, an ordered model chain for one subsystem. An unset slot inherits the interactive model. |
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
  advisor: anthropic/claude-sonnet-5:medium
```

Role values may include a thinking suffix (`:off`, `:auto`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). The model picker shows only variants the selected model supports. If a provider publishes effort tiers as separate upstream IDs, Veyyon presents one logical model and routes the chosen effort to the matching ID.

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
| `subagent.model` | Ordered model chain for every subagent that has no model of its own. The first entry is primary and later entries are fallbacks. An unset chain inherits the interactive model. A per-agent model in `subagent.agents` wins over it. |
| `compaction.model` | Ordered model chain for compaction and handoff. An unset chain inherits the interactive model. |

```yaml
subagent:
  model: deepseek/deepseek-chat:high,anthropic/claude-sonnet-5:low
compaction:
  model: openai/gpt-5-mini:low,anthropic/claude-haiku-4-5
  strategy: handoff
  threshold: "80%"
```

In Settings, Enter edits the highlighted chain position. **Add fallback**
appends a position. Delete removes only the highlighted position.

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
