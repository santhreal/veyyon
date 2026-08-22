# Argot

Argot is a per-project token shorthand codec for model interactions. A project dictionary maps short handles to recurring text strings such as paths, import roots, and build commands. The model outputs the handle, and the runtime expands the handle to the full string before passing arguments to tools, rendering UI, or appending to transcripts.

For configuration and flags, see [Save tokens with project shorthand](../using/configuration.md#save-tokens-with-project-shorthand-argot-experimental).

## Shorthand format

A handle consists of a sigil prefix followed by an identifier:

- The default sigil is `§`.
- Identifiers use lowercase ASCII letters, digits, and underscores.
- Per-project sigils are configured in the dictionary's `sigil` field.

When the model emits `§build`, the runtime replaces `§build` with the configured string before executing the command in the shell.

## Dictionary structure

Handles are defined in an `AGENTS.dict` file:

```toml
sigil = "§"

[handles]
build = "node --experimental-vm-modules ./scripts/build.mjs --target release --profile ci"
dbconn = "src/server/db/connection.ts"
```

The dictionary format enforces length bounds on expansions and includes a schema version. Files with incompatible major versions fail load validation.

The dictionary is generated automatically from project contents. When a session starts or the `argot_load` tool runs on a target directory, the generator identifies recurring strings, ranks candidates by token reduction, and stores the compiled dictionary in the local cache directory. Nothing is written to the repository working tree.

Automatic startup loading is controlled by `argot.autoload` (enabled by default).

## Codec boundaries

The codec operates under two distinct boundaries:

- **Decoding**: Turning handles back into full text is unconditional. Whenever a dictionary is active, all handles are expanded before text reaches tool execution, transcript storage, or terminal display.
- **Encoding**: Teaching shorthand syntax to the model is controlled by configuration:
  - Model allowlist (`argot.models`): Shorthand instructions are provided only to explicitly allowed models.
  - Context cutoff (`argot.maxContextTokens`): Shorthand instructions are omitted once session context exceeds the specified token limit.

When encoding is disabled, the model writes full strings. Decoding remains active so existing handles in session history continue to expand.

## Cache storage

Cache entries are content-keyed using the repository commit hash or a directory fingerprint:

- Cache files are immutable once written.
- Distinct commits produce separate cache entries.
- Stored transcripts contain expanded text rather than raw handles, allowing cache entries to be discarded and rebuilt without corrupting session history.

To rebuild a project cache, remove the cached dictionary directory under `~/.veyyon/cache/argot/`.

## Subagent boundary

Subagents evaluate shorthand independently:

- Each agent instance expands its output before invoking tools, writing transcripts, prompting subagents, or returning values to a parent agent.
- Raw handles do not cross agent boundaries.
- The `argot.subagents` setting controls whether child agents inherit the parent dictionary, generate a project-specific dictionary, or operate without shorthand. See [Subagents configuration](../using/configuration.md#choose-how-subagents-start).

## Related

- [Save tokens with project shorthand](../using/configuration.md#save-tokens-with-project-shorthand-argot-experimental)
- [Mechanisms](./innovations.md)
