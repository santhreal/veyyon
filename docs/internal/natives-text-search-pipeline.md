# Natives Text/Search Pipeline

This document maps the `@veyyon/natives` text/search/code surface from generated JS/TS exports to Rust N-API modules and back to JS result objects.

Terminology follows [`natives-architecture.md`](./natives-architecture.md):

- **Package entrypoint**: `packages/natives/package.json` maps JavaScript imports to `packages/natives/native/index.js` and types to the generated `packages/natives/native/index.d.ts`.
- **Lazy JS boundary**: `packages/natives/native/index.js` exposes functions through `lazyNativeFn` from `packages/natives/native/loader-state.js`.
- **Rust module layer**: N-API exports in `crates/veyyon-natives/src/*`.
- **Shared scan cache**: TTL directory-entry cache owned by `veyyon-walker` (`crates/veyyon-walker/src/cache.rs`) used by discovery/search flows.

## Implementation files

- `packages/natives/package.json`
- `packages/natives/native/index.js`
- `packages/natives/native/loader-state.js`
- `packages/natives/native/index.d.ts`
- `crates/veyyon-natives/src/grep.rs`
- `crates/veyyon-natives/src/glob.rs`
- `crates/veyyon-natives/src/glob_util.rs`
- `crates/veyyon-natives/src/iofs.rs`
- `crates/veyyon-walker/src/cache.rs`
- `crates/veyyon-natives/src/fd.rs`
- `crates/veyyon-natives/src/ast.rs`
- `crates/veyyon-natives/src/block.rs`
- `crates/veyyon-natives/src/summary.rs`
- `crates/veyyon-natives/src/text.rs`
- `crates/veyyon-text/src/lib.rs`
- `crates/veyyon-natives/src/highlight.rs`
- `crates/veyyon-natives/src/tokens.rs`

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
| `blockRangeAt(options)`                                                         | `blockRangeAt`                                   | `block.rs`     |
| `enclosingBlockBoundaries(options)`                                             | `enclosingBlockBoundaries`                       | `block.rs`     |
| `summarizeCode(options)`                                                        | `summarizeCode`                                  | `summary.rs`   |
| `setHangulCompatJamoWidthOverride(value)`                                       | `setHangulCompatJamoWidthOverride`               | `text.rs`      |
| `wrapTextWithAnsi(text, width, tabWidth)`                                       | `wrapTextWithAnsi`                               | `text.rs`      |
| `truncateToWidth(text, maxWidth, ellipsisKind, pad, tabWidth)`                  | `truncateToWidth`                                | `text.rs`      |
| `sliceWithWidth(line, startCol, length, strict, tabWidth)`                      | `sliceWithWidth`                                 | `text.rs`      |
| `extractSegments(line, beforeEnd, afterStart, afterLen, strictAfter, tabWidth)` | `extractSegments`                                | `text.rs`      |
| `visibleWidth(text, tabWidth)`                                                  | `visibleWidth`                                   | `text.rs`      |
| `highlightCode(code, lang, colors)`                                             | `highlightCode`                                  | `highlight.rs` |
| `supportsLanguage(lang)`                                                        | `supportsLanguage`                               | `highlight.rs` |
| `getSupportedLanguages()`                                                       | `getSupportedLanguages`                          | `highlight.rs` |
| `countTokens(input, encoding?)`                                                 | `countTokens`                                    | `tokens.rs`    |

## Pipeline overview by subsystem

### Package entrypoint and addon loading

`packages/natives/package.json` selects `native/index.js` as the JavaScript entrypoint and `native/index.d.ts` as its generated declaration surface. Every public function in `native/index.js` is a `lazyNativeFn` wrapper. Importing the package, reading enum values, or taking a bare function reference does not load a `.node` binary. The first actual call invokes the hand-written loader in `loader-state.js`, and the resolved function is then cached by that wrapper.

The loader tries install-specific addon candidates in priority order. Source and ordinary `node_modules` installs prefer leaf/in-tree release candidates and then the per-version cache. Compiled and staged modes put extracted or versioned candidates ahead of release-tree candidates. A missing or unloadable binary records the failure and permits the next candidate; a present-but-unloadable binary also emits a warning. Once a candidate loads, version-sentinel validation runs outside that fallback path and fails closed on a mismatch instead of trying another copy. Exhausting all candidates throws. Candidate fallback only selects another native binary; there is no functional pure-JavaScript implementation fallback.

## 1) Regex search (`grep`, `search`, `hasMatch`)

### Input/options flow

