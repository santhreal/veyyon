# `/tree` Command Reference

`/tree` opens the interactive session tree navigator. Selecting an entry moves the active leaf in the current session file and continues from that point.

This is an in-file leaf move, not a new session export.

## What `/tree` does

- Builds a tree from current session entries (`SessionManager.getTree()`)
- Opens `TreeSelectorComponent` with keyboard navigation, filters, and search
- On selection, calls `AgentSession.navigateTree(targetId, { summarize, customInstructions })`
- Rebuilds visible chat from the new leaf path
- Optionally prefills editor text when selecting a user/custom message

Primary implementation:

- `src/slash-commands/builtin-registry.ts` (`/tree`, `/branch` command routing)
- `src/modes/terminal/controllers/input-controller.ts` (keybinding wiring, double-escape behavior)
- `src/modes/terminal/controllers/selector-controller.ts` (tree UI launch + summary prompt flow)
- `src/modes/terminal/components/selectors/tree-selector.ts` (navigation, filters, search, labels, rendering)
- `src/session/agent-session.ts` (`navigateTree` leaf switching + optional summary)
- `kernel/src/session/session-manager.ts` (`getTree`, `branch`, `branchWithSummary`, `resetLeaf`, label persistence)

## How to open it

Any of the following opens the same selector:

- `/tree`
- configured keybinding for the `app.session.tree` action
- double-escape on empty editor when `doubleEscapeAction = "tree"` (default)
- `/branch` when `doubleEscapeAction = "tree"` (routes to tree selector instead of user-only branch picker)

## Tree UI model

The tree is rendered from session entry parent pointers (`id` / `parentId`).

- The branch holding the current leaf is drawn first at every fork, so the live path reads top to bottom
- Each row is `cursor`, tree rail, node mark, kind column, label, entry text, and a right-aligned age
- The node mark is `●` at the current leaf, `•` elsewhere on the path from root to that leaf, and blank off it. Every row reserves the column, so entry text at one depth starts at one column
- The kind column is ten columns wide and states what the row is: a message role (`user`, `assistant`, `developer`), a tool name (`read`, `bash`, `web_search`), or an entry type (`compaction`, `summary`, `model`, `mode`). The entry text beside it never repeats the kind
- The rail is drawn in the accent colour on the active path and dimmed off it
- The age is coarse (`12m`, `4h`, `3d`, `2w`, `1y`), blank under a minute, and dropped on a card narrower than 48 columns
- A label, when the entry resolves to one, renders as `[label]` after the kind column and before the entry text
- A tool row shows its arguments: the path for `read`, `write`, `edit` and `ls`, the command for `bash`, the type, pattern and scope for `search`. A path longer than 44 columns is cut from the left (`…/selectors/tree-selector.ts`), because the file name is what distinguishes one row from the next
- A tool the card has no rule for shows the argument that names its target, preferring `command`, `query`, `input`, `path`, `url`, `expression`, `pattern`, `name`, `prompt`, `task`, `message`, and never the caller's `i` intent line. With no string argument it shows the arguments as recorded
- If multiple roots exist (orphaned/broken parent chains), they are shown under a virtual branching root

```text
┌── Session Tree ──────────────────────────────────────────────────────── [x] ┐
│ Type to search                                          12/17  ·  default   │
├─────────────────────────────────────────────────────────────────────────────┤
│                                                                             │
│    • user       [tree work] revamp the session tree card so it rea…    4h   │
│    • assistant  Reading the row builder and the modal chrome first.    3h   │
│    • read       …/components/selectors/tree-selector.ts:640-759        3h   │
│    • search     structure theme.fg($$$) in packages/coding-agent/s…    3h   │
│    • edit       …/components/selectors/tree-selector.ts                3h   │
│    • bash       bun test packages/coding-agent/test/modes/terminal…    2h   │
│    • assistant  Nine of nine pass; the kind column lands on one of…    1h   │
│    ├─ • user       keep the age, widen the gutter                     30m   │
│    │     • web_search terminal tree view column alignment             26m   │
│  › │     ● assistant  Age sits three cells clear of the text now.      4m   │
│    └─   user       try it without the age column                       1h   │
│       │    assistant  Dropped it, and the fork lost its orientatio…    1h   │
│                                                                             │
├─────────────────────────────────────────────────────────────────────────────┤
│   up/down move  ·  left/right page  ·  shift+L label  ·  ctrl+O filter      │
│                         enter jump  ·  esc close                            │
└─────────────────────────────────────────────────────────────────────────────┘
```

