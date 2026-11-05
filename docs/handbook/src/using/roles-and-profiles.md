# Models, helpers, and profiles

## Concepts

| Concept | Meaning |
| --- | --- |
| **Default model** | The model a new session starts on. Set with `/model`, for one run with `--model`, or in `/settings` under Model → Default Model. Stored as `defaultModel`. |
| **Helper** | A model call a feature makes on its own behalf: the advisor, plan mode, image description, commit messages, session titles, and others. Configured under `agent.helpers` or in `/settings` under Agents → Roster → Helpers. |
| **Agent policy** | The blanket model and effort plus per-agent `enabled`, `model`, `thinkingLevel`, and `maxNestedSpawnDepth` choices under `agent`. |
| **Profile** | User config tree at `~/.veyyon/profiles/<name>/` (including `default`). |

## Default model

- `/model` switches the live model. Persisting the choice writes `defaultModel` in the active profile's `config.yml`.
- `--model <provider/id>` sets the model for one run and is never written back.
- `defaultModel` is an ordered chain: a comma-separated string or a list. The first entry that matches an available model is used, and later entries are retry fallbacks for it.
- Unset, a new session starts on an available model that has credentials.

```yaml
# ~/.veyyon/profiles/default/agent/config.yml
defaultModel: anthropic/claude-sonnet-5:medium,openai/gpt-5
```

A model value may include a thinking suffix (`:off`, `:auto`, `:minimal`, `:low`, `:medium`, `:high`, `:xhigh`, `:max`). The model picker shows only variants the selected model supports. If a provider publishes effort tiers as separate upstream IDs, Veyyon presents one logical model and routes the chosen effort to the matching ID.

`Ctrl+P` and `Shift+Ctrl+P` (`app.model.cycleForward`, `app.model.cycleBackward`) cycle the scoped models when `--models` is set, and the available models otherwise.

## Helpers

Each helper reads `agent.helpers.<id>.model` and `agent.helpers.<id>.thinkingLevel`.

| Helper id | Roster label | Runs |
| --- | --- | --- |
| `advisor` | Advisor | Reviews the session's turns while the advisor is on. |
| `plan` | Plan | Runs the session while plan mode is on. `--plan <model>` sets it for one run. |
| `vision` | Vision | Describes images for `inspect_image` and for a session model without image input. |
| `commit` | Commit | Writes commit messages and changelog entries for `veyyon commit`. |
| `title` | Session Title | Names each session from its first messages. |
| `memory` | Memory | Extracts and consolidates memories when memory is on. |
| `autoThinking` | Auto Thinking | Rates each prompt's difficulty for the `auto` effort. |
| `unexpectedStop` | Unexpected Stop | Checks whether a turn stopped before it finished, when detection is on. |
| `speech` | Speech | Rewrites a reply for speech before it is spoken aloud. |
| `completion` | Eval Completion | Answers `completion()` calls from the eval tool. |

A helper with no model runs the session's live model, and one with no effort runs the session's effort. A caller with no session, such as `veyyon commit` or a headless title, runs `defaultModel` instead. A helper model is an ordered chain like `defaultModel`; a `:level` suffix on the matching entry outranks the helper's `thinkingLevel`. A configured chain that matches no available model leaves the feature without a model, and the feature reports the setting to fix.

The `vision` helper searches further, because its job is to find a model that accepts images when the session model does not. `inspect_image` and image description for a text-only session model both take the first image-capable model from the `vision` chain, then `defaultModel`, then the session model, then any available model, skipping text-only models. A `vision` chain whose matched models are all text-only fails `inspect_image` with the setting to fix. The request runs at the `vision` helper's effort, or a `:level` on its matched entry, else the session's effort, fitted to the efforts the chosen model offers.

```yaml
agent:
  helpers:
    title:
      model: openai/gpt-5-mini
      thinkingLevel: low
    plan:
      model: anthropic/claude-opus-4-5:high
```

In `/settings`, Agents → Roster lists the subagents, then the helpers, with the model and effort each one runs; a cell that reads `session` follows the session's model or effort. Enter opens a helper's page, which edits its model and effort, and Esc returns to the helper's row. Choosing the first row of a picker, or Del or Backspace with an empty search, returns the value to unset.

