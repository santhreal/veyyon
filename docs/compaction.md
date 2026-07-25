# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** rewrites old history into a summary on the current branch.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted back into user-context messages when rebuilding LLM input.

## Key implementation files

- `packages/agent/src/compaction/compaction.ts` (context-full summarization and handoff generation)
- `packages/agent/src/compaction/legacy-snapcompact-archive.ts` (reads archives left by the removed image-archive engine so old sessions keep loading)
- `packages/agent/src/compaction/branch-summarization.ts`
- `packages/agent/src/compaction/pruning.ts`
- `packages/agent/src/compaction/utils.ts`
- `packages/coding-agent/src/session/session-manager.ts`
- `packages/coding-agent/src/session/agent-session.ts`
- `packages/coding-agent/src/session/messages.ts`
- `packages/coding-agent/src/extensibility/hooks/types.ts`
- `packages/coding-agent/src/config/settings-schema.ts`

## Session entry model

Compaction and branch summaries are first-class session entries, not plain assistant/user messages.

- `CompactionEntry`
  - `type: "compaction"`
  - `summary`, optional `shortSummary`
  - `firstKeptEntryId` (compaction boundary)
  - `tokensBefore`
  - optional `details`, `preserveData`, `fromExtension`
- `BranchSummaryEntry`
  - `type: "branch_summary"`
  - `fromId`, `summary`
  - optional `details`, `fromExtension`

When context is rebuilt (`buildSessionContext`):

1. Latest compaction on the active path is converted to one `compactionSummary` message.
2. Kept entries from `firstKeptEntryId` to the compaction point are re-included.
3. Later entries on the path are appended.
4. `branch_summary` entries are converted to `branchSummary` messages.
5. `custom_message` entries are converted to `custom` messages.

Those custom roles are then transformed into LLM-facing messages in `convertToLlm()`: `compactionSummary` and `branchSummary` become user messages rendered through the static templates

- `packages/agent/src/prompts/compaction/compaction-summary-context.md`
- `packages/agent/src/prompts/compaction/branch-summary-context.md`

while `custom` messages pass through as developer messages with their raw content (no template).

## Compaction pipeline

### Triggers

Compaction/context maintenance can run in six ways:

1. **Manual context compaction**: `/compact [instructions]` calls `AgentSession.compact(...)`.
2. **Automatic overflow recovery**: after a same-model assistant error that matches context overflow.
3. **Automatic incomplete-output recovery**: after a same-model assistant message ends with `stopReason === "length"` (OpenAI/Codex `response.incomplete`).
4. **Automatic threshold maintenance**: after a successful turn when context exceeds the resolved threshold.
5. **Mid-turn threshold maintenance**: before the next provider request when a tool-loop turn crosses the threshold and `compaction.midTurnEnabled !== false`.
6. **Idle maintenance**: `runIdleCompaction()` can invoke the same auto-maintenance path with reason `"idle"`.

### Compaction shape (visual)

```text
Before compaction:

  entry:  0     1     2     3      4     5     6      7      8     9
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┘
                └────────┬───────┘ └──────────────┬──────────────┘
               messagesToSummarize            kept messages
                                   ↑
                          firstKeptEntryId (entry 4)

After compaction (new entry appended):

  entry:  0     1     2     3      4     5     6      7      8     9      10
        ┌─────┬─────┬─────┬──────┬─────┬─────┬──────┬──────┬─────┬──────┬─────┐
        │ hdr │ usr │ ass │ tool │ usr │ ass │ tool │ tool │ ass │ tool │ cmp │
        └─────┴─────┴─────┴──────┴─────┴─────┴──────┴──────┴─────┴──────┴─────┘
               └──────────┬──────┘ └──────────────────────┬───────────────────┘
                 not sent to LLM                    sent to LLM
                                                         ↑
                                              starts from firstKeptEntryId

What the LLM sees:

  ┌────────┬─────────┬─────┬─────┬──────┬──────┬─────┬──────┐
  │ system │ summary │ usr │ ass │ tool │ tool │ ass │ tool │
  └────────┴─────────┴─────┴─────┴──────┴──────┴─────┴──────┘
       ↑         ↑      └─────────────────┬────────────────┘
    prompt   from cmp          messages from firstKeptEntryId
```

