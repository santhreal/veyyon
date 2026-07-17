# Natives Text/Search Pipeline

This document maps the `@veyyon/pi-natives` text/search/code surface from generated JS/TS exports to Rust N-API modules and back to JS result objects.

Terminology follows [`natives-architecture.md`](./natives-architecture.md):

- **Generated binding**: public API in `packages/natives/native/index.d.ts`.
- **Rust module layer**: N-API exports in `crates/pi-natives/src/*`.
- **Shared scan cache**: TTL directory-entry cache owned by `pi-walker` (`crates/pi-walker/src/cache.rs`) used by discovery/search flows.

## Implementation files

- `packages/natives/native/index.d.ts`
- `crates/pi-natives/src/grep.rs`
- `crates/pi-natives/src/glob.rs`
- `crates/pi-natives/src/glob_util.rs`
- `crates/pi-natives/src/iofs.rs`
- `crates/pi-walker/src/cache.rs`
- `crates/pi-natives/src/fd.rs`
- `crates/pi-natives/src/ast.rs`
- `crates/pi-natives/src/text.rs`
- `crates/pi-natives/src/highlight.rs`
- `crates/pi-natives/src/tokens.rs`

## JS API ↔ Rust export mapping

| JS API                                                                          | Rust export (`#[napi]`, snake_case -> camelCase) | Rust module    |
| ------------------------------------------------------------------------------- | ------------------------------------------------ | -------------- |
| `grep(options, onMatch?)`                                                       | `grep`                                           | `grep.rs`      |
| `search(content, options)`                                                      | `search`                                         | `grep.rs`      |
| `hasMatch(content, pattern, ignoreCase?, multiline?)`                           | `hasMatch`                                       | `grep.rs`      |
| `fuzzyFind(options)`                                                            | `fuzzyFind`                                      | `fd.rs`        |
| `glob(options, onMatch?)`                                                       | `glob`                                           | `glob.rs`      |
| `invalidateFsScanCache(path?)`                                                  | `invalidateFsScanCache`                          | `iofs.rs`      |
| `astGrep(options)`                                                              | `astGrep`                                        | `ast.rs`       |
| `astMatch(options)`                                                             | `astMatch`                                       | `ast.rs`       |
| `astEdit(options)`                                                              | `astEdit`                                        | `ast.rs`       |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrapTextWithAnsi`                               | `text.rs`      |
| `truncateToWidth(text, maxWidth, ellipsis, pad, tabWidth)`                      | `truncateToWidth`                                | `text.rs`      |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `sliceWithWidth`                                 | `text.rs`      |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extractSegments`                                | `text.rs`      |
| `visibleWidth(text, tabWidth)`                                                  | `visibleWidth`                                   | `text.rs`      |
| `highlightCode(code, lang, colors)`                                             | `highlightCode`                                  | `highlight.rs` |
| `supportsLanguage(lang)`                                                        | `supportsLanguage`                               | `highlight.rs` |
| `getSupportedLanguages()`                                                       | `getSupportedLanguages`                          | `highlight.rs` |
| `countTokens(input, encoding?)`                                                 | `countTokens`                                    | `tokens.rs`    |

## Pipeline overview by subsystem

## 1) Regex search (`grep`, `search`, `hasMatch`)

### Input/options flow

1. Callers invoke generated native exports directly; there is no package-local TS wrapper that renames `search` to `searchContent`.
2. Rust option structs in `grep.rs` deserialize camelCase fields (`ignoreCase`, `maxCount`, `contextBefore`, `contextAfter`, `maxColumns`, `timeoutMs`).
3. `grep` creates `CancelToken` from `timeoutMs` + `AbortSignal` and runs inside `task::blocking("grep", ...)`.
4. `search` and `hasMatch` operate on provided string/`Uint8Array` content and do not scan the filesystem.

### Execution branches

