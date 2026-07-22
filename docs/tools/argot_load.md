# argot_load

> Teach yourself another folder's Argot shorthand, so you can write its long paths and identifiers as short `§handle` tokens.

## Source
- Entry: `packages/coding-agent/src/tools/argot.ts` (`ArgotLoadTool`)
- Tool name constant: `ARGOT_LOAD_TOOL`, exported by the `argot` package.
- Key collaborators:
  - `packages/coding-agent/src/argot-cache.ts`: `loadArgotFolder()` resolves the folder to its work-unit root and reads or generates that root's cache entry.
  - `packages/coding-agent/src/tools/path-utils.ts`: `resolveToCwd()` resolves a relative request against the session cwd.
  - `packages/coding-agent/src/tools/index.ts`: registers the tool, gated on the `argot.enabled` setting.

## What Argot is
Argot gives a project a dictionary of short handles for strings that recur in it: long paths, package names, repeated identifiers. Writing `§handle` instead of the full string saves tokens. Every handle is expanded back to its full text before it leaves the model's history, so a handle is always lossless: it cannot change meaning, only length.

A session arms the shorthand for its own cwd's project automatically. This tool is for the other folders you end up working in, such as a sibling crate in a monorepo or a dependency checkout.

## Inputs

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `folder_path` | `string` | Yes | Absolute (preferred) or session-relative path to the folder to load. Surrounding whitespace is trimmed; an empty value is rejected. |

Argot resolves the folder to the nearest project it belongs to, meaning the closest enclosing directory holding a `.git` or `.argot` marker. It never resolves upward to a parent that contains many projects. Load the narrowest folder that is your work unit.

## Outputs
A single text block plus structured `details`.

- Handles loaded: `Loaded Argot shorthand for <root> (<n> handles). ...`
- Project resolved but empty: `Resolved <root>, but its dictionary is empty (no string recurs often enough to earn a handle), so there is nothing new to write in shorthand. Decoding is on regardless.`
- No project marker: `No project marker (.git or .argot) found at or above <folder>, so there is no shorthand to load. ...`
- `details`:
  - `root`: the work-unit root the folder resolved to.
  - `handles`: how many handles the loaded dictionary carries (`0` for both the empty-dictionary and no-marker cases).
  - `requested`: the trimmed path string as it arrived.

## Flow

1. `ArgotLoadTool.execute()` trims `folder_path` and throws `folder_path is required` when it is empty.
2. `requireArgot()` reads the session's Argot codec and throws when Argot is off for this session, rather than quietly doing nothing.
3. `resolveToCwd()` resolves the request against the session cwd.
4. `loadArgotFolder()` resolves the folder to its work-unit root and reads that root's immutable cache entry, generating it once (keyed by content signature) when it is missing.
5. The resolved vocabulary is unioned into the session under the root as its key. Loading a second, different folder adds to the union; loading the same folder again replaces its entry with the freshly resolved one.

## Side Effects
- Session state: adds the project's handles to the session's teach set, so they appear in the prompt's handle table from the next turn.
- Filesystem: reads the project to build its dictionary, and writes a cache entry outside the repository when one does not already exist. The dictionary is never committed to the repo, and no working tree is modified.
- Approval: read-tier. The tool reads a repository and mutates only a local cache and the teach set.

## Errors
- `folder_path is required` when the argument is empty or whitespace only.
- `Argot shorthand is not enabled for this session, so there is nothing to load. Enable it with the `argot.enabled` setting.` when the session has no codec.
- A genuine dictionary conflict (two projects binding one handle name to different expansions) or a malformed cache entry surfaces as a `ToolError` carrying the underlying message. These fail loudly rather than skipping the folder, because a silently skipped load looks identical to a project with no handles.

A folder with no project marker is not an error. It is a normal "nothing to load" answer and is reported as one.

## Notes
- Loading can only save tokens. It cannot change what anything means, because every handle expands before it leaves your history.
- Prefer the narrowest folder. Pointing at a monorepo root teaches you handles for projects you are not working in and makes the handle table larger for no benefit.
- A project whose dictionary is empty is a normal outcome for small or highly varied codebases. Nothing recurs often enough to be worth a handle.
- Use `argot_unload` when you are done with a folder, to keep the taught handle table small.
