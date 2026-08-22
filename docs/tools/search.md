# search

> Search paths, text, or syntax through one model-facing tool.

## Source

- Entry: `packages/coding-agent/src/tools/search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search.md`
- Collaborators: `packages/coding-agent/src/tools/glob.ts`, `packages/coding-agent/src/tools/grep.ts`, `packages/coding-agent/src/tools/ast-grep.ts`

## Enablement

Set `tools.unifiedSearch: true`. The default `false` keeps the separate `glob`, `grep`, and `ast_grep` tools.

The unified tool exposes only capabilities enabled by `glob.enabled`, `grep.enabled`, and `astGrep.enabled`. If all three are disabled, `search` is not loaded.

## Modes

| Mode | Operation | Delegated tool |
| --- | --- | --- |
| `files` | Find files and directories by path pattern. | `glob` |
| `text` | Search file contents with a regular expression. | `grep` |
| `ast` | Search source by syntax shape. | `ast_grep` |

Each mode preserves the delegated tool's output, limits, cancellation behavior, and filesystem boundary checks. The result details include the selected mode and the delegated tool details.
