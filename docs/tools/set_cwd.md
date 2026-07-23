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

- Changed: `Session cwd is now <cwd> (previously <previous>). Your requested path "<raw>" resolved to it.`
- Unchanged: `Session cwd is <cwd>. Your requested path "<raw>" resolved to that same directory, so nothing needed to change. This call succeeded; do not retry it.`
- `details`:
  - `previous`: the cwd before the call.
  - `cwd`: the cwd after the call, as the session resolved it.
  - `requested`: the trimmed path string as it arrived.

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
+- **Prompt Cache Protection:** Working directory changes occur across three distinct mutation vectors:
  1. *Profile Defaults (`session.workdir` setting)*: Configured per-profile; updating it mid-session updates future session defaults without mutating live prompt headers.
  2. *Agent Tool (`set_cwd`)*: Re-roots live session scope for path resolving (`[name#tag]`); prompt header metadata remains frozen until context compaction.
  3. *User Commands (`/cd`, `/move`)*: Changes interactive execution scope without invalidating system prompt prefix hashes.
  
  **Rule:** To prevent cache invalidation, the rendered System Prompt and `<workstation>` block in preceding chat context MUST NOT be re-rendered mid-session prior to context compaction. Updating prompt header metadata is deferred to compaction re-primes when history is already reset.
- Filesystem: none. The directory is read for validation by the session, nothing is written.
- Approval: write-tier. It prompts in ask mode, is allowed under yolo and `bypassAllApprovals`, and is always blocked by a hard deny. The approval prompt shows `Working directory: <previous> → <next>`.
## Errors
- `path is required` when the argument is empty or whitespace only.
- `Session does not support setCwd.` when the session has no re-root capability.
- Whatever the session raises when the target cannot be adopted (a missing directory, a path that is not a directory, a permission error), re-wrapped as a `ToolError`.

A rejected directory is always an error. It is never reported as a no-op, so "nothing needed to change" can only ever mean the move genuinely was not needed.

## Notes
- Asking for the directory you are already in is a success, not a failure, and the result says so outright.
- The transcript distinguishes the two cases: a real move renders `<previous> → <cwd>`, a no-op renders `<cwd> (already here)`. Previously both drew the same confirmation, so a run of retries was unreadable after the fact.
- Prefer absolute paths. Relative paths resolve against the current cwd, which is the value this call is about to change, so chaining relative moves is harder to reason about than it looks.
