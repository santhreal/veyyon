# search

> Locate paths, find exact occurrences, or analyze code through one model-facing tool.

## Source

- Entry: `packages/coding-agent/src/tools/search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search.md`
- Collaborators: `packages/coding-agent/src/tools/glob.ts`, `packages/coding-agent/src/tools/grep.ts`, `packages/coding-agent/src/tools/ast-grep.ts`

## Enablement

Set `tools.unifiedSearch: true`. The default `false` keeps the separate `glob`, `grep`, and `ast_grep` tools.

The unified tool exposes only capabilities enabled by `glob.enabled`, `grep.enabled`, and `astGrep.enabled`. If all three are disabled, `search` is not loaded.

## Purposes

| Purpose | Question answered | Delegated implementation |
| --- | --- | --- |
| `locate` | Where are the relevant files or directories? | `glob` |
| `match` | Where does this exact identifier, literal, configuration value, or regex occur? | `grep` |
| `analyze` | Which definitions, calls, methods, types, imports, or syntax relationships match? | `ast_grep` |

Each purpose preserves the delegated implementation's output, limits, cancellation behavior, and filesystem boundary checks. The result details include the selected purpose and delegated details. When unified search is enabled, `search` owns workspace discovery; the separate model-facing search tools are absent.
