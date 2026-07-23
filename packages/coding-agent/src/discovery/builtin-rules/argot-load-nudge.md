---
description: "Nudge the model to call argot_load when editing a project whose Argot shorthand is not loaded yet"
scope: "tool:edit, tool:write, tool:ast_edit"
interruptMode: never
---

{{#if argot}}
You are modifying files in a repository whose Argot shorthand dictionary has not been loaded into your session context yet.

## Why this costs tokens
Without loading the project's dictionary, every path and identifier is processed in uncompressed plaintext. Calling `argot_load` on the project root generates short `§handle` tokens (`§a`, `§b`), cutting token footprint across all subsequent turns.

## What to do
- Call `argot_load(folder_path: ".")` (or the project root) to load shorthand handles for this repository.
- Use `§handle` tokens in your subsequent prose and tool parameters.
{{/if}}
