Read files, directories, archives, SQLite, images, documents, internal resources, and web URLs via `path`.

<instruction>
- SHOULD parallelize independent reads.
- SHOULD use `read` (not a browser tool) for web content; browser only when `read` can't deliver.
</instruction>

## Parameters

- `path` — required. Local path, internal URI (`skill://`, `agent://`, `artifact://`, `memory://`, `rule://`, `local://`, `vault://`, `mcp://`, `veyyon://`, `issue://`, `pr://`, `ssh://`), or URL. Append `:<sel>` for ranges/modes (e.g. `src/foo.ts:50-200`, `src/foo.ts:raw`, `db.sqlite:users:42`).

## Selectors

- _(none)_ — parseable code → structural summary; other files → from start (up to {{DEFAULT_LIMIT}} lines).
- `:50` / `:50-` — from line 50 onward.
- `:50-200` — lines 50–200 inclusive.
- `:50+150` — 150 lines from 50.
- `:20+1` — anchor line 20.
- `:5-16,960-973` — multiple ranges in one call.
- `:raw` — verbatim; no anchors/summary/line prefixes.
- `:2-4:raw` / `:raw:2-4` — range AND verbatim; either order.
- `:conflicts` — one line per unresolved git merge conflict block.

A bounded range shows a few surrounding context lines so you can see where it sits: up to 1 line before (when you constrain the start) and 3 lines after. So `:1-5` returns lines 1 through 8, not 5 lines. The extra lines keep their own line numbers, so they read as context, not as part of what you asked for. Use `:raw` (for example `:raw:1-5`) when you need exactly the requested lines and nothing else.

# Files

- Directory → depth-limited dirent listing.
{{#if IS_HL_MODE}}
- File + selector → filename-only snapshot header + numbered lines: `[foo.ts#1A2B]` then `41:def alpha():`. Copy `[FILENAME#TAG]` for anchored edits; ops use bare line numbers. NEVER fabricate the tag.
- A file that ends in a newline shows one extra numbered line with an empty body (a 2-line file `x\ny\n` reads as `1:x`, `2:y`, `3:`). That final empty line is not content: it marks the trailing newline and is the anchor you insert after to append at end of file.
{{else}}
{{#if IS_LINE_NUMBER_MODE}}
- File + selector → numbered lines: `41|def alpha():`.
{{/if}}
{{/if}}
- Parseable code, no selector → **structural summary**: declarations kept, body elided with `…`. Footer names the recovery selector; re-issue ONLY the ranges you need.

# Documents & Notebooks

PDF, Word, PowerPoint, Excel, RTF, EPUB → extracted text. Notebooks (`.ipynb`) → editable `# %% [type] cell:N` text. `:raw` bypasses the converter.

# Images

{{#if INSPECT_IMAGE_ENABLED}}
Image → metadata. Visual analysis: call `inspect_image` with the path and a question.
{{else}}
Image → decoded inline (PNG, JPEG, GIF, WEBP) for direct visual analysis.
{{/if}}

# Archives

`.tar`, `.tar.gz`, `.tgz`, `.zip`. `archive.ext:path/inside/archive` reads a member; inner paths take normal selectors: `archive.zip:dir/file.ts:50-60`.

# SQLite

For `.sqlite`, `.sqlite3`, `.db`, `.db3`:
- `file.db` — tables with row counts
- `file.db:table` — schema + sample rows
- `file.db:table:key` — row by primary key
- `file.db:table?limit=50&offset=100` — pagination
- `file.db:table?where=status='active'&order=created:desc` — filter/order
- `file.db?q=SELECT …` — read-only SELECT

# URLs

- Reader-mode default: HTML, GitHub issues/PRs, Stack Overflow, Wikipedia, Reddit, NPM, arXiv, RSS/Atom, JSON endpoints, PDFs → clean text/markdown.
- `:raw` → untouched HTML; line selectors (`:50`, `:50-100`, `:50+150`) paginate the fetch.
- Bare `host:port` collides with selector grammar — add a trailing slash: `https://example.com/:80`.

# Internal URIs

All URI schemes take the same line selectors. `artifact://<id>` recovers spilled output; large artifacts block unbounded `:raw`, so page with `artifact://<id>:N-M` / `artifact://<id>:raw:N-M` and use the reported artifact file path for search/copy workflows.

`ssh://host/<absolute-path>` reads a remote text file (UTF-8, ≤1 MiB) or lists a directory one level deep, on a pre-configured SSH host or `~/.ssh/config` alias; `ssh://host/` lists the remote root and bare `ssh://` lists the configured hosts. Files are also writable via `write` and searchable via `search`; a directory only lists (`search` refuses a directory, `write` refuses to overwrite one). A literal `:`, `?`, or `#` in the remote path must be percent-encoded (`%3A`/`%3F`/`%23`) — a trailing `:sel` is read as a line selector, and `?`/`#` start a URL query/fragment. Requires a POSIX login shell (`sh`/`bash`/`zsh`); a Windows host or a non-POSIX shell (fish, csh/tcsh) is rejected — use the `ssh` tool there.

<critical>
- Summary footer names elided ranges? Re-issue ONLY those ranges. NEVER guess `..`/`…` content.
</critical>
