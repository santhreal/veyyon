# Tools reference

Model-facing tools are advertised to the model per turn. Availability depends on
settings, approval mode, plan mode, memory backend, and feature flags.

For approvals see [Approvals and autonomy](../features/sandbox.md). For MCP tools see [MCP](../features/mcp.md).
Per-tool engineering specs live under [`docs/tools/`](../../../tools/).

## Core loop

1. Model emits a tool call (JSON arguments per schema).
2. Veyyon validates arguments; handlers run after approval checks.
3. Text or structured output returns to the conversation.

General schema repair runs before dispatch on all schema-bearing tool calls; tool-specific
leniency (e.g. hashline parsing) is layered on top. See [Repair overview](../repair/overview.md).

## Edit and write (built)

| Tool | Purpose |
| --- | --- |
| `edit` | Apply changes — default **hashline** `input` string (`edit.mode`) |
| `write` | Create or overwrite a whole file |
| `apply_patch` | V4A envelope when `edit.mode: apply_patch` |

Hashline flow: `read`/`grep` mint `[path#TAG]` anchors → model copies tags into `edit` →
`@veyyon/hashline` applies ops. See [Edit engine](../edit/engine.md) and
[`docs/tools/edit.md`](../../../tools/edit.md).

## Read and search (built)

| Tool | Purpose |
| --- | --- |
| `read` | Files, dirs, URLs, archives, SQLite, `memory://`, `skill://`, … |
| `grep` | Ripgrep-backed search; hashline headers in hashline display mode |
| `glob` | Path globbing |
| `search_tool_bm25` | Discover tools by description (when enabled) |

## Shell and execution (built)

| Tool | Purpose |
| --- | --- |
| `bash` | Shell commands, gated by the approval mode |
| `ssh` | Remote commands via configured hosts |
| `eval` | JS/Python/Julia/Ruby eval cells (when enabled) |
| `debug` | Debugger integration |
| `browser` | Browser automation |
| `job` | Background job control |

## Agent coordination (built)

| Tool | Purpose |
| --- | --- |
| `task` | Spawn subagents |
| `irc` | Inter-agent messaging |
| `todo` | Structured task lists |
| `goal` | Goal card updates (with goal mode) |
| `ask` | User questions |
| `yield` | Yield turn for follow-ups |

## Memory (when backend enabled)

| Tool | Purpose |
| --- | --- |
| `recall`, `retain`, `reflect`, `memory_edit` | Mnemopi/hindsight surfaces |
| `learn` | Autolearn (when `autolearn.enabled`) |

## Other builtins

Includes `web_search`, `github`, `lsp`, `ast_edit`, `ast_grep`, `checkpoint`, `rewind`, `resolve`,
`manage_skill`, `launch`, `inspect_image`, `generate_image`, `tts`, `report_finding`, and MCP tools
(`mcp__*`). Extension hooks may register more.
