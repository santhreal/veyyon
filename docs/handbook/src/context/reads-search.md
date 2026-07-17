# Bounded reads & instant search

> **Status: Built.** The `read`, `glob`, `grep`, and `write` tools ship as TypeScript modules in
> `packages/coding-agent/src/tools/{read,glob,grep,write}.ts`. There is no `experimental_tools` or
> `backends.toml` gating — every tool below is always on. This chapter describes their real parameter
> shapes and behavioral contracts.

These tools fight **token blowup** and **latency** — supporting concerns that compound into
control-flow failures on long trajectories, the long-context runs where a model stops making progress
because its window is full of raw dumps.

## The `read` tool (`tools/read.ts`)

A model that `cat`s a 20k-line file blows its whole context on one call. The `read` tool takes a single
`path` string (no separate `offset`/`limit` arguments) and bounds every read to a budget:

- **One parameter, inline selectors.** `read {path}`, where `path` can carry a line-range selector
  appended after a colon: `src/foo.ts:50-200` (inclusive range), `src/foo.ts:50` / `:50-` (from line 50
  on), `src/foo.ts:50+150` (150 lines from line 50), or `src/foo.ts:5-16,960-973` (multiple ranges in
  one call). `:raw` reads verbatim with no anchors or line prefixes.
- **Dual budget, whichever is hit first:** a line cap (`DEFAULT_MAX_LINES = 3000`) and a byte cap
  (`DEFAULT_MAX_BYTES = 50 KB`), defined in `session/streaming-output.ts`. A file that is short in lines
  but huge in bytes (minified JS, a data blob) is bounded by bytes; a file with many short lines is
  bounded by lines.
- **Structural summaries for parseable code.** A read with no selector on a parseable source file
  returns declarations with bodies elided (`…`), and the footer names the recovery selector so the model
  re-issues only the ranges it actually needs instead of re-reading the whole file.
- **Truncation is never silent.** A summary footer or a `[Showing lines …]`-style notice always names the
  exact continuation selector.
- **Beyond plain text files:** the same tool also reads directories (depth-limited listing), archives
  (`.tar`, `.tar.gz`, `.zip`, via `archive.zip:path/inside`), SQLite databases (`file.db:table`, with
  pagination and `where`/`order` filters), PDF/Word/PowerPoint/Excel/EPUB (extracted text), Jupyter
  notebooks (editable cell text), images, URLs (reader-mode by default), and internal URI schemes
  (`memory://`, `skill://`, `artifact://`, `mcp://`, `ssh://`, and others).

Text reading is intentionally separate from image inspection: image files go through `view_image` or
a vision prepass rather than being bundled into ordinary text reads.

## The `glob` tool (`tools/glob.ts`)

There is no separate `find` or `ls` tool — pattern matching and directory listing are both the `glob`
tool. A model that runs `find . -name '*.rs'` or `ls -R` in the shell gets back an unbounded dump that
includes `target/`, `node_modules/`, and `.git/`; `glob` is bounded and gitignore-aware instead:

- **Glob matching, or a bare directory/file path.** `glob {path?, hidden?, gitignore?, limit?}`. `path`
  accepts a glob, a single file, a directory (recursed), or a semicolon-delimited list of any of those
  (`src/**/*.ts; test/**/*.ts`); omitted, it searches the workspace root.
- **`gitignore` (default `true`)** hides `.gitignore` matches; set `false` to find `.env*`, build
  output, or anything the repo ignores. **`hidden` (default `true`)** includes dotfiles.
- **Bounded by result count**, default and max `200` (`DEFAULT_LIMIT` / `MAX_LIMIT` in `glob.ts`) — not
  a byte cap. Every truncation is surfaced as an actionable notice.
- **Sorted by mtime, newest first** (not lexicographic), grouped under `# <dir>/` headers with
  basenames below; directories get a trailing `/`.
- **`.git` and `node_modules` are never descended**, and traversal goes through the same filesystem
  abstraction `read`/`grep` use, so it is correct inside a sandbox or remote container, not just on the
  host.

## The `grep` tool (`tools/grep.ts`)

A model that runs `grep -r` / `rg` in the shell can get back tens of thousands of matching lines. The
`grep` tool is always regex (Rust regex / PCRE2 syntax; no literal-match flag) and paginates by file
count on top of the same gitignore-aware traversal `glob` uses:

- **`grep {pattern, path?, case?, gitignore?, skip?}`.** `path` scopes the search (single path,
  semicolon-delimited list, or a `file:line-range` selector on one target); `case` enables
  case-sensitivity (default case-insensitive is **not** assumed — see the tool description for the
  exact default); `skip` pages past files already returned once a call hits the file limit.
- **Bounded by file count, not match count.** Results are paginated at `DEFAULT_FILE_LIMIT = 20` files
  per call, with an internal total cap of `2000` matches (`grep.ts`); `skip` continues from where the
  previous call left off.
- **Output is per-file, line-number-prefixed**, with context rows around each match when the harness
  runs in line-number mode.
- **Cross-line patterns** are detected from a literal `\n`/`\\n` in `pattern`.
- The tool description explicitly forbids shelling out to `grep`/`rg`/`ripgrep`/`ag`/`ack`/`git grep`
  via Bash — the built-in tool is the only sanctioned path.

## The `write` tool (`tools/write.ts`)

`read`/`glob`/`grep` are the read side; `write {path, content}` creates or replaces a whole file. It
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
  (`crates/pi-natives/src/text.rs::sanitize_text`, noted in the current source comment) — there is no
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
