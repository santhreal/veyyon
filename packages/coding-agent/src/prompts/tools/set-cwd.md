Re-root this session's working directory for the rest of the session only.

Use when the launch directory is wrong (for example the user started from `$HOME`) and subsequent relative `read` / `grep` / `bash` / `task` paths should resolve against a different project root.

Rules:
- `path` must exist and be a directory.
- The change is session-scoped: it never writes the profile `session.workdir` setting.
- Subagents already running keep the cwd they were spawned with; new subagents inherit the new root.
- Prefer an absolute path. Relative paths resolve against the current session cwd.
