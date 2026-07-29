# set_cwd

> Re-root the session's working directory for the rest of the session; it does not touch your saved profile.

## Source
- Entry: `packages/coding-agent/src/tools/set-cwd.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/set-cwd.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/path-utils.ts`: `resolveToCwd()` turns a relative request into an absolute path against the current cwd.
  - `packages/coding-agent/src/tools/tool-errors.ts`: maps failures to user-facing `ToolError`s.
  - `packages/coding-agent/src/tui`: `framedBlock` / `renderStatusLine` draw the transcript result.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `path` | `string` | Yes | Absolute (preferred) or session-relative directory to become the new session cwd. Surrounding whitespace is trimmed; an empty or whitespace-only value is rejected. |

## Outputs
A single text block plus structured `details`.

- Changed: `Moved cwd: <previous> → <cwd>. Your requested path "<raw>" resolved to <cwd>. Relative paths now resolve from there, so read "." to list the top level of your new cwd. This change is session-scoped and ephemeral; a per-profile default working directory is the session.workdir setting, not this tool.`
- Unchanged: `Cwd stays at <cwd>. Your requested path "<raw>" resolved to the directory the session was already in, so nothing moved. This call succeeded; do not retry it. Relative paths resolve from there, so read "." to list the top level of your cwd.`

  Both name the directory at each end rather than only the destination. A model that re-roots and then cannot tell whether it moved reads the next relative path against the wrong root, and the earlier `Session cwd is now <cwd> (previously <previous>)` wording collapsed to `Session cwd is now . (previously .)` whenever either value reached it unresolved.
- Both branches then describe the rule files. When the set changed, the result names the files that started applying and the ones that stopped. When it did not, it says `The rule files in effect are unchanged.`
- `details`:
  - `previous`: the cwd before the call.
  - `cwd`: the cwd after the call, as the session resolved it.
  - `requested`: the trimmed path string as it arrived.
  - `rulesApplied`: rule files that apply here and did not apply at `previous`.
  - `rulesDropped`: rule files that applied at `previous` and do not apply here.
  - `rulesUnchanged`: how many rule files apply in both directories.

The rule fields are reported for a no-op too, and they carry the real counts. A no-op used to report `rulesUnchanged: 0`, which was untrue: user-level rule files apply from every directory, so a session that never moved still has rules governing it. Both branches now read the same describer, so the numbers and the sentence beside them cannot disagree.

Both branches state the resulting directory rather than describing what did or did not happen, and both echo the path that actually arrived. This is deliberate. The earlier wording for the no-op case was `Session cwd unchanged: <path>`, which a caller that just asked for that path reads as "your call did not take effect". A real agent retried it repeatedly, got the identical line each time, and concluded its argument was not reaching the tool. Nothing in the message let it check that, which is why `requested` is echoed now: when you ask for `.` and land in a long absolute path, seeing both tells you your argument was fine.

## Flow

1. `SetCwdTool.execute()` trims `path`. An empty result throws `path is required`.
2. If the session has no `setCwd` capability, it throws `Session does not support setCwd.`
3. `resolveToCwd(raw, previous)` resolves the request against the current cwd.
4. `session.setCwd(resolved, { validate: true })` performs the move. Validation is the session's job, so a missing or unreadable directory surfaces here as a thrown error, not as a confirmation.
5. The returned path is compared with the previous cwd to choose between the two result texts. The session may canonicalize (symlinks, macOS `/private`), so the reported directory is what `setCwd` returned, not what was requested.
6. Any throw from the session is re-wrapped as a `ToolError` carrying the original message.

## Side Effects & Prompt Cache Stability
- Session state: re-roots the live session at the new directory. The session cwd changes, and in an interactive session the project-scoped state follows it: project settings (`.veyyon` / `.claude`) reload, and plugins, slash commands, capabilities, the ssh tool, and the system-prompt project framing are rebuilt for the new directory.
- **Prompt Cache Protection:** Working directory changes occur across three distinct mutation vectors:
  1. *Profile Defaults (`session.workdir` setting)*: Configured per-profile; updating it mid-session updates future session defaults without mutating live prompt headers.
  2. *Agent Tool (`set_cwd`)*: Re-roots live session scope for path resolving (`[name#tag]`); prompt header metadata remains frozen until context compaction.
  3. *User Commands (`/cwd`, `/move`)*: Changes interactive execution scope without invalidating system prompt prefix hashes.
  **Rule:** To prevent cache invalidation, the rendered System Prompt and `<workstation>` block in preceding chat context MUST NOT be re-rendered mid-session prior to context compaction. Updating prompt header metadata is deferred to compaction re-primes when history is already reset.
