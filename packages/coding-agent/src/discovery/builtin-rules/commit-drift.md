---
description: "Uncommitted edits from this session have piled up; land the finished chunk as its own commit before the change becomes one unreviewable blob"
condition: ".*"
scope: "tool:edit, tool:write, tool:ast_edit"
interruptMode: never
repeatMode: after-gap
repeatGap: 25
---

{{#if commitDrift}}
You have changed {{commitDrift.count}} files that are not in a commit yet: {{commitDrift.files}}.

A commit is how a change becomes reviewable and recoverable. One commit holding several
concerns cannot be read, reverted, or bisected, and the further this runs the less any of
those are possible.

## What to do

- If some of this work is finished and stands on its own, commit that part now, with a subject that names the one concern it covers. Leave the rest uncommitted.
- If none of it stands on its own yet, keep going. A commit in the middle of a refactor is worse than a large one at the end of it.

## Rules for that commit

- **Green first.** Run the gate that covers what you changed before committing it. A commit that does not build is not a checkpoint.
- **Stage your own paths only, by name.** Never `git add -A`: a working tree routinely carries someone else's in-flight work, and the file list above is yours. Anything dirty that is not on it is not.
- **Do not push.** Pushing is a separate action and needs the user to ask for it.
{{/if}}
