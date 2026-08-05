Re-root this session's working directory for the rest of the session only.

Use when the launch directory is wrong and subsequent relative `read` / `grep` / `bash` / `task` paths should resolve against a different project root. Files inside the working directory get short relative paths in `read` / `edit` headers; a file outside it keeps its full absolute path.
{{#if argot}}

Re-rooting does NOT arm that project's Argot shorthand; the two are separate. To also compress the project's identifiers, call `argot_load` on it.
{{/if}}

The result names which rule files (AGENTS.md, CLAUDE.md and the other context layers) started and stopped applying, because those are found by walking up from the working directory. Follow the ones it names as newly in effect, and stop applying the ones it names as dropped.

Rules:
- `path` must exist and be a directory.
- The change is session-scoped and ephemeral: it applies to this session only and never writes the profile `session.workdir` setting.
- Subagents already running keep the cwd they were spawned with; new subagents inherit the new root.
- Re-rooting to a directory OUTSIDE the current working directory needs the same permission as reading or writing outside it, so it may ask the user first. Re-rooting to a subdirectory of the current one never asks: it narrows what the session can reach rather than widening it.
- Prefer an absolute path. Relative paths resolve against the current session cwd, not the OS cwd or the project root, so a relative path can point somewhere unexpected when the session was re-rooted.
- `.` means the current session cwd and `..` means its parent. A later tool header may display the cwd itself as `.`, which is only a short label for the absolute cwd returned here, not evidence that the session moved.