### Overflow/incomplete recovery vs threshold/idle maintenance

The automatic paths are intentionally different:

- **Overflow recovery**
  - Trigger: current-model assistant error is detected as context overflow and the error is not older than the latest compaction.
  - The failing assistant error message is removed from active agent state before retry.
  - Context promotion is tried first; if a configured larger model is available, the agent switches model and retries without compacting.
  - If promotion is unavailable and compaction is enabled, context-full compaction runs with `reason: "overflow"` and `willRetry: true`; handoff strategy is not used for overflow because the handoff request would reuse the overflowing input.
  - On success, `agent.continue()` is scheduled to retry the turn.

- **Incomplete-output recovery**
  - Trigger: same-model assistant message ends with `stopReason === "length"` and the message is not older than the latest compaction.
  - The incomplete assistant message is removed from active agent state before recovery.
  - Context promotion is tried first.
  - If promotion is unavailable and compaction is enabled, auto maintenance runs with `reason: "incomplete"` and `willRetry: true`.
  - Unlike overflow, `compaction.strategy: "handoff"` is allowed for incomplete-output recovery because the input context is still usable.
  - On context-full success, `agent.continue()` is scheduled to retry the turn.

- **Threshold maintenance**
  - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`.
  - Mid-turn maintenance also checks safe tool-loop boundaries before the next provider request when `compaction.midTurnEnabled !== false`.
  - Tool-output pruning can reduce the measured token count before threshold comparison.
  - Context promotion is tried before post-turn compaction.
  - If promotion is unavailable, auto maintenance runs with `reason: "threshold"` and `willRetry: false`.
  - With `compaction.strategy: "handoff"`, post-turn threshold maintenance normally schedules a post-prompt auto-handoff task instead of writing a compaction entry; pre-prompt and mid-turn checks run inline to avoid racing the next turn. Mid-turn checks suppress handoff session resets and fall back to context-full compaction.
  - On success, if `compaction.autoContinue !== false`, post-turn maintenance schedules an agent-authored developer auto-continue prompt from `prompts/turn-control/auto-continue.md`; mid-turn maintenance never schedules a separate continuation because the core loop already owns the next provider request.

- **Idle maintenance**
  - Trigger: `runIdleCompaction()` when not streaming or already compacting.
  - Uses `reason: "idle"` and does not auto-continue afterward.

### What each strategy is for

The two strategies differ by what survives them, and their prompts say so.

`summary` continues the SAME session. The most recent turns stay in context next to the summary, so the summary covers the history it replaces and does not restate what those turns already say.

`handoff` starts a NEW session. Nothing carries over except the document, so the handoff also records cold-restart state: working directory, branch, uncommitted or untracked files, the toolchain or wrapper commands the repository needs, and the exact next command to run.

Both prompts ask for the same verification evidence, because that is the part of a transcript a paraphrase cannot reconstruct: commands run verbatim, pass/fail counts, durations, run IDs, and exact error text with file and line. The summary prompt also states the precedence between brevity and evidence. Prose is where the model is concise; evidence is where it is complete. When they conflict it drops the prose, because a command left out is a command the next turn has to rediscover by re-running it.

Both strategies end with the same deterministic `<files>` block, produced by `computeFileLists` and `upsertFileOperations` from the session's own file operations. It costs no model call and is identical whatever model ran, so it is the cheapest useful thing in either artifact.

You can measure changes to any of this with `scripts/compaction-counterfactual.ts`, which replays one real session through both strategies on two models from a single shared `prepareCompaction()` result, so strategy and model are the only variables.

### Legacy image-archive sessions

An earlier version shipped a `snap` strategy that archived discarded history as dense bitmap images instead of an LLM summary. That engine is removed. `compaction.strategy` now offers two pure-LLM strategies, `summary` (the default) and `handoff`; any stored `snap` value normalizes to `summary` on load.

Sessions compacted by the old engine still open without loss. The removed engine always stored the full plaintext source alongside its image frames, so a legacy archive degrades gracefully:

- On each context rebuild, `legacyArchiveSourceText` (in `packages/agent/src/compaction/legacy-snapcompact-archive.ts`) reads the archived source from `CompactionEntry.preserveData.snapcompact` and re-attaches it as a single recovered text block on the compaction summary. The old image frames are never rehydrated, which also removes the oversized-payload hazard they carried.
- The next compaction over such a session drains that recovered source into the fresh LLM summary and drops the legacy archive from `preserveData`, so the session converges to a plain summarized history.

### Display transcript

Compaction no longer visually restarts the conversation. The TUI renders the **display transcript** (`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`): every path entry in chronological order, with each compaction shown inline as a slim divider, `── 📷 compacted · ctrl+o ──`, at the point it fired. Expanding (ctrl+o) reveals the summary. Only the LLM context resets at the compaction boundary; the scrollback above the divider stays intact, including across session resume.

### Pre-compaction pruning

Before compaction checks, tool-result pruning may run (`pruneToolOutputs`).

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Require at least `20_000` total estimated savings.
- Never blank a result below `50` tokens (`MIN_PRUNE_TOKENS`): the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing. (Superseded and useless results keep their own rules: the useless collector already drops no-savings candidates; superseded reads prune for correctness regardless of size.)
- Never prune `skill` tool results, `read` results of `skill://` paths, or reads of the active plan reference file (added via `AgentSession`'s plan protection).