`›` marks the cursor, `●` the current leaf, `•` the rest of the active path; the abandoned branch
under `└─` carries no mark.

The header row carries the search query on the left, and on the right the rows on screen out of every
entry in the tree plus the filter mode that decided it (`9/14 · no-tools`).

The card asks for one body row per entry the filter mode admits, bounded by what the terminal can
show, so a short session gets a short card. The search query does not resize it.

## Recording the card

`proof/scenes/session-tree-card.sh` drives the card on a branched session seeded by
`proof/docker/seed-session-tree.ts`, which writes the fork, the abandoned attempt and the labeled
entry the frames show. The card does not animate, so the take is still and the motion gate is set to
accept it. Record it with:

```sh
SCENE_MOTION_FLOOR=0 \
	SCENE_COMMAND="bun /repo/packages/coding-agent/src/cli.ts --continue --model local/qwen2.5-1.5b" \
	proof/record.sh --pair proof/scenes/session-tree-card.sh
```

## Keybindings inside tree selector

- `Up` / `Down`: move selection (wraps)
- `Left` / `Right`: page up / page down
- `Home` / `End`: first / last visible entry
- `Enter`: select node
- `Esc`: clear search if active; otherwise close selector
- `Ctrl+C`: close selector
- `Type`: append to search query
- `Backspace`: delete search character
- `Shift+L`: edit/clear label on selected entry
- `Ctrl+O`: cycle filter forward
- `Shift+Ctrl+O`: cycle filter backward
- `Alt+D/T/U/L/A`: jump directly to specific filter mode

## Filters and search semantics

Filter modes (`TreeList`):

1. `default`
2. `no-tools`
3. `user-only`
4. `labeled-only`
5. `all`

### `default`

Shows conversational nodes. It hides these session bookkeeping entry types:

- `label`
- `custom`
- `model_change`
- `thinking_level_change`
- `service_tier_change`
- `mode_change`
- `title_change`
- `session_init`
- `ttsr_injection`
- `mcp_tool_selection`

`all` shows each of them with its own kind and text (`mode`, `title`, `session`, `rules`, `mcp`,
`tier`). An entry kind a package adds to the session vocabulary shows its type tag in the kind
column.

### `no-tools`

Same as `default`, plus hides `toolResult` messages.

### `user-only`

Only `message` entries where role is `user`.

### `labeled-only`

Only entries that currently resolve to a label.

### `all`

Everything in the session tree, including bookkeeping and custom entries.

### Tool-only assistant node behavior

Assistant messages that contain **only tool calls** (no text) are hidden by default in all filtered views unless:

- message is error/aborted (`stopReason` not `stop`/`toolUse`), or
- it is the current leaf (always kept visible)

### Search behavior

- Query is tokenized by spaces
- Matching is fuzzy (subsequence) and case-insensitive (`fuzzyMatch`)
- All tokens must match (AND semantics)
- Searchable text includes the label, the role, the tool name and its argument summary, and type-specific content (message text, branch summary text, custom type, mode and title values, injected rule names, MCP tool names)
- A row paints every case-insensitive occurrence of a token in the match colour, in the kind column and the label chip as well as the entry text. A row kept by a subsequence match with no literal occurrence paints nothing

## Selection outcomes (important)

