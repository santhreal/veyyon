# Bounded reads & instant search

> **Status: Built.** The `read`, `grep`, `find`, `ls`, and `write` tools ship in the Bun/TypeScript
> product. This chapter describes the behavioral contracts they hold.

These tools fight **token blowup** and **latency** — supporting concerns that compound into
control-flow failures on long trajectories, the long-context runs where a model stops making progress
because its window is full of raw dumps.

## The `read` tool

A model that `cat`s a 20k-line file blows its whole context on one call. The `read` tool bounds every
read to a budget and tells the model how to page the rest:

- **Dual budget, whichever is hit first:** a line cap (2000) and a byte cap (50 KB). A file that is
  short in lines but huge in bytes (minified JS, a data blob) is bounded by bytes; a file that is many
  short lines is bounded by lines.
- **`offset` / `limit` paging:** `read {path, offset?, limit?}`, where `offset` is a 1-indexed start
  line and `limit` caps how many lines come back. The model walks a large file in budget-sized windows
  instead of one ruinous dump.
- **Truncation is never silent.** When content is withheld, the output carries an actionable notice
  that names the exact continuation, for example `[Showing lines 1-2000 of 30000. Use offset=2001 to
  continue.]`. A single line larger than the whole budget points the model at the one tool that can
  slice it.
- **Whole-file fidelity.** A read that fits the budget reconstructs the file's bytes verbatim,
  trailing newline included.

Text reading is intentionally separate from image inspection: image files go through `view_image` or
a vision prepass rather than being bundled into ordinary text reads.

## The `find` tool

A model that runs `find . -name '*.rs'` or `ls -R` in the shell gets back an unbounded dump that
includes `target/`, `node_modules/`, and `.git/`. The `find` tool is bounded and gitignore-aware:

- **Glob matching with `fd` semantics:** `find {pattern, path?, limit?}`. A pattern with no `/` matches
  the **file name** at any depth (`*.rs` finds `src/deep/lib.rs`); a pattern containing `/` matches the
  **full path**, with an implicit leading `**/`.
- **Honors `.gitignore`, hierarchically.** Traversal walks the environment's filesystem (local or
  remote) through the same abstraction `read`/`edit` use, applying a stack of `.gitignore` matchers with
  deepest-directory precedence, including `!`-negation re-includes. `.git` and `node_modules` are never
  descended, so it is correct inside a sandbox or remote container, not just on the host.
- **Bounded, and never silently.** Output stops at a result limit (default 1000) or 50 KB, whichever is
  hit first, and every limit is surfaced as an actionable notice. A permission-denied subtree is
  reported (`[N directories could not be read]`), not swallowed.
- **Deterministic output.** Results are lexicographically sorted, depth-first; directories carry a
  trailing `/`.

## The `ls` tool

`find` recurses by glob; `ls` answers the different, common question "what is *immediately* in this
directory?" `ls {path?, limit?}` lists a directory's immediate entries, sorted case-insensitively, with
a `/` suffix on directories and dotfiles included. It does not recurse and does not consult
`.gitignore` — it is the raw directory view. It is bounded (500 entries / 50 KB) with actionable
limit notices and an explicit `(empty directory)`.

## The `grep` tool

A model that runs `grep -r` / `rg` in the shell can get back tens of thousands of matching lines. The
`grep` tool bounds the search on top of the same gitignore-aware traversal `find` uses:

- **Regex or literal, optional case-insensitivity.** `grep {pattern, path?, glob?, ignoreCase?,
  literal?, context?, limit?}`. `pattern` is a regex unless `literal: true`.
- **Gitignore-aware candidate selection**, optionally narrowed by a `glob` (`*.rs`, `src/**/*.ts`),
  using the same filesystem abstraction as `read`/`find` so it is correct on a remote or sandboxed
  environment.
- **Output is `path:line: text`**, with `context` lines emitted as gutter rows around each match.
- **Bounded, and never silently.** It stops at a match limit (default 100) or 50 KB, long lines are
  truncated to 500 chars, and every bound is an actionable notice.
- **Binary files are skipped** (non-UTF-8) as grep's defined contract, distinct from a genuine read
  failure, which is surfaced rather than hidden.

## The `write` tool

`read`/`find`/`grep`/`ls` are the read side; `write` creates or replaces a whole file. It routes
through the **same verified path** as `edit`, never touching the filesystem directly:

- **One verified pipeline, not two.** `write {path, content}` reads the target to decide
  create-vs-overwrite, then applies the change through the same handler that `edit` uses, inheriting its
  verification, approval prompt, sandbox enforcement, event emission, and turn-diff tracking. There is
  exactly one code path that mutates a file.
- **Race-free create-vs-overwrite.** A non-parallel tool holds the exclusive mutation lock for the whole
  call, so nothing can create or change the file between the existence check and the apply. Identical
  content short-circuits to "no change" rather than emitting an empty diff.
- **Steers to `edit` for surgery.** `write` is for new files or full rewrites; for a surgical change to
  an existing file the model is told to prefer `edit`, which keeps `write` from becoming the lazy
  "re-emit the whole file" habit that burns tokens.

## Sanitizing exec output for the model

The shell/exec tool captures raw terminal bytes, which are full of things that cost tokens and confuse
a reader without carrying information: ANSI color codes, cursor-move and clear-line sequences, OSC title
strings, `\r`-driven progress redraws, and stray control bytes. Veyyon strips this noise before it
reaches the model:

- **One linear pass over the ECMA-48 grammar**, recognizing escape sequences by their defined shape
  rather than a heuristic regex, so an uncommon-but-valid sequence cannot leak through and an escape
  flood cannot backtrack.
- **Keep `\n` and `\t`, drop the rest** of the C0 control bytes, `\r`, and the interlinear-annotation
  format chars that crash width counters.
- **Model-facing only.** Sanitizing happens on the text that becomes tool output for the model. The TUI
  renders exec output from its own delta stream and keeps its colors, so the operator's view is
  untouched.
- **Both exec surfaces**, not just the legacy `shell` tool: every model-facing render runs through the
  same sanitizer.
- **Zero-cost when clean.** Ordinary output that carries no escapes returns without any allocation; only
  output that actually carries escapes pays for a rewrite.

## Why these are grouped with context

A read that bounds and a search that bounds its output are both about keeping the working context
*small and relevant*. Long trajectories degrade when context fills with raw file dumps; these tools plus
[compaction & project memory](./compaction-memory.md) are how a long task stays coherent.
