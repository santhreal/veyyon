# Session switching and recent session listing

This document describes how coding-agent discovers recent sessions, resolves `--resume` targets, presents session pickers, and switches the active runtime session.

It focuses on current implementation behavior, including fallback paths and caveats.

## Implementation files

- [`kernel/src/session/session-manager.ts`](../../kernel/src/session/session-manager.ts)
- [`kernel/src/session/session-listing.ts`](../../kernel/src/session/session-listing.ts)
- [`kernel/src/session/session-paths.ts`](../../kernel/src/session/session-paths.ts)
- [`../src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts)
- [`../src/cli/session-picker.ts`](../../packages/coding-agent/src/cli/session-picker.ts)
- [`../src/modes/terminal/components/selectors/session-selector.ts`](../../packages/coding-agent/src/modes/terminal/components/selectors/session-selector.ts)
- [`../src/modes/terminal/controllers/selector-controller.ts`](../../packages/coding-agent/src/modes/terminal/controllers/selector-controller.ts)
- [`../src/main.ts`](../../packages/coding-agent/src/main.ts)
- [`../src/sdk.ts`](../../packages/coding-agent/src/sdk.ts)
- [`../src/modes/terminal/interactive-mode.ts`](../../packages/coding-agent/src/modes/terminal/interactive-mode.ts)
- [`../src/modes/terminal/utils/ui-helpers.ts`](../../packages/coding-agent/src/modes/terminal/utils/ui-helpers.ts)

## Recent-session discovery

### Directory scope

`SessionManager` stores sessions under a cwd-scoped directory by default:

- `~/.veyyon/profiles/default/agent/sessions/<dir-encoded>/*.jsonl` (home-relative `-<rel>` names, `-tmp-<rel>` for temp paths, legacy `--<abs>--` otherwise)
- `$XDG_DATA_HOME/veyyon/sessions/<dir-encoded>/*.jsonl` on Linux and macOS once `$XDG_DATA_HOME/veyyon` exists (`getSessionsDir()` resolves the `data` category); a named profile uses `$XDG_DATA_HOME/veyyon/profiles/<name>/sessions` only when that profile directory exists

`SessionManager.list(cwd, sessionDir?)` reads only that directory unless an explicit `sessionDir` is provided. `SessionManager.listAll()` walks the whole sessions root and keeps only top-level transcripts (`<root>/<bucket>/<file>.jsonl`): a spawned agent's transcript under its parent's artifacts directory, and an `orphan-task-*` transcript, is left out.

### Two listing paths with different payloads

There are two different listing pipelines:

1. `getRecentSessions(sessionDir, limit = 4)` (welcome/summary view)
   - Stats every file, then scans files newest first by `mtime` and stops once `limit` non-blank sessions are found; files sharing one `mtime` are scanned together so the header-timestamp and path tiebreaks apply. Each scan is the per-file scan of `list` without the status tail: a 4KB prefix, escalating once to a bounded 1 MiB read (`SESSION_LIST_ESCALATED_PREFIX_BYTES`) when the prefix hides the first user message in a larger file. The directory's `.session-list-index.json` is neither read nor written.
   - Skips blank sessions (no title and no user message), so the launch's own empty file never appears.
   - Returns lightweight `RecentSessionInfo` (`path`, `name`, `timeAgo`); `name` and `timeAgo` are computed eagerly (`sessionDisplayName` / `formatTimeAgo`), not lazy getters.
   - Returns the first `limit` rows of the order `list` uses: file `mtime` descending, then header timestamp, then path.

2. `SessionManager.list(...)` / `SessionManager.listAll()` (resume pickers and ID matching)
   - Reads a 4KB prefix plus, for `list`/`listAll` (which pass `withStatus`), a bounded 32 KiB tail in one `readTextSlices(...)` call per file, not the full JSONL file; when the prefix contains no user message in a larger file, one bounded escalated read of up to 1 MiB recovers the display fields.
   - Builds `SessionInfo` objects (`id`, `cwd`, `title`, `messageCount`, `firstMessage`, `allMessagesText`, timestamps, lifecycle status).
   - Uses prefix parsing plus marker counting for list text, and tail parsing for the final-message lifecycle status; later messages beyond the prefix may not be present in `allMessagesText`.
   - Cuts `firstMessage` and `allMessagesText` to `SESSION_LIST_TEXT_CHARS` (4,096) characters, without splitting a surrogate pair, and copies the cut out of the scanned window so a row keeps no window alive. The directory's `.session-list-index.json` stores the same bounded rows; `SESSION_LIST_INDEX_VERSION` 2 discards an index written before the bound.
   - Sorts by `modified` descending, breaking ties by header timestamp and then path.

### Metadata fallback behavior

For recent summaries (`RecentSessionInfo`):

- display name preference (`sessionDisplayName`): `title` -> first user message -> an `Untitled · <time>` label (the raw `id` is intentionally never used)
- the welcome screen truncates the rendered name to the available column width (no fixed length)
- only the first line is kept and control characters are stripped from title/message-derived names (`sanitizeSessionName`)

For `SessionInfo` list entries:

- `title` is `header.title` or the last compaction `shortSummary` seen in the scanned window (the 4KB prefix, or the escalated read)
- `firstMessage` is first user message text discoverable from the prefix or `"(no messages)"`

## `--continue` resolution and terminal breadcrumb preference

`SessionManager.continueRecent(cwd, sessionDir?)` resolves the target in this order:

1. Read terminal-scoped breadcrumb (`terminal-sessions/<terminal-id>` in the profile's `state` directory: `~/.veyyon/profiles/default/agent/terminal-sessions/`, or `$XDG_STATE_HOME/veyyon/terminal-sessions/`)
2. Validate breadcrumb:
   - current terminal can be identified
   - referenced file still exists
   - referenced file belongs to the active profile (`foreignSessionFileProfile`); a breadcrumb naming another profile's transcript is ignored
   - a breadcrumb naming a spawned agent's transcript is resolved to its interactive root session
3. If the breadcrumb cwd matches the current cwd (resolved path compare), use the breadcrumb session
4. Otherwise, if the breadcrumb's cwd is absent (moved/renamed dir; an unreachable cwd is not absent) and the current directory has no sessions of its own, re-root the breadcrumb session into the current directory (`SessionManager.open` + `moveTo`) instead of starting fresh
5. Otherwise use the newest session in the session dir (`findMostRecentSession`: the first row of `list`'s order, found by scanning files newest first by mtime and stopping at the first readable one)
6. If none found, create a new session

Terminal ID derivation prefers TTY path and falls back to env-based identifiers (`ZELLIJ_PANE_ID`, `TMUX_PANE`, `CMUX_SURFACE_ID`, `KITTY_WINDOW_ID`, `WEZTERM_PANE`, `TERM_SESSION_ID`, `WT_SESSION`).

Breadcrumb writes are best-effort and non-fatal.

## Startup-time resume target resolution (`main.ts`)

### `--resume <value>`

Before any profile-scoped module loads, `cli/resume-profile.ts` resolves the id or file against every profile's sessions directory, and `runCli` activates the owning profile unless `--profile` pins one. `--fork <id>` resolves the same way.

`createSessionManager(...)` then handles string-valued `--resume` in two modes:

1. Path-like value (`namesSessionFile`: contains `/`, `\\`, or ends with `.jsonl`)
   - a file owned by another profile is forked into the active profile (`forkFromOtherProfile`), at its recorded cwd when that directory exists
   - otherwise direct `SessionManager.open(sessionArg, parsed.sessionDir)`

2. Resume key value
   - `resolveResumableSession(...)` searches the local session dir first, then the whole sessions root (agent transcripts included) when `sessionDir` is not forced, then every other profile's sessions root
   - matching is case-insensitive and accepts `id` prefix, JSONL filename stem prefix, or the session-id suffix after the last `_`
   - first match in modified-descending order is used (no ambiguity prompt)
   - a match from another profile (reached only when `--profile` pins the active one) is forked into the active profile

Cross-project match behavior:

- if the matched session's recorded cwd no longer exists (moved/renamed dir), CLI prompts `Session's directory no longer exists (<cwd>). Move (re-root) it into the current directory? [Y/n]`; yes opens the session and `moveTo(cwd)` re-roots it
- declined -> the launch prints `Resume cancelled: the session's directory no longer exists.` and exits 0
- non-TTY -> throws `SessionResolutionError` instead of prompting
- any other match, local or from another project, opens in place; `enterResumedSessionProject` then switches the process into the session's recorded directory (`setProjectDir`, plugin and capability cache resets, `settings.reloadForCwd`). An explicit `--cwd` instead re-roots the session at the launch directory and records a `cwd_changed` entry.

No match -> throws `SessionResolutionError` (`Session "..." not found.`) with a hint to run `veyyon --resume` without an argument.

### `--resume` (no value)

Handled after initial session-manager construction:

1. list local sessions with `SessionManager.list(cwd, parsed.sessionDir)`
2. if empty: preload `SessionManager.listAll()` (used to print `No sessions found` and exit early only when the global list is also empty, and to make the picker's Tab switch instant); the picker still opens in current-folder scope
3. open TUI picker (`selectSession`, with optional preloaded `allSessions`)
4. if canceled: print `No session selected` and exit early
5. if selected: `SessionManager.open(selected.path)`; when the session belongs to another project, `enterResumedSessionProject` switches the process into that project's directory before the session is built

### `--continue`

Uses `SessionManager.continueRecent(...)` directly (breadcrumb-first behavior above).

## Picker-based selection internals

## CLI picker (`src/cli/session-picker.ts`)

`selectSession(sessions, { allSessions? })` creates a standalone TUI with `SessionSelectorComponent` and resolves exactly once:

- selection -> resolves selected `SessionInfo` (caller uses `.path` / `.cwd`)
- cancel (Esc) -> resolves `null`
- hard exit (Ctrl+C path) -> stops TUI and `process.exit(0)`
- Tab toggles current-folder / all-projects scope; the all-projects list is loaded lazily via `SessionManager.listAll` (or preloaded via `allSessions`)
- search ranking is augmented with prompt-history matches from `history.db` (`HistoryStorage.matchingSessionIds`) when available

## Interactive in-session picker (`SelectorController.showSessionSelector`)

Flow:

1. fetch sessions from current session dir via `SessionManager.list(currentCwd, currentSessionDir)`; the selector always opens in current-folder scope, an empty list renders `No sessions in current folder. Press Tab to view all.`, and Tab loads all-projects lazily via `SessionManager.listAll()`
2. mount `SessionSelectorComponent` through `showModalSelector` as a fullscreen alternate-screen overlay (`ctx.ui.showOverlay(...)`, mouse wheel and click-to-resume), wired with `loadAllSessions: () => SessionManager.listAll()`, a `history.db` prompt matcher, and the running conversations held by `BackgroundSessions.global()`
3. callbacks:
   - select -> close selector and call `handleResumeSession(sessionPath)`
   - cancel -> close selector
   - delete -> when the row is the active session, detach first by starting a new session; then `deleteSessionWithArtifacts`
   - exit -> close selector, then `ctx.shutdown()`

## Session selector component behavior

`SessionList` supports:

- arrow/page navigation
- Enter to select
- Delete to delete after confirmation
- Esc to cancel
- Ctrl+C to exit
- Tab to toggle current-folder / all-projects scope
- ctrl+x on a row that runs in the background (a conversation `/new` left running) to stop it without resuming it; the row stays and reads its file status again
- ranked fuzzy search across session id/title/cwd/first message/all messages/path, merged with prompt-history matches from `history.db`

Empty-list render behavior:

- current-folder scope renders `No sessions in current folder. Press Tab to view all.`; all-projects scope renders `No sessions found`
- Enter/Delete on empty do nothing (no callback)
- Esc/Ctrl+C still work

## Runtime switch execution (`AgentSession.switchSession`)

`switchSession(sessionPath)` is the core in-process switch path. It runs inside `SessionScope.run` (`session/runtime/session-scope.ts`), which starts it after every cwd and session transition started before it.

Lifecycle/state transition:

1. capture `previousSessionFile`
2. reject a target owned by another profile (`foreignSessionFileProfile`) with an error naming the `veyyon --resume` and `veyyon --profile ... --resume` commands
3. emit `session_before_switch` hook event (`reason: "resume"`, cancellable)
4. if canceled -> return `false` with no switch
5. disconnect from current agent event stream
6. abort active generation/tool flow
7. flush session writer (`sessionManager.flush()`) to persist pending writes, then capture rollback state (manager state, messages, queues, model, thinking, service tier, MCP selection, tools, system prompts, provider session keys, checkpoint state, wire path roots); the previous display context is built only for a same-session reload
8. clear queued steering/follow-up/next-turn message buffers
9. `sessionManager.setSessionFile(sessionPath)`
   - loads entries / migrates / blob-resolves / reindexes
   - adopts the header cwd when that directory exists
   - updates session file pointer and writes terminal breadcrumb
   - keeps payloads of record-only entries unreachable from the branch on disk
   - if the file is missing or empty: initializes a new session at that path and rewrites header
10. reassert the recorded cwd when reachable; when the cwd changed, rescope cwd-bound runtime state (`SessionScope.rescope`) and wire path roots
11. for a different session: clear the fresh provider session id and adopt the target header's prompt cache key; update `agent.sessionId` (`ProviderSessions.sync()`) and rekey memory
12. rebuild display context via `buildDisplaySessionContext()`
13. restore persisted/discovered MCP tool selections, rebuild active tools/system prompt when discovery is enabled, and rehydrate checkpoint state from the branch
14. emit `session_switch` hook event (`reason: "resume"`, `previousSessionFile`)
15. replace agent messages with rebuilt context, reset advisor state, and sync todos from the branch
16. close provider sessions when switching to a different session or when same-session reload changed replay messages
17. restore model via `getRestorableSessionModels(sessionContext.models, lastModelChangeRole)`: tries the recorded models in fallback order and uses the first one present in the model registry
18. append an interrupted-turn abort message when the branch ends in an interrupted turn, and rebuild messages
19. restore thinking level and service tier:
    - thinking uses the persisted `thinking_level_change` selector (`auto` resumes in auto mode; older entries without `configured` pin the concrete level), otherwise the configured default
    - service tier uses persisted `service_tier_change`, otherwise the configured per-family `tier.openai`/`tier.anthropic`/`tier.google` settings (`"none"` becomes unset)
20. for a different session: reset memory context for the new transcript and rescope the agent registry
21. reconnect agent listeners, run the registered session-switch reconciler if any (interactive mode re-enters persisted modes; errors logged, not fatal), and return `true`

A failure after step 8 restores the captured state, rescopes back to the previous cwd, reconnects listeners, and rethrows; when restoring the cwd scope or the MCP selection also fails, the switch throws an `AggregateError` holding every failure.

## UI state rebuild after interactive switch

`SelectorController.handleResumeSession` performs UI reset around `switchSession`:

- `clearTransientSessionUi()`: abandon the working loader, stop compaction and retry loaders, clear status, pending-message and model-cycle containers, and reset streaming component/message references
- when the target is a live session `/new` left running (`BackgroundSessions.global().take(path)`), attach that session object instead of switching, so its turn keeps streaming; the status reads `Resumed a session that is still running` while it streams
- otherwise call `session.switchSession(...)`
- if the resumed session's cwd differs from the previous one, re-point the process and cwd-derived caches at it (`applyCwdChange`)
- refresh the terminal title and editor border
- clear chat container and rerender from session context (`renderInitialMessages({ clearTerminalHistory: true })`)
- reload todos from new session artifacts
- show `Resumed session` (or `Resumed session in <dir>` for a cross-project resume)

So visible conversation/todo state is rebuilt from the new session file.

## Startup resume vs in-session switch

### Startup resume (`--continue`, `--resume`, direct open)

- Session file is chosen before `createAgentSession(...)`.
- `sdk.ts` builds `existingSession = sessionManager.buildSessionContext()`.
- Agent messages are restored once during session creation.
- Model/thinking are selected during creation (including restore/fallback logic).
- Interactive mode then runs `#reconcileModeFromSession()` to re-enter persisted mode state (e.g. plan mode).

### In-session switch (`/resume`-style selector path)

- Uses `AgentSession.switchSession(...)` on an already-running `AgentSession`.
- Messages/model/thinking are rebuilt immediately in place.
- Hook `session_before_switch`/`session_switch` events are emitted.
- UI chat/todos are refreshed.
- Mode re-entry is symmetric with startup: interactive mode registers `#reconcileModeFromSession()` as the session-switch reconciler (`setSessionSwitchReconciler`), and `switchSession()` invokes it after reconnecting.

## Failure and edge-case behavior

### Cancellation paths

- CLI picker cancel -> returns `null`, caller prints `No session selected`, process exits early.
- Interactive picker cancel -> editor restored, no session change.
- Hook cancellation (`session_before_switch`) -> `switchSession()` returns `false`.

### Empty list paths

- CLI `--resume` (no value): an empty local list with an empty global list prints `No sessions found` and exits.
- Interactive selector: empty list renders message and remains cancellable.

### Missing/invalid target session file

When opening/switching to a specific path (`setSessionFile`):

- ENOENT or a zero-byte file -> treated as empty -> new session initialized at that exact path and persisted.
- a non-empty file with no readable header, or whose first readable record is not a session header -> `loadSessionFile` throws `CorruptSessionFileError`; the file is left untouched and a switch rolls back.

### Hard failures

Switch/open also throws on I/O failures (permission errors, rewrite failures, etc.), which propagate to callers.

### ID prefix matching caveats

- Matching uses `startsWith` on the lowercased session id, lowercased JSONL filename stem, and lowercased id suffix after the last `_` of the stem.
- First match in modified-descending order wins; there is no ambiguity UI if multiple sessions share a prefix.
- Prefix-listing metadata is intentionally lightweight, so search text may not include messages outside the scanned window (the first 4KB, or the 1 MiB escalated read), and each text field is cut to 4,096 characters.

*Verified against `42d40c0cd4` on 2026-10-05.*
