<omfg>
The user is frustrated about recurring agent behavior.
Author ONE Time Traveling Stream Rule (TTSR) that would have caught the offending behavior earlier in this conversation.

TTSR mechanics:
- A rule is a markdown file with YAML frontmatter.
- `condition` is one or more JavaScript regex patterns tested against assistant streamed output.
- `astCondition` is one or more ast-grep patterns tested structurally against the source an edit/write tool call introduces. Prefer it when the offense is a code shape (`$X as any`, `eval($X)`) rather than a substring, and keep a regex `condition` as backstop.
- `scope` is a comma-separated allowlist. If present, only listed streams are checked.
- `text` = assistant prose only. `thinking` = hidden reasoning summaries. `tool` = every tool's arguments.
- `tool:<name>(<glob>)` = one tool, only when path-like args match the glob. Examples: `tool:write(*.rb)`, `tool:edit(*.ts)`.
- SHOULD use file-specific tool scopes for code complaints. Ruby code generated through `write` → `tool:write(*.rb)`, not bare `tool` or `text`.
- Tool arguments may be serialized while streaming. Conditions for code containing quotes SHOULD tolerate JSON escaping.
- When `condition` or `astCondition` matches within `scope`, the stream is interrupted and the markdown body is injected as correction guidance.

Output contract:
- JSON fields: `name`, `description`, `condition`, `scope`, `body`. Optional: `astCondition`, `interruptMode`, `pathScope`, `repeatMode`, `repeatGap`, `repeatCompactions`, `warmupMatches`.
- `name` MUST be kebab-case.
- `description` MUST be a one-line summary.
- `condition` MUST be a string or string array of JavaScript regex patterns.
- `condition` MUST match the specific offending assistant output visible earlier in this conversation. Required unless `astCondition` is present; include both when the offense has both textual and structural form.
- Escape regex backslashes for JSON exactly once: use `"\\beval\\s*\\("`, NEVER `"\\\\beval\\\\s*\\\\("`.
- Keep `condition` precise; NEVER use broad catch-alls.
- `scope` MUST be a string or string array.
- Keep `scope` as narrow as the complaint allows. NEVER use `tool, text` unless the same bad behavior occurred in both tool arguments and assistant prose.
- An `astCondition` rule MUST scope to edit or write over files of its language (for example `tool:edit(*.ts)`), because AST conditions are evaluated only there.
- `interruptMode`: omit unless the complaint implies it. `"tool-only"` interrupts tool calls but lets prose finish; `"never"` queues the guidance after the turn instead of interrupting; `"prose-only"` and `"always"` are the remaining values.
- `pathScope`: `"outside-cwd"` only for complaints about touching paths outside the project; `"inside-cwd"` is the reverse.
- Repeat tuning: omit by default. A habit worth re-stating per occurrence → `repeatMode: "after-gap"` plus `repeatGap` (messages between firings). Advice tied to a standing state that keeps being true → `repeatMode: "per-compact"` plus `repeatCompactions` (transcript resets to wait out). A behavior that should not earn an interruption until seen several times → `warmupMatches` (distinct matching streams before the first firing).
- `body` MUST be markdown guidance explaining the right behavior concisely.
- The caller assembles YAML frontmatter. NEVER emit markdown frontmatter or a fenced code block around the JSON.

Example shape:
{
  "name": "ts-no-any",
  "description": "Never use `any` in TypeScript — use `unknown`, a generic, or the real type",
  "condition": ": any|as any",
  "scope": ["tool:edit(*.ts)", "tool:edit(*.tsx)", "tool:write(*.ts)", "tool:write(*.tsx)"],
  "body": "Never use `: any` or `as any`. Use `unknown`, a domain type, a generic, or a type guard."
}

Complaint:
{{complaint}}

{{#if feedback}}
Failed attempts or requested amendments so far:
{{feedback}}

Latest candidate JSON:
{{previousRule}}

Regenerate one corrected rule. Fix the listed validation failures or user amendment. NEVER repeat failed scopes or conditions.
{{/if}}
</omfg>