1. Callers invoke the package's lazy JavaScript exports directly; there is no package-local TS wrapper that renames `search` to `searchContent`.
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
  - Directory walks go through `veyyon_walker::WalkRequest` (files-only filter, `WalkDetail::Minimal`, `FollowLinks::Never`, `SizeHintPolicy::WhenCheap`) built by `build_grep_walk_request`.
  - Grep always walks with `.cache(false)`: it does not use the shared TTL scan cache (that cache serves `glob`/`fuzzyFind`).
  - Entry filtering: file-only + optional glob filter (`CompiledWalkGlob::compile`) + optional type filter mapping (`js`, `ts`, `rust`, etc.).
  - The compiled glob also supplies the walk's maximum depth through `depth_bound()`, so `--glob 'src/*.ts'` stops at two components instead of traversing the whole tree and filtering the rest back out.

### Search/collection semantics

- Regex engine: `grep_regex::RegexMatcherBuilder` with `ignoreCase` and `multiline`.
- Context resolution:
  - `contextBefore/contextAfter` override legacy `context`.
  - Non-content modes do not collect context.
- Output modes:
  - `content` -> one `GrepMatch` per hit.
  - `count` maps to count-style entries (`lineNumber=0`, `line=""`, `matchCount` set); `filesWithMatches` emits one entry per file with `lineNumber=0`, `line=""`, and `matchCount` omitted.
  - `offset` and `maxCount` are applied during aggregation across sorted file results.
  - Directory searches use parallel filesystem walking/searching, then aggregate per-file results to preserve global offset/limit semantics in the returned result and callback stream.

### Result shaping back to JS

- Rust `SearchResult`/`GrepResult` fields map to TS interfaces via N-API object conversion.
- Counters are clamped before crossing N-API where needed.
- `GrepResult.limitReached` is optional and emitted when true.
- `SearchResult.patternTreatedAsLiteral` and `GrepResult.patternTreatedAsLiteral` are optional. When present, the field holds the original regex compile error and reports that the successful search used an escaped literal matcher instead.
- Streaming callbacks receive each shaped `GrepMatch` for content or count-style entries. The result-level literal-demotion notice is not part of an individual callback entry.

### Failure behavior

- `search` returns a populated result after ordinary literal demotion. `SearchResult.error` is reserved for failures that remain after matcher construction, such as failure to construct the final literal matcher, content conversion failure, or search execution failure.
- `grep` also returns normally after ordinary literal demotion. It rejects on hard errors such as an invalid path or glob, cancellation, final matcher-construction failure, or search execution failure.
- `hasMatch` returns the literal match boolean after demotion but currently drops the demotion notice because its return type is only `boolean`. Input or pattern UTF-8 conversion and final matcher-construction failures can still throw.
- File open/search errors in multi-file scans are skipped per-file; scan continues.

### Malformed regex handling

`grep.rs#build_matcher` runs a tolerant compile chain:

1. Braces that cannot form `{N}`, `{N,}`, `{N,M}` are escaped (`{`/`}` -> `\{`/`\}`), so literal-template fragments (for example `${platform}`) do not fail as malformed repetition.
2. The sanitized pattern is compiled with the Rust regex engine; on failure it is retried with PCRE2, which supports lookaround and backreferences the Rust engine omits.
3. An unclosed/unopened-group error triggers one retry with unescaped parentheses escaped (so literal snippets like `fetchAnthropicProvider(` still search), tried on both engines.
4. If both engines reject the regex attempts, the original pattern is `regex::escape`d and compiled as a literal matcher. A successful literal demotion returns normal search results plus `patternTreatedAsLiteral` on `SearchResult` or `GrepResult`; `hasMatch` uses the same matcher but drops that notice. Only failure to build the final literal matcher remains a regex error.

## 2) File discovery (`glob`) and fuzzy path search (`fuzzyFind`)

`glob`, `fuzzyFind`, and directory candidate discovery for `astGrep`/`astEdit` use the `veyyon-walker` TTL scan cache; their matching logic and cache controls differ.

### `glob` flow

1. Caller passes `GlobOptions` directly. `pattern` and `path` are required in the generated type.
2. Rust resolves the search path and compiles the pattern via `veyyon_walker::CompiledWalkGlob::compile`, which normalizes it with `veyyon-glob` and reports the walk depth it can reach.
3. Entry source: a `veyyon_walker::WalkRequest` with `.cache(config.cache)` and `.empty_recheck(EmptyRecheck::Configured)`: `cache=true` serves from the walker TTL cache (with stale-empty recheck), `cache=false` walks fresh without storing.
4. Filtering:
   - skip `.git` always;
   - skip `node_modules` unless requested (`includeNodeModules`) or pattern mentions `node_modules`;
   - apply glob match;
   - apply file-type filter; symlink `file`/`dir` filters resolve target metadata.
5. Optional sort by mtime descending (`sortByMtime`) before truncating to `maxResults`.

### `fuzzyFind` flow

1. Rust implementation lives in `fd.rs`; generated export is `fuzzyFind`.
2. Shared scan source from the `veyyon-walker` cache with the same cache/no-cache split and stale-empty recheck policy (fd walks with `FollowLinks::Always`).
3. Scoring:
   - exact / starts-with / contains / subsequence-based fuzzy score;
   - separator/punctuation-normalized scoring path;
   - directory bonus (+10) and deterministic ordering: `score` desc, then path-depth asc (shallower paths first), then `path` asc.
4. Symlink entries are excluded from fuzzy results.

### Failure behavior

- Invalid glob pattern returns an error from `CompiledWalkGlob::compile`, carrying the glob engine's own message.
- Search root must resolve to an existing directory for directory discovery flows.
- Cancellation/timeouts propagate as abort errors via `CancelToken::heartbeat()` checks in loops.

### Malformed glob handling

`veyyon_glob::build_glob_pattern`, which `CompiledWalkGlob::compile` applies for every walking tool, is tolerant:

- normalizes `\` to `/`,
- auto-prefixes simple recursive patterns with `**/` when `recursive=true`,
- auto-closes unbalanced `{...` alternation groups before compile.

The walk depth is measured after that normalization, so the same `*.ts` is bounded to one component for `astGrep` (which compiles non-recursively) and unbounded for `grep` (which compiles recursively and so measures `**/*.ts`).

## 3) AST and structural code utilities

`ast.rs` exposes syntax-aware code search and rewrite operations.

- `astGrep(options)` returns matches with byte/line/column coordinates and optional metavariable bindings.
- `astMatch(options)` runs the same patterns against an in-memory `source` string instead of files; `lang` is required (there is no path to infer it from), and the result keeps matches, `totalMatches`, `limitReached`, and parse errors but omits the file-count fields.
- `astEdit(options)` returns replacement changes, per-file counts, searched/touched file counts, parse errors, and whether edits were applied.
- `dryRun` defaults to true for edit options in the generated documentation.
- Options include language override, path/glob/selector, strictness, limits, parse-error policy, `signal`, and `timeoutMs`.

For a directory operand, `astGrep` and `astEdit` discover candidates through a walker request with caching always enabled and `EmptyRecheck::Configured`. A stale cached directory result that filters to no candidates can therefore trigger the configured fresh recheck. A single-file operand bypasses the walker and its cache. `astMatch` remains wholly in-memory and uncached.

The adjacent N-API adapters expose three in-memory tree-sitter helpers:

- `blockRangeAt({ code, line, lang?, path? })` returns the 1-indexed inclusive range of the outermost named node beginning on `line`. It returns `null` for an unknown language, an out-of-range or blank line, no node beginning on the line, or a resolved subtree containing a syntax error.
- `enclosingBlockBoundaries({ code, ranges, lang?, path? })` returns sorted, unique, 1-indexed boundary lines for multi-line named nodes crossing the visible ranges. It returns `null` for an unknown language or a parse tree with syntax errors, signaling that the caller should use a lexical fallback.
- `summarizeCode(options)` produces an in-memory tree-sitter summary with canonical language and parse status, total-line and elision metadata, and source-ordered `kept`/`elided` segments. Its options control body/comment elision thresholds and breadth-first unfolding targets and limits.

All six public functions are reached through the package's lazy JS wrappers. Once the addon is loaded they call N-API directly; no package-local TypeScript layer changes their contracts.

## 4) Shared scan/cache lifecycle (`veyyon-walker` cache)

The scan cache lives in `crates/veyyon-walker/src/cache.rs`. `collect_entries(root, options, heartbeat)` stores scan results as normalized relative entries (`path`, `fileType`, optional `mtime` and regular-file `size`) keyed by the canonical search root plus the **entire** `WalkOptions` struct (with the `cache` flag normalized out), so `include_hidden`, `use_gitignore`, `skip_node_modules`, `follow_links`, and scan detail (`Minimal` vs `Full`) all key distinct cache entries.

Tunables are env-configured: `FS_SCAN_CACHE_TTL_MS` (default 1000ms; `0` disables), `FS_SCAN_EMPTY_RECHECK_MS` (default 200ms), and a max-entry cap with oldest-entry eviction.

### Cache state transitions

1. **Miss / disabled**
   - TTL is `0`, `options.cache` is false, or key absent/expired -> fresh collection (fresh cached scans are stored and return `cache_age_ms: 0`).
2. **Hit**
   - Entry age is within TTL -> return cached entries + `cache_age_ms`.
3. **Stale-empty recheck**
   - Requests that opt in via `EmptyRecheck::Configured` (`glob`, `fuzzyFind`, and AST directory discovery): if the query yields zero matches and cache age exceeds the empty-result threshold, force one rescan.
4. **Invalidation**
   - `invalidateFsScanCache(path?)` (exported from `iofs.rs`, backed by `veyyon_walker::cache::invalidate_all` / `invalidate_path_string`):
     - no arg: clear all keys;
     - path arg: remove keys whose cached root contains that path.

### Stale-result tradeoff

- Cache favors low-latency repeated scans over immediate consistency.
- TTL window can return stale positives/negatives.
- Empty-result recheck reduces stale negatives for older cached scans at the cost of one extra scan.
- Explicit invalidation is the intended correctness hook after file mutations.

## 5) ANSI text utilities (`text.rs` and `veyyon-text`)

These are pure, in-memory utilities.

### Boundaries and responsibilities

- `crates/veyyon-text/src/lib.rs` is the text engine. It owns ANSI parsing, grapheme and terminal-cell measurement, wrapping, truncation, slicing, segment extraction, and the process-wide Hangul compatibility-jamo width override.
- `crates/veyyon-natives/src/text.rs` is the thin N-API adapter. It owns the N-API DTOs, conversion from JavaScript strings to UTF-16 engine input, construction of UTF-16 JavaScript results, and integer clamping at the boundary. It forwards width-sensitive operations and their explicit tab-width arguments to `veyyon-text`.
- `grep.rs` line truncation (`maxColumns`) is separate:
  - simple character-boundary truncation of matched lines with `...`,
  - not ANSI-state-preserving and not terminal-cell width aware.

### Key behaviors

- `wrapTextWithAnsi`: wraps by visible width, carries active SGR codes across wrapped lines.
- `truncateToWidth`: visible-cell truncation with ellipsis policy (`Unicode`, `Ascii`, `Omit`), optional right padding.
- `sliceWithWidth`: column slicing with optional strict width enforcement.
- `extractSegments`: extracts before/after segments around an overlay while restoring ANSI state for the `after` segment.
- `setHangulCompatJamoWidthOverride`: changes the process-wide compatibility-jamo cell width used by the `veyyon-text` engine after the host measures its terminal.
- `sanitizeText` (ANSI/control/surrogate stripping with line-ending normalization) no longer lives in `text.rs`; it moved to `@veyyon/utils` as a pure-JS implementation in `packages/utils/src/sanitize-text.ts`. The native binding was removed in the same change because the JS version was competitive on the benchmarked workloads, and keeping a Rust copy forced every caller (including `pi-utils`) to pull in `@veyyon/natives`.
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
- Arrays return one aggregate count and are encoded in parallel when the global Rayon pool is available, otherwise serially.
- Default encoding is `O200kBase`; `Cl100kBase` is also available.
- The implementation uses ordinary tokenization, not special-token handling.

## Pure utility vs filesystem-dependent flows

| Flow                                      | Filesystem access | Shared cache          | Notes                                                  |
| ----------------------------------------- | ----------------- | --------------------- | ------------------------------------------------------ |
| `search` / `hasMatch`                     | No                | No                    | regex or demoted literal on provided bytes/string only |
| `veyyon-text` functions via `text.rs`     | No                | No                    | ANSI/width utilities only                              |
| `highlight` module functions              | No                | No                    | syntax + ANSI coloring only                            |
| `countTokens`                             | No                | No                    | tokenization only                                      |
| `astMatch`                                | No                | No                    | in-memory syntax-aware match (no disk)                 |
| structural block/summary helpers          | No                | No                    | in-memory tree-sitter operations                       |
| `astGrep` / `astEdit`, directory operand  | Yes               | Always                | cached directory candidate discovery                   |
| `astGrep` / `astEdit`, single-file operand | Yes              | No                    | direct file candidate, walker bypassed                 |
| `glob`                                    | Yes               | Optional              | directory scans + glob filtering                       |
| `fuzzyFind`                               | Yes               | Optional              | directory scans + fuzzy scoring                        |
| `grep` (file/dir path)                    | Yes               | No (`.cache(false)`)  | ripgrep over files, optional filters/callback          |

## End-to-end lifecycle summary

1. Caller invokes a lazy package export. Its first actual call selects, loads, and validates a native addon candidate; later calls use the cached native function.
2. Rust validates/normalizes options and builds matcher/search config.
3. For filesystem flows, entries are scanned (cache hit/miss/rescan where applicable) then filtered/scored/searched.
4. Worker loops periodically call cancel heartbeat; timeout/abort can terminate execution.
5. Rust shapes outputs into N-API objects (`lineNumber`, `matchCount`, `limitReached`, `patternTreatedAsLiteral`, etc.).
6. The package's lazy binding returns typed JS objects and optional per-match callbacks for `grep`/`glob`.

*Verified against `0eb8d74a3ecf60e1b2ec37c15e9255f2dbe310dc` on 2026-07-30.*