Pruned tool results are replaced with:

- `[Output truncated - N tokens]`

If pruning changes entries, session storage is rewritten and agent message state is refreshed before compaction decisions.

### Useless-result elision

Tools can flag a finished result as contextually useless, a search with zero matches, a `job` poll that timed out with everything still running, an empty `irc` inbox drain. The flag originates on the tool result (`AgentToolResult.useless`, set via `ToolResultBuilder.useless()` or directly on the returned object), is copied by the agent loop onto the persisted `ToolResultMessage` (never together with `isError`, errors always win), and is consumed in three places:

- **Per-turn stale-result pass** (`pruneSupersededToolResults`, gated by `compaction.dropUseless`, default on): flagged results are blanked to the exact placeholder `[Uneventful result elided]` (`USELESS_NOTICE`) with the same cache-aware timing as superseded reads: only when the suffix after the candidate is small (≤ ~8k tokens) or the session has idled past the provider prompt-cache lifetime. Results smaller than the notice itself are never blanked (no savings), and protected tools are exempt.
- **Threshold prune** (`pruneToolOutputs`): flagged results bypass the protect-recent window, same as superseded reads, and receive `USELESS_NOTICE` instead of the token-count placeholder.
- **Summary serialization**: `serializeConversation` drops the whole tool call/result pair from summarizer input: the source region is discarded after summarization anyway, so the exclusion costs no cache.

The flag never reaches provider wire formats, and flagged pairs are never removed from history (only blanked in place), so tool-call/result pairing stays intact.

### The overarching goal

All three compaction prompts (`compaction-summary`, `compaction-update-summary`, `handoff-document`) ask for the goal in one shape:

```
## Goal
[The overarching goal for the whole session, carried forward unless the user changed it]
Current task: [what is being worked on right now, which is allowed to change often]
```

The two are separated because they move at different speeds. When they shared a single field the model wrote whichever goal was most concrete, which is always the immediate task, and the standing objective was never recorded at all. That is a defect at the first compaction rather than decay across many: once the wrong thing is written, every later cycle faithfully carries it forward.

Both strategies also carry a `Blocked` section. Handoff additionally carries `Pending`, for work nobody has started: summary is injected beside the live turns where that work is still visible, while handoff replaces everything and is the only one that has to carry it forward.

`compaction-update-summary` is the prompt that matters most here, because it runs on every compaction after the first. It lets the model drop anything no longer relevant, and the overarching goal is carved out of that permission explicitly: it is removed only when the user replaces it.

You do not need to pin the goal or store it as a field. Each compaction sees the previous summary alongside the live recent turns, so it is re-grounded against reality every cycle rather than copied blind, and a goal that is still active keeps being restated by the work itself.

### Empty responses