- **In-memory branch**
  - `search` -> `search_sync` / search helpers over provided content bytes.
  - `hasMatch` compiles/checks pattern against provided content and returns a boolean.
  - No filesystem scan, no `fs_cache`.
- **Single-file branch**
  - `grep` resolves path, checks metadata is file, and searches that file.
- **Directory branch**
  - Directory walks go through `pi_walker::WalkRequest` (files-only filter, `WalkDetail::Minimal`, `FollowLinks::Never`, `SizeHintPolicy::WhenCheap`) built by `build_grep_walk_request`.
  - Grep always walks with `.cache(false)` — it does not use the shared TTL scan cache (that cache serves `glob`/`fuzzyFind`).
  - Entry filtering: file-only + optional glob filter (`glob_util`) + optional type filter mapping (`js`, `ts`, `rust`, etc.).

### Search/collection semantics

- Regex engine: `grep_regex::RegexMatcherBuilder` with `ignoreCase` and `multiline`.
- Context resolution:
  - `contextBefore/contextAfter` override legacy `context`.
  - Non-content modes do not collect context.
- Output modes:
  - `content` -> one `GrepMatch` per hit.
  - `count` and `filesWithMatches` map to count-style entries (`lineNumber=0`, `line=""`, `matchCount` set).
  - `offset` and `maxCount` are applied during aggregation across sorted file results.
  - Directory searches use parallel filesystem walking/searching, then aggregate per-file results to preserve global offset/limit semantics in the returned result and callback stream.

### Result shaping back to JS

- Rust `SearchResult`/`GrepResult` fields map to TS interfaces via N-API object conversion.
- Counters are clamped before crossing N-API where needed.
- `GrepResult.limitReached` is optional and emitted when true.
- Streaming callback receives each shaped `GrepMatch` for content or count-style entries.

### Failure behavior

- `search` returns `SearchResult.error` for regex/search failures instead of throwing.
- `grep` rejects on hard errors such as invalid path, invalid glob/regex, or cancellation timeout/abort.
- `hasMatch` returns a boolean on success and throws on invalid pattern/UTF-8 conversion errors.
- File open/search errors in multi-file scans are skipped per-file; scan continues.

### Malformed regex handling

`grep.rs#build_matcher` runs a tolerant compile chain:

1. Braces that cannot form `{N}`, `{N,}`, `{N,M}` are escaped (`{`/`}` -> `\{`/`\}`), so literal-template fragments (for example `${platform}`) do not fail as malformed repetition.
2. The sanitized pattern is compiled with the Rust regex engine; on failure it is retried with PCRE2, which supports lookaround and backreferences the Rust engine omits.
3. An unclosed/unopened-group error triggers one retry with unescaped parentheses escaped (so literal snippets like `fetchAnthropicProvider(` still search), tried on both engines.
4. Final fallback: the original pattern is `regex::escape`d and matched literally; only if that also fails does the call return `Regex error: ...`.

## 2) File discovery (`glob`) and fuzzy path search (`fuzzyFind`)

`glob` and `fuzzyFind` share the `pi-walker` TTL scan cache; matching logic differs.

### `glob` flow

1. Caller passes `GlobOptions` directly. `pattern` and `path` are required in the generated type.
2. Rust resolves the search path and compiles pattern via `glob_util::compile_glob`.
3. Entry source: a `pi_walker::WalkRequest` with `.cache(config.cache)` and `.empty_recheck(EmptyRecheck::Configured)` — `cache=true` serves from the walker TTL cache (with stale-empty recheck), `cache=false` walks fresh without storing.
4. Filtering:
   - skip `.git` always;
   - skip `node_modules` unless requested (`includeNodeModules`) or pattern mentions `node_modules`;
   - apply glob match;
   - apply file-type filter; symlink `file`/`dir` filters resolve target metadata.
5. Optional sort by mtime descending (`sortByMtime`) before truncating to `maxResults`.

### `fuzzyFind` flow