A config from an earlier version that holds `modelRoles` is migrated on load. `modelRoles.default` becomes `defaultModel`. Each helper takes the first role that was set, in this order:

| Helper | Roles read |
| --- | --- |
| `advisor`, `plan`, `vision` | the role of the same name |
| `commit` | `commit`, then `smol` |
| `title` | `tiny`, then `commit`, then `smol` |
| `memory`, `autoThinking`, `unexpectedStop`, `speech` | `tiny`, then `smol` |

An `@role` reference in another model setting is replaced by that role's models. `slow`, custom roles, `cycleOrder`, `modelTags` and role-keyed retry fallback chains are dropped, and the log lists each dropped value.

## Agent policy and compaction overrides

| Setting | Effect |
| --- | --- |
| `agent.sharedModel` | Which scope sets an agent's model and effort. Off, each agent's own row does. On, the two rows below do, for every agent. |
| `agent.model` | Ordered model chain every agent runs while `agent.sharedModel` is on. The first entry is primary and later entries are fallbacks. Unset runs every agent on the spawning session's live model. |
| `agent.thinkingLevel` | Effort every agent runs at while `agent.sharedModel` is on. `inherit` runs the spawning session's live effort. |
| `agent.agents` | Per-agent `enabled`, `model`, `thinkingLevel`, and `maxNestedSpawnDepth` choices. The `model` and `thinkingLevel` on a row apply while `agent.sharedModel` is off, and are not read while it is on. |
| `agent.delegation` | How strongly the model is prompted to delegate: `allowed`, `preferred`, or `required`. |
| `compaction.model` | Ordered model chain for compaction. Unset inherits the interactive model. |

```yaml
agent:
  sharedModel: true
  model: deepseek/deepseek-chat:high,anthropic/claude-sonnet-5:low
  agents:
    scout:
      enabled: false
    reviewer:
      thinkingLevel: auto
compaction:
  model: openai/gpt-5-mini:low,anthropic/claude-haiku-4-5
  strategy: summary
  threshold: "80%"
```

In Settings, Enter edits the highlighted chain position. **Add fallback**
appends a position. Delete removes only the highlighted position.

## Profiles

Every profile including `default`:

```text
~/.veyyon/profiles/<name>/agent/   # config.yml, sessions, MCP, skills, …
```

### Instruction Files: Global vs Per-Profile (`AGENTS.md`)

Veyyon discovers **two user-level instruction layers** before every session:

1. **Global User Layer (`~/.veyyon/AGENTS.md`)**: Applies across EVERY profile and workspace. Reserved for cross-profile standing rules.
2. **Active Profile Layer (`~/.veyyon/profiles/<profile_name>/...`)**: Applies ONLY to the active profile. Scanned in **descending priority order** (first match wins; 1 file loaded per profile to prevent duplication):
   1. `~/.veyyon/profiles/<name>/agent/AGENTS.md` (Highest)
   2. `~/.veyyon/profiles/<name>/AGENTS.md`
   3. `~/.veyyon/profiles/<name>/agent/agent.md`
   4. `~/.veyyon/profiles/<name>/agent.md` (Lowest)

Global `~/.veyyon/config.yml` holds cross-profile keys such as `defaultProfile`.  
Activate: `--profile`, `VEYYON_PROFILE`, `veyyon profile default <name>`, TUI `/profiles` picker or `/profile <name>` (relaunch).  
See [Profiles](../features/profiles.md), [File locations](../reference/file-locations.md).
## Approvals

`tools.approvalMode`: `plan` | `ask` | `ask-command` | `auto` | `yolo` (schema default `auto`).
Aliases: `always-ask` → `ask`, `write` and `auto-edit` → `ask-command`.
See [Approvals](../features/sandbox.md).

## Related

- [Models and providers](../reference/models-yml.md)
- [Settings: models](../reference/settings.md) (repo `docs/handbook/src/reference/settings.md`)
- [Compaction](../context/compaction-memory.md)