Neither strategy accepts an empty document. A provider can finish with `stopReason: "stop"` having spent its output budget on reasoning and emitted no text, and both call sites now raise rather than return.

This matters more than an ordinary request failure. For `handoff` the caller appends the deterministic `<files>` block afterwards, so an empty document still looks like a real one and the next session starts with a file list and nothing else. For `summary` the summary replaces the history it summarizes, so storing an empty one deletes the conversation and reports success. If you hit this repeatedly, lower the compaction thinking level so the model spends its budget on the document instead of on reasoning.

### Boundary and cut-point logic

`prepareCompaction()` only considers entries since the last compaction entry (if any).

1. Find previous compaction index.
2. Compute `boundaryStart = prevCompactionIndex + 1`.
3. Adapt `keepRecentTokens` using measured usage ratio when available.
4. Run `findCutPoint()` over the boundary window.

Valid cut points include:

- message entries with roles: `user`, `assistant`, `bashExecution`, `hookMessage`, `branchSummary`, `compactionSummary`
- `custom_message` entries
- `branch_summary` entries

Hard rule: never cut at `toolResult`.

If there are non-message metadata entries immediately before the cut point (`model_change`, `thinking_level_change`, labels, etc.), they are pulled into the kept region by moving cut index backward until a message or compaction boundary is hit.

### Split-turn handling

If cut point is not at a user-turn start, compaction treats it as a split turn.

Turn start detection treats these as user-turn boundaries:

- `message.role === "user"`
- `message.role === "bashExecution"`
- `custom_message` entry
- `branch_summary` entry

Split-turn compaction generates two summaries:

1. History summary (`messagesToSummarize`)
2. Turn-prefix summary (`turnPrefixMessages`)

Final stored summary is merged as:

```markdown
<history summary>

---

**Turn Context (split turn):**

<turn prefix summary>
```

### Summary generation

`compact(...)` builds summaries from serialized conversation text:

1. Convert messages via `convertToLlm()`.
2. Serialize with `serializeConversation()`.
3. Wrap in `<conversation>...</conversation>`.
4. Optionally include `<previous-summary>...</previous-summary>`.
5. Optionally inject extension hook context and active memory-backend compaction context as `<additional-context>` entries.
6. Execute summarization prompt with `SUMMARIZATION_SYSTEM_PROMPT`.

Prompt selection:

- first compaction: `compaction-summary.md`
- iterative compaction with prior summary: `compaction-update-summary.md`
- split-turn second pass: `compaction-turn-prefix.md`
- short UI summary: `compaction-short-summary.md`
- handoff document: `handoff-document.md` (used by `generateHandoff(...)`, not serialized compaction)

Remote summarizer endpoint:

Compaction has two strategies, `summary` and `handoff`, and no provider gets a private compaction path. `compaction.remoteEndpoint` does not add a third strategy: it moves where the `summary` strategy's text is generated. Whatever it points at must return summary text, which veyyon stores exactly like a locally generated summary.

- When `compaction.remoteEndpoint` is set, summary generation POSTs one of two wire formats:
  - custom veyyon summarizer endpoints receive `{ systemPrompt, prompt }` and must return JSON containing at least `{ summary }`.
  - OpenAI-compatible endpoints whose path ends in `/chat/completions` receive `{ model, messages, stream: false }`, where `messages` contains one system prompt and one user prompt. The summary is read from `choices[0].message.content`, which lets self-hosted servers such as llama.cpp and vLLM act as summarizers without a separate shim.
- When it is unset, the active model generates the summary locally. That is the default for every provider.

Provider-native remote compaction was removed. OpenAI and OpenAI Codex models used to send history to `/responses/compact` and store the reply in `preserveData.openaiRemoteCompaction`. What came back was an opaque `encrypted_content` blob that only that provider could replay, so the compaction entry's summary field held a fixed placeholder string instead of a summary. Switching models stranded the history, and each call re-sent the whole context uncached. Sessions compacted by the old path still load: veyyon treats such an entry as having no usable summary, re-expands the original messages behind it, and summarizes them locally.

### Handoff generation

