---
title: "Argot: Per-Project Vocabularies for Coding Agents"
slug: argot
date: 2026-07-19
summary: "A per-project dictionary format and codec for replacing repeated strings with short token handles."
draft: true
---

# Argot: Per-Project Vocabularies for Coding Agents

Argot defines a per-project shorthand vocabulary and codec. It maps frequently repeated strings, such as file paths, commands, and import roots, to short identifier handles prefixed with a sigil. The model writes the handle during generation; the runtime expands the handle to the full string before tool execution, display, or persistence.

## Dictionary format

The dictionary format uses TOML:

```toml
version = 1
sigil = "§"

[handles]
dbconn = "packages/server/src/database/connection.ts"
tsc    = "CARGO_TARGET_DIR=/dev/null bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit"
migr   = "packages/server/src/database/migrations"
```

Each entry in `[handles]` defines a handle identifier and its target expansion string. The `sigil` field defines the prefix character that distinguishes handle tokens from surrounding text.

Handle names must match `^[a-z0-9_]+$`. Expansions must be non-empty strings and cannot contain the sigil character.

## Codec execution

Argot operates at two boundaries:

1. **Model input**: System prompts provide the active handle mapping in prompt context.
2. **Model output**: Generated text passes through the Argot decoder before reaching tool execution, TUI rendering, session transcripts, or subagent message channels.

The decoder replaces handles with their expansions:

- **Longest match**: Given both `§db` and `§dbconn`, `§dbconn` matches first.
- **Identifier boundaries**: A match triggers only when not immediately followed by identifier characters (`[a-z0-9_]`). For example, `§dbextra` is not matched if `dbextra` is undefined, and `§db` is not expanded out of it.
- **Passthrough**: Unrecognized handle patterns pass through unchanged.

Decoded text is the only form stored in session transcripts or passed to system tools.

## Discovery and caching

Project dictionaries are generated dynamically rather than committed to repositories:

1. The agent invokes the `argot_load` tool with a target directory path.
2. The runtime resolves the repository root by locating `.git` or a `.argot` marker file.
3. The runtime scans tracked files, identifies repeated string candidates, ranks them by potential token reduction, and generates the active dictionary.
4. Generated dictionaries are cached locally in the profile directory. Cache keys derive from the git commit SHA or the file listing signature.
5. The `argot_unload` tool clears active handles from the current session context.

## Scoping and configuration

Dictionary entries can be scoped to specific subtrees using the `[meta]` table:

```toml
[meta.dbconn]
note  = "Database connection module"
scope = "packages/server/**"
```

When a scope glob is specified, the runtime activates the handle only when operations occur within matching paths.

Settings controls:

- `argot.enabled`: Master toggle for Argot functionality (default `false`).
- `argot.models`: List of model IDs permitted to receive handle dictionaries.