`navigateTree` computes new leaf behavior from selected entry type:

### Selecting `user` message

- New leaf becomes selected entry’s `parentId`
- If parent is `null` (root user message), leaf resets to root (`resetLeaf()`)
- Selected message text is copied to editor for editing/resubmit

### Selecting `custom_message`

- Same leaf rule as user messages (`parentId`)
- Text content is extracted and copied to editor

### Selecting non-user node (assistant/tool/summary/compaction/custom bookkeeping/etc.)

- New leaf becomes selected node id
- Editor is not prefilled

### Selecting current leaf

- No-op; selector closes with “Already at this point”

```text
Selection decision (simplified):

selected node
   │
   ├─ is current leaf? ── yes ──> close selector (no-op)
   │
   ├─ is user/custom_message? ── yes ──> leaf := parentId (or resetLeaf for root)
   │                                     + prefill editor text
   │
   └─ otherwise ──> leaf := selected node id
                    + no editor prefill
```

## Summary-on-switch flow

Summary prompt is controlled by `branchSummary.enabled` (default: `false`).

When enabled, after picking a node the UI prompts:

- `No summary`
- `Summarize`
- `Summarize with custom prompt`

Flow details:

- Escape in summary prompt reopens tree selector
- Custom prompt cancellation returns to summary choice loop
- During summarization, UI shows loader and binds `Esc` to `abortBranchSummary()`
- If summarization aborts, tree selector reopens and no move is applied

`navigateTree` internals:

- Collects abandoned-branch entries from old leaf to common ancestor
- Emits `session_before_tree` (extensions can cancel or inject summary)
- Uses default summarizer only if requested and needed
- Applies move with:
  - `branchWithSummary(...)` when summary exists
  - `branch(newLeafId)` for non-root move without summary
  - `resetLeaf()` for root move without summary
- Replaces agent conversation with rebuilt session context
- Emits `session_tree`

Note: if user requests summary but there is nothing to summarize, navigation proceeds without creating a summary entry.

## Labels

Label edits in tree UI call `appendLabelChange(targetId, label)`.

- non-empty label sets/updates resolved label
- empty label clears it
- labels are stored as append-only `label` entries
- tree nodes display resolved label state, not raw label-entry history

## `/tree` vs adjacent operations

| Operation | Scope                                            | Result                                                                                                                                                   |
| --------- | ------------------------------------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `/tree`   | Current session file                             | Moves leaf to selected point (same file)                                                                                                                 |
| `/branch` | Usually current session file -> new session file | By default branches from selected **user** message into a new session file; if `doubleEscapeAction = "tree"`, `/branch` opens tree navigation UI instead |
| `/fork`   | Whole current session                            | Duplicates session into a new persisted session file                                                                                                     |
| `/resume` | Session list                                     | Switches to another session file                                                                                                                         |

Key distinction: `/tree` is a navigation/repositioning tool inside one session file. `/branch`, `/fork`, and `/resume` all change session-file context.

## Operator workflows

### Re-run from an earlier user prompt without losing current branch

1. `/tree`
2. search/select earlier user message
3. choose `No summary` (or summarize if needed)
4. edit prefilled text in editor
5. submit

Effect: new branch grows from selected point within same session file.

### Leave current branch with context breadcrumb

1. enable `branchSummary.enabled`
2. `/tree` and select target node
3. choose `Summarize` (or custom prompt)

Effect: a `branch_summary` entry is appended at the target position before continuing.

### Investigate hidden bookkeeping entries

1. `/tree`
2. press `Alt+A` (all)
3. search for `model`, `thinking`, `custom`, or labels

Effect: inspect full internal timeline, not just conversational nodes.

### Bookmark pivot points for later jumps

1. `/tree`
2. move to entry
3. `Shift+L` and set label
4. later use `Alt+L` (`labeled-only`) to jump quickly

Effect: fast navigation among durable branch landmarks.
