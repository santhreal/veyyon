---
description: "Nudge the model to call argot_load when editing a project whose Argot shorthand is not loaded yet"
condition: ".*"
scope: "tool:edit, tool:write, tool:ast_edit"
interruptMode: never
---

{{#if argotUnloaded}}
You are editing files in a project whose Argot shorthand dictionary is not loaded, so every identifier you write costs its full token length.

- Call `argot_load(folder_path: ".")` on the project root to load its `§handle` shorthand.
- Then use `§handle` tokens in your prose and in tool parameters. Shorthand is armed per project, so a project you have not loaded is still spelled out in full.
{{/if}}
