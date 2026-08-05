Re-root this session's working directory for the rest of the session only.

Use when the launch directory is wrong and subsequent relative `read` / `grep` / `bash` / `task` paths should resolve against a different project root. Files inside the working directory get short relative paths in `read` / `edit` headers; a file outside it keeps its full absolute path.
{{#if argot}}

Re-rooting does NOT arm that project's Argot shorthand; the two are separate. To also compress the project's identifiers, call `argot_load` on it. A model settling into a new project typically does both: `set_cwd` there (shorter headers) and `argot_load` there (shorter identifiers).
{{/if}}

Re-root when the work moves, not when you touch a file. Concretely: the user names a project or directory and you are about to work there; you have read or edited three or more files under one directory outside the working directory, or run three or more commands there; or the session started in a home, temp, or launch directory rather than the project you were asked about. Do not re-root to pass through a file or two, and do not re-root to a parent of the current directory in order to reach one file.

The result names which rule files (AGENTS.md, CLAUDE.md and the other context layers) started and stopped applying, because those are found by walking up from the working directory. Follow the ones it names as newly in effect, and stop applying the ones it names as dropped.

Rules:
- `path` must exist and be a directory.
- The change is session-scoped and ephemeral: it applies to this session only and never writes the profile `session.workdir` setting.
- Subagents already running keep the cwd they were spawned with; new subagents inherit the new root.
- Re-rooting to a directory OUTSIDE the current working directory needs the same permission as reading or writing outside it, so it may ask the user first. Re-rooting to a subdirectory of the current one never asks: it narrows what the session can reach rather than widening it.
- Prefer an absolute path. Relative paths resolve against the current session cwd, not the OS cwd or the project root, so a relative path can point somewhere unexpected when the session was re-rooted.
- `.` means the current session cwd and `..` means its parent. A later tool header may display the cwd itself as `.`, which is only a short label for the absolute cwd returned here, not evidence that the session moved.
