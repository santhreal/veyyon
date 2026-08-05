# Compaction and Branch Summaries

Compaction and branch summaries are the two mechanisms that keep long sessions usable without losing prior work context.

- **Compaction** rewrites old history into a summary on the current branch.
- **Branch summary** captures abandoned branch context during `/tree` navigation.

Both are persisted as session entries and converted into agent-attributed developer context when rebuilding LLM input.

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
  - `summary`, optional `shortSummary` (display only, and no longer produced by `compact()`: see
    "Short summary" below)
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

`convertToLlm()` transforms these custom roles into LLM-facing messages, through these static
templates:

- `packages/agent/src/prompts/compaction/compaction-summary-context.md`
- `packages/agent/src/prompts/compaction/branch-summary-context.md`

`branchSummary` becomes an agent-attributed **developer** message.

`compactionSummary` becomes an agent-attributed **user** message. The role is the trust boundary: a
compaction summary is model-generated history, so putting it in the user channel means it cannot
outrank a live developer message that contradicts it. Any image attachments follow the summary text
in the same message, which is also why the user slot is the safe one: every provider accepts images
there.

The compaction template wraps the summary in its own `<summary>` delimiters, so the untrusted region
has an explicit start and end. Exactly one wrapper is ever emitted: a legacy or model-authored
`<summary …>` wrapper persisted inside the summary text is stripped first
(`withoutSummaryPresentationTags`), and embedded or sibling `<summary>` elements that are not one
enclosing wrapper are left alone as content. The branch template uses no delimiters.

Other `custom` messages pass through as developer messages with their raw content and no template.

## Compaction pipeline

### Triggers

Compaction/context maintenance can run in six ways:

1. **Manual context compaction**: `/compact [summary] [focus]` calls `AgentSession.compact(...)`.
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
  - If promotion is unavailable and compaction is enabled, in-place compaction runs with `reason: "overflow"` and `willRetry: true`.
  - On success, `agent.continue()` is scheduled to retry the turn.

- **Incomplete-output recovery**
  - Trigger: same-model assistant message ends with `stopReason === "length"` and the message is not older than the latest compaction.
  - The incomplete assistant message is removed from active agent state before recovery.
  - Context promotion is tried first.
  - If promotion is unavailable and compaction is enabled, auto maintenance runs with `reason: "incomplete"` and `willRetry: true`.
  - On context-full success, `agent.continue()` is scheduled to retry the turn.

- **Threshold maintenance**
  - Trigger: successful, non-error assistant message whose adjusted context tokens exceed `resolveThresholdTokens(...)`.
  - Mid-turn maintenance also checks safe tool-loop boundaries before the next provider request when `compaction.midTurnEnabled !== false`.
  - Tool-output pruning can reduce the measured token count before threshold comparison.
  - Context promotion is tried before post-turn compaction.
  - If promotion is unavailable, auto maintenance runs with `reason: "threshold"` and `willRetry: false`.
  - On success, if `compaction.autoContinue !== false`, post-turn maintenance schedules an agent-authored developer auto-continue prompt from `prompts/turn-control/auto-continue.md`; mid-turn maintenance never schedules a separate continuation because the core loop already owns the next provider request.

- **Idle maintenance**
  - Trigger: `runIdleCompaction()` when not streaming or already compacting.
  - Uses `reason: "idle"` and does not auto-continue afterward.

### Compaction and manual handoff

`summary` is the sole compaction strategy, and it continues the SAME session. The generated summary
is prefixed onto a retained raw tail in one message array: `buildSessionContext` pushes the summary,
then re-emits every entry from `firstKeptEntryId` onward verbatim. The tail is non-empty by
construction, because `findCutPoint` walks backwards accumulating until `keepRecentTokens`
(default 20000).

Note that the summary prompt does not say any of that. Its opening line asks for "a structured
handoff summary for another LLM to resume the task", which describes a cold restart that compaction
does not perform. This is inherited from upstream, whose engine keeps the same recent tail, so the
mismatch is upstream's rather than a fork difference. It is recorded here because a summarizer told
it is writing for a fresh reader will restate turns that are still in context. Changing the prompt
is an operator decision, not a fix to apply locally.

`/handoff` is a separate, explicit operation that starts a new session. Nothing carries over except
its generated transfer document. Automatic compaction never selects or schedules a handoff.

### Legacy compaction strategies

Earlier versions offered `snap`, `handoff`, and other strategy values. They now
migrate to `summary`. Legacy `off` also sets `compaction.enabled: false`.

Sessions compacted by the old engine still open without loss. The removed engine always stored the full plaintext source alongside its image frames, so a legacy archive degrades gracefully:

