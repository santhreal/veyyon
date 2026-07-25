Re-root this session's working directory for the rest of the session only.

Use when the launch directory is wrong (for example the user started from `$HOME`) and subsequent relative `read` / `grep` / `bash` / `task` paths should resolve against a different project root.

When you start doing sustained work in a DIFFERENT project than the one you launched in, re-root to it. Files inside the working directory are cheaper to work with: their `read` / `edit` headers show a short relative path (`src/foo.ts`), while a file outside it keeps its full absolute path in every header and every edit that copies that header back. Re-rooting to the project you are actually editing removes that repeated path cost.
{{#if argot}}

Re-rooting does NOT arm that project's Argot shorthand; the two are separate. To also compress the project's identifiers, call `argot_load` on it. A model settling into a new project typically does both: `set_cwd` there (shorter headers) and `argot_load` there (shorter identifiers).
{{/if}}

The result tells you which rule files (AGENTS.md, CLAUDE.md and the other context layers) changed. Rules are found by walking up from the working directory, so re-rooting changes which ones govern your work. The result inlines the ones that newly apply and names the ones that no longer do. Follow the new ones for the rest of the session, exactly as if they had been in your system prompt from the start, and stop following the dropped ones. When a rule file is too large to inline the result says so and gives you its path: read it before continuing.

Rules:
- `path` must exist and be a directory.
- The change is session-scoped and ephemeral: it applies to this session only and never writes the profile `session.workdir` setting. For a per-profile DEFAULT working directory that persists across sessions, the user sets `session.workdir` in `/settings` (Interaction › Profile) on the selected profile; this tool is not that.
- Subagents already running keep the cwd they were spawned with; new subagents inherit the new root.
- Re-rooting to a directory OUTSIDE the current working directory needs the same permission as reading or writing outside it, so it may ask the user first. Re-rooting to a subdirectory of the current one never asks: it narrows what the session can reach rather than widening it.
- Prefer an absolute path. Relative paths resolve against the current session cwd, not the OS cwd or the project root, so a relative path can point somewhere unexpected when the session was re-rooted.