1. Rust implementation lives in `fd.rs`; generated export is `fuzzyFind`.
2. Shared scan source from the `pi-walker` cache with the same cache/no-cache split and stale-empty recheck policy (fd walks with `FollowLinks::Always`).
3. Scoring:
   - exact / starts-with / contains / subsequence-based fuzzy score;
   - separator/punctuation-normalized scoring path;
   - directory bonus and deterministic tie-break (`score desc`, then `path asc`).
4. Symlink entries are excluded from fuzzy results.

### Failure behavior

- Invalid glob pattern returns an error from `glob_util::compile_glob`.
- Search root must resolve to an existing directory for directory discovery flows.
- Cancellation/timeouts propagate as abort errors via `CancelToken::heartbeat()` checks in loops.

### Malformed glob handling

`glob_util::build_glob_pattern` is tolerant:

- normalizes `\` to `/`,
- auto-prefixes simple recursive patterns with `**/` when `recursive=true`,
- auto-closes unbalanced `{...` alternation groups before compile.

## 3) AST search/match/edit (`astGrep`, `astMatch`, `astEdit`)

`ast.rs` exposes syntax-aware code search and rewrite operations.

- `astGrep(options)` returns matches with byte/line/column coordinates and optional metavariable bindings.
- `astMatch(options)` runs the same patterns against an in-memory `source` string instead of files; `lang` is required (there is no path to infer it from), and the result keeps matches, `totalMatches`, `limitReached`, and parse errors but omits the file-count fields.
- `astEdit(options)` returns replacement changes, per-file counts, searched/touched file counts, parse errors, and whether edits were applied.
- `dryRun` defaults to true for edit options in the generated documentation.
- Options include language override, path/glob/selector, strictness, limits, parse-error policy, `signal`, and `timeoutMs`.

These exports are direct native APIs used by tooling; they are not mediated by a TS wrapper in `packages/natives`.

## 4) Shared scan/cache lifecycle (`pi-walker` cache)

The scan cache lives in `crates/pi-walker/src/cache.rs`. `collect_entries(root, options, heartbeat)` stores scan results as normalized relative entries (`path`, `fileType`, optional `mtime` and regular-file `size`) keyed by the canonical search root plus the **entire** `WalkOptions` struct (with the `cache` flag normalized out) — so `include_hidden`, `use_gitignore`, `skip_node_modules`, `follow_links`, and scan detail (`Minimal` vs `Full`) all key distinct cache entries.

Tunables are env-configured: `FS_SCAN_CACHE_TTL_MS` (default 1000ms; `0` disables), `FS_SCAN_EMPTY_RECHECK_MS` (default 200ms), and a max-entry cap with oldest-entry eviction.

### Cache state transitions

1. **Miss / disabled**
   - TTL is `0`, `options.cache` is false, or key absent/expired -> fresh collection (fresh cached scans are stored and return `cache_age_ms: 0`).
2. **Hit**
   - Entry age is within TTL -> return cached entries + `cache_age_ms`.
3. **Stale-empty recheck**
   - Requests that opt in via `EmptyRecheck::Configured` (glob, fuzzyFind): if the query yields zero matches and cache age exceeds the empty-result threshold, force one rescan.
4. **Invalidation**
   - `invalidateFsScanCache(path?)` (exported from `iofs.rs`, backed by `pi_walker::cache::invalidate_all` / `invalidate_path_string`):
     - no arg: clear all keys;
     - path arg: remove keys whose cached root contains that path.

### Stale-result tradeoff

- Cache favors low-latency repeated scans over immediate consistency.
- TTL window can return stale positives/negatives.
- Empty-result recheck reduces stale negatives for older cached scans at the cost of one extra scan.
- Explicit invalidation is the intended correctness hook after file mutations.

## 5) ANSI text utilities (`text`)

These are pure, in-memory utilities.

### Boundaries and responsibilities

- `text.rs` owns terminal-cell semantics:
  - ANSI sequence parsing,
  - grapheme-aware width and slicing,
  - wrap/truncate/slice behavior,
  - explicit tab-width parameter on width-sensitive APIs.
- `grep.rs` line truncation (`maxColumns`) is separate:
  - simple character-boundary truncation of matched lines with `...`,
  - not ANSI-state-preserving and not terminal-cell width aware.

### Key behaviors

- `wrapTextWithAnsi`: wraps by visible width, carries active SGR codes across wrapped lines.
- `truncateToWidth`: visible-cell truncation with ellipsis policy (`Unicode`, `Ascii`, `Omit`), optional right padding.
- `sliceWithWidth`: column slicing with optional strict width enforcement.
- `extractSegments`: extracts before/after segments around an overlay while restoring ANSI state for the `after` segment.
- `sanitizeText` (ANSI/control/surrogate stripping with line-ending normalization) no longer lives in `text.rs`; it moved to `@veyyon/pi-utils` as a pure-JS implementation in `packages/utils/src/sanitize-text.ts`. The native binding was removed in the same change because the JS version was competitive on the benchmarked workloads, and keeping a Rust copy forced every caller (including `pi-utils`) to pull in `@veyyon/pi-natives`.
- `visibleWidth`: counts visible terminal cells using caller-supplied tab width.

### Failure behavior

Text functions generally return deterministic transformed output; errors are limited to N-API argument/string conversion boundaries.

## 6) Syntax highlighting (`highlight`)

`highlight.rs` is pure transformation; it does not use the filesystem scan cache.

### Flow

1. Caller passes `code`, optional `lang`, and ANSI color palette.
2. Rust resolves syntax by token/name lookup, extension lookup, alias table fallback, then plain-text fallback.
3. Each line is parsed with syntect `ParseState` and scope stack.
4. Scopes map to semantic color categories and ANSI color codes are injected/reset.

### Failure behavior

- Per-line parse failure does not fail the call: that line is appended unhighlighted and processing continues.
- Unknown/unsupported language falls back to plain text syntax.

## 7) Token counting (`tokens`)

`countTokens(input, encoding?)` is an in-memory utility.

- `input` may be a single string or an array of strings.
- Arrays return one aggregate count and are encoded in parallel in Rust.
- Default encoding is `O200kBase`; `Cl100kBase` is also available.
- The implementation uses ordinary tokenization, not special-token handling.

## Pure utility vs filesystem-dependent flows

| Flow                         | Filesystem access | Shared cache         | Notes                                         |
| ---------------------------- | ----------------- | -------------------- | --------------------------------------------- |
| `search` / `hasMatch`        | No                | No                   | regex on provided bytes/string only           |
| `text` module functions      | No                | No                   | ANSI/width utilities only                     |
| `highlight` module functions | No                | No                   | syntax + ANSI coloring only                   |
| `countTokens`                | No                | No                   | tokenization only                             |
| `astMatch`                   | No                | No                   | in-memory syntax-aware match (no disk)        |
| `astGrep` / `astEdit`        | Yes               | No                   | syntax-aware file search/edit                 |
| `glob`                       | Yes               | Optional             | directory scans + glob filtering              |
| `fuzzyFind`                  | Yes               | Optional             | directory scans + fuzzy scoring               |
| `grep` (file/dir path)       | Yes               | No (`.cache(false)`) | ripgrep over files, optional filters/callback |

## End-to-end lifecycle summary

1. Caller invokes generated native export with typed options.
2. Rust validates/normalizes options and builds matcher/search config.
3. For filesystem flows, entries are scanned (cache hit/miss/rescan where applicable) then filtered/scored/searched.
4. Worker loops periodically call cancel heartbeat; timeout/abort can terminate execution.
5. Rust shapes outputs into N-API objects (`lineNumber`, `matchCount`, `limitReached`, etc.).
6. Generated bindings return typed JS objects and optional per-match callbacks for `grep`/`glob`.

*Verified against `7ca44d3` on 2026-07-17.*
