# Tools reference

Model-facing tools are advertised to the model per turn. Availability depends on
settings, approval mode, plan mode, memory backend, and feature flags.

For approvals see [Approvals](../features/sandbox.md). For MCP tools see [MCP](../features/mcp.md).
Per-tool engineering specs live under [`docs/tools/`](../../../tools/).

## Core loop

1. Model emits a tool call (JSON arguments per schema).
2. Veyyon validates arguments; handlers run after approval checks.
3. Text or structured output returns to the conversation.

General schema repair runs before dispatch on all schema-bearing tool calls; tool-specific
leniency (e.g. hashline parsing) is layered on top. See [Repair overview](../repair/overview.md).

## Edit and write

| Tool | Purpose |
| --- | --- |
| `edit` | Apply changes, default **hashline** (`edit.mode: hashline`); also `apply_patch` / `patch` / `replace` modes |
| `write` | Create or overwrite a whole file |

Hashline flow: `read`/`grep` mint `[path#TAG]` anchors → model copies tags into `edit` →
`@veyyon/hashline` applies ops. See [Edit engine](../edit/engine.md) and
[`docs/tools/edit.md`](../../../tools/edit.md).

## Read and search

| Tool | Purpose |
| --- | --- |
| `read` | Files, dirs, URLs, archives, SQLite, `memory://`, `skill://`, … |
| `grep` | Ripgrep-backed search; hashline headers in hashline display mode |
| `glob` | Path globbing |
| `search_tool_bm25` | Discover tools by description (when enabled) |

## Shell and execution

| Tool | Purpose |
| --- | --- |
| `bash` | Shell commands, gated by the approval mode |
| `ssh` | Remote commands via configured hosts |
| `eval` | JS/Python/Julia/Ruby eval cells (when enabled) |
| `debug` | Debugger integration |
| `browser` | Browser automation |
| `job` | Background job control |

### Long-running and stuck commands

Two opt-in settings decide when a foreground `bash` call is moved to a background job. Both are off by default, and both hand the command to the `job` tool so its result still arrives later. You set them per profile in `/settings`, under Shell.

Turn on **Bash Auto-Background** to cap how long a command holds the model in the foreground. Once a call runs longer than "Auto-Background After" (`bash.autoBackground.thresholdMs`, default 1 minute), it moves to the background and the model keeps working. This fires on elapsed time even while the command is still printing: a test suite that takes forty minutes should not hold the model, and a long foreground command would otherwise outlast the prompt cache. Set the value to "Immediately" to background every command up front.

Turn on **Bash Stall Detection** to catch a command that has gone quiet. When a call produces no new output for "Stall After" (`bash.stallDetection.stallMs`, default 30 seconds), it is backgrounded and the model is told it may be stuck, along with the exact `job` cancel to run. This measures idle output, not total run time, so a command that keeps printing never trips it. The model decides: if the quiet was expected (a slow compile, a network wait), it lets the job finish; if the command is genuinely hung, it cancels it. The setting recommends, it never force-kills.

## Agent coordination

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