- On each context rebuild, `legacyArchiveSourceText` (in `packages/agent/src/compaction/legacy-snapcompact-archive.ts`) reads the archived source from `CompactionEntry.preserveData.snapcompact` and re-attaches it as a single recovered text block on the compaction summary. The old image frames are never rehydrated, which also removes the oversized-payload hazard they carried.
- The next compaction over such a session drains that recovered source into the fresh LLM summary and drops the legacy archive from `preserveData`, so the session converges to a plain summarized history.

### Display transcript

By default the live TUI collapses pre-compaction history: `display.collapseCompacted` defaults to `true`, so only the latest compacted tail renders live above the summary divider and the scrollback is cleared at the compaction point. Set `display.collapseCompacted` to `false` to keep the full **display transcript** inline instead (`buildSessionContext({ transcript: true })` / `AgentSession.buildTranscriptSessionContext()`): every path entry in chronological order, with each compaction shown as a slim divider, `── 📷 compacted · ctrl+o ──`, at the point it fired. Expanding (ctrl+o) reveals the summary. In the collapsed default the LLM context and the visible transcript reset together; in the inline mode only the LLM context resets, and the scrollback above the divider stays intact, including across session resume.

### Per-turn and pre-compaction pruning

Two passes run from `AgentSession.#checkCompaction()`, after every completed turn, and both persist
through `rewriteEntries()` so the session file matches the live context (`/fork`, `/tan` and resume
read the file, and a divergent prefix cold-misses the provider prompt cache):

1. **Stale-result pass** (`#pruneStaleToolResults` → `pruneSupersededToolResults`) runs first, before
   any threshold gating, so it fires even with `compaction.enabled` off. It is skipped entirely when
   both `compaction.supersedeReads` and `compaction.dropUseless` are false.
2. **Threshold prune** (`#pruneToolOutputs` → `pruneToolOutputs`) runs only on the threshold path,
   after the `compaction.enabled` / strategy check and after error turns are skipped, and only once
   the turn has usable usage data. Its savings feed `postMaintenanceContextTokens`, which is the
   trigger figure reported to the compaction it may schedule.

Default prune policy:

- Protect newest `40_000` tool-output tokens.
- Require at least `20_000` total estimated savings.
- Never blank a result below `50` tokens (`MIN_PRUNE_TOKENS`): the `[Output truncated - N tokens]` placeholder costs ~8 tokens, so pruning a sub-floor result would grow the context and churn the prompt cache for nothing. (Superseded and useless results keep their own rules: the useless collector already drops no-savings candidates; superseded reads prune for correctness regardless of size.)
- Never prune `skill` tool results, `read` results of `skill://` paths, or reads of the active plan reference file (added via `AgentSession`'s plan protection).

Pruned tool results are replaced with:

- `[Output truncated - N tokens]`

### Superseded-read elision

Gated by `compaction.supersedeReads` (default on). When it is on, the stale-result pass keys every
`read` result by `readToolSupersedeKey` (path plus selector grammar; a selector-free read supersedes
range reads of the same base path, URL-scheme paths are exempt), and every result but the newest in
a key group is blanked to the exact placeholder `[Superseded by a newer read of this file]`
(`SUPERSEDED_NOTICE`). Turning the setting off passes no key function, so no read is ever grouped and
every read result survives at full length.

Blanking happens only where it is cheap: when the messages after the candidate total at most ~8k
estimated tokens (`PRUNE_CACHE_WARM_SUFFIX_TOKENS`, the read→edit→read tail), or when the last
message is at least 90 minutes old (`PRUNE_IDLE_FLUSH_MS`, past the 1h Anthropic "long" prompt-cache
retention), in which case every still-sent candidate flushes at once. Entries before the latest
compaction's `firstKeptEntryId` are summarized away and are never rewritten.

### Useless-result elision

Tools can flag a finished result as contextually useless, a search with zero matches, a `job` poll that timed out with everything still running, an empty `irc` inbox drain. The flag originates on the tool result (`AgentToolResult.useless`, set via `ToolResultBuilder.useless()` or directly on the returned object), is copied by the agent loop onto the persisted `ToolResultMessage` (never together with `isError`, errors always win), and is consumed in three places:

- **Per-turn stale-result pass** (`pruneSupersededToolResults`, gated by `compaction.dropUseless`, default on): flagged results are blanked to the exact placeholder `[Uneventful result elided]` (`USELESS_NOTICE`) with the same cache-aware timing as superseded reads: only when the suffix after the candidate is small (≤ ~8k tokens) or the session has idled past the provider prompt-cache lifetime. Results smaller than the notice itself are never blanked (no savings), and protected tools are exempt.
- **Threshold prune** (`pruneToolOutputs`): flagged results bypass the protect-recent window, same as superseded reads, and receive `USELESS_NOTICE` instead of the token-count placeholder.
- **Summary serialization**: `serializeConversation` drops the whole tool call/result pair from summarizer input: the source region is discarded after summarization anyway, so the exclusion costs no cache.

The flag never reaches provider wire formats, and flagged pairs are never removed from history (only blanked in place), so tool-call/result pairing stays intact.

### What the summary prompts ask for

`compaction-summary.md`, `compaction-update-summary.md`, and `compaction-summary-context.md` are
oh-my-pi's text verbatim, by operator order, on the measurement that upstream scores higher on
long-run evals. `packages/agent/test/compaction-strategy-contracts.test.ts` pins each one by
SHA-256 and preflight runs it, so an unapproved edit fails the build instead of quietly changing
summary quality. Approving a change means updating the digest in the same commit.

Both prompts request the same ten sections, in the same order: `## Goal`,
`## Constraints & Preferences`, `## Progress` (`### Done`, `### In Progress`, `### Blocked`),
`## Key Decisions`, `## Next Steps`, `## Critical Context`, `## Additional Notes`. Sections may be
omitted when they do not apply. The lists have to match, because iterative compaction feeds its own
output back in: a section the update prompt failed to name would be dropped on every cycle.

Both require exact file paths, function names, and error messages preserved rather than paraphrased,
require repository state changes (branch, uncommitted changes) when mentioned, forbid any text
outside the structured summary, and require an unanswered question to the user to survive. The
initial prompt preserves that question verbatim; the update prompt files it into `## Critical
Context`, replacing a previous pending question once it has been answered.

`## Goal` is a single undifferentiated field: the prompts do not separate a durable overarching goal
from the current task, and only `handoff-document.md` still draws that line. The update prompt also
instructs the model to preserve all information from the previous summary and permits removing only
what is no longer relevant, so iterative compaction accumulates rather than replacing drift.

### Empty responses

Neither a compaction summary nor an explicit handoff document may be empty. A provider can finish with `stopReason: "stop"` after spending its output budget on reasoning and emit no text. Both call sites raise instead of persisting an empty artifact. Lower the compaction thinking level if this repeats so the model spends its budget on the document.

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
- handoff document: `handoff-document.md` (used only by explicit `generateHandoff(...)`, not serialized compaction)

### Short summary

`CompactionEntry.shortSummary` is a display-only, pull-request-style line. `compact()` no longer
generates one: a second model request per compaction, spent on text the model never reads, is not
worth the input cost. Every reader stays, because compaction hooks still set the field and sessions
written before the change still carry it.

Its one display consumer is the session-listing title fallback (`title: header.title ?? shortSummary`
in `packages/coding-agent/src/session/session-listing.ts`), which veyyon reaches only when its own
tiny-model titler declined: `VEYYON_NO_TITLE` set, or a first message too low-signal to title from.
In that case the session picker falls back again to the first user message, so nothing renders blank.

Remote summarizer endpoint:


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

The file list is a grouped, prefix-folded directory tree (find-tool shape) with a per-file access marker, `(Read)` for read-only files, `(Write)` for modified files never read, `(RW)` for modified files also present in the cumulative read set. Capped at 20 files with an `[…N files elided…]` line. Compaction and explicit handoff append it as a `<files>` tag (via `upsertFileOperations`).

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

After summary generation (or a hook-provided summary), agent session:

1. Appends a `CompactionEntry` with `appendCompaction(...)`.
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

`compaction.model` (settings/`config.yml`, `--compaction-model` CLI, or the Compaction Model picker in `/settings`) selects the model used for LLM compaction and handoff generation. **Default: unset, compaction inherits the main session model live**, so switching the session model also switches the compactor. When set, `resolveCompactionModelPatterns` expands the value through the normal pattern/role resolution (role aliases like `"@smol"` and `:thinking` suffixes work), and auto compaction tries the resulting candidates in order. The value is a chain and can be written either way, as a comma-separated string (`opus,sonnet`) or as a YAML list; both normalize to the same ordered candidates. Legacy config keys `compaction.compactionModel` / top-level `compactionModel` are migrated to `compaction.model` on load.

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
- `compaction.strategy` = `"summary"`, the sole strategy. Every stored legacy strategy token migrates to `summary`; legacy `off` also sets `compaction.enabled: false`. Use `/handoff` for an explicit transfer to a new session.
- `compaction.reserveTokens` = unset (absent key). When unset the compaction layer falls back to `DEFAULT_RESERVE_TOKENS` = `16384`, and small-window recovery may substitute a proportional 15%-of-window reserve when the default does not fit the window (`resolveBudgetReserveTokens`).
- `compaction.keepRecentTokens` = `20000`
- `compaction.supersedeReads` = `true` (drop earlier file reads that a later read of the same file makes redundant)
- `compaction.dropUseless` = `true`
- `compaction.handoffSaveToDisk` = `false` (also write the handoff packet to disk)
- `compaction.modelContextWindow` = unset (absent key); overrides the window size the compaction budget resolves against
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