`packages/agent/src/compaction/compaction.ts` also exports `generateHandoff(...)`. Handoff generation uses the same `completeSimple(...)` oneshot style as summarization, but it preserves the live agent cache prefix by sending the active system prompt, tool array, and real LLM message history, then appending one agent-attributed `user` message containing the handoff prompt. It forces `toolChoice: "none"` and returns joined text blocks directly.

Handoff does not write a `CompactionEntry`. `AgentSession.handoff()` owns the session transition: it starts a new session, injects the generated document as a visible `custom_message` with `customType: "handoff"`, and rebuilds agent messages from that new session.

### File-operation context in summaries

Compaction tracks cumulative file activity using assistant tool calls:

- `read(path)` → read set
- `write(path)` → modified set
- `edit(path)` → modified set

Cumulative behavior:

- Includes prior compaction details only when prior entry is pi-generated (`fromExtension !== true`).
- In split turns, includes turn-prefix file ops too.
- `details.readFiles` excludes files also modified; `details.modifiedFiles` carries the rest (persisted shape is unchanged).

The file list is a grouped, prefix-folded directory tree (find-tool shape) with a per-file access marker, `(Read)` for read-only files, `(Write)` for modified files never read, `(RW)` for modified files also present in the cumulative read set. Capped at 20 files with an `[…N files elided…]` line. Both strategies append it as a `<files>` tag (via `upsertFileOperations`).

```xml
<files>
# packages/agent/src/compaction/
compaction.ts (Read)
utils.ts (RW)
## prompts/
file-operations.md (Write)
</files>
```

Legacy `<read-files>`/`<modified-files>` tags from summaries written by earlier versions are stripped (alongside `<files>`) before re-appending, so old summaries self-heal on the next compaction.

### Persist and reload

After summary generation (or hook-provided summary), agent session:

1. Appends `CompactionEntry` with `appendCompaction(...)` for context-full maintenance; handoff strategy creates a new session and injects a handoff `custom_message` instead.
2. Rebuilds display context from the active leaf via `buildDisplaySessionContext()`.
3. Replaces live agent messages with rebuilt context.
4. Synchronizes active todo phases from the rebuilt branch and closes provider sessions whose history was rewritten.
5. Emits `session_compact` hook event.

## Branch summarization pipeline

Branch summarization is tied to tree navigation, not token overflow.

### Trigger

During `navigateTree(...)`:

1. Compute abandoned entries from old leaf to common ancestor using `collectEntriesForBranchSummary(...)`.
2. If caller requested summary (`options.summarize`), generate summary before switching leaf.
3. If summary exists, attach it at the navigation target using `branchWithSummary(...)`.

Operationally this is commonly driven by `/tree` flow when `branchSummary.enabled` is enabled.

### Branch switch shape (visual)

```text
Tree before navigation:

         ┌─ B ─ C ─ D (old leaf, being abandoned)
    A ───┤
         └─ E ─ F (target)

Common ancestor: A
Entries to summarize: B, C, D

After navigation with summary:

         ┌─ B ─ C ─ D ─ [summary of B,C,D]
    A ───┤
         └─ E ─ F (new leaf)
```

### Preparation and token budget

`generateBranchSummary(...)` computes budget as:

- `tokenBudget = model.contextWindow - branchSummary.reserveTokens`

`prepareBranchEntries(...)` then:

1. First pass: collect cumulative file ops from all summarized entries, including prior pi-generated `branch_summary` details.
2. Second pass: walk newest → oldest, adding messages until token budget is reached.
3. Prefer preserving recent context.
4. May still include large summary entries near budget edge for continuity.

Compaction entries are included as messages (`compactionSummary`) during branch summarization input.

### Summary generation and persistence

Branch summarization:

1. Converts and serializes selected messages.
2. Wraps in `<conversation>`.
3. Uses custom instructions if supplied, otherwise `branch-summary.md`.
4. Calls summarization model with `SUMMARIZATION_SYSTEM_PROMPT`.
5. Prepends `branch-summary-preamble.md`.
6. Appends file-operation tags.

Result is stored as `BranchSummaryEntry` with optional details (`readFiles`, `modifiedFiles`).

## Extension and hook touchpoints

