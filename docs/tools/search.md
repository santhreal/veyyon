# search

> Search workspace files, text, or code structure.

## Source
- Entry: `packages/coding-agent/src/tools/search.ts`
- Model-facing prompt: `packages/coding-agent/src/prompts/tools/search.md`
- Key collaborators:
  - `packages/coding-agent/src/tools/file-search.ts`: file/path search (`executeFileSearch`).
  - `packages/coding-agent/src/tools/text-search.ts`: regex/literal text search (`executeTextSearch`).
  - `packages/coding-agent/src/tools/structure-search.ts`: structural code search (`executeStructureSearch`).
  - `packages/coding-agent/src/tools/search-scope.ts`: shared search scope resolution.
  - `packages/coding-agent/src/tools/cwd-boundary.ts`: filesystem targets for search scoping and permissions.
  - `crates/veyyon-natives/src/grep.rs`: native regex search.
  - `crates/veyyon-natives/src/glob.rs`: native file discovery and glob matching.
  - `crates/veyyon-natives/src/ast.rs`: native structural pattern matching.

## Inputs

Required ordered fields:

| Field | Type | Required | Description |
| --- | --- | --- | --- |
| `type` | `"files" \| "text" \| "structure"` | Yes | Representation to match: `files` for paths and repository layout, `text` for syntax-irrelevant content, `structure` for code syntax and relationships. Ordered first. |
| `input` | `string` | Yes | What to match: a path or glob for `files`, a literal or regular expression for `text`, or one valid structural code pattern for `structure`. Ordered second. |

Optional type-specific fields:

| Field | Type | Applicable Types | Description |
| --- | --- | --- | --- |
| `path` | `string` | `text`, `structure` | Search scope: file, directory, glob, internal URL, or semicolon-delimited list (`"src; tests"`). Pass the narrowest known scope; omit it only when the workspace root (`"."`) is intended. Single file targets accept line-range selectors (`:50-100`) in text mode. |
| `case` | `boolean` | `text` | Case-sensitive matching. Defaults to `true`. |
| `hidden` | `boolean` | `files` | Include hidden files. Defaults to `true`. |
| `gitignore` | `boolean` | `files`, `text` | Respect `.gitignore`. Defaults to `true`. |
| `limit` | `number` | `files` | Maximum returned paths. Defaults to `200`, max `200`. |
| `skip` | `number` | `text`, `structure` | Results to skip for pagination (file page offset for `text`, match offset for `structure`). |

Cross-type fields are rejected with `Search type "<type>" does not accept: <field>`.

## Outputs

The tool returns a single text block in `content[0].text` plus structured details in `{ type, result }`:
- For `type: "files"`: `details: { type: "files", result: FileSearchDetails }` containing `fileCount`, `files`, `truncated`, `resultLimitReached`. Output is a grouped path hierarchy sorted newest `mtime` first.
- For `type: "text"`: `details: { type: "text", result: TextSearchDetails }` containing `matchCount`, `fileCount`, `files`, `fileMatches`, `fileLimitReached`. Output is grouped by directory and file with `[PATH#TAG]` headers and `*LINE:content` match rows.
- For `type: "structure"`: `details: { type: "structure", result: StructureSearchDetails }` containing `matchCount`, `fileCount`, `filesSearched`, `limitReached`. Output shows structural code matches with metavariable bindings under `[PATH#TAG]` headers.

## Flow

1. `SearchTool.execute()` validates `input` is non-empty after trimming.
2. `rejectCrossTypeFields()` ensures only options valid for `type` are present.
3. Dispatch by `type`:
   - `files`: invokes `executeFileSearch` with `path: params.input`, `hidden`, `gitignore`, `limit`.
   - `text`: invokes `executeTextSearch` with `pattern: params.input`, `path`, `case`, `gitignore`, `skip`.
   - `structure`: invokes `executeStructureSearch` with `pattern: params.input`, `path`, `skip`.
4. Returns formatted content and `{ type, result }` details.

## Modes / Variants

1. **Files search (`type: "files"`)**
   - Match workspace file paths and directory layout via globs or directory names.
   - Example: `{ type: "files", input: "src/**/*.ts" }`
2. **Text search (`type: "text"`)**
   - Regex or literal content search across files, directories, globs, or internal URLs (`veyyon://`, `skill://`).
   - Example: `{ type: "text", input: "TODO|FIXME", path: "src" }`
3. **Structure search (`type: "structure"`)**
   - Structural code pattern search using syntax patterns (`$NAME`, `$_`, `$$$NAME`, `$$$`).
   - Example: `{ type: "structure", input: "console.log($$$)", path: "src/**/*.ts" }`

## Settings
The tool is part of the default inventory. Text matching uses two settings:
- `search.contextBefore`: `number`, default `1` (lines of context before each match).
- `search.contextAfter`: `number`, default `3` (lines of context after each match).

## Limits & Caps

- Files limit: `200` paths max (`DEFAULT_LIMIT` / `MAX_LIMIT`).
- Text file limit: `20` files per page (`DEFAULT_FILE_LIMIT`), max `20` matches per file in multi-file mode, internal cap `2000` total matches.
- Structure match limit: `50` matches (`DEFAULT_AST_LIMIT`).
- Text output byte cap: 50 KB default via `tools.artifactSpillThreshold`.

## Errors

- `Search input must not be empty` when `input` is empty or whitespace.
- `Search type "<type>" does not accept: <fields>` on cross-type options.
- `Search scope entries must be non-empty paths or globs` for invalid `path`.
- `Path not found: ...` when target paths do not exist.
