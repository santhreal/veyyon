# Changelog

## [Unreleased]

### Changed

- Syntax highlighting moved from the native addon into the `veyyon-highlight` crate, with no change to highlighting output.

### Fixed

- Fixed stock Windows AVX2 detection by trying PowerShell 7 before an isolated modern-addon trial; only explicit shell answers or illegal-instruction exits become verdicts, while missing, incompatible, timed-out, and unexpectedly crashing addons remain unknown.
- Persisted AVX2 verdicts are schema-versioned and keyed by platform, architecture, and CPU model, so copied or stale caches cannot select a native variant for different hardware.
- The AVX2 trial load answers from the addon loader's first import and exits, so a compiled host, whose `process.execPath` is the product binary rather than a JavaScript runtime, reports a verdict instead of booting the whole CLI and spawning a trial child of its own at every level.
- A wrapped line now continues under the indent its first row opened at, so an indented row no longer reads as a new top-level row at a narrow width.
- An indented row inside a tool block keeps its indent when it wraps at a narrow width, instead of continuing at the block's left edge.

## [1.2.0] - 2026-08-23

### Breaking Changes

- The minimum supported Bun runtime is now 1.4.0.

### Changed

- A grep that matches in every file it searches no longer allocates a vector per file to decide which of that file's matches to return. The aggregator collected each file's selected matches into a temporary `Vec` and then pushed the rows out of it, and it grew the row vector by doubling: on 50,000 files of 1KiB with a match in each, four workers spent 15.4ms of a 91.2ms pass inside aggregation. Selection is arithmetic on counts now — how many of this file's matches the offset skips, how many the limit still allows — applied to the file's own iterator, and the row vector is sized by one counting pass before the first row is pushed, because 50,000 `GrepMatch` rows is about 6MiB and the doubling copied more than the rows. The same query is 83.8ms with 10.6ms in aggregation, and a query dense in matches but sparse in files (2,500 files of twenty matches, the same 50,000 matches) is unchanged at 59.9ms. The residual gap between those two shapes is per-file result-object and N-API cost, not ripgrep's per-match collection, which is what the stage split was built to tell apart: a 20x difference in result objects with an identical match count. Row selection is proved against the algorithm it replaces, swept over file shapes, offsets, limits and all three output modes.
- A filtered directory scan no longer copies the entries it is about to discard. Globbing and listing ask the walker for a small slice of a large tree, and the answer was assembled by cloning every cached entry and then dropping the rejects, so a glob keeping 10 entries of 100,000 still allocated 100,000 owned paths: 101,373 allocations and 13.8MiB per cache hit, with peak resident memory rising by the same 13.8MiB. The filter now runs where the entries live — inside the cache entry, or inside the fresh scan before it is handed to the cache — and only a survivor is cloned: the same hit costs 283 allocations and 0.0MiB, and a cold fill of it drops from 306,954 allocations and 45.2MiB to 205,864 and 31.4MiB, with peak growth of 1.0MiB instead of 15.7MiB. Survivors are marked in a one-bit-per-entry mask so the result vector is allocated once at its exact size (an unknown-count `collect` doubles a buffer of 48-byte entries and cost 9.8MiB of churn, a vector of indices cost 2MiB, the mask costs 12KiB), and a filter that accepts everything still clones the slice in one shot, as cheap as before. `crates/veyyon-walker/examples/walk-cache-copy.rs` is the instrument, and it keeps permanent "filter after copy" arms so the difference is re-measured on every run rather than remembered.
- The parallel grep's worker scaling is now measured by a committed instrument, and the shared results mutex it was suspected of queueing behind is cleared by that measurement. `bench/grep-workers.ts` runs one child process per `VEYYON_WALK_WORKERS` value (the walker reads that variable once per process, so a worker count cannot change inside a run), on disk and on tmpfs, and checks every worker count returns byte-identical path-sorted rows and identical counters before it reports a ratio. It carries three corpus densities on purpose: 50,000 files with one match each and 2,500 files with twenty each collect the same 50,000 matches while differing twentyfold in how often the accumulator is locked, so scaling can be attributed. At four workers the arms reach 2.37x, 2.70x and 3.22x one worker on disk (2.49x, 2.38x, 2.80x on tmpfs), and cutting lock acquisitions twentyfold moves that by 0.33x on disk and by nothing on tmpfs, while cutting match volume eightfold at a fixed lock count moves it by 0.52x. A temporary build that timed every acquisition confirmed it and was not kept: summed across workers, lock wait was 0.9% of aggregate cpu wall at four workers and 4.1% at eight, hold 4-12ms, the path sort under 4ms. The corpus generator gained the density knobs this needed (`matchEvery`, `matchesPerFile`, `fileBytes`), each recorded in the manifest so a corpus of another shape is regenerated rather than silently reused.
- The grep benchmark measures a corpus it generates and refuses a speed claim it cannot support. It used to search this repository and the local Cargo registry, so its numbers described a different workload on every machine and after every commit; it compared a single total match count, which cannot see a path, line or text difference between the two engines; and it ran `rg` with stderr discarded and the exit code unread, so an `rg` that failed to start measured as a very fast search of no files and still printed `Nx faster`. It now generates a versioned, fixed-seed corpus of 10,000 files (~40MiB, one constant path length, 5% matching, with hidden, gitignored and `node_modules` controls), compares content, files-with-matches and count modes row for row against `rg`, records the `rg` and addon versions, the runtime, the CPU and the corpus identity, separates a cold pass from the warm medians, and prints a ratio only when parity held, the provenance is complete and the run's own halves agreed within 5%. Parity covers path, line number and line text; the addon exposes no column, so column drift is outside what any comparison here can see.

### Fixed

- A source that changed by one edit is no longer parsed from scratch. The retained tree matched on exact bytes only, so the two questions a streamed edit preview asks — the boundaries of the file on disk, then the boundaries of the file the edit would produce — missed the slot in turn and each paid a whole-file parse: measured on a 3.7MB, 40,000-line source, 102ms per `enclosingBlockBoundaries` call, twice per redraw, for a preview that redraws while arguments arrive. A miss whose source shares a byte prefix and a byte suffix with the retained one is now served by editing the retained tree with that one run and reparsing against it, which tree-sitter answers in time proportional to the edit and which produces the tree a fresh parse produces. The same call is 47ms, so one preview pass over that source is 110ms where it was 215ms. Verified against a fresh parse for nine edit shapes (in place, inserted, deleted, at either end, multi-line, non-ASCII, truncated, replaced wholesale) at three windows each, and for a line inserted into the fixture of every one of the 57 supported languages. A source above the 4MB retention ceiling still has no entry to reuse and still parses in full.
- A second window of a file just read no longer reparses it. Every syntax-aware call parsed the whole source from scratch, and after the walk above was pruned that parse was the entire cost: 205ms of a 205ms `enclosingBlockBoundaries` on a 3.5MB source, paid again for the next window of the same file and again for a block resolved in it. The thread that parsed keeps the tree for the source it parsed, matched on the exact bytes — a digest would answer wrongly on a collision, and comparing 3.5MB costs 0.2ms against a 205ms parse — so an edit, a different language, or a different file is a miss. One entry per thread, and a source above 4MB is parsed without being retained, which also clears the slot rather than leaving a smaller tree resident behind it. A bounded range read of that 3.5MB file measures a 18.5ms p50 where it was 442ms before this release; the first read of a file still pays the parse.
- A bracket-context lookup no longer walks the whole syntax tree to answer a bounded window. `enclosingBlockBoundaries` visited every node in the file to find the at most two boundary lines a 20-line window can produce, so the walk cost as much as the parse it followed: measured on a 3.5MB, 103,000-line source, 287ms of a 503ms call, and 43ms of 85ms on an 829KB one. The walk now descends only into subtrees that hold a visible line, which is exact rather than approximate — a node holds no descendant whose content escapes its own span — so the boundary set is unchanged, verified against an unpruned reference walk over every window of a fixture in each of the 57 supported languages. The same call is 224ms and 42ms, and a `read path:50000-50019` of that 3.5MB file went from a 452ms p95 to 256ms.
- A launch no longer waits for the stale addon cache to be deleted. The prune of dead `<data home>/veyyon/natives/<version>/` directories ran synchronously between `dlopen` returning and the first native call, so its cost was set by whatever was on disk: measured on the development host, one 150MiB cache cost 7ms, three cost 24ms, and three that also held 5000 small files cost 105ms, all of it before the first frame. The prune is now handed to the event loop with the unlink work off the calling thread, which puts the first native call at 123.0ms with 450MiB of stale cache against a 123.7ms clean baseline, where it was 146.4ms against 124.9ms. A process that exits within the tick reclaims nothing and the next launch prunes instead; `scripts/ensure-native.ts` still prunes synchronously at install time, which is when a stale cache is created.
- `xargs` in replace mode (`-I`, `-i`, `--replace`) matches GNU on a line with nothing to substitute: leading blanks are stripped from the substituted line, a blanks-only line runs the command zero times instead of once, and whitespace-only input no longer appends an empty argument in ordinary mode. The empty batch this produced is what used to reach `CommandBuilder::execute` and panic with `index out of bounds: the len is 0 but the index is 0` (recorded nine times in the crash logs); the panic itself was fixed earlier without a test, and that suite now exists.
- `find -L` lists a symlink it cannot resolve instead of dropping it. A link whose target is missing is listed silently and exits 0, a link whose target sits under a file is listed with its `Not a directory` diagnostic and exits 1, and a loop is diagnosed and listed nowhere — the three lines GNU findutils 4.9.0 draws. The link's own metadata comes with it, so `-type l` matches it, and the walker's depth bounds still apply. Previously the diagnostic was printed and the entry was thrown away, so `find -L` over a tree with a dangling link both omitted it from the listing and failed with exit 1.
- The `find` test suite runs. 65 of its 207 tests read a `test_data/` tree that vendoring never brought across, so every run reported 142 passed / 65 failed and a real regression would have arrived inside that noise. The tree is now provisioned from code on the first test that reads a fixture, which is also what git cannot carry: a symlink whose target must not exist, a loop, and a file whose exact byte count is asserted. Two of those tests were dead for a second reason — `format_strings` rewrapped their expected output through the middle of a `\n` escape, leaving a literal backslash, a newline and the letter `n` in a string no run of `find` could produce.
- The native text engine skips an Fp escape sequence when it measures and when it cuts. `ansi_seq_len_u16` recognised the Fe class after `ESC` and stopped at `0x40`, so the two-byte private sequences below it — `ESC 7`, `ESC 8`, `ESC =`, `ESC >` — were charged as two printable columns by the cutter while the width oracle beside it drew nothing for them. A cut taken against one and rendered by the other lands mid-sequence, which writes the escape's payload byte into the visible row.

