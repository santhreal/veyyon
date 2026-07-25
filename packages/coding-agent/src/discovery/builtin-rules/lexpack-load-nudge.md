---
description: "Nudge the model to call argot_load when editing a project whose Argot shorthand is not loaded yet"
scope: "tool:edit, tool:write, tool:ast_edit"
interruptMode: never
---

{{#if argot}}
You are modifying files in a repository whose Argot shorthand dictionary is not loaded yet.

- Call `argot_load(folder_path: ".")` on the project root to load `§handle` shorthand.
- Use `§handle` tokens in your subsequent prose and tool parameters.
{{/if}}
