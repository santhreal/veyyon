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
- **Dual budget, whichever is hit first:** a line cap and a byte cap. The line cap is
  `read.defaultLimit` (300) when the call names no line count, the requested count when it does, and
  `DEFAULT_MAX_LINES` (3000) at the ceiling. The byte cap is `tools.artifactSpillThreshold` (50 KB),
  the same budget every other tool result carries; a call that names a line count raises it to hold
  those lines, at about 512 bytes a line. So a file that is short in lines but huge in bytes
  (minified JS, a data blob) is bounded by bytes, and a file of many short lines by lines. `read` is
  bounded rather than spilled to an artifact: a paged window with a continuation selector is more use
  than a truncated one with a link.
- **Structural summaries for parseable code.** A read with no selector on a parseable source file
  returns declarations with bodies elided (`…`), and the footer states the recovery selector so the model
  re-issues only the ranges it actually needs instead of re-reading the whole file. The summary takes
  the same byte budget as a file window, and lines wider than `tools.outputMaxColumns` are clipped, so
  a declaration-dense file (generated protobuf bindings, a large `.d.ts`) returns a bounded window
  with the line that continues it rather than the whole projection.
- **Truncation is explicit.** A summary footer or a `[Showing lines …]`-style notice states the
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

## `@path` mentions (`utils/file-mentions.ts`)

A `@path` token in a prompt auto-reads the file or lists the directory it names, and the result is
bounded by `tools.artifactSpillThreshold`, the same budget a tool result carries, because the
mention stays in the transcript and is billed on every later request. A capped mention states the
lines it showed and the selector that pages the rest. A file over 5 MB, a binary file, or an image
over 25 MB is not read: the message carries the path and the reason.

`tools.artifactSpillThreshold` bounds every model-visible result. `read` applies it directly to a
file window, a structural summary, a directory listing, an archive listing, a notebook or converted
document, a URL body, a PDF image-member list and an `agent://<id>/<field>` extraction, and states
what it carried and how to reach the rest. An extraction takes no line selector, so it is cut by
bytes and the notice names its full size and the URL that pages it. A selector-free structural
summary also stops at `read.defaultLimit` lines, the bound a selector-free file window already
follows, and the notice names which of the two stopped it. Every other tool passes the shared spill
layer: output over the threshold is written to an artifact and the result keeps a head and tail
window no larger than the threshold, sized by `tools.artifactHeadBytes` and
`tools.artifactTailBytes` in the ratio they name, plus the `artifact://` id that reads the full text
back.

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
  - **`path`** scopes the search (file, directory, glob, internal URL like `veyyon://`, or a semicolon-delimited list). `ssh://` scopes are supported here. Pass the narrowest known scope; omit it only when the workspace root (`"."`) is intended. Line-range selectors (e.g. `:50-100`) on a single file target constrain matches.
  - **`case` (default `true`)** toggles case sensitivity.
  - **`gitignore` (default `true`)** respects `.gitignore`.
  - **`skip`** pages past already-returned files; results are paginated at `20` files per call (`DEFAULT_FILE_LIMIT`) with an internal cap of `2000` matches. Context lines around matches are governed by `search.contextBefore` (default `1`) and `search.contextAfter` (default `3`).
- **`type: "structure"`** accepts `path` and `skip`:
  - **`path`** scopes the search (file, directory, glob, local or materialized internal URL, or semicolon-delimited list). `ssh://` is not supported; inspect remote code with `read` before structural matching.
  - **`skip`** specifies match offset for pagination (default limit `50` matches).
  - Metavariable syntax supports `$NAME` (single node), `$_` (anonymous node), `$$$NAME` (multi-node sequence), and `$$$` (anonymous sequence).

### Unified result contract and settings

Results return formatted text plus structured details `{ type, result }` corresponding to the search type (`FileSearchDetails`, `TextSearchDetails`, or `StructureSearchDetails`).

Broad grouped multi-file text searches use progressive disclosure when the full formatted match set exceeds the session's discovery budget (scaled from an 8 KiB search-specific ceiling through the turn curve to ~2 KiB at turn 0). The full pre-disclosure output is saved to an artifact before compacting. The inline result emits up to two representative matches per file, total match and file counts, warnings, and an `artifact://<id>` recovery footer. Explicit single-file searches and line-range queries keep detailed output without compacting. Only the visible representative lines emitted with snapshot tags are recorded as seen for anchored editing; un-emitted matches remain unseen. If artifact storage is unavailable, broad searches fall back to generic turn-scaled head truncation.

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

## Tool text per request

Every request carries the name, description and JSON schema of every active tool. At the defaults
that is 17 tools and about 14,000 tokens, paid on each request rather than once per session. The
largest entries are `edit`, `eval`, `read`, `launch` and `bash`.

`tools.discoveryMode: "all"` keeps the seven essential tools (`read`, `bash`, `launch`, `edit`,
`write`, `search`, `eval`) plus `goal` and `resolve`, and hides `ast_edit`, `debug`, `ssh`, `task`,
`job`, `todo`, `web_search` and `set_cwd` behind the discovery search tool, which removes about
4,800 tokens from each request. A hidden tool costs a discovery round trip on the turn that first
needs it, so the setting trades a fixed per-request cost for an occasional one.
`tools.essentialOverride` sets which tools stay visible.

## Why these are grouped with context

A read that bounds and a search that bounds its output are both about keeping the working context
*small and relevant*. Long trajectories degrade when context fills with raw file dumps; these tools plus
[compaction & project memory](./compaction-memory.md) are how a long task stays coherent.