## [16.5.2] - 2026-07-14

### Fixed

- Fixed an issue where Windows PTY callers were forced through shell command re-quoting by supporting direct executable and argument launching.

## [16.4.6] - 2026-07-12

### Added

- Added an in-process `readlink` shell builtin (vendored from uutils coreutils 0.8.0), supporting `-f`/`-e`/`-m` canonicalization, `-n`/`-z` delimiters, and `-v`/`-q`/`-s` verbosity, with path operands resolved against the shell working directory.
- Added in-process shell builtins for `realpath`, `touch`, `stat`, `date`, `mktemp`, `seq`, `yes`, `printenv`, `ln`, `truncate`, `tac`, `nproc`, `uname`, `whoami`, and `hostname` (vendored from uutils coreutils 0.8.0), plus native `which` (shell PATH lookup) and `diff` (unified output, `-U`/`-q`/`-N`, binary detection, recursive directory compare) builtins. All resolve path operands against the shell working directory, read the shell's exported environment, and honor abort/timeout cancellation; `ln` is gated with the destructive set (`PI_DISABLE_UUTILS_DESTRUCTIVE`), and system-mutating modes (`date --set`, hostname setting) are disabled.

### Fixed

- Fixed `ast_edit` rejecting byte-identical duplicate replacements as "Overlapping replacements detected": multiple rewrite ops matching the same node with the same output now collapse into one deterministic edit (deduped in both the preview listing/counts and the apply pass), so only genuinely divergent overlaps error.

## [16.4.5] - 2026-07-11

### Added

- Added context-safe, in-process shell builtins for common utilities including base64, basename, dirname, cut, tee, tr, paste, comm, sed, xargs, jq, and the md5sum/sha/b2sum checksum family. These builtins run without spawning external binaries, support pipelines, respect shell-relative paths and environment variables, and honor abort/timeout cancellation.

## [16.4.4] - 2026-07-11

### Fixed

- Fixed fuzzyFind tie-breaking logic to prefer shallower paths first, preventing deeply nested matches from ranking above shallow ones on score ties.
- Fixed macOS installation issues for veyyon-natives by statically linking PCRE2, removing the runtime dependency on Homebrew's dynamic libpcre2-8.0.dylib library.

## [16.4.3] - 2026-07-11

### Fixed

- Optimized non-recursive glob patterns (e.g., `dir/*.json`) to prevent traversing entire subtrees, significantly improving performance and preventing timeouts when searching large directories.
- Fixed native filesystem searches (`glob`, `grep`, and AST search/edit) incorrectly excluding explicitly rooted directories due to ancestor ignore rules.

## [16.3.13] - 2026-07-09

### Fixed

