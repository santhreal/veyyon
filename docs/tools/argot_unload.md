# argot_unload

> Stop being taught a folder's Argot shorthand; handles you already wrote keep expanding, so this is always safe.

## Source
- Entry: `packages/coding-agent/src/tools/argot.ts` (`ArgotUnloadTool`)
- Tool name constant: `ARGOT_UNLOAD_TOOL`, exported by the `argot` package.
- Key collaborators:
  - `packages/coding-agent/src/argot-cache.ts`: `unloadArgotFolder()` resolves the folder to its work-unit root and drops that key from the teach set.
  - `packages/coding-agent/src/tools/path-utils.ts`: `resolveToCwd()` resolves a relative request against the session cwd.
  - `packages/coding-agent/src/tools/index.ts`: registers the tool, gated on the `argot.enabled` setting.

## Teaching and decoding are separate
This is the distinction the whole tool rests on. **Teaching** is showing you a project's handle table so you can write `§handle` instead of a long string. **Decoding** is expanding a handle back to its full text.

Unloading stops the teaching only. Decoding stays on for every handle the session has ever loaded, so anything already written keeps expanding correctly. That is why unloading can never strip meaning from your transcript, and why it needs no confirmation.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `folder_path` | `string` | Yes | Absolute (preferred) or session-relative path to the folder to stop teaching. Surrounding whitespace is trimmed; an empty value is rejected. |

The folder resolves to its work-unit root the same way `argot_load` resolves it, so unloading targets the entry that loading created.

## Outputs
A single text block plus structured `details`.

- Changed: `Stopped teaching Argot shorthand for <root>. Any handles you already wrote still expand; you just will not be shown new ones for this project.`
- Nothing to do: `Argot shorthand for <root> was not loaded (or was already not being taught), so nothing changed. Decoding of any handle already written stays on.`
- No project marker: `No project marker (.git or .argot) found at or above <folder>, so there was nothing loaded to unload.`
- `details`:
  - `root`: the work-unit root the folder resolved to.
  - `changed`: whether the unload actually removed an entry. `false` when the folder was never taught.
  - `requested`: the trimmed path string as it arrived.

Each branch states the resulting state and echoes the path that arrived, so a call that changed nothing still reads as the success it is rather than as a failure to act.

## Flow

1. `ArgotUnloadTool.execute()` trims `folder_path` and throws `folder_path is required` when it is empty.
2. `requireArgot()` reads the session's Argot codec and throws when Argot is off for this session.
3. `resolveToCwd()` resolves the request against the session cwd.
4. `unloadArgotFolder()` resolves the folder to its work-unit root and drops that key from the teach set, reporting whether anything was there to drop.

## Side Effects
- Session state: removes the project's handles from the teach set, so its handle table stops appearing in the prompt. Decoding is untouched.
- Filesystem: none. Unlike loading, this reads no repository and writes no cache; it only resolves the project root.
- Approval: read-tier, for the same reason as `argot_load`. No working tree is modified.

## Errors
- `folder_path is required` when the argument is empty or whitespace only.
- `Argot shorthand is not enabled for this session, so there is nothing to load. Enable it with the `argot.enabled` setting.` when the session has no codec.

Unloading a folder that was never loaded is not an error. Neither is a folder with no project marker. Both are reported as the no-change outcomes they are.

## Notes
- Reach for this when you are done with a folder you loaded earlier and want the taught handle table to stay small. A large table costs tokens in every prompt.
- You never need to unload for correctness. Nothing breaks if you leave a folder loaded for the rest of the session.
- Unloading the session's own project is possible but rarely useful: that project is the one whose paths you are most likely to keep writing.