- Filesystem: none. The directory is read for validation by the session, nothing is written.
- Approval: write-tier. It prompts in ask mode, is allowed under yolo and `bypassAllApprovals`, and is always blocked by a hard deny. The approval prompt shows `Working directory: <previous> → <next>`.
## Errors
- `path is required` when the argument is empty or whitespace only.
- `Session does not support setCwd.` when the session has no re-root capability.
- Whatever the session raises when the target cannot be adopted (a missing directory, a path that is not a directory, a permission error), re-wrapped as a `ToolError`.

A rejected directory is always an error. It is never reported as a no-op, so "nothing needed to change" can only ever mean the move genuinely was not needed.

## Getting the tool

`set_cwd` is a `discoverable` tool. Under `tools.discoveryMode: all` it is deliberately kept out of the initial toolset, because most sessions never re-root and the slot is not free; the model finds it through `search_tool_bm25`.

Two places tell the model to re-root, and both account for that:

- The `<working-directory>` block of the system prompt states when to re-root. When `set_cwd` is not in the active tool list, the block adds that the tool must be activated first.
- A session rooted somewhere that is not a project at all is told so in the system prompt, at startup, rather than after it drifts. Three things count as not a project: a launch directory (a filesystem root, your home, a mount point under `/media`, `/mnt` or `/Volumes`, a temp directory, or the Windows equivalents), a directory carrying no `.git`, build manifest or `AGENTS.md`, and a repository that holds other projects. The prompt names the directory, the reason, and what it costs you: no project `AGENTS.md` has loaded and every path will be absolute.
- Such a session also needs less evidence before the hint fires. Normally three files under one outside directory are needed to tell "the work moved" from "a file was read in passing"; when the working directory is not a project that question does not arise, so one file is enough. The detector also counts work happening *inside* the working directory in this case, which it otherwise ignores. That matters more than it sounds: if you launch from `$HOME` and work in `$HOME/code/project`, every path you touch is inside the working directory, so without this nothing is ever recorded and no hint can fire at all.
- The re-root hint (`packages/coding-agent/src/tools/reroot-hint.ts`) watches out-of-cwd filesystem activity and appends one line to a tool result once a directory outside the working directory has been touched three times. Before it emits that line it activates `set_cwd` for the session, so the call it recommends is a call the model can make. If activation is unavailable or fails, the hint says the tool is missing and names the reason instead of recommending it.
- The hint names the PROJECT, not the directory the activity was measured in. The detector picks the deepest directory that crossed the threshold, which is the right way to decide which activity to report and the wrong place to send you: three reads under `keyhog/crates/cli/src/subcommands/` would otherwise advise re-rooting five levels inside one project. `resolveProjectRoot` climbs from there to the nearest `.git`, or to the outermost manifest when there is no repository, and never returns a directory that contains your working directory. One project earns at most one hint, however many of its subtrees you work in.
- A repository that holds OTHER projects is not offered as a destination. Some trees are under version control without being a project: a whole working tree mirrored for backup is one repository containing dozens of unrelated checkouts, and re-rooting there leaves every path in the project you care about as long as it was while loading the container's rules instead of the project's. The test is not how many repositories are nested inside, because an ordinary project can carry many as fixtures or caches. It is whether the outer repository *ignores* them: a project gitignores the checkouts it vendors or caches, saying they are not part of it, while a tree that merely holds other projects ignores none of them. One unignored nested repository is enough to rule a directory out. When git cannot answer the question, the directory is ruled out and a warning says so, rather than being offered on a guess.

That check is the difference between advice and an instruction the model cannot follow. Without it the prompt told the model to call a tool absent from its request, so re-rooting worked only in the sessions where something else had already activated the tool.

## Notes
- Asking for the directory you are already in is a success, not a failure, and the result says so outright.
- The transcript distinguishes the two cases: a real move renders `<previous> → <cwd>`, a no-op renders `<cwd> (already here)`. Previously both drew the same confirmation, so a run of retries was unreadable after the fact.
- Prefer absolute paths. Relative paths resolve against the current cwd, which is the value this call is about to change, so chaining relative moves is harder to reason about than it looks.