- Fixed unbounded memory growth in the native bash output bridge when a command produces output faster than the JS event loop consumes it: the shell streaming path now uses a bounded chunk queue with real backpressure (pipe readers park until the JS callback catches up, parking the child on its pipe) instead of buffering the entire surplus in memory. No output is dropped — the rolling tail view, `[raw output: artifact://…]` lossless capture, and byte accounting are unaffected ([#4078](https://github.com/can1357/oh-my-pi/issues/4078)).
- Fixed `readImageFromClipboard` on Windows failing with "could not be converted to the appropriate format" for screenshots taken by Qt-based tools such as PixPin and Snipaste. arboard hands their `CF_DIBV5` payload (`BI_RGB` plus an alpha mask, rewritten to `BI_BITFIELDS`) to a header-less BMP decode that mis-places the pixel offset for V4/V5 bitfield headers; the native reader now falls back to decoding the raw `CF_DIB` clipboard bytes directly, so image paste no longer depends on the PowerShell bridge. ([#3426](https://github.com/can1357/oh-my-pi/issues/3426))
- Fixed OMP being killed outright (OOM on memory-capped hosts such as WSL) when an output-heavy bash command hit its timeout: the unbounded output-bridge backlog could grow by gigabytes before cancellation and starve the JS event loop far past the deadline; with the bounded backpressured bridge the run resolves at its deadline with flat memory ([#4866](https://github.com/can1357/oh-my-pi/issues/4866)).

## [16.3.12] - 2026-07-08

### Fixed

- Fixed the native build script failing to locate the `@napi-rs/cli` `napi` binary on Windows because the `PATH` lookup joined entries with a Unix `:` separator instead of the platform delimiter (`path.delimiter`).
- Fixed a Windows regression where an abnormal `omp` exit or bash cancellation could `TerminateProcess` unrelated `pwsh.exe` / `powershell.exe` sessions (including other Cursor terminal tabs). `SpawnRegistry` stored only the raw pid of each brush-spawned child and re-opened it via `Process::from_pid` at cancellation time; between those two moments Windows could recycle a freed pid onto an unrelated PowerShell, and `signal_tree` then walked the wrong subtree via Toolhelp. The observer now pins a stable `Process` handle at spawn time — on Windows the open handle keeps the pid slot reserved, on Linux the pidfd carries identity, on macOS the `(pid, start_time)` triple detects impersonation — so cancellation can only reach children this run actually launched. The registry sweeps exited entries once the recorded set crosses a small threshold so a long bash loop of short external commands cannot pin one owned OS handle per historical spawn. ([#4605](https://github.com/can1357/oh-my-pi/issues/4605))

## [16.3.6] - 2026-07-04

### Changed

- Rewrote native `grep` directory search to stream while the tree is walked: a work-stealing parallel traversal feeds searchers directly, and content-mode match budgets now terminate the walk itself instead of only the search. Limited searches keep deterministic path-ordered first pages at every budget size via windowed commits, with oversized files still deferred behind normal-sized results.
- Faster filesystem walker: gitignore/ignore state is now derived from each directory's own listing instead of up to five per-directory stat probes, per-entry allocations were eliminated through pooled directory scratch buffers and reusable path builders, and a new parallel unordered file-candidate walk API backs full-scan grep.
- Concurrent `grep` calls are no longer serialized against each other, searchers are reused per worker instead of rebuilt per file, and non-multiline patterns opt into grep-regex's line-terminator fast path with a compatibility fallback.

## [16.3.0] - 2026-07-02

### Added

- Added `workingDir` to `ShellRunResult` to allow hosts to synchronize the session's current working directory without executing a hidden probe command.

### Fixed

- Fixed an issue where panics in native worker tasks (such as grep, AST parsing, globbing, workspace listing, HTML-to-markdown conversion, fuzzy finding, and clipboard image reading) would abort the host process instead of properly rejecting the returned JavaScript Promise.
- Fixed a crash on Windows under low memory or commit charge conditions when spawning worker threads for token counting or sorting operations.

## [16.2.11] - 2026-07-01

### Fixed

- Fixed high memory usage in native `astGrep` and `astMatch` by retaining only the requested page window of match payloads during broad searches while preserving exact totals.

## [16.2.10] - 2026-06-30

### Added

- Added a platform-native no-ignore filesystem traversal path for `glob`/`grep` scans, using `getattrlistbulk` on macOS, `getdents64`/`statx` on Linux, and `NtQueryDirectoryFile` with `FileIdFullDirectoryInformation` on Windows while preserving the existing `WalkBuilder` path for gitignore-aware scans.

## [16.2.7] - 2026-06-30

### Added

- Added embedded Silver TrueType font rendering support to `renderSnapcompactPng`, featuring automatic per-glyph fallback for missing bitmap characters and anti-aliased scaling for East Asian wide code points.
- Added the `snapcompactSupportedChars` function to check font capability for specific characters.

## [16.2.5] - 2026-06-28

### Fixed

- Fixed the in-process `grep` builtin rejecting GNU-grep's `--color`/`--colour` (with or without `=WHEN`) and `--version` flags. The shadowing rejection broke bash's near-universal `alias grep='grep --color=auto'`, causing bare `grep` in any pipeline to fail with exit 2. The builtin now accepts and ignores `--color[=WHEN]` (its output goes through in-process file descriptors, never a TTY, so ANSI injection would corrupt downstream consumers) and reports its version through the context streams ([#3755](https://github.com/can1357/oh-my-pi/issues/3755)).

## [16.2.4] - 2026-06-28

### Fixed

- Fixed a crash in the in-process `tail` builtin where the host process would abort with a `BrokenPipe` panic if the stdout consumer closed the pipe early.

## [16.1.23] - 2026-06-26

### Added

- Added Nix and Mermaid syntax highlighting support to `highlightCode`/`supportsLanguage` via vendored `Nix.sublime-syntax` and `Mermaid.sublime-syntax` definitions plus `nix`, `mermaid`, and `mmd` aliases.
- Added in-process [uutils](https://github.com/uutils/coreutils)-backed shell builtins to the embedded brush `Shell`: `cat`, `head`, `tail`, `wc`, `sort`, `uniq`, `ls`, `find`, `grep`, `mkdir`, `rm`, and `mv`. These vendored + patched utilities run inside the shell process (no `fork`/`exec`), resolve path operands against the shell working directory, route stdio through the command's (possibly piped/redirected) file descriptors, read the shell's exported environment, and honor abort/timeout cancellation (a blocked `stdin` read unwinds cleanly). `grep` is built on the ripgrep `grep-*` crates and `find` on `uutils/findutils`; the rest are pinned to `uutils/coreutils` 0.8.0 (matching the bundled `uucore`). Registration is gated: set `PI_DISABLE_UUTILS_BUILTINS` to fall back to the system binaries for the whole set, or `PI_DISABLE_UUTILS_DESTRUCTIVE` / `PI_DISABLE_RM_BUILTIN` / `PI_DISABLE_MV_BUILTIN` to disable only the destructive `rm`/`mv` shadows.

## [16.1.17] - 2026-06-24

### Added

- Added `setHangulCompatJamoWidthOverride(value)` to override the Hangul Compatibility Jamo (U+3131..U+318E) display width at runtime via a process-global atomic, instead of relying solely on the compile-time `cfg!(target_os = "macos")` heuristic. The actual width is decided by the client terminal (not the host OS), so the TUI resolves it from the terminal identity and pushes the result here. Encoding: `0` = platform default (macOS narrow, otherwise UAX#11), `1` = narrow (1 cell), `2` = wide (2 cells), `3` = Unicode width (no correction). The leaf width helpers read this override, so no width/slice/truncate/wrap signatures change.

## [16.1.15] - 2026-06-22

### Added

- Added `Shell.liveBackgroundJobCount()` reporting the number of live external background jobs (`&`/`nohup` children) on a persistent session, reaping completed jobs first via a silent `poll()`. Lets the host retain a shell whose background process is still running instead of dropping it (which would SIGKILL the child via kill-on-drop).

### Fixed

- Fixed `veyyon_natives` failing to load in Bun worker threads on macOS x64 when the host built only the `modern` (AVX2) variant. The runtime detector's `child_process.spawnSync("sysctl", …)` returned null from the worker even though the build-time detector succeeded in the parent, so `loadNative()` resolved `variant=baseline` and searched a file list that excluded the on-disk `veyyon_natives.darwin-x64-modern.node`. Resolution now prefers `Bun.spawnSync`, tries `/usr/sbin/sysctl` before bare `sysctl`, and caches the first context's verdict via a private env key so child workers and subprocesses inherit it instead of re-detecting ([#3238](https://github.com/can1357/oh-my-pi/issues/3238)).

## [16.1.14] - 2026-06-22

### Fixed

- Enabled full Julia syntax highlighting support in highlightCode

## [16.1.12] - 2026-06-21

### Added

- Added Julia syntax highlighting to `highlightCode`/`supportsLanguage` via a vendored `Julia.sublime-syntax` folded into syntect's default set (`jl`/`julia` aliases); syntect ships no Julia grammar.

## [16.1.8] - 2026-06-20

### Breaking Changes

- Changed renderSnapcompactPng to return a promise instead of a string value

### Fixed

- Fixed directory `grep` continuing to walk large trees after the requested content match budget had already been satisfied, which could make broad coding-agent searches time out before returning the first page of matches ([#2738](https://github.com/can1357/oh-my-pi/issues/2738)).

## [16.0.11] - 2026-06-19

### Fixed

- Fixed native shell execution reporting `veyyon-natives:command: syntax error at end of input` for a valid `&&`/`;` chain whose later pipeline stage is a compound command, e.g. `echo x && git log | while read h; do …; done | head`. The output minimizer's segmented-chain runner rebuilds each chain segment from the brush-parser AST via `pipeline.to_string()` and re-executes that string, but `simple_segment` only validated the *first* pipeline stage — so a compound later stage (`while`/`for`/`if`/subshell) was re-serialized without its terminator (`Display` drops it) and re-run as broken shell. `simple_segment` now requires every stage to be a `Display`-safe simple command, and — closing the recurring class of brush `Display` round-trip divergences (here-doc close-tag quoting, multi-byte char/byte offsets) at its root — each reconstructed segment is re-parsed and must match the original pipeline shape before the chain runner executes it; any divergence runs the command whole via the unsegmented path instead of corrupting it.

## [16.0.7] - 2026-06-18

### Added

- Added Fortran support to the AST tooling, including file/alias resolution.

## [16.0.6] - 2026-06-18

### Removed

- Removed the `cache` option from `GrepOptions`

## [16.0.4] - 2026-06-17

### Fixed

- Fixed `summarizeCode` BFS unfold aborting the entire pass when it hit an oversized, un-unfoldable leaf span (e.g. an HTML `<style>` raw-text block, an embedded blob, or a minified line) whose only unfold candidate is its whole body. The overflow check used to `break` the breadth-first loop, so any large leaf encountered before its siblings starved the rest of the tree — an HTML page summarized to `<style> ... </style>` plus `<div class="page"> ... </div>`, collapsing the document body into one dead `...`. An overflowing span is now skipped (left folded, its subtree unexplored) and the BFS keeps unfolding the remaining queued siblings, so structured siblings like the `<body>` DOM are revealed up to `unfoldLimit` while the oversized leaf stays folded.

## [16.0.2] - 2026-06-16

### Added

- Added Emacs Lisp (`.el`, `.emacs`, `emacs-lisp`/`elisp`) support to native tree-sitter language inference, enabling astGrep/astEdit, summarizeCode, and blockRangeAt on Emacs Lisp source.

## [16.0.1] - 2026-06-15

### Fixed

- Fixed shipped Linux native addons failing to load with `version 'GLIBC_2.39' not found` on distributions older than Ubuntu 24.04. After native builds moved onto the Ubuntu 24.04 (glibc 2.39) self-hosted runner, the x64 addon was a plain host build that linked the runner's glibc and the arm64 cross-build floated up to GLIBC_2.30; the `linux-x64` (baseline + modern) and `linux-arm64` addons are now built through `cargo-zigbuild` against a pinned glibc 2.17 floor, restoring portability to any glibc ≥ 2.17 (CentOS 7 / Ubuntu 14.04 era).
- Fixed Linux native builds hard-failing when `RUSTC_WRAPPER=sccache` points at an unavailable shared cache backend. The native build script now retries the `napi` build once without the sccache wrapper after a cache-storage startup failure, so install smoke tests and local fallback builds can proceed while preserving the cached fast path when the backend is healthy.
- Fixed shell cancellation cleanup failing to reap child processes inside containers whose guest kernel was built without `CONFIG_PROC_CHILDREN` (e.g. some Kata/microVM guests): the Linux descendant walk relied solely on `/proc/<pid>/task/<tid>/children`, which does not exist there, so `children()` / `live_descendants()` returned empty and termination waves never reached the children. It now falls back to scanning `/proc` and grouping by parent pid (the primitive the macOS path already uses) when no `children` file is readable, keeping the cheap per-task fast path on kernels that support it.

## [15.13.1] - 2026-06-15

### Fixed

- Fixed `veyyon-natives` deadlocking at addon load (`dlopen` hang) on some Linux hosts. The load-time Tokio runtime install added in 15.12.6 ran inside `#[module_init]`, which executes while the dynamic-loader lock is held; building the multi-thread runtime there eagerly spawns worker threads, and a fresh worker blocking to acquire the loader lock the init thread still owns deadlocks the whole load (every native consumer hangs at startup). The runtime is now built from an exported `__veyyonInstallTokioRuntime` that the JS loader calls once, immediately after `dlopen` returns and before any async native runs; `#[module_init]` only installs the crash handler. napi-rs materializes its runtime lazily on first async use (`RT` is a `LazyLock`) and `create_custom_tokio_runtime` only records the runtime, so the post-load install is still adopted — preserving the Windows commit-limit thread probing/back-off from 15.12.6 without spawning under the loader lock.
- Fixed `blockRangeAt` (and thus the edit tool's `replace block` / `delete block` / `insert after block` ops) returning no block for a construct whose opening line follows a blank line — most visibly in Swift, where `replace block` on a SwiftUI `var body: some View {` (or any statement/declaration after a blank line) failed with "could not resolve a syntactic block… (unsupported language, blank/closer line, or parse error)". tree-sitter-swift inserts a zero-width separator node at the start of a statement that follows a blank line; the resolver queried the first content column with a zero-width point range, which `ts_node_named_descendant_for_point_range` absorbs into that invisible node and bubbles back up to the enclosing body (or the file root), so no block was found. The query now spans the first content character (a one-column-wide range) so it skips zero-width nodes and descends into the node that actually begins on the line.
- Fixed native shell execution reporting `unterminated here document sequence` for a multi-command line that contains a here-doc with a quoted or escaped delimiter (`<<'TAG'`, `<<"TAG"`, `<<\TAG`) followed by another command (e.g. a `sqlite3 … <<'SQL' … SQL` query followed by an `echo`/second command). The output minimizer's segmented-chain runner rebuilds each `&&`/`;`/newline segment from the brush-parser AST via `pipeline.to_string()`, and that `Display` impl re-emits a quoted/escaped here-doc's *closing* delimiter with its quotes intact (`'SQL'` instead of the required bare `SQL`) — an invalid close tag that the re-run segment never matches. Here-doc-bearing pipelines are now ineligible for segmentation, so the command runs whole via the unsegmented path (where the executor parses it correctly); a lone here-doc was unaffected because it was never segmented.
- Fixed native addon loading leaving stale `~/.veyyon/natives/<version>` cache directories behind after updates; successful loads now remove older version directories best-effort.
- Fixed Linux source-built native addons hanging during package import by keeping the Windows-only Tokio worker probe out of non-Windows module initialization ([#2553](https://github.com/can1357/oh-my-pi/issues/2553)).
- Fixed `veyyon-iso` Windows clippy failures in symlink placeholder metadata, block-clone path resolution, and readonly cleanup handling ([#2379](https://github.com/can1357/oh-my-pi/pull/2379) by [@oldschoola](https://github.com/oldschoola)).

## [15.12.6] - 2026-06-14

### Fixed

- Fixed `veyyon-natives` aborting the whole process at addon load on memory-constrained Windows hosts (`OS can't spawn worker thread`, typically OS error 1455 — pagefile/commit limit). napi-rs builds its own Tokio runtime with one eagerly-spawned worker per CPU, and that spawn *panics* rather than erroring, so under `panic = "abort"` the failure was uncatchable. The addon now installs its own runtime at load: it probes how many threads the OS will actually grant (starting from the Tokio default, clamped to a small ceiling since CPU-heavy native work runs on libuv/Rayon and Tokio's separate blocking pool, not the scheduler workers), sizes the multi-thread runtime to the probed count, and falls back to a current-thread runtime if not even one worker can be spawned — no panic on any path.

## [15.12.4] - 2026-06-13

### Fixed

- Fixed native shell execution rejecting quoted heredocs whose closing delimiter is the final line without a trailing newline, matching bash paste-run snippets.

## [15.11.7] - 2026-06-12

### Added

- Added the X.org misc `6x12` and `8x13` BDF fonts (public domain, vendored in `crates/veyyon-natives/src/fonts/`) to `renderSnapcompactPng`, alongside two new options for the snapcompact eval-winner shapes: `stretch: false` renders glyphs at natural size on the requested cell box while keeping the 4-bit indexed encoder (e.g. 8x13 glyphs on an 8x16 pitch, the "8on16" shapes), and `columns: 2` flows pre-wrapped newline-separated lines down two newspaper columns with a 3-cell gutter (the "doc" shapes); in doc mode sentence hues also advance across a terminator followed by a newline
- Added a line-break marker to `renderSnapcompactPng`: `U+2588` (FULL BLOCK) fills its entire cell box with pitch-black ink in both grid and doc layouts, ignoring the sentence hue and dim state, and counts as a sentence boundary after a `.`/`!`/`?` terminator

### Changed

- `renderSnapcompactPng` now clips the frame height to the text: the PNG stays `size` pixels wide but is only `usedRows * lineRepeat * cellHeight` tall (dim toggles are zero-width; doc layout counts `\n`-separated lines), so a partially filled frame no longer pads to a full square of blank rows
- `renderSnapcompactPng` indexed frames now narrow the palette to the colors actually printed and pick the matching bit depth (plain `bw` 1-bit, dim/banded 2-bit, sentence hues up to 4-bit), and both encode paths moved from `Balanced` to `High` deflate: `8on16-bw` frames shrink ~35%, `6x12-dim` ~10%, sentence-hue doc frames ~9% — pure PNG, no decoder-side changes (lossless WebP was measured at only ~8% beyond this and rejected for provider-compatibility risk)

## [15.11.4] - 2026-06-12

### Fixed

- Fixed `blockRangeAt` (and thus the edit tool's `replace block` / `insert after block` ops) failing on extensionless shell rc/profile files. `Path::extension` returns `None` for both bare (`zshrc`) and dotfile (`.zshrc`, `.bashrc`) forms, so language inference fell through to "unrecognized" and block resolution was permanently unresolvable on those files — an agent retrying the block op would loop on the same error. Known shell rc/profile basenames (`zshrc`/`zshenv`/`zprofile`/`zlogin`/`zlogout`/`bashrc`/`bash_profile`/`bash_login`/`bash_logout`/`bash_aliases`/`profile`/`kshrc`/`mkshrc`/`shrc`, with or without a leading dot) now resolve to the bash grammar.

## [15.11.0] - 2026-06-10

### Breaking Changes

- Changed `renderSnapcompactPng(text, options)` to return a base64-encoded PNG `string` instead of a `Uint8Array`

### Added

- Added dim-span ink toggles to `renderSnapcompactPng`: `U+000E`/`U+000F` in the input switch to a dim gray ink (palette index 9) and back without occupying a glyph cell, letting callers visually de-emphasize spans such as archived tool output
- Added `renderSnapcompactPng(text, options)`: rasterizes pre-normalized text onto a square PNG in an eval-validated snapcompact shape. Options select the bundled font (`5x8` X.org BDF or `8x8` unscii-8, both public domain, shipped in `crates/veyyon-natives/src/fonts/`), the ink variant (`sent` six-hue sentence cycling or `bw` black), line repetition (each text line printed N times, copies on a pale highlight band), and a target cell size — cells differing from the font's natural cell render via Lanczos3 stretch into an anti-aliased RGB frame (e.g. the OpenAI-optimal 6x6 unscii shape); native-cell shapes encode as 4-bit indexed PNG. Replaces the JS rasterizer/PNG writer previously in `@veyyon/agent-core`.

## [15.10.12] - 2026-06-10

### Added

- Added deterministic shell-output minimization to the native shell pipeline, including opt-in per-command rewrite telemetry surfaced through `executeShell().minimized` for callers that want compact inline output plus a separately persisted original capture.

### Fixed

- Fixed native crash-log directory resolution diverging from the JS logger when `PI_CONFIG_DIR` is absolute: the config root now mirrors `path.join(homedir, PI_CONFIG_DIR)` semantics (absolute values re-rooted under `$HOME`, `.`/`..` components normalized), and an empty `PI_CODING_AGENT_DIR` no longer disables XDG state-dir resolution.
- Fixed shell-output minimization condensing `pyright`/`basedpyright` `--outputjson` runs into a diagnostics summary; machine-readable JSON output now passes through untouched.
- Fixed `veyyon-natives` aborting Bun on Windows with `memory allocation of N bytes failed` and no backtrace whenever the native cdylib hit a Rust panic or out-of-memory condition. The release profile uses `panic = "abort"`, so neither default handler emitted any context — Bun received only the bare message and tore down the TUI session before flushing. Module load now installs `std::panic::set_hook` and `std::alloc::set_alloc_error_hook` via `#[napi::module_init]`; both hooks capture `Backtrace::force_capture()` (so it works without `RUST_BACKTRACE=1`) and write a structured report — pid, thread, size/alignment for OOM, source location and message for panics, full backtrace — to the same logs directory the JS logger uses (`$XDG_STATE_HOME/veyyon/logs/` on Linux/macOS when the user has migrated to XDG and `PI_CODING_AGENT_DIR` isn't customized, otherwise `~/.veyyon/logs/`) and to stderr before the host process exits. The OOM hook prints the canonical allocation-failure line before any allocation-prone diagnostics and aborts immediately on re-entry, so real process-wide OOM still surfaces the fallback message instead of recursing in the report path ([#2211](https://github.com/can1357/oh-my-pi/issues/2211)).

## [15.10.11] - 2026-06-10

### Added

- Added a `maxCountPerFile` option to `grep` that caps how many matches a single file may contribute, so one hot file can no longer exhaust the global `maxCount` budget in path order and starve every file sorted after it out of the result set entirely.
- Added `PI_DEBUG_STARTUP` streaming markers to the addon loader (`native:loadNative:start`, `native:extractEmbeddedAddon:start`, `native:require:<file>`, `native:loadNative:done`), written with synchronous stderr writes so a hang inside first-run extraction or `dlopen()` — which blocks the event loop and defeats any timer-based diagnostics — still leaves the failing step as the last marker on stderr.
- Added a `skippedOversized` count to `GrepResult`: directory walks now report how many files were silently skipped for exceeding the 4MB per-file grep limit (previously they vanished without a trace, letting callers conclude a symbol does not exist).

### Changed

- Parallelized the mtime-ranked `glob()` walk (the path OMP `find` always takes): per-thread bounded top-N heaps replace the single-threaded full-stat traversal, so large trees rank in a fraction of the wall clock while keeping the deterministic mtime-desc/path ordering and bounded memory.

### Fixed

- Fixed cross-line grep being a silent no-op on real files: `multiline` set the `(?m)` flag on the regex matcher but never enabled `multi_line` on the `Searcher`, which stayed line-oriented, so any pattern spanning a `\n` returned zero matches with no error.

## [15.10.5] - 2026-06-08

### Added

- Added the `enclosingBlockBoundaries` native API (with `EnclosingBoundaryOptions` and `LineRange` types) that returns, for a set of visible line ranges, the off-window boundary lines of every multi-line tree-sitter node whose span crosses the window — the closer when an opener is shown and the opener when a closer is shown. Covers brace and indentation languages (Python) via real syntactic spans; returns `null` for unrecognized languages or sources with syntax errors so callers can fall back to a lexical scan.
- Added a `nohup` shell builtin to the embedded `veyyon_shell`, shadowing the external `/usr/bin/nohup`. It runs its operand command and propagates that command's exit status (and reports `missing operand` / exit 125 with no operand), but deliberately does **not** mask `SIGHUP` or detach the child into a new session the way real `nohup` does. Agents reach for `nohup … &` assuming the shell is one-shot; in this persistent embedded shell that assumption is wrong and the only effect of real `nohup` was to leak background processes that outlived the host. The builtin keeps such commands as ordinary descendants so they are reaped with the host instead of surviving as orphans.

## [15.10.2] - 2026-06-08

### Added

- Added the `super` modifier to `matchesKey` / `parseKey` / `parseKittySequence`. Key identifiers may now include `super+` (anywhere in the modifier prefix), and Kitty CSI-u sequences whose modifier mask contains the super bit (8) — e.g. Ghostty's macOS Option+Backspace `ESC [127;11u` — are now recognised instead of dropped ([#2064](https://github.com/can1357/oh-my-pi/issues/2064)).

### Fixed

- Fixed the native `copyToClipboard` leaving the X11 clipboard empty on Linux even while the process kept running. arboard answers clipboard `SelectionRequest`s from a background thread that lives only as long as a `Clipboard` instance exists, and the binding dropped its transient `Clipboard` immediately after `set_text` — tearing that thread down so the selection lost its owner and the clipboard read back empty (matching the `returned ok but clipboard=''` symptom). The Linux path now holds a single `Clipboard` for the lifetime of the process so the owner thread keeps serving, with no `xclip`/`wl-copy` subprocess; macOS/Windows keep the transient write on the calling thread ([#2075](https://github.com/can1357/oh-my-pi/issues/2075)).

## [15.10.1] - 2026-06-07

### Fixed

- Fixed `applyBashFixups` corrupting commands that contain multi-byte UTF-8 before a trailing `| head`/`| tail` (or `2>&1`). `brush-parser` reports source positions as Unicode-scalar (char) offsets, but `veyyon_shell::fixup` sliced the command `&str` by those numbers as if they were byte offsets, so each multi-byte char (e.g. `✓`/`×` in a `grep -E` pattern) shifted the cut earlier and left a mangled command — e.g. `… |✓|×|XCTAssert" | tail -80` became `… |✓|×-80`, orphaning the closing quote and making the shell reject the whole pipeline with `unterminated double quote`. Positions are now translated to byte offsets before slicing.

## [15.9.0] - 2026-06-04

### Fixed

- Bounded sorted `glob()` scans to `maxResults` during uncached traversal and emitted `onMatch` callbacks only for entries admitted to the bounded top-`maxResults` heap so broad OMP `find` progress and timeout partials stay consistent with the returned mtime-ranked set while keeping parent-process memory bounded ([#1761](https://github.com/can1357/oh-my-pi/issues/1761)).
- Fixed `wrapTextWithAnsi` hanging (infinite loop) on text containing a BEL-terminated string escape — DCS/SOS/PM/APC (`ESC P`/`ESC X`/`ESC ^`/`ESC _`) closed by `BEL` instead of `ST`. `ansi_seq_len_u16` only accepted the `ST` (`ESC \`) terminator for these (OSC already accepted both), so a BEL-terminated APC such as the TUI cursor marker (`ESC _ pi:c BEL`) was left unclassified: it was miscounted as visible width and `break_long_word`'s non-ESC scan could not advance past the `ESC`, spinning forever. The terminator set now matches OSC (ST **or** BEL), and `break_long_word` defensively emits and steps over any escape it cannot classify so a malformed/unknown sequence can never wedge the wrap loop.

## [15.7.0] - 2026-05-31

### Added

- Added `blockRangeAt` native API along with `BlockRange` and `BlockRangeOptions` types to return the 1-indexed line span of the outermost tree-sitter node beginning on a given line

### Fixed

- Fixed an interactive shell inside a **pipeline** (`zsh -i ... | awk`, `time zsh -i | cat`, etc.) suspending the embedded host with `suspended (tty input)`. The earlier embedded-host fix `setsid`-detached external children so they could not seize the host's controlling tty, but carved pipeline stages out because a later stage that `setpgid`-joined a detached leader failed with EPERM — leaving every pipeline stage in the host session, where an interactive child opened `/dev/tty`, `tcsetpgrp`'d itself to the foreground, and stopped the host (OMP) on its next tty read. `veyyon_shell` now detaches pipeline stages too: `child_session_action` returns `DetachSession` for any non-terminal-stdin child regardless of pipeline membership, and `execute_external_command` skips `process_group(...)` entirely for detached children so no cross-session `setpgid` is attempted. Pipeline stages no longer share one process group, which the embedded host does not rely on (cancellation walks the descendant tree and pipes are session-independent).

## [15.6.0] - 2026-05-30

### Changed

- Changed npm publishing to ship `@veyyon/natives` as a small core loader package plus per-platform optional dependency leaf packages, so installs fetch only the host platform's native addon instead of every supported `.node` binary.

## [15.5.10] - 2026-05-28

### Fixed

- Fixed background bash jobs pinning the JS main thread at ~200% CPU when the child process emits output in many tiny writes (printf-style progress, llama-cli token streams). `veyyon_shell`'s pipe reader forwarded every chunk through a separate `ThreadsafeFunction::call` per kernel `read(2)`, so a chatty child produced millions of cross-thread napi callbacks that the JS main thread had to drain serially — even after the child exited, the queue kept the process saturated for seconds. The bridge now greedily coalesces every chunk already in the mpsc queue into a single batched call (capped at 64 KiB) before crossing into JS, collapsing 1-byte writes into one napi dispatch and bringing the steady-state callback rate back to the JS event-loop's throughput.

## [15.5.9] - 2026-05-28

### Changed

- Changed native addon extraction to skip re-extracting cached `.node` files when their size already matches embedded archive metadata
- Changed standalone binaries to embed native addons as a compressed tarball and unpack them into the versioned native cache on first run instead of embedding each `.node` file uncompressed.

### Fixed

- Fixed CI native addon builds retaining ELF debug and symbol sections in release artifacts; stripped builds are now verified to reject `.debug_*`, `.zdebug_*`, `.symtab`, and `.strtab` sections.

### Security

- Hardened embedded addon archive extraction by rejecting unsafe entry names and non-file archive entries before writing binaries to disk

## [15.5.4] - 2026-05-27

### Added

- Added `Hashline` class with methods to format headers, parse/apply hashline edits, split inputs, compute diffs, generate previews, and recover from stale hashes
- Added `HashlineChunker` class to stream UTF-8 text into numbered hashline chunks incrementally
- Added `HashlineCursorKind`, `HashlineEditKind`, and `HashlineTokenKind` exports for hashline cursor/edit/token discrimination
- Added `unfoldUntilLines` and `unfoldLimitLines` options to `SummaryOptions` to control BFS unfold visibility with an optional hard cap

## [15.5.0] - 2026-05-26

### Fixed

- Fixed bash heredocs (`<<`) and here-strings (`<<<`) deadlocking the shell on Windows past ~4 KiB and on macOS past 16-64 KiB. `brush_core::interp::setup_open_file_with_contents` wrote the entire body into an anonymous pipe synchronously before handing the reader to the next command; once the body exceeded the OS pipe buffer the writer blocked forever and the `bash` tool timed out at the hard 305 s ceiling without ever launching the consumer. The Linux fast path still uses `F_SETPIPE_SZ` to grow the pipe in-place; every other OS-threaded platform (and Linux bodies above `pipe-max-size`) now decouples the write onto a fire-and-forget thread that terminates naturally on drain or `BrokenPipe`; no-thread targets keep the upstream synchronous path so heredocs do not fail at thread spawn.

## [15.3.2] - 2026-05-25

### Fixed

- Fixed `matchesKey` claiming `ctrl+m`/`ctrl+j`/`ctrl+i`/`ctrl+h`/`ctrl+[` for the single bytes terminals emit for Enter/Tab/Backspace/Escape in legacy mode. Pressing Enter no longer triggers a `ctrl+m` binding; the named keys now own those bytes and the colliding `ctrl+<letter>` combinations only match when the terminal disambiguates via the Kitty keyboard protocol or `modifyOtherKeys`. The same gate now also applies to `ctrl+alt+<letter>` legacy `ESC + <ctrl-char>` sequences (e.g. `\x1b\r` is Alt+Enter, not Ctrl+Alt+M). ([#1354](https://github.com/can1357/oh-my-pi/issues/1354))

## [15.0.2] - 2026-05-15

### Added

- Added a per-release version sentinel napi export (`__veyyonNativesV{major}_{minor}_{patch}`). The Rust `js_name` is bumped in lock-step with the package version by `scripts/release.ts`; the JS loader computes the expected name from `package.json#version` and throws an actionable error when the on-disk `.node` doesn't expose it. This converts the silent `<sym> is not a function` crash from a stale addon into a load-time failure pointing at the real fix.
- Added `applyBashFixups(command)` — a synchronous brush-parser-driven rewrite that strips trailing `| head|tail …`, redundant `2>&1`, and the `|&` shorthand from top-level pipelines, returning `{ command, stripped }`. Replaces the hand-rolled top-level mask scanner in `pi-coding-agent`; tokenization, quoting, heredocs, command substitution, and nested compound commands are now handled by the real shell AST instead of regex/character-walking. Lives in `veyyon_shell::fixup` on the Rust side.

### Fixed

- Fixed `<sym> is not a function` crashes on Windows after `bun install -g @veyyon/coding-agent` updates while an `omp` process was running. Bun cannot overwrite a locked `node_modules/@veyyon/natives/native/veyyon_natives.win32-x64.node` and silently keeps the old binary alongside the new ESM wrapper, so the next launch loads mismatched code. The loader now mirrors the addon into `~/.veyyon/natives/<version>/` on Windows npm installs and prefers that copy at load time — each version gets its own filesystem path, so future updates land in `node_modules` unchallenged. The new version sentinel detects any remaining drift up front.
- Fixed `$env:NAME` PowerShell references being collapsed to `:NAME` when brush forwarded a command to a PowerShell (or any) subprocess. `veyyon-shell` now defines `env=$env` as a non-exported global on every brush session so the bash parameter expansion of `$env` yields the literal `$env`, leaving `$env:NAME` intact. User-driven assignments (`env=prod`) push their own command-scope binding and shadow the fallback, preserving the bash POSIX contract. ([#1079](https://github.com/can1357/oh-my-pi/issues/1079))

## [15.0.1] - 2026-05-14

### Breaking Changes

- Raised the minimum required Bun runtime version to >=1.3.14
- Removed `PhotonImage` class, `ImageFormat` enum, and `SamplingFilter` enum from native exports. General-purpose image decode/resize/encode now uses [`Bun.Image`](https://bun.com/docs/runtime/image), which ships in Bun 1.3.14+ with statically-linked libjpeg-turbo, libspng, and libwebp plus SIMD geometry kernels — same operations, zero native-addon footprint. `encodeSixel` stays (no Bun equivalent for the SIXEL terminal protocol).
- Removed `webp` Rust workspace dependency along with `PhotonImage`'s WebP encoder.

## [14.9.9] - 2026-05-12

### Breaking Changes

- Removed `projfsOverlayProbe`, `projfsOverlayStart`, and `projfsOverlayStop` overlays APIs and `ProjfsOverlayProbeResult` type from the public natives interface

### Added

- Added unified isolation APIs `isoBackend`, `isoProbe`, `isoResolve`, `isoStart`, `isoStop`, `isoDiff`, and `isoIsUnavailableError` for selecting, probing, resolving, starting, stopping, and diffing isolated filesystems
- Added `IsoBackendKind`, `IsoChangeKind`, `IsoDiff`, `IsoFileChange`, `IsoProbeResult`, and `IsoResolveResult` type exports to describe isolation backend capabilities and diff outcomes

### Changed

- Changed `native` exports to remove the platform-specific ProjFS-only overlay surface in favor of generic isolation controls

## [14.9.5] - 2026-05-12

### Fixed

- Fixed shell cancellation occasionally killing the harness. The `veyyon_shell` descendant tracker harvested every descendant's `pgid` into the kill set, so any subprocess that inherited the harness's pgid (any helper spawned via APIs that do not call `setpgid` — sibling LSP/MCP processes, etc.) dragged `harness.pgid` into the list and the follow-up `kill(-harness.pgid, SIGTERM)` terminated the harness alongside the targets. The classifier now only adopts a `pgid` when its leader is itself one of the new descendants, and `kill_process_group` refuses the harness's own process group as a last-line defense.
- Fixed macOS process-tree termination silently doing nothing. The descendant walk relied on `proc_listchildpids`, which on recent darwin kernels (25.4+) returns no entries when a process queries its own children, so `Process::descendants` came back empty and tree-kill cleanup never reached grandchildren. The walk now builds a one-shot `ppid → [pid]` map from `proc_listallpids` + `proc_pidinfo`, matching the approach already used by `find_by_path` and the Windows Toolhelp path.

### Changed

- Removed the 20 Hz background descendant tracker that scanned the harness's process tree for the entire lifetime of every shell command. Cancellation now does a small rescan-and-signal loop on demand (up to three waves — SIGTERM, then SIGKILL, then SIGKILL — with early exit as soon as no descendants remain). The previous tracker existed to pin process identities against PID reuse races, but `Process::from_pid` already pins identity by kernel start time / pidfd, so the constant scanning paid for nothing and added meaningful syscall load on macOS where each scan now does `proc_listallpids` + `proc_pidinfo` per pid.

## [14.9.3] - 2026-05-10

### Added

- Added `idle`, `system`, and `user` options to `MacOSPowerAssertion` so callers can request specific macOS sleep-prevention modes (`caffeinate -i`, `-s`, and `-u`) in addition to the existing `display` option
- Added support for combining multiple macOS power assertion flags in a single `MacOSPowerAssertion` handle

### Changed

- Changed `MacOSPowerAssertion.stop()` documentation to indicate it releases all held assertions and is safe to call repeatedly as a no-op

## [14.9.2] - 2026-05-10

### Added

- Added `listWorkspace`, a native single-pass workspace walker that returns bounded tree entries and AGENTS.md directory-context candidates together.

## [14.7.1] - 2026-05-06

### Added

- Added `size` property to `GlobMatch` for regular files to expose their byte size

### Changed

- Sped up native `grep` files-with-matches searches by stopping after the first match per file, reading small files without mmap overhead, and relying on grep-searcher binary detection instead of a separate full-file NUL scan.

### Fixed

- Fixed native `grep` `filesWithMatches` mode so `totalMatches` reports the number of matching files rather than line-match totals
- Fixed native `grep` count-mode limits applying to files instead of matches, and restored timeout/abort cancellation checks for small native filesystem scans.

## [14.7.0] - 2026-05-04

### Added

- Added `summarizeCode` function to expose native code summarization with `kind`, `startLine`, `endLine`, and optional `text` segments plus parse/elision metadata
- Added `minBodyLines` and `minCommentLines` options to `summarizeCode` to control when function/body and multiline comment elision is applied
- Added `SummaryOptions` and `SummaryResult` TypeScript definitions for typed `summarizeCode` input and output

## [14.6.1] - 2026-05-02

### Changed

- Changed the native package loader from CommonJS analyzer-visible assignments to a template-rendered ESM entry point with explicit named exports

## [14.5.13] - 2026-05-01

### Changed

- Stopped overriding `CARGO_TARGET_DIR` with an internal `target/napi-build/...` directory during native builds, so Cargo now uses the default or caller-provided target directory
- Simplified native build profile suffix formatting without changing `local` and `ci` values
- Changed the native build output behavior to avoid setting an isolated Cargo target directory automatically

### Removed

- Removed the host Zig CPU contract wrapper (`zig-safe-wrapper.ts`) and its `ZIG`/`PI_NATIVE_REAL_ZIG`/`PI_NATIVE_ZIG_TARGET`/`PI_NATIVE_ZIG_CPU` env handling, since the `zlob` Rust dependency that required Zig is gone
- Removed the `ci-release-verify-natives` script and its AVX-512 marker scan from the release pipeline

## [14.5.12] - 2026-04-30

### Breaking Changes

- Changed `waitForExit` to accept a single options object instead of a numeric timeout argument

### Added

- Added a `signal` option to `terminate` for cancelling termination while waiting for process shutdown
- Added abort `signal` support to `waitForExit` via `ProcessWaitOptions`
- Added a `ProcessWaitOptions` type and updated `waitForExit` to accept an options object

## [14.5.9] - 2026-04-30

### Fixed

- Fixed shell minimizer output so successful commands whose noise is fully stripped still return `OK` instead of an artifact-only result

## [14.5.6] - 2026-04-29

### Added

- Added shell minimizer support for CMake, CTest, Ninja, GoogleTest binaries, and Bun/Bunx wrappers that run those tools

## [14.5.2] - 2026-04-26

### Changed

- Changed local native build profile from `dev` to `local` for non-CI builds, updating the profile used by the build and local build output label

## [14.4.2] - 2026-04-26

### Removed

- Removed the `chunk` napi module (`ChunkState`, chunk schema, chunk rendering, chunk edit) and dropped `generate_chunk_schema()` from the build script

## [14.3.0] - 2026-04-25

### Added

- Added `text` to `MinimizerResult` so consumers can replace rewritten output with the minimized replacement text
- Added `settingsHash` to `MinimizerOptions` to verify the minimizer `settingsPath` contents against a xxHash64 digest before applying them
- Added `minimized` output telemetry via `MinimizerResult` on `ShellExecuteResult` and `ShellRunResult`, exposing the applied minimizer filter and original/minimized byte counts when output is rewritten
- Added a new `minimizer` option to `ShellExecuteOptions` and `ShellOptions` to configure per-command output minimization
- Added the `MinimizerOptions` API with controls for enabling minimization, overriding settings via `settingsPath`, allow/deny lists (`only`, `except`), and `maxCaptureBytes` capture limits

### Changed

- Changed the shell output minimizer to more aggressively compact successful test runs, git output, large listings, grep/find results, source reads, and dependency manifests
- Changed compound and piped shell commands to bypass output minimization entirely, keeping minimization limited to eligible whole-command output after the command exits

### Fixed

- Fixed chunk edit batches so later operations can reuse an initially validated checksum after an earlier operation changes that same chunk

### Removed

- Removed `PI_DEV` loader diagnostic env var and associated console logging in the native addon loader

### Security

- Added trust-gated loading for minimizer settings by requiring a matching `settingsHash` before accepting a settings file

## [14.2.0] - 2026-04-23

### Added

- Added Dart support to `astGrep` and `astEdit` through the native tree-sitter Dart grammar ([#748](https://github.com/can1357/oh-my-pi/pull/748) by [@0fflineuser](https://github.com/0fflineuser))

## [14.1.1] - 2026-04-14

### Added

- Added support for honoring the `ZIG` environment variable when resolving the Zig executable for native builds

### Removed

- Removed the `SearchDb` API from the natives type declarations
- Removed the optional `db` parameter from `fuzzyFind`, `glob`, and `grep`
- Removed the `fuzzyFind`, `glob`, and `grep` cache database argument previously used for search state

## [14.0.5] - 2026-04-11

### Breaking Changes

- Made `tabWidth` parameter required (no longer optional) for `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments`
- Removed `getIndentation`, `getDefaultTabWidth`, and `setDefaultTabWidth` (moved to `@veyyon/utils`)
- `visibleWidth`, `truncateToWidth`, `wrapTextWithAnsi`, `sliceWithWidth`, and `extractSegments` now require an explicit `tabWidth` argument

## [14.0.4] - 2026-04-10

### Added

- Added `normalizeIndent` option to `EditParams` to control indentation normalization for response rendering and inserted content
- Added `hasConflicts()` method to detect unresolved merge conflicts in parsed files
- Added `conflictCount()` method to count unresolved merge conflicts in the chunk tree

## [14.0.2] - 2026-04-09

### Added

- Added `Decl` variant to `ChunkRegion` enum for accessing semantic declarations without leading trivia
- Added `check:types` script for explicit TypeScript type checking
- Added `lint` script for running Biome linter
- Added `fmt` script for code formatting with Biome
- Added package exports field with typed entry point configuration
- Added turbo.json configuration for build task caching and optimization

### Changed

- Renamed `build:native` script to `build` for simpler invocation
- Updated `check` script to separately call `check:types` for type checking
- Modified tsconfig.json to extend `tsconfig.workspace.json` instead of `tsconfig.base.json`

## [14.0.0] - 2026-04-08

### Breaking Changes

- Changed `ChunkRegion.Inner` enum value to `ChunkRegion.Body` to align with region semantics
- Changed `ChunkRegion` enum values from `Container`, `Prologue`, `Body`, `Epilogue` to `Head`, `Inner`, `Tail` with updated semantics for region targeting
- Replaced `ChunkEditOp` enum values — `AppendChild`, `PrependChild`, `AppendSibling`, `PrependSibling`, and `ReplaceBody` are now `Before`, `After`, `Prepend`, and `Append` with updated semantics for region-scoped operations
- Removed `ReplaceBody` operation — use `Replace` with `region: ChunkRegion.Body` to replace only chunk body content
- Moved package entry point from `src/index.ts` to `native/index.js` — consumers must update imports to use the new native module path
- Removed TypeScript source files from `src/` directory — all APIs now exported from auto-generated `native/index.js` with types in `native/index.d.ts`
- Changed enum exports to runtime objects — `const enum` values are now available at runtime via generated enum exports in `native/index.js`

### Added

- Added `ChunkRegion` enum with `Container`, `Prologue`, `Body`, and `Epilogue` values for targeting specific regions within chunks
- Added `region` parameter to `EditOperation` to specify which chunk region to target (defaults to `Container`)
- Added `UnsupportedRegion` status to `ChunkReadStatus` enum to indicate when a chunk does not support the requested region
- Added `normalizeIndent` parameter to `RenderParams` and `ReadRenderParams` to normalize displayed indentation to canonical tabs
- Added `ReplaceBody` chunk edit operation to replace only the inner body of a chunk while preserving signature and closing delimiter
- Added `ChunkFocusMode` enum with `Expanded`, `Collapsed`, and `Container` modes for controlling chunk participation in focus-scoped render passes
- Added `FocusedPath` interface to pair paths with focus modes for the N-API boundary
- Added `focusedPaths` parameter to `RenderParams` to restrict rendering to specified chunks with their focus modes
- Generated native module bindings in `native/index.js` and `native/index.d.ts` from napi-rs build output
- Added `gen-enums.ts` script to extract and export runtime enum values from TypeScript const enums
- Added `embedded-addon.js` for managing embedded native addon variants and metadata
- Added `MacOSPowerAssertion` for session-scoped macOS idle-sleep prevention without shelling out

### Changed

- Changed `ChunkInfo.name` field to optional `identifier` field — now provides bare chunk identifier without kind prefix instead of display name
- Updated `region` parameter documentation in `EditOperation` to clarify full chunk targeting when omitted instead of container-scoped default
- Updated `ChunkEditOp` documentation to reflect region-scoped semantics — operations now target specific regions rather than chunk structure positions
- Changed `ChunkEditOp.Replace` documentation to clarify substring replacement via `find` parameter instead of line-based replacement
- Changed `EditOperation` interface to use `find` parameter for scoped find/replace operations instead of `line` and `endLine` parameters
- Changed `EditParams` documentation to remove mention of scheduling reordering for line-scoped groups
- Simplified native build pipeline by removing `--dev` flag support; debug builds no longer available through npm scripts
- Updated native module loader to check `XDG_DATA_HOME` environment variable for native addon location before falling back to `~/.veyyon/natives`
- Removed native binding validation function that checked for required exports at load time
- Refactored build pipeline to use napi-rs generated bindings instead of hand-written TypeScript wrappers
- Updated `build-native.ts` to generate runtime enum exports after native compilation
- Updated `embed-native.ts` to output JavaScript instead of TypeScript for embedded addon metadata

### Removed

- Removed `dev:native` npm script — use `build:native` for all build scenarios
- Removed inline pi-utils helpers and dependency on `@veyyon/utils` from native module loader
- Removed `logger.time()` wrapper calls from native module loading
- Removed all TypeScript wrapper modules from `src/` directory (appearance, ast, chunk, clipboard, glob, grep, highlight, html, image, keys, projfs, ps, pty, shell, text, work)
- Removed `src/bindings.ts` and `src/index.ts` entry points
- Removed `src/search-db.ts` and `src/search-db-types.ts`

## [13.16.1] - 2026-03-27

### Added

- Exported `SearchDb` class from main package entry point for direct instantiation
- Added `SearchDb` class for stateful shared search database instances to improve performance across multiple search operations
- Added optional `db` parameter to `grep()`, `glob()`, and `fuzzyFind()` functions to enable database-backed searching

### Changed

- Updated `grep()`, `glob()`, and `fuzzyFind()` function signatures to accept optional `db` parameter for database-backed searching

## [13.12.0] - 2026-03-14

### Breaking Changes

- Changed `abort()` method signature: removed optional `reason` parameter and changed return type from `void` to `Promise<void>`

## [13.4.0] - 2026-03-01

### Breaking Changes

- Changed `AstFindOptions.pattern` to `patterns` (now accepts array of strings instead of single string)
- Replaced `AstReplaceOptions.pattern` and `rewrite` with single `rewrites` option (Record<string, string>)

### Added

- `astGrep` now accepts multiple patterns in a single call; results from all patterns are merged and sorted by file path then position before offset/limit are applied
- `astEdit` now accepts a `rewrites` map (`Record<string, string>`) and applies all patterns per file in a single pass, compiling them once upfront
- Result ordering in `astGrep` is now deterministic: sorted by path, line, column using `BTreeSet`/`BTreeMap`

## [13.3.8] - 2026-02-28

### Added

- Added `astFind()` function for structural code search using AST patterns with support for language-specific matching, selectors, and meta-variable extraction
- Added `astReplace()` function for structural code rewriting with dry-run mode, replacement limits, and parse error handling
- Added `./ast` export path for accessing AST search and rewrite functionality

## [12.18.0] - 2026-02-21

### Changed

- Replaced custom `TextDecoder` usage with native `toString('utf-8')` for buffer decoding
- Replaced custom debug logging with structured `logger.time()` calls for startup performance tracking

## [12.17.1] - 2026-02-21

### Added

- Expanded package exports to support subpath imports for clipboard, glob, grep, highlight, html, image, keys, ps, pty, shell, text, and work modules
- Added wildcard export patterns (`./*`) for all submodules to enable flexible import paths

### Changed

- Updated package description to clarify native bindings for grep, clipboard, image processing, syntax highlighting, PTY, and shell operations
- Expanded package keywords to include clipboard, image, pty, shell, and syntax-highlighting for better discoverability
- Added README.md to package distribution files

## [12.10.0] - 2026-02-18

### Changed

- Updated addon filename resolution to include default filename fallback in both modern and baseline variant paths

## [12.8.2] - 2026-02-17

### Breaking Changes

- Removed `getSystemInfo()` and `SystemInfo` from package exports, breaking consumers that imported system info APIs from this package

## [12.8.0] - 2026-02-16

### Added

- Added support for x64 CPU variant selection with `TARGET_VARIANT` environment variable (modern/baseline) during build to optimize for specific ISA levels
- Added automatic AVX2 detection on Linux, macOS, and Windows to select optimal native addon variant at runtime
- Added `PI_NATIVE_VARIANT` environment variable to override CPU variant selection at runtime
- Added support for multiple native addon variants per platform (modern with AVX2, baseline without AVX2) for improved performance portability

### Changed

- Changed native addon filename scheme to include CPU variant suffix for x64 builds (e.g., `veyyon_natives.linux-x64-modern.node`)
- Changed embedded addon structure to support multiple variant files per platform instead of single file
- Changed native addon loader to automatically select appropriate variant based on CPU capabilities or explicit override
- Changed build output to include variant information in console messages

### Removed

- Removed fallback untagged `veyyon_natives.node` binary creation for native builds; platform-tagged variants are now required

### Fixed

- Fixed regex patterns containing literal braces (e.g. `${platform}`) failing with "repetition quantifier expects a valid decimal" by escaping `{`/`}` that don't form valid repetition quantifiers

## [12.5.0] - 2026-02-15

### Added

- Added `recursive` option to `GlobOptions` to control whether simple patterns match recursively (defaults to true)

### Changed

- Changed default glob pattern behavior to always use recursive matching for simple patterns instead of requiring explicit `**/` prefix
- Updated `fileType` filter documentation to clarify that symlinks match file/dir filters based on their target type

## [12.4.0] - 2026-02-14

### Added

- Exported `sanitizeText` function to strip ANSI codes, remove binary garbage, and normalize line endings in text output

## [12.1.0] - 2026-02-13

### Added

- Added `cache` option to `glob()`, `grep()`, and `fuzzyFind()` to enable shared filesystem scan caching
- Added `invalidateFsScanCache()` function to manually invalidate filesystem scan cache entries

## [11.14.0] - 2026-02-12

### Added

- Added `PtySession` class for PTY-backed interactive command execution with streaming output
- Added `PtyStartOptions` interface to configure pseudo-terminal sessions with command, working directory, environment variables, and terminal dimensions
- Added `PtyRunResult` interface to report command exit code, cancellation, and timeout status
- Added `write()` method to send raw input to PTY stdin
- Added `resize()` method to dynamically adjust PTY column and row dimensions
- Added `kill()` method to force-terminate active commands

## [11.3.0] - 2026-02-06

### Added

- OSC 52 fallback for clipboard operations over SSH/mosh connections
- Termux support with `termux-clipboard-set` integration
- Headless environment guards to prevent clipboard errors when no display server is available
- Async clipboard API with improved error handling and fallback strategies

### Changed

- OSC 52 clipboard emission now only occurs in real terminal environments (when stdout is a TTY), preventing unnecessary output in piped or headless contexts
- Improved error handling for OSC 52 writes to gracefully handle EPIPE errors when stdout is closed or piped to processes that exit early
- Clipboard functions now return promises for better async handling
- Native clipboard operations are now best-effort with graceful degradation

## [11.0.0] - 2026-02-05

### Removed

- Removed legacy type aliases `WasmMatch` and `WasmSearchResult`

## [10.6.0] - 2026-02-04

### Changed

- Added separate grep context before/after options in bindings

## [10.2.2] - 2026-02-02

### Added

- Exported `getWorkProfile` function and `WorkProfile` type for work profiling capabilities

## [10.2.0] - 2026-02-02

### Breaking Changes

- Replaced `find()` with `glob()` - update imports and function calls
- Changed file type filtering from string values to `FileType` enum
- Removed `abortShellExecution()` function - use `Shell.abort()` method instead
- Removed `RequestOptions` parameter from `htmlToMarkdown()` - pass options directly

### Added

- Added `glob()` function for file discovery with glob pattern matching and .gitignore support
- Added `Cancellable` interface for timeout and abort signal support across async operations
- Added `FileType` enum to filter glob results by file type (File, Dir, Symlink)
- Added `signal` parameter to shell operations for cancellation via AbortSignal

### Changed

- Renamed `find()` to `glob()` for file discovery operations
- Renamed `FindMatch` to `GlobMatch` and `FindOptions` to `GlobOptions`
- Moved timeout and abort signal handling into unified `Cancellable` interface across grep, glob, and shell modules
- Updated `Shell.abort()` to accept optional abort reason parameter
- Simplified `htmlToMarkdown()` signature by removing `RequestOptions` parameter

### Removed

- Removed `RequestOptions` type and `wrapRequestOptions()` utility function
- Removed `abortShellExecution()` function; use `Shell.abort()` instead
- Removed `executionId` parameter from `ShellExecuteOptions`

## [10.1.0] - 2026-02-01

### Breaking Changes

- Changed `executionId` parameter type from `string` to `number` in `abortShellExecution()` and `ShellExecuteOptions`
- Removed `sessionKey` field from `ShellExecuteOptions`

### Added

- Added `getWorkProfile()` function to retrieve work scheduling profiling data from a circular buffer of recent activity
- Added `WorkProfile` type with folded stack format, markdown summary, SVG flamegraph, and sample metrics for profiling results

## [9.8.0] - 2026-02-01

### Breaking Changes

- Removed `resize()` function; use `PhotonImage.resize()` method instead
- Removed `terminateImageWorker()` function
- Changed `PhotonImage.new_from_byteslice()` to `PhotonImage.parse()`
- Changed `PhotonImage.get_bytes()` to `encode(ImageFormat.PNG, 100)`
- Changed `PhotonImage.get_bytes_jpeg(quality)` to `encode(ImageFormat.JPEG, quality)`
- Removed `get_width()` and `get_height()` methods; use `width` and `height` properties instead
- Removed manual resource management via `free()` and `Symbol.dispose`

### Added

- Added automatic extraction of embedded native addon to `~/.veyyon/natives/<version>` on first run for compiled binaries
- Added `embed:native` build script to embed platform-specific native addon payloads into compiled binaries
- Exported `Shell` class for creating persistent shell sessions with `run()` method and session options
- Exported `ShellOptions`, `ShellRunOptions`, and `ShellRunResult` types for shell session management
- Exported `find()` function for file discovery with glob patterns and .gitignore support
- Exported `FindOptions`, `FindMatch`, and `FindResult` types for file search operations
- Exported `ImageFormat` enum for specifying output formats (PNG, JPEG, WEBP, GIF) in image encoding
- Added `ImageFormat` enum for specifying output format (PNG, JPEG, WEBP, GIF) in `encode()` method
- Added `SamplingFilter` as exported enum instead of object
- Added `Shell` class with persistent session options (`sessionEnv`, `snapshotPath`) and a `run()` command API
- Exported `getSystemInfo()` function and `SystemInfo` type for retrieving system information including distro, kernel, CPU, and disk details
- Exported `copyToClipboard()` and `readImageFromClipboard()` functions for clipboard operations
- Exported `ClipboardImage` type for clipboard image data with MIME type information
- Added `wrapTextWithAnsi()` function to wrap text to a visible width while preserving ANSI escape codes across line breaks
- Added native clipboard helpers for copying text and reading images via arboard

### Changed

- Enhanced native addon loading to prioritize extracted embedded addon for compiled binaries before falling back to system paths
- Improved error messages to provide platform-specific guidance for addon loading failures, including manual download instructions for compiled binaries
- Reorganized native bindings into modular type files with declaration merging via `NativeBindings` interface
- Moved type definitions from implementation files to dedicated `types.ts` modules for better separation of concerns
- Enhanced `SystemInfo` type with additional fields: `os`, `arch`, `hostname`, `shell`, `terminal`, `de`, `wm`, and `gpu`
- Refactored module exports to use direct destructuring from native bindings instead of wrapper functions
- Changed `PhotonImage` API to use instance methods (`resize()`, `encode()`) instead of standalone functions
- Changed `PhotonImage` to use property accessors for `width` and `height` instead of getter methods
- Embedded native addon payload for compiled binaries and extract to `~/.veyyon/natives/<version>` on first run

## [9.7.0] - 2026-02-01

### Added

- Exported `killTree` function to kill a process and all its descendants using platform-native APIs
- Exported `listDescendants` function to list all descendant PIDs of a process
- Added `dev:native` npm script to build debug native binaries with `--dev` flag
- Added `OMP_DEV` environment variable support for loading and debugging development native builds
- Exported keyboard parsing and matching functions: `parseKey`, `parseKittySequence`, `matchesLegacySequence`, and `matchesKey` for terminal input handling
- Exported `KeyEventType` enum and `ParsedKittyResult` type for Kitty keyboard protocol support
- Added `parseKey` function to parse terminal input and return normalized key identifiers (e.g., "ctrl+c", "shift+tab")
- Added `parseKittySequence` function to parse Kitty keyboard protocol sequences with codepoint, modifier, and event type information
- Added `matchesLegacySequence` function to match legacy escape sequences for specific keys
- Added `matchesKey` function to match input against key identifiers with support for modifiers and Kitty protocol

### Changed

- Modified native binary build process to support both debug and release builds via `--dev` flag
- Updated native binary search to prioritize platform-tagged builds and separate debug/release candidates
- Changed debug builds to output to `veyyon_natives.dev.node` instead of mixing with release artifacts
- Improved native binary installation to use atomic rename operations and better fallback handling for Windows DLLs
- Reordered native binary search candidates to prioritize platform-tagged builds and avoid loading stale cross-compiled binaries
- Enhanced cross-compilation detection to prevent installing wrong-platform fallback binaries during cross-compilation builds

### Fixed

- Fixed potential issue where cross-compiled binaries could overwrite platform-specific native builds with incorrect architecture binaries

## [9.6.4] - 2026-02-01

### Breaking Changes

- Changed callback signature for `find()` and `grep()` streaming callbacks to receive `(error, match)` instead of `(match)` for proper error handling

## [9.6.2] - 2026-02-01

### Breaking Changes

- Renamed `EllipsisKind` enum to `Ellipsis`
- Changed `TextInput` type parameter to `string` in `truncateToWidth()`, `visibleWidth()`, `sliceWithWidth()`, and `extractSegments()` functions—Uint8Array is no longer accepted
- Removed `TextInput` type export from public API

### Added

- Added `visibleWidth()` function to measure the visible width of text, excluding ANSI codes

### Changed

- Reordered native module search paths to prioritize repository build artifacts
- Improved JSDoc documentation for `truncateToWidth()` with clearer parameter descriptions and behavior details
- Added early return optimization in `truncateToWidth()` to skip native call when text fits within maxWidth and padding is not requested
- Added early return optimization in `sliceWithWidth()` to return empty result when length is zero or negative

### Removed

- Removed validation checks for `PhotonImage` and `SamplingFilter` native exports
- Removed early return optimization in `truncateToWidth()` when text fits within maxWidth

## [9.6.1] - 2026-02-01

### Added

- Added `matchesKittySequence` function to match Kitty protocol sequences for codepoint and modifier

### Removed

- Removed `visibleWidth` function from text utilities

## [9.6.0] - 2026-02-01

### Added

- Support for cross-compilation via `CARGO_BUILD_TARGET` environment variable
- Support for overriding platform and architecture detection via `TARGET_PLATFORM` and `TARGET_ARCH` environment variables

### Changed

- Native build script now searches for release artifacts in target-specific directories when cross-compiling

## [9.5.0] - 2026-02-01

### Added

- Added `sortByMtime` option to `FindOptions` to sort results by modification time (most recent first) before applying limit
- Added streaming callback support to `grep()` function via optional `onMatch` parameter for real-time match notifications
- Exported `RequestOptions` type for timeout and abort signal configuration across native APIs
- Exported `fuzzyFind` function for fuzzy file path search with gitignore support
- Exported `FuzzyFindOptions`, `FuzzyFindMatch`, and `FuzzyFindResult` types for fuzzy search API
- Added `fuzzyFind` export for fuzzy file path search with gitignore support

### Changed

- Changed `grep()` and `fuzzyFind()` to support timeout and abort signal handling via `RequestOptions`
- Updated `GrepOptions` and `FuzzyFindOptions` to extend `RequestOptions` for consistent timeout/cancellation support
- Refactored `htmlToMarkdown()` to support timeout and abort signal handling

### Removed

- Removed `grepDirect()` function (use `grep()` instead)
- Removed `grepPool()` function (use `grep()` instead)
- Removed `terminate()` export from grep module
- Removed `terminateHtmlWorker` export from html module

### Fixed

- Fixed potential crashes when updating native binaries by using safe copy strategy that avoids overwriting in-memory binaries

## [1.1.0] - 2026-08-20

### Fixed

- `find` no longer crashes the worker thread when its output pipe closes early. Every write on both of `find`'s print paths — `-print`/`-print0` and `-printf` — called `.unwrap()`, so an ordinary truncated pipeline like `find . | head -1` arrived as a BrokenPipe panic on a `tokio-rt-worker` rather than as the write error the matcher already knew how to report. Writes now end the entry quietly, and the error reports that used to be issued alongside them can no longer panic either, since stderr is a pipe too and both ends close together.

## [1.0.47] - 2026-08-13

### Added

- Added the `CpuBudgetGroup` native class and the `cpuBudgetId` option on `Shell.run`, `executeShell`, `PtySession.start`, and `PtySession.startArgv`, backing the coding-agent's per-session CPU limits. A budget group wraps a cgroup v2 directory on Linux, a Windows Job Object with `JOB_OBJECT_CPU_RATE_CONTROL_HARD_CAP`, or a bookkeeping-only group elsewhere; the brush spawn observer and the PTY spawner adopt every spawned child into the named group, and usage, membership, quota rewrite, renice, and teardown are exposed for the session-layer watcher.

### Changed

- Comment prose that credited or dated a chat message is gone from the loader-state fallback note and `ensure-native`; the credit named who reported a defect and never what the code must do. Comments only, so nothing behaves differently.

## [1.0.38] - 2026-07-31

### Changed

- Two search tools stopped walking a tree they cannot match into. A walk-relative glob compiles with `literal_separator(true)`, so `*`, `?` and `[...]` never cross a `/` and a pattern with two segments cannot match anything three components deep. The glob tool bounded its walk on that; `grep --glob 'src/*.ts'` and `astGrep` did not, and traversed every directory in the repository to filter everything below depth two back out. The results were right and the cost was a full traversal, with nothing reporting it. Each tool had hand-assembled the same three steps (normalize the pattern, compile it, choose a depth) and only one of them took the third. `CompiledWalkGlob::compile` is the one entry point now and the depth comes off the compiled glob through `depth_bound()`, so the bound can no longer be measured from a different pattern than the one that was compiled.
- The searcher has one construction site. `SearcherBuilder` has eleven settings and a caller that forgets one gets the library's default without being told, which is how three engines ended up with three different answers to whether a search computes line numbers: nobody wrote `line_number(false)`, so every content search paid for line numbers whether or not it printed any. The three flag vocabularies stay separate, since GNU `grep`, `rg` and the N-API tools spell the same ideas differently on purpose, and all three now translate into one `SearcherSpec` whose defaults are asserted field by field against the library's own.
- The compiled pattern has one owner. The N-API `grep`/`search` tools, the `grep` shell builtin and the `rg` shell builtin had each declared their own `enum CompiledMatcher { Rust(..), Pcre(..) }` and their own copy of the PCRE2 `utf`/`ucp`/`jit` defaults. All three now use `veyyon-grep-kernel`, a plain library crate so the type can be tested and fuzzed at all, which the cdylib addon cannot be. The defaults matter more than the enum: `utf` and `ucp` decide whether `\w` means a word character or an ASCII word character, so two engines that set them differently return different results for the same pattern and neither reports a problem. A differential suite runs 44 pattern/haystack pairs through both engines and asserts the full match offsets agree, since a pattern that the Rust engine rejects falls back to PCRE2 without telling the caller.

### Fixed

- Two shell-builtin search modes reported the wrong answer to a script. `grep -L` and `rg --files-without-match` list the files that did NOT match, so a file that matches produces no output, and both exited 0 for it anyway: success, for a run whose entire output was empty. `if grep -L pattern file; then` is how a script asks the question, and it was getting the opposite boolean. Both now exit 1 when nothing is listed and 0 when something is, which is what GNU grep and ripgrep do. Separately, `rg -q` printed a line: before-context lines are written ahead of the match that selects them, and quiet was missing from the suppression predicate, so `rg -q -C1` wrote one line before stopping. A mode whose whole contract is to print nothing now prints nothing.
- The fresh-HOME cost gate no longer counts Bun's own install cache. It weighed the whole redirected `HOME`, and `$HOME/.bun` is 4.1 MB on a first run because the case points `HOME` at a `bun` process, so the gate failed at 4.4 MB on a clean checkout while reporting that the native addon was being staged. The remedy it named did not work, which is worse than a plain failure. The walk skips `$HOME/.bun` and weighs everything else, including the `$HOME/.veyyon/natives/` a staged addon lands in; veyyon's own first-run footprint measures 644 KB, the bound is 2 MB, and the failure message prints the ten heaviest files so the two causes are distinguishable.
- Text that follows a stray escape introducer is drawn again. The ANSI scanner behind
  `visibleWidth`, `wrapTextWithAnsi`, `truncateToWidth`, `sliceWithWidth` and `extractSegments`
  answered a `CSI` by searching the rest of the line for anything that looked like a terminator, so a
  single `ESC [` left in a program's output made every character up to the next punctuation mark
  measure as zero cells: the text was in the buffer and rendered as nothing. Every branch now follows
  the ECMA-48 grammar and stops at the first byte the grammar does not allow.
- A truncated line no longer prints a stray `0m` and loses its colour reset. When the line was cut
  just after an escape the scanner could not classify, the introducer stayed in the output and
  swallowed the `ESC [ 0 m` that truncation appends, leaving the reset's own characters behind as
  text and letting the colour run into the next row. Escapes that begin no valid sequence are now
  removed once, before measuring or copying, which is what a terminal does with them.
- An overlay drawn over wide text lands in the column it was asked for. `extractSegments` included a
  grapheme that merely started before the overlay column, so a tab or a two-cell character straddling
  that column pushed the overlay to the right and cost a cell of the text after it. A grapheme now has
  to end at or before the column to be part of the segment before it, and the caller pads the gap, the
  same answer strict slicing already gave.
- Fixed the in-process `rm` builtin treating an empty path operand as the shell working directory, so `rm -rf ""` recursively deleted the current directory instead of rejecting the operand. An empty operand reached `veyyon_uutils_ctx::resolve`, which joins `""` onto the cwd and yields the cwd itself; the builtin now rejects empty operands before resolution, matching GNU `rm` (ENOENT, silent under `-f`) and leaving the cwd untouched (Closes #51).

## [1.0.24] - 2026-07-24

### Fixed

- The build and loader no longer silently fall back to a baseline (non-AVX2) build when AVX2 detection fails. The failure is surfaced instead of quietly shipping a slower binary.
- The loader now refuses to embed a native addon built for the wrong version instead of loading it.
- Declared the four new loader-state exports in the TypeScript definitions.

## [1.0.16] - 2026-07-23

### Fixed

- The build now refuses to embed a native addon built for a different version than the package. A `.node` left stale by a version bump (or one CPU variant rebuilt at a different version than another) used to ship inside the compiled binary and then fail to load at first use, bricking the CLI on exactly the machines that selected that variant. That mismatch is now caught at build time with a clear message instead of in your terminal.

## [1.0.14] - 2026-07-23

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [1.0.13] - 2026-07-23

### Removed

- The `snapcompact` native module (`renderSnapcompactPng` and the `snapcompact.rs` crate module) that rendered conversation history to bitmap PNG frames, following removal of the `snap` compaction strategy.
