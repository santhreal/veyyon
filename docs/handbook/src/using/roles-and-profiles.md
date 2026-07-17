# Models, roles, and profiles

Veyyon keeps model selection explicit and simple. Three ideas stay separate:

- the **model you talk to** — chosen live,
- **roles** — optional named model assignments, configured in settings and scoped per profile,
- **profiles** — separate user config trees.

## Three model slots

Veyyon gives you three explicit model choices. Each is set on its own — there is no `default` model
that silently stands in for the others.

| Slot | Runs | Where you set it |
| --- | --- | --- |
| **Interactive model** | the conversation you are in | `/model` (live), `--model`, `config.yml` `model` |
| **Subagent model** | task subagents | settings → Models |
| **Compaction model** | context compaction | settings → Models |

Leave the subagent or compaction model unset and that slot uses your interactive model.

## Picking the interactive model

Use `/model`, the model carousel, or the CLI (`--model`). Your choice is saved to the active profile's
`config.yml` and applies to the conversation. This is the only model you choose from the picker.

## Subagent and compaction models

Set them once in **settings → Models**, or in `config.yml`:

```yaml
modelRoles:
  default: anthropic/claude-sonnet-5   # interactive
subagent:
  model: anthropic/claude-haiku-4-5
compaction:
  model: openai/gpt-5
```

They are plain fields — one model each, no per-role matrix and no indirection. When a task subagent
spawns, it runs on `subagent.model`. When context is compacted, it runs on `compaction.model`.

## Roles (optional)

A **role** is a named model assignment for a kind of work (`task`, `plan`, `advisor`, …). Roles are
optional. Edit them in **`/settings` → Model → Roles → Role Models**: pick a role, then use the
**searchable model selector** (auth / local / no auth shown on each row). Never edit `config.yml` for
this — settings writes the active profile’s assignments for you.

`default` is not a role and not a model. The model you pick with `/model` is simply your interactive
model; nothing falls back through a `default` slot.

### Task subagents

The main agent spawns **task** subagents for parallel scoped work. They run on `subagent.model`.
Task isolation (`task.isolation.*`) and concurrency (`task.maxConcurrency`) are settings — not a
surface you configure every turn.

## Compaction settings

Compaction has exactly three settings, in **settings → Models → Compaction**:

1. **Auto-compaction threshold** (`compaction.thresholdPercent`) — when to compact.
2. **Type** (`compaction.strategy`) — `handoff` or `snap`.
3. **Model** (`compaction.model`) — the compaction model above.

See [Memory and compaction](../features/memory.md) for what each type does.

## Profiles

A **profile** relocates `~/.veyyon/agent/` to `~/.veyyon/profiles/<name>/agent/` for native Veyyon
config (settings, sessions, MCP, skills, hooks, and your role assignments and model slots). Activate
with `veyyon --profile <name>` or `VEYYON_PROFILE`.

Profiles are chosen at process start; `/profile <name>` in the TUI relaunches Veyyon on the target
profile as a fresh session. See [Profiles](../features/profiles.md) for the lifecycle commands
(`veyyon profile list/new/rm`), the `/profile new` copy picker, and display-name renaming.

## Tool approval

Behavior is governed by `tools.approvalMode` (`plan`, `ask`, `auto-edit`, `yolo`) and per-tool
`tools.approval` overrides. Configure in `/settings` → Safety or `--approval-mode` on launch.

## Where each choice lives

| You want to | Where |
| --- | --- |
| Change the interactive model | `/model`, `config.yml` `model` |
| Set the subagent model | settings → Models (`subagent.model`) |
| Set the compaction model | settings → Models (`compaction.model`) |
| Assign models to roles (optional) | settings → Models → Roles, per profile |
| Separate user config trees | `veyyon --profile <name>` |
| Tighten tool prompts | `tools.approvalMode`, `tools.approval` |

## See also

- [Profiles](../features/profiles.md)
- [Models and providers](./models.md)
- [Memory and compaction](../features/memory.md)
- [Configuration](./configuration.md)
