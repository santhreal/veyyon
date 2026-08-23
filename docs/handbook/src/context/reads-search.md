# Bounded reads and search

Three tools give the agent controlled access to your files: `read`, `search`, and
`write`. They are always available; there is no `experimental_tools` or `backends.toml` gate
to turn them on.

The point of these tools is bounds. An unbounded `cat`, `find`, or `grep -r` in the shell
can dump enough text to fill the whole context window. These tools apply line, byte, and
result caps instead, and they surface truncation rather than dropping output silently. This
page documents each tool's parameters and the limits it enforces. The implementations live
under `packages/coding-agent/src/tools/{read,search,write}.ts`.

## The `read` tool (`tools/read.ts`)

`read` takes a single `path` string (no separate `offset`/`limit` arguments) and bounds every read
to a budget:

- **One parameter, inline selectors.** `read {path}`, where `path` can carry a line-range selector
  appended after a colon: `src/foo.ts:50-200` (inclusive range), `src/foo.ts:50` / `:50-` (from line 50
  on), `src/foo.ts:50+150` (150 lines from line 50), or `src/foo.ts:5-16,960-973` (multiple ranges in
  one call). `:raw` reads verbatim with no anchors or line prefixes.
- **Dual budget, whichever is hit first:** a line cap (`DEFAULT_MAX_LINES = 3000`) and a byte cap
  (`DEFAULT_MAX_BYTES`, 50 KB). A file that is short in lines but huge in bytes (minified JS, a data
  blob) is bounded by bytes; a file with many short lines is bounded by lines. Both are compiled, not
  configured, and `read` is deliberately the one tool exempt from artifact spilling: it is bounded by
  LINES, so spilling on bytes would hand back fewer lines than you asked for and break the contract
  the tool has. Every other tool's output is bounded by `tools.artifactSpillThreshold`, described
  under [The `search` tool](#the-search-tool-toolssearchts) below.
- **Structural summaries for parseable code.** A read with no selector on a parseable source file
  returns declarations with bodies elided (`…`), and the footer names the recovery selector so the model
  re-issues only the ranges it actually needs instead of re-reading the whole file.
- **Truncation is explicit.** A summary footer or a `[Showing lines …]`-style notice names the
  continuation selector.
- **Beyond plain text files:** the same tool also reads directories (depth-limited listing), archives
  (`.tar`, `.tar.gz`, `.zip`, via `archive.zip:path/inside`), SQLite databases (`file.db:table`, with
  pagination and `where`/`order` filters), PDF/Word/PowerPoint/Excel/EPUB (extracted text), Jupyter
  notebooks (editable cell text), images, URLs (reader-mode by default), and internal URI schemes
  (`memory://`, `skill://`, `artifact://`, `mcp://`, `ssh://`, and others).

Text reading is intentionally separate from image inspection. By default, `read` decodes image
files (PNG, JPEG, GIF, WEBP) inline for direct visual analysis. When `inspect_image.enabled` is set,
`read` returns image metadata instead and the model inspects the image by calling `inspect_image`
with a question.

## The `search` tool (`tools/search.ts`)

Workspace discovery and searching are unified in the `search` tool, covering file path lookup,
text/regex search, and structural code search through one canonical model-facing interface. It
takes two required ordered fields followed by type-specific options:

1. **`type` (ordered first):** representation to match:
   - `"files"`: match paths and repository layout.
   - `"text"`: match syntax-irrelevant text or regex content.
   - `"structure"`: match code syntax and structural relationships.
2. **`input` (ordered second):** what to match:
   - for `"files"`: a path, directory, or glob pattern (e.g. `"src/**/*.ts"`).
   - for `"text"`: a literal or regular expression pattern (e.g. `"TODO|FIXME"`).
   - for `"structure"`: one structural code pattern (e.g. `"console.log($$$)"`).

### Type-specific options and validation

Options are strictly validated per `type`; cross-type fields are rejected with an actionable error:

- **`type: "files"`** accepts `hidden`, `gitignore`, and `limit`:
  - **`hidden` (default `true`)** includes dotfiles.
  - **`gitignore` (default `true`)** respects `.gitignore` rules; set `false` to search ignored paths.
  - **`limit` (default `200`, max `200`)** bounds returned paths; output is sorted by `mtime` descending and grouped under `# <dir>/` directory headers.
- **`type: "text"`** accepts `path`, `case`, `gitignore`, and `skip`:
  - **`path`** scopes the search (file, directory, glob, internal URL like `veyyon://`, or a semicolon-delimited list). Pass the narrowest known scope; omit it only when the workspace root (`"."`) is intended. Line-range selectors (e.g. `:50-100`) on a single file target constrain matches.
  - **`case` (default `true`)** toggles case sensitivity.
  - **`gitignore` (default `true`)** respects `.gitignore`.
  - **`skip`** pages past already-returned files; results are paginated at `20` files per call (`DEFAULT_FILE_LIMIT`) with an internal cap of `2000` matches. Context lines around matches are governed by `search.contextBefore` (default `1`) and `search.contextAfter` (default `3`).
- **`type: "structure"`** accepts `path` and `skip`:
  - **`path`** scopes the search (file, directory, glob, internal URL, or semicolon-delimited list).
  - **`skip`** specifies match offset for pagination (default limit `50` matches).
  - Metavariable syntax supports `$NAME` (single node), `$_` (anonymous node), `$$$NAME` (multi-node sequence), and `$$$` (anonymous sequence).

### Unified result contract and settings

Results return formatted text plus structured details `{ type, result }` corresponding to the search type (`FileSearchDetails`, `TextSearchDetails`, or `StructureSearchDetails`).

The tool is part of the default inventory. Text matching uses two settings:
- `search.contextBefore`: number, default `1` (lines of context before each text match).
- `search.contextAfter`: number, default `3` (lines of context after each text match).

## The `write` tool (`tools/write.ts`)

`read` and `search` are the read side; `write {path, content}` creates or replaces a whole file. It
shares infrastructure with the edit engine rather than touching the filesystem directly:

- **Shared verified pipeline.** `write.ts` imports the same file-snapshot store and LF-normalization
  helpers as the edit path (`../edit/file-snapshot-store`, `../edit/normalize`) and formats hashline
  headers via `@veyyon/hashline`, so writes inherit LSP diagnostics writethrough and diff/verification
  behavior rather than bypassing it.
- **Exclusive concurrency.** The tool declares `concurrency: "exclusive"`, so nothing else can create or
  change the target file mid-call.
- **Steers to `edit` for surgery.** The tool description tells the model to prefer `edit` for a
  surgical change to an existing file, keeping `write` from becoming a "re-emit the whole file" habit
  that burns tokens.

## Sanitizing exec output for the model

Bash/exec tool output is sanitized before it reaches the model, via `sanitizeText()`
(`packages/utils/src/sanitize-text.ts`), used from `session/streaming-output.ts` and the interactive PTY
capture path (`tools/bash-interactive.ts`):

- **ANSI stripping is Bun-native, not a hand-rolled parser.** `sanitizeText()` calls Bun's built-in
  `Bun.stripANSI()` when an ESC byte is present, then strips C0/C1 control bytes and DEL with a single
  regex pass. The function is a TypeScript replacement for a former Rust native
  (`crates/veyyon-natives/src/text.rs::sanitize_text`, noted in the current source comment), there is no
  live Rust ECMA-48 grammar walker in this path today.
- **Keep `\n` and `\t`, drop the rest.** The control regex covers C0 (excluding tab/newline), `\r`,
  DEL, and the C1 range; `\n` and `\t` are the two explicit exclusions.
- **Model-facing only.** Sanitizing happens on the text that becomes tool output for the model. The TUI
  renders exec output from its own delta stream and keeps its colors, so the operator's view is
  untouched.
- **Zero-cost when clean.** Well-formed input with no control/ANSI bytes returns the original string
  reference after one regex probe; only output that actually carries escapes pays for `Bun.stripANSI()`.

## Why these are grouped with context

A read that bounds and a search that bounds its output are both about keeping the working context
*small and relevant*. Long trajectories degrade when context fills with raw file dumps; these tools plus
[compaction & project memory](./compaction-memory.md) are how a long task stays coherent.