### `session_before_compact`

Pre-compaction hook.

Can:

- cancel compaction (`{ cancel: true }`)
- provide full custom compaction payload (`{ compaction: CompactionResult }`)

### `session.compacting`

Prompt/context customization hook for default compaction.

Can return:

- `prompt` (override base summary prompt)
- `context` (extra context lines injected into `<additional-context>`)
- `preserveData` (stored on compaction entry)

### `session_compact`

Post-compaction notification with saved `compactionEntry` and `fromExtension` flag.

### `session_before_tree`

Runs on tree navigation before default branch summary generation.

Can:

- cancel navigation
- provide custom `{ summary: { summary, details } }` used when user requested summarization

### `session_tree`

Post-navigation event exposing new/old leaf and optional summary entry.

## Which model compacts

`compaction.model` (settings/`config.yml`, `--compaction-model` CLI, or the Compaction Model picker in `/settings`) selects the model used for LLM compaction and handoff generation. **Default: unset, compaction inherits the main session model live**, so switching the session model also switches the compactor. When set, `resolveCompactionModelPatterns` expands the value through the normal pattern/role resolution (role aliases like `"@smol"` and `:thinking` suffixes work), and auto compaction tries the resulting candidates in order. Legacy config keys `compaction.compactionModel` / top-level `compactionModel` are migrated to `compaction.model` on load.

## Runtime behavior and failure semantics

- Manual compaction aborts current agent operation first.
- `abortCompaction()` cancels manual compaction, auto-compaction, and handoff generation controllers.
- Auto compaction emits start/end session events for UI/state updates.
- Auto compaction can try multiple model candidates and retry transient failures; long retry delays prefer the next candidate when one is available.
- Overflow errors are excluded from generic retry path because they are handled by context promotion/compaction.
- If auto-compaction fails:
  - overflow path emits `Context overflow recovery failed: ...`
  - incomplete-output path emits `Incomplete response recovery failed: ...`
  - threshold/idle paths emit `Auto-compaction failed: ...`
- Branch summarization can be cancelled via abort signal (e.g., Escape), returning canceled/aborted navigation result.

## Settings and defaults

From `settings-schema.ts`:

- `compaction.enabled` = `true`
- `compaction.strategy` = `"summary"` (schema: `"summary"` | `"handoff"`; default `"summary"`). Summary rewrites old history into an in-place LLM summary; handoff uses an LLM transfer into a new session. A stored `snap` from the removed image-archive engine normalizes to `summary` on load.
- `compaction.reserveTokens` = `16384`
- `compaction.keepRecentTokens` = `20000`
- `compaction.autoContinue` = `true`
- `compaction.midTurnEnabled` = `true`
- `compaction.remoteEndpoint` = `undefined`
- `compaction.threshold` = `auto`; the one trigger setting, with its unit in the value. `auto` is `contextWindow - max(15% of contextWindow, reserveTokens)`. `85%` is a percent of the current model's window. `170000` is an absolute token amount, model-independent: compaction runs once context exceeds that many tokens whatever the current model's window is, and when the amount is larger than that window it is honored up to `contextWindow - 1` with a one-time warning (never silently reinterpreted). Resolution and the migration off the two retired keys live in `packages/agent/src/compaction/threshold.ts`.
- `compaction.thresholdTokens` = `-1` and `compaction.thresholdPercent` = `-1`; retired. The global config is rewritten on load (`#migrateRawSettings`): a positive amount becomes `threshold: <amount>`, a positive percent becomes `threshold: <percent>%` (the amount wins when both are set), and both keys are dropped, so the ambiguity leaves the file without moving the trigger. Config sources that are never rewritten — project files, `--config` overlays — are folded in at read time by `withLegacyCompactionThreshold` with the same precedence, and the session reports which retired key supplied the value.
- `compaction.idleEnabled` = `false`
- `compaction.idleThresholdTokens` = `200000`
- `compaction.idleTimeoutSeconds` = `300`
- `branchSummary.enabled` = `false`
- `branchSummary.reserveTokens` = `16384`

These values are consumed at runtime by `AgentSession` and compaction/branch summarization modules.
