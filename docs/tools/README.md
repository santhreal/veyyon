# Tool reference

One page per tool, written for the person changing it. Each page names the modules that
implement the tool, the arguments it accepts, what it returns, and how it fails.

For the operator's view of the same tools, what they are for and when the model reaches
for them, read [the handbook's tool reference](../handbook/src/reference/tools.md).

## Where a tool comes from

Three registries decide whether a tool exists in a session, and the difference shows up in
these pages:

| Registry | Declared in | Behavior |
| --- | --- | --- |
| `BUILTIN_TOOLS` | `packages/coding-agent/src/tools/index.ts` | The normal case. A factory that calls `createIf(...)` returns `null` when its setting is off, and the tool is then absent rather than disabled. |
| `HIDDEN_TOOLS` | the same file | Not offered to the operator and not listed in `/tools`. The model receives them when the session needs them. Only `resolve` has a page here. |
| Custom tools | `packages/coding-agent/src/sdk.ts` | Force-activated alongside the builtins, so an explicit tool whitelist has to name them or they are dropped. `generate_image` and `tts` are the two documented here. |

## Reading and writing files

| Tool | Page |
| --- | --- |
| `read` | [read.md](read.md) |
| `write` | [write.md](write.md) |
| `edit` | [edit.md](edit.md) |
| `glob` | [glob.md](glob.md) |
| `grep` | [grep.md](grep.md) |
| `ast_grep` | [ast-grep.md](ast-grep.md) |
| `ast_edit` | [ast-edit.md](ast-edit.md) |
| `resolve` | [resolve.md](resolve.md) (hidden: merge-conflict resolution) |

## Running things

| Tool | Page |
| --- | --- |
| `bash` | [bash.md](bash.md) |
| `launch` | [launch.md](launch.md) |
| `eval` | [eval.md](eval.md) |
| `debug` | [debug.md](debug.md) |
| `ssh` | [ssh.md](ssh.md) |
| `job` | [job.md](job.md) |

## Session state

| Tool | Page |
| --- | --- |
| `checkpoint` | [checkpoint.md](checkpoint.md) |
| `rewind` | [rewind.md](rewind.md) |
| `todo` | [todo.md](todo.md) |
| `set_cwd` | [set_cwd.md](set_cwd.md) |

## Delegation and coordination

| Tool | Page |
| --- | --- |
| `task` | [task.md](task.md) |
| `irc` | [irc.md](irc.md) |

## Memory and learning

Each of these requires its subsystem to be configured; the page says which setting.

| Tool | Page |
| --- | --- |
| `retain` | [retain.md](retain.md) |
| `recall` | [recall.md](recall.md) |
| `reflect` | [reflect.md](reflect.md) |
| `memory_edit` | [memory_edit.md](memory_edit.md) |
| `learn` | [learn.md](learn.md) |
| `manage_skill` | [manage_skill.md](manage_skill.md) |

## Outside the working tree

| Tool | Page |
| --- | --- |
| `browser` | [browser.md](browser.md) |
| `web_search` | [web_search.md](web_search.md) |
| `github` | [github.md](github.md) |
| `lsp` | [lsp.md](lsp.md) |
| `search_tool_bm25` | [search_tool_bm25.md](search_tool_bm25.md) |
| `inspect_image` | [inspect_image.md](inspect_image.md) |
| `generate_image` | [generate_image.md](generate_image.md) |
| `tts` | [tts.md](tts.md) |
| `ask` | [ask.md](ask.md) |

## Argot

Present only when `argot.enabled` is on and the session holds a codec, which a subagent
under `argot.subagents: off` does not.

| Tool | Page |
| --- | --- |
| `argot_load` | [argot_load.md](argot_load.md) |
| `argot_unload` | [argot_unload.md](argot_unload.md) |

## Not documented here

`yield`, `goal`, `report_finding` and `report_tool_issue` are hidden tools with no page in
this directory. `yield` is described where it matters, in [task.md](task.md), since a
subagent's contract is to finish through it. Goal Mode, which the `goal` tool serves, is
in [the handbook](../handbook/src/context/goal-state.md). `report_finding` is part of the
review flow, in [the handbook's review page](../handbook/src/features/review.md).
