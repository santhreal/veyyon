# Personalities

Configure personality via `/settings` or the `personality` key in `config.yml` (below).

Personalities change **how the agent writes replies**, not which tools it has or `tools.approvalMode`.

## Built-in personalities

A personality injects a `<personality>` block into the system prompt when enabled, changing tone only.

| Personality | Config value | Effect |
| --- | --- | --- |
| Default | `default` | Built-in default system personality text |
| Pragmatic | `pragmatic` | Concise, task-focused prompt text |
| Friendly | `friendly` | Collaborative prompt text |
| None | `none` | No personality block |

Schema default: `personality: default` in `settings-schema.ts`. The setting is a free-form string, not a closed enum — see [Extending the catalog](#extending-the-catalog).

## Configuring personality

- **Settings UI:** `/settings` → **Model** tab → **Prompt** group → **Personality**. Options are resolved at render time (built-ins + your `~/.veyyon/personalities` and project `.veyyon/personalities` files); changing the value refreshes the base system prompt immediately.
- **Config file:** in `~/.veyyon/profiles/default/agent/config.yml` (or profile agent dir):

```yaml
personality: pragmatic
```

There is no `/personality` slash command in the shipped registry. Subagents use `none` regardless of the main setting (`sdk.ts`).

## Extending the catalog

The 3 shipped personalities are seeds, not a closed set. Add a `<name>.md` file and its filename stem becomes a selectable personality name; the file body is injected verbatim as the `<personality>` block:

- **User-level:** `~/.veyyon/personalities/<name>.md` — available in every project.
- **Project-level:** `.veyyon/personalities/<name>.md` — available only in that project, and overrides a user or built-in personality of the same name.

Precedence for a given name is **project > user > built-in**. For example, dropping `~/.veyyon/personalities/pirate.md` with the body `You speak like a pirate.` and setting `personality: pirate` renders `<personality>You speak like a pirate.</personality>` with no rebuild. A project `.veyyon/personalities/default.md` overrides the built-in `default` for that project only.

Edge cases:

- `none` is a reserved sentinel that disables the block; a file literally named `none.md` is ignored (it can never shadow the disable behavior).
- An empty or whitespace-only personality file is treated as absent — the next tier (or the built-in) is used instead, so the block is never emitted empty.
- Setting `personality` to a name that resolves to nothing (no built-in, user, or project file) falls back to `default` and prints a visible warning; the `<personality>` block is never silently emitted empty for a real (non-`none`) request.

See `packages/coding-agent/src/personality/resolver.ts` for the resolver implementation.

## Boundaries

- Personality does not grant tools, change `tools.approvalMode`, or bypass sandboxing.
- Personality text is escaped and injected as a bounded system-prompt section; it cannot override project rules or tool policy.

## See also

- [Configuration](../using/configuration.md)
- [System prompt customization](https://github.com/santhreal/veyyon/blob/main/docs/system-prompt-customization.md) (engine doc)
