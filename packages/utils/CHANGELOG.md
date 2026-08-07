# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Added
- `github-check-run`: `classifyGithubCheckRun` reduces a GitHub check-run status and conclusion to one of `success`, `failure`, `running`, `pending` or `unknown`, and `githubIssueRefNumber` reads `#N` out of a bare number or an issue/pull URL. The terminal renderer of the `github` tool and the React one each held their own conclusion tables, and the two had already drifted, so the same queued job read as pending in one view and as an unknown state in the other. `tab-spacing` also says which of its constants crosses the FFI: the display default does, and the min/max bounds stay on the JS side as the `.editorconfig` clamp.
- `dynamicImportSpecifiersIn` and `dynamicImportBindings` in `module-reach`, the deferred-edge twins of `moduleSpecifiersIn` and `namedImportsFrom`. A gate asserting "this module was cut off the static graph but still reaches the capability" can now read the dynamic edge structurally instead of searching the source for `await import("x")`.

- `module-reach`: `typeOnlyModuleSpecifiersIn` reports the specifiers a file imports for TYPES only, alongside the existing `moduleSpecifiersIn` for the ones it imports at runtime. Tests policing a leaf-package boundary were spelling that question as `expect(source).toContain('from "@veyyon/ai"')`, which a runtime import also satisfies, so the check passed in exactly the world it existed to forbid. With both readings available the boundary is asserted as what it is: present in the type-only set, absent from the runtime one.
- `ptree`: `spawn` accepts `onSpawnPid`, called with the fresh child pid immediately after the process exists. The per-session CPU budget needs the pid before the child has done any work in order to move it into the session's cgroup, and every other hook in this module fires too late for that. Around twenty spawn sites across the LSP, DAP, MCP, SSH, fetch and RPC paths already pass it.
- `dirs`: a comment referenced `scripts/find-test-leaks.ts`, which moved to `scripts/test-sandbox/find-test-leaks.ts` when the test-sandbox tooling was consolidated.
- `semver`: `RELEASE_VERSION_BODY` is the `X.Y.Z` grammar as unanchored source text, for patterns that embed a version rather than matching one whole. A changelog version heading is that grammar inside `## [...]`, and the four hand-written copies of it on the release path had drifted: two accepted `01.2.3`, which no tag can match, and the gate that decides whether a version is documented accepted an undated heading while the cleanup that deletes hollow sections required a date, so an empty section could satisfy the gate and survive the cleanup at the same time.
- `dirs`: `resolveGlobalOnboardingVersion`, `readGlobalOnboardingVersionSafe` and `writeGlobalOnboardingVersion` read and write the setup generation in the cross-profile `~/.veyyon/config.yml`, so onboarding state belongs to the machine rather than to whichever profile happened to be active. The safe reader reports unreadable separately from absent, because for onboarding those two must not collapse into the same number: a file that cannot be read is not a fresh install, and treating it as one is what re-ran the setup wizard on every launch.
- `dirs`: `readLegacyProfileSetupVersion` reports the highest retired per-profile `setupVersion` found across every profile on the machine, so a caller promoting that value into the machine-wide record does not have to guess which profile happens to be active. A profile with no config contributes nothing; a profile whose config exists but cannot be read is reported as unreadable rather than silently skipped, since skipping it would let a promotion conclude "never onboarded" from a file it simply failed to open.
- `dirs`: `getGlobalConfigFilePath` names the global config file a write would actually target, following the same precedence the reader uses, so a message about a failed save cannot send you to a file veyyon is ignoring.
- `semver`: `isReleaseVersion` and `isReleaseTag` answer whether a string is a version this project is willing to release, meaning exactly `X.Y.Z` with no prerelease and no build suffix. `isValidSemver` cannot answer that question because it accepts `1.2.3-rc.1` by design, and the release path has no prerelease handling, so a suffix produces artifacts that do not match the tag. They replace four hand-written regexes that had already drifted: the release CLI's front door accepted `01.2.3` while a gate later in the same file rejected it as not strict semver, and the tag gate threw "is not strict vX.Y.Z semver" while testing a pattern that accepts `v01.2.3`. When two checks share a name and not a definition, the one you read is not the one that runs.

### Fixed

- `fetch-retry`: an HTTP/2 stream or session reset is now classified by the RFC 7540 error code it names instead of by whatever the surrounding prose happens to read like. `isRetryableError` only recognised the phrase "internal error" with a literal space, so Node's `Stream closed with error code NGHTTP2_INTERNAL_ERROR` matched nothing and a lost stream became a hard failure with no retry. `http2ErrorCode` and `http2RetryVerdict` are exported so the session layer classifies the same reset the same way: `NO_ERROR`, `PROTOCOL_ERROR`, `INTERNAL_ERROR`, `SETTINGS_TIMEOUT`, `STREAM_CLOSED`, `REFUSED_STREAM`, `CONNECT_ERROR` and `ENHANCE_YOUR_CALM` are retried, while `CANCEL`, `FLOW_CONTROL_ERROR`, `FRAME_SIZE_ERROR`, `COMPRESSION_ERROR`, `INADEQUATE_SECURITY` and `HTTP_1_1_REQUIRED` stay hard. A named code wins over the wording heuristics, because those would otherwise retry a `CANCEL` our own side asked for. A `GOAWAY` that closed the session before the stream existed is retried too, since nothing was processed.
- `dirs`: `getMCPConfigPath` takes an optional agent dir, defaulting to the active profile. The user-scope path was pinned to whichever profile the process booted with, so a caller loading MCP configuration on behalf of another profile read that profile's server list out of one file and its disable list out of another, and a server the operator had switched off came back.
- `dirs`: a global config write can no longer destroy the file it is updating. `mutateGlobalConfigKey` read the existing config with a bare `try { readFileSync } catch { continue; }`, so any error that was not a missing file left the parsed record empty, and the read-modify-write then emitted a file holding ONLY the key being written. One transient `EACCES`, `EMFILE` or `EIO` was enough to take `defaultProfile`, `profileSharing`, `onboardingVersion` and the stored auth-broker token with it. The reader already distinguished a missing file from an unreadable one and retried; both now share that single helper, so a candidate that is present but unreadable aborts the mutation instead of truncating the file.
- `dirs`: an empty or malformed global config reads as unknown rather than as a fresh install. A zero-byte `config.yml`, or one holding a scalar or a list, parsed to an empty record indistinguishable from no config at all, which re-ran the setup wizard on a machine that had been set up years ago. It is a state veyyon can reach on its own, since a config emptied of its last key writes an empty file when it cannot unlink one. `readGlobalOnboardingVersionSafe` now reports it as unreadable and keeps absent for a genuinely missing file.
- `dirs`: an unusable `config.yml` no longer permanently hides a valid `config.yaml`. The reader returned at the first candidate that existed, whatever it contained, so an empty file at the higher-precedence name shadowed a populated one with no error and no way to notice. A candidate that parses to a map now wins; precedence between the two names is otherwise unchanged and they are still never merged.
- `file-lock`: a lock abandoned by a killed process is claimed in the attempt that proves it dead, instead of the one after. A dead owner was reaped at the end of an acquire and only taken by the next retry, so recovery always cost a full retry delay and a single-attempt acquire failed outright against a lock whose owner no longer existed. Measured against a real `SIGKILL`, recovery goes from 104ms to 2ms. Who may remove a lock is unchanged, so this shortens the wait without widening the authority: a lock whose owner is alive is still refused, and a torn directory still waits out its grace period so a live creator mid-publication is not robbed.
- `dirs`: the error you get for an absolute `VEYYON_CONFIG_DIR` no longer sends you to a variable that does nothing. It told you to use the XDG variables to move the config root onto another volume and named `XDG_CONFIG_HOME` first, but nothing reads `XDG_CONFIG_HOME`: the resolver knows only data, state and cache, and the config root is always `<home>/<VEYYON_CONFIG_DIR>`. Following the advice moved nothing and reported nothing. The message now names only routes that work, and the doc comment on `XDG_BASE_ENV_KEYS`, which claimed the resolver read the variable through some other path, says the truth instead. The key stays in that list because `XDG_CONFIG_HOME` does still decide where the profile alias and the shell completions are written, which is what the list is for. Honouring it as the config root was considered and rejected on purpose: it is set on most Linux desktops, so reading it would relocate the profiles, credentials, onboarding record and auth-broker token of every existing user at once and present veyyon as a fresh install. A test pins that, with the reasoning, so it is not later mistaken for an oversight.

### Breaking Changes

- `VEYYON_CONFIG_DIR` is a PATH to the config root, not a name hung off your home, and a value that resolves back INSIDE your home is refused. The rule was exactly backwards: a bare name like `.veyyon-mysuite` was accepted and silently created a real directory in the real home, because assigning `process.env.HOME` does not move `os.homedir()` under Bun, so every suite that "isolated" itself that way was writing to the operator's home — 136 such directories accumulated in one; meanwhile an absolute path, the one spelling that could not land in the home, was the one spelling refused. Now an absolute path is taken as written (`/srv/veyyon` is `/srv/veyyon`, not `~/srv/veyyon`), a relative value still resolves against the home so `path.relative(os.homedir(), tempRoot)` keeps working, and any destination under the home throws with the path it resolved to unless `VEYYON_TEST_SANDBOX` says the home is the test sandbox's disposable one. A value written as an absolute path for the other platform (`C:\veyyon`) is still refused, since it would be resolved as a relative name and create a directory whose name contains a path separator. New `getConfigRootOverride()` returns the resolved root; `getConfigDirName()` now derives its answer from that root as a home-RELATIVE path, so every caller that joins it onto a home rebuilds the same location.
- `dir-env-keys`: added `SANDBOX_MARKER_ENV_KEY` (`VEYYON_TEST_SANDBOX`). It is deliberately absent from `DIR_OVERRIDE_ENV_KEYS` and `DIR_LOCATION_ENV_KEYS`: a test that strips directory overrides out of a child's environment must not strip the child's proof that it is sandboxed, and a `$HOME/.env` must never be able to grant it.

### Removed

- `dirs`: dropped five directory helpers that no code in the repository called — `getCommandsDir`, `getAgentModulesDir`, `getProjectModulesDir`, `getCrashLogPath` and `getAutoresearchRunDir`. Each described a layout the product does not actually maintain: nothing has ever written `veyyon-crash.log`, and autoresearch stores a run under the per-project database rather than a `runs/<id>` directory. A path helper with no writer is worse than no helper, because the next caller takes it as evidence the directory is real.
- `mime`: dropped `readImageMetadataSync`. Nothing called it, and the async `readImageMetadata` beside it serves every real consumer (the read tool, file mentions, the CLI file processor). A synchronous file read sitting next to the async one it duplicates is an invitation to block an event loop for no reason; `peekFileSync` is untouched, since `binary.ts` still needs it.

## [16.5.2] - 2026-07-14

### Fixed

- Improved CLI argument and flag validation error output to display a concise error message and command usage instead of a minified code frame.
- Corrected required variadic positionals to render as `MODELS...` instead of `[MODELS]` in usage help.

## [16.5.1] - 2026-07-14

### Added

- Added terminal stderr guard utilities (suppressTerminalStderr and restoreTerminalStderr) to prevent macOS runtime diagnostics from corrupting TUI viewports while ensuring crash reports remain visible.

### Fixed

- Fixed an issue in Mermaid ASCII routing where unreachable edge attachment points caused unbounded pathfinder searches.

## [16.4.6] - 2026-07-12

### Added

- Added `AsyncDrain`, the deferred write-batching helper previously private to the coding-agent's prompt-history storage; now shared with model-perf recording.

## [16.4.2] - 2026-07-10

### Added

- Added `stringifyJson` utility with support for BigInt serialization.

## [16.3.12] - 2026-07-08

### Added

- Added `postmortem.interceptUnhandledRejections()` to register interceptors consulted before an unhandled rejection tears the process down; a consuming interceptor (e.g. the JS eval runtime claiming rejections floated by user cell code) keeps the process alive and owns reporting.

### Fixed

- Fixed child shell environment filtering to drop launch-directory `.env.local` values that Bun auto-loaded before OMP starts command shells. ([#4723](https://github.com/can1357/oh-my-pi/issues/4723))

## [16.3.10] - 2026-07-06

### Added

- Added `postmortem.markExpectedCleanupError()` / `postmortem.isExpectedCleanupError()` to tag errors thrown by routine resource teardown; the global `uncaughtException`/`unhandledRejection` handlers downgrade marked errors (walking the `cause` chain) to warnings instead of exiting the process.

### Fixed

- Bounded postmortem cleanup with a 10s deadline so a hanging cleanup callback can no longer wedge the process indefinitely after a fatal error or signal; the process now always reaches `process.exit`.

## [16.3.7] - 2026-07-05

### Added

- Added `classifyJsonPrefix`, a strict RFC 8259 streaming-buffer classifier (`"complete" | "prefix" | "invalid"`). Providers use it to disambiguate identifierless streaming tool-call deltas: a `{`-prefixed chunk only advances to a sibling call when the current argument buffer cannot absorb it.

## [16.3.1] - 2026-07-02

### Fixed

- Fixed `parseJsonWithRepair` failing tool calls whose streamed arguments contain an unquoted string value (e.g. `{"paths": packages/foo/*, "i": "…"}`). Final parsing now recovers such barewords in object/array value position as strings, terminating at `,` / `}` / `]` / newline. Recovery deliberately refuses anything that could mask real structure or bad data — truncated values, tokens containing `"` / `{` / `[` or a key-like `:` (URL `://` and Windows `:\` colons stay literal), and non-finite atoms (`NaN`, `Infinity`, `undefined`) — and streaming partial parses still roll back unfinished barewords instead of committing them.

## [16.3.0] - 2026-07-02

### Added

- Added `wrapFetchForExtraCa` and `withExtraCaFetch` utility functions to apply `NODE_EXTRA_CA_CERTS` to Bun's `RequestInit.tls.ca` configuration.

## [16.2.9] - 2026-06-30

### Added

- Improved resilience in `fetchWithRetry()` by adding a response-body retry gate to handle deterministic provider failures that return retryable HTTP statuses.

### Fixed

- Fixed YAML frontmatter parsing for skill descriptions containing unquoted colons (`: `), ensuring typed fields are correctly preserved without triggering unnecessary warnings.

## [16.2.7] - 2026-06-30

### Added

- Added a utility to detect binary files based on content sniffing.

## [16.2.6] - 2026-06-29

### Added

- Added `stripWindowsExtendedLengthPathPrefix()` utility to normalize `\\?\` and native Win32 path prefixes before Bun import or spawn calls.

## [16.2.3] - 2026-06-28

### Added

- Added `escapeXmlAttribute` utility function for safe XML attribute value encoding.

### Fixed

- Fixed a crash in `ptree.ChildProcess.bytes()` and the `ssh://` read path when handling large subprocess outputs (over 128 KB) under Bun by ensuring it consistently returns a `Uint8Array`.

## [16.2.0] - 2026-06-27

### Added

- Added a relaxed JSON parser supporting single-quoted strings, unquoted keys, and comments.
- Added `parseStreamingJson` and `parseStreamingJsonThrottled` for robust, efficient parsing of truncated or incremental streaming JSON.
- Added an XDG-aware document conversion cache directory helper.
- Exported `removeWithRetries()` as a standalone asynchronous function to handle retry-on-EBUSY cleanup logic.

### Changed

- Improved `readSseJson` to gracefully recover truncated or malformed final events using the streaming JSON parser, ending the stream cleanly instead of throwing.
- Increased the retry delay for EBUSY file-lock errors from 25ms to 50ms (extending the total retry window to 2 seconds) to improve reliability on Windows.

## [16.1.8] - 2026-06-20

### Added

- Exported `removeSyncWithRetries()` as a standalone function so tests that manage their own temp dirs can use the same retry-on-EBUSY cleanup logic as `TempDir.removeSync()`.

## [16.1.3] - 2026-06-19

### Changed

- Expanded the `TempDir` Windows retry window from 4×10ms to 40×25ms (1s total) to accommodate SQLite WAL/SHM file handle release delays

### Fixed

- Made EPIPE rejections from IPC `send()` to worker subprocesses (`syscall: "send"`) non-fatal: the global `unhandledRejection` handler now logs and continues instead of terminating the session when an optional subsystem's pipe breaks. A broken optional subsystem (TTS/STT/tiny-title/MCP) can no longer crash the whole agent session mid-task. ([#2997](https://github.com/can1357/oh-my-pi/issues/2997))

## [16.1.2] - 2026-06-19

### Added

- Added `directoryExists(dir)` to `dirs`: resolves whether a path is an existing directory, returning `false` on any stat failure (ENOENT, permission, non-directory). Lets callers check a directory is safe to `chdir` into before `setProjectDir` throws.

### Removed

- Removed the public `createAbortableStream` API from `@veyyon/utils`. Consumers should use the lighter, direct-reader `abortableSource` async generator inside `@veyyon/utils/stream` to avoid the extra ReadableStream wrapper layer and per-chunk enqueue overhead.

## [16.0.11] - 2026-06-19

### Removed

- Removed `getIndentation`, `setDefaultTabWidth`, and `getDefaultTabWidth` helpers

## [16.0.8] - 2026-06-18

### Changed

- Mermaid diagrams are now rendered to ASCII by a first-party vendored renderer (`src/vendor/mermaid-ascii`, derived from the MIT-licensed `beautiful-mermaid`, ASCII pipeline only) with terminal display width measured via `Bun.stringWidth` (grapheme-aware, correct for wide/East-Asian glyphs and emoji). Inline label formatting (HTML formatting tags and markdown emphasis) is now reduced to plain text instead of printed raw.

### Removed

- Removed the external `beautiful-mermaid` dependency (and its transitive `elkjs`, ~3.13MB) in favor of the vendored ASCII renderer.

## [16.0.3] - 2026-06-16

### Added

- Added `escapeXmlText` utility to escape XML-significant characters `&`, `<`, and `>` in element body text
- Added `isTerminalHeadless()` / `setTerminalHeadless()` to centrally suppress real-terminal side effects (stdout escape/frame writes, stdin raw mode, CSI/OSC capability probes, SIGWINCH, window-title changes, emergency restore) under the test runtime. Defaults on when `bun test` sets `NODE_ENV=test`; terminal-contract tests opt out via `setTerminalHeadless(false)`

## [15.13.3] - 2026-06-15

### Added

- Added `installWorkerInbox(port)` / `consumeWorkerInbox()` to `@veyyon/utils/worker-host`. A self-dispatching CLI host that imports a Bun worker module dynamically attaches the worker's real `message` listener after Bun flushes the messages the parent posted before spawn, dropping a synchronously-posted `init`. The host installs this buffering inbox synchronously in the entry's sync prefix so a listener exists at flush time; the worker module consumes it and binds the real handler, replaying anything buffered.

## [15.13.1] - 2026-06-15

### Added

- Added profile-aware directory helpers and isolated profile state roots, while keeping the install ID shared across profiles.
- Added a named-profile API to the `dirs` module — `setProfile()`, `getActiveProfile()`, `getProfileRootDir()`, and `normalizeProfileName()` — plus `resolveProfileEnv()`, which selects the active profile from `OMP_PROFILE` (canonical; takes precedence) then `PI_PROFILE` (legacy fallback, consulted only when `OMP_PROFILE` is unset).
- Added support for a runtime `overrides` map in `RuntimeInstallSpec`, which is now written into generated runtime `package.json` manifests to force dependency pins (including transitive ones) across the runtime tree
- Added a lightweight loop-phase breadcrumb stack (`pushLoopPhase`/`popLoopPhase`/`currentLoopPhase`, plus `takeRecentLoopPhase` which returns the live phase or the most recently popped one and clears it) so the TUI event-loop watchdog can attribute a main-thread block to the phase that caused it — including a synchronous phase already popped before the watchdog's delayed tick runs ([#2485](https://github.com/can1357/oh-my-pi/issues/2485))
- Added `FetchWithRetryOptions.timeout` (forwarded to the underlying `fetch` call). `false` disables Bun's native ~300s pre-response timeout; a positive number overrides the ceiling. Bare browser/Node fetch ignores it ([#2422](https://github.com/can1357/oh-my-pi/issues/2422))
- Added the side-effect-free `@veyyon/utils/worker-host` module (`declareWorkerHostEntry()` / `workerHostEntry()`), extracted from `env` (still re-exported there) so worker spawn sites can resolve the self-dispatching CLI host entry without importing `env`'s side-effecting module graph.

### Fixed

- Fixed profile directory isolation when a profile's agent `.env` customizes directory roots: directory-affecting keys (`XDG_DATA_HOME`/`XDG_STATE_HOME`/`XDG_CACHE_HOME`, and a default-mode `PI_CODING_AGENT_DIR`) are now honored. The `env` loader rebuilds the `dirs` resolver after applying `.env` files (`refreshDirsFromEnv()`), so a profile `.env` that points XDG roots elsewhere no longer leaks state into the home-based config dir.
- Made `TempDir` cleanup retry transient Windows `EBUSY`/`EPERM`/`ENOTEMPTY` removal failures so tests are less likely to fail when deleting just-used temp directories.
- Fixed `installRuntimeModuleResolver()` to keep bare requests from runtime-cache modules inside that registered runtime before falling back to host/workspace packages.

## [15.12.4] - 2026-06-13

### Fixed

- Fixed abortable stream wrappers to cancel the source stream on abort, so timeout watchdogs release upstream HTTP bodies instead of only stopping the local reader.

## [15.12.0] - 2026-06-12

### Added

- Added `runtime-install`: shared on-demand runtime dependency support — `ensureRuntimeInstalled()` (locked, idempotent `bun install` of a pinned dependency set into a cache dir) and a multi-root `installRuntimeModuleResolver()`/`resolveRuntimeModule()` for loading those graphs inside compiled binaries (Bun #1763). Extracted from the coding-agent tiny-model worker; now also backs Mnemopi's on-demand fastembed runtime ([#2389](https://github.com/can1357/oh-my-pi/issues/2389))
- Added `getFastembedRuntimeDir()` (~/.veyyon/cache/fastembed-runtime) alongside `getFastembedCacheDir()`

## [15.11.4] - 2026-06-12

### Added

- Added `getEditorConfigFormatting(file)`: returns the `.editorconfig`-pinned `tabSize`/`insertSpaces` (both optional, no fallback) so LSP-format callers can layer per-file defaults under it without paving over silence with the renderer's display tab width ([#2329](https://github.com/can1357/oh-my-pi/issues/2329)).

## [15.11.3] - 2026-06-11

### Added

- Added `getEditorConfigFormatting(file)`: returns the `.editorconfig`-pinned `tabSize`/`insertSpaces` (both optional, no fallback) so LSP-format callers can layer per-file defaults under it without paving over silence with the renderer's display tab width ([#2329](https://github.com/can1357/oh-my-pi/issues/2329)).

## [15.11.1] - 2026-06-11

### Fixed

- Fixed cleanup reentry noise during fatal shutdown: recursive cleanup requests now no-op idempotently instead of logging repeated `Cleanup invoked recursively` errors ([#2284](https://github.com/can1357/oh-my-pi/issues/2284)).

## [15.11.0] - 2026-06-10

### Added

- Added the `path-tree` module (`buildPathTree`, `walkPathTree`, `formatGroupedPaths`, `isUrlLikePath`), moved from the coding agent's grouped file output so compaction file lists can share the same prefix-folded directory-tree rendering; `formatGroupedPaths` gains an optional `annotate` callback for per-file suffixes

### Fixed

- Fixed the `{{join}}` prompt helper joining with a literal two-character `\n` when templates pass `"\n"` as the separator — Handlebars string literals carry no escape processing. The separator now unescapes `\n`/`\t`, matching the `{{#list}}` helper's documented convention (visible as literal `\n` between paths in compaction `<read-files>` lists).

## [15.10.11] - 2026-06-10

### Added

- Restored `PI_DEBUG_STARTUP` streaming startup markers: `logger.time` now writes a synchronous `[startup] <op>:start` / `:done` / `:fail` stderr line per phase (independent of `PI_TIMING`), so a startup that hangs hard still names the phase it is stuck in — the `PI_TIMING` tree only prints after startup completes and is structurally unable to diagnose a hang. The CLI runner emits `cli:load:<name>` markers around each lazily-imported command module for the same reason.
- Added `logger.openSpanPath()`: ops of the currently-open timing-span chain (root → deepest), used by the coding agent's startup watchdog to name the in-flight phase of a stalled startup.
- Added `declareWorkerHostEntry()` / `workerHostEntry()` (env): self-dispatching CLI entrypoints declare `Bun.main` as the worker host so worker spawn sites can re-enter the single entry module with `WorkerOptions.argv` selectors across source, npm-bundle, and compiled distributions

### Changed

- Changed `prompt.compile()` to cache compiled templates by the raw template string so repeated calls reuse the same compiled function without re-disambiguating
- `Snowflake.formatParts` packs the id as a single 64-bit BigInt hex format instead of stitching four 16-bit segments (simpler and ~1.7x faster), and `getTimestamp` extracts via exact double arithmetic instead of a BigInt round-trip. Output is bit-identical.
- Logger initialization is lazy: the winston logger, file transport, and log-directory creation now happen on first log emission instead of at module import (the import previously cost ~8ms of fs work on the CLI startup path); the in-memory timing infrastructure never touches winston
- `prompt.format()` post-processing got cheap per-line guards and a single-pass ASCII-symbol replacement (was 7 chained regex passes per line), roughly halving render post-processing cost; output is byte-identical

### Fixed

- Fixed `prompt.format()` so ASCII symbol replacements such as `-->` and `!=` still run on lines containing a closing HTML comment token when not inside a comment
- `isCompiledBinary()` now also honors a define-folded `process.env.VEYYON_COMPILED` (only `Bun.env` was checked), so builds that constant-fold `process.env` keep compiled-binary detection without relying on `import.meta.url` bunfs markers
- `omp <cmd> --help` now loads only the requested command module instead of the entire command table, so an unrelated command whose import graph hangs or crashes can no longer take down every per-command help invocation.

## [15.10.8] - 2026-06-09

### Removed

- Removed the exported `hookFetch` API, which previously intercepted `globalThis.fetch` via middleware handlers
- Removed `hookFetch` from the package entrypoint, so imports from `@.../utils` no longer provide this fetch interception helper

## [15.10.0] - 2026-06-06

### Changed

- `logger.printTimings()` (the `PI_TIMING` startup tree) now surfaces two previously-invisible regions: a `(before instrumentation)` line for runtime init / uncaptured pre-marker work, and an `(unattributed self)` line for the root span's own untimed work so the gap between visible top-level spans and `Total` is no longer swallowed. `Total` is now labelled `(since first marker)` to make the window explicit. The restored `module-timer.ts` preload can feed module spans into the report: each module records `onLoad` → final top-level marker as `total`, a prepended body marker → final marker as `body/TLA`, and resolved static imports as a bounded dependency tree so the report separates graph wait from actual top-level module work.

## [15.9.2] - 2026-06-05

### Added

- Added `getAuthBrokerSnapshotCachePath()` with `OMP_AUTH_BROKER_SNAPSHOT_CACHE` override support for isolating the encrypted broker snapshot cache.

## [15.9.1] - 2026-06-04

### Fixed

- Hardened `getIndentation` against malformed paths: any filesystem error from the `.editorconfig` probe (e.g. `ENAMETOOLONG` on oversized garbage path segments) is now swallowed and cached as a miss instead of escaping and crashing the TUI mid-render ([#1871](https://github.com/can1357/oh-my-pi/issues/1871)).
- Fixed `getIndentation` (and the edit renderer's `replaceTabs` callers) crashing with `ENAMETOOLONG`/`ENOTDIR`/etc. when handed a path with an overlong component or a non-directory in its parent chain. Editorconfig discovery now short-circuits to the default tab width on any path component above `NAME_MAX` (255 bytes) and absorbs any `FsError` while walking the editorconfig chain — best-effort discovery must never escape as an uncaught exception ([#1872](https://github.com/can1357/oh-my-pi/issues/1872)).

## [15.9.0] - 2026-06-04

### Added

- Added color helpers `colorLuma` (perceptual luma), `relativeLuminance` (WCAG, linearized sRGB), and `hslToHex` to the color utilities. The luminance helpers parse `#rgb`/`#rrggbb` hex and 256-color palette indices, returning `undefined` for unparseable values.
- Added `peekFileEnds`, a single-open head-and-tail file peek helper that reuses the head bytes for the tail when the file fits the head window.
- Added `peekFileTail`, the tail mirror of `peekFile`: reads up to the last `maxBytes` of a file ending at EOF, reusing the same pooled-buffer strategy (no per-call allocation for small reads).

## [15.7.3] - 2026-05-31

### Added

- Added `getFastembedCacheDir` to return the FastEmbed model cache directory under ~/.veyyon/cache/fastembed

### Fixed

- Fixed `$flag` environment parsing to accept lowercase truthy values such as `y`, `true`, `yes`, and `on`

## [15.6.0] - 2026-05-30

### Added

- Added an XDG-aware tiny-title model cache directory helper for coding-agent local title models.

## [1.0.39] - 2026-08-01

### Fixed

- Process cancellation results now keep `exitCode` at `null` when the operating system reports a
  signal-derived status such as `143`. You can distinguish an intentional abort from an ordinary
  child process that exits with the same numeric code on every supported host.

## [1.0.38] - 2026-07-31

### Added

- `string-length.ts` owns two more measurements beside `codePointLength`: `utf8ByteLength(value,
  start?, end?)`, the number of bytes a string encodes to (optionally over a code-unit range, so a
  caller rewriting a long string can measure a span without allocating it), and
  `isWellFormedUtf16(value)`, whether every surrogate in it is part of a pair. Both were private
  helpers inside an 1,800-line secrets module in `@veyyon/coding-agent`, and `isWellFormedUtf16` had
  a second copy in the module next door. Neither is about secrets: one is the size a string takes on
  the wire and the other is whether it survives being encoded at all. Both are used as security
  bounds, so both are now tested differentially against `TextEncoder` and
  `String.prototype.isWellFormed`.
- `formatMoreLines(count)` in `format.ts`, the one owner of the "N more lines" phrase every collapsed
  block prints. Nineteen surfaces wrote it inline, so all nineteen said "1 more lines" whenever a fold
  hid exactly one line. It returns the counted phrase only, without the ellipsis or the expand hint,
  because callers frame it differently.
- `pathExists(target, what)` in `fs-optional.ts`: the async answer to "is it there". It replaces `fs.existsSync` at call sites inside an `async` function, where the synchronous version stops the event loop for the length of a stat and the probes are usually sequential, so the cost multiplies by however many paths are checked in a row. It also reports what `existsSync` cannot: a path that exists and cannot be stat'd answers `false` there, making a permissions problem indistinguishable from absence, and this logs the path and the reason before answering.
- `definePromptRegistry(dir, rows)` builds a package's prompt registry, and the descriptor it returns is what consumers take: `dir`, `prompts`, `ids`, `text(id)`, `require(id)`, `has(id)` and `fileFor(id)`. Each registry had hand-written the same three derivations (`Object.keys(...) as Id[]`, a text lookup, a refusing lookup with its directory as a literal), and the directory was then restated by every consumer that needed it: `veyyon prompt`'s table of registries, the coverage suite's owner list, its CLI counterpart, and the generated prompt inventory. Four copies of one fact, none checked against the others, and the inventory's had already gone stale: it listed three directories under a doc comment claiming one per package that owns prompts, so two packages' prompts were outside the inventory's scope entirely and "no template exists without a module that renders it" was true only of the directories it happened to know about. A registry now says where it lives once. `PromptRegistryView` is the same surface without the statically-known ids, because `text(id: keyof T & string)` makes the parameter contravariant and a list of every registry would not otherwise typecheck.
- `JsonValue` and `JsonPrimitive` have one declaration, in `json.ts`, beside the JSON helpers. They had been written out five times across the repository: three times inside `@veyyon/mnemopi` alone, plus `@veyyon/tui`'s render harness and a laxer variant in the coding agent's secret obfuscator. Four of the five were identical and the scalar was spelled `JsonScalar` in one place and `JsonPrimitive` in three others for the same type, so a reader comparing two modules had to read both definitions to learn that they agreed. `JsonValue` is strict: an object's values are `JsonValue` and never `undefined`, because `undefined` is not JSON and `JSON.stringify` drops the property rather than encoding it.
- `PromptEntry` and `PromptSection` have one declaration, in `prompt-registry.ts`, and `requirePromptFrom` is the one lookup that refuses an unknown prompt id. The row type was declared twice, and the two copies had already diverged: `@veyyon/agent-core`'s had no `sections` field, so whether a prompt could describe how it divides depended on which registry happened to hold it. The lookup existed in one registry and not the others, where a caller holding an id in a variable indexed the table directly, so a drifted id yielded `undefined` and `.text` on it reached the model as no instructions at all: nothing throws on that path, the model still replies, and the missing brief reads as the model ignoring one. `requirePromptFrom` throws instead, names the directory ids come from, and quotes the nearest registered id, and it uses `Object.hasOwn` rather than a plain index, because `registry["toString"]` finds `Object.prototype.toString` and hands back a truthy function where a row belonged.
- Added `fs-optional.ts`: `readdirIfPresent(dir, what)` and `statIfPresent(path, what)`, for a filesystem read whose subject is allowed to be absent. A missing path is silent, because that is the ordinary state of every optional config directory and a warning there would print a line per probe. Any other failure is logged with the path and a phrase naming what the caller was looking for, then the empty answer is returned. They replace `await fs.readdir(dir).catch(() => [])`, which is right about a directory that does not exist and wrong about one that exists and cannot be listed: both collapse to an empty array, so a permissions problem reads as "nothing configured" and the user's subagents disappear from `/agents` with nothing in the log.
- Added `strings.ts`: `firstNonEmpty` (the first value that is set and not blank after trimming) and `nonEmptyTrimmed` (all of them). They are the case `??` and `||` each get half of — `??` keeps an empty string, `||` drops one but also drops `0`, and neither trims — so a blank `TERM=` now falls through to `COLORTERM` instead of winning. Both had hand-written copies in the coding agent: the prompt builder's own `firstNonEmpty`, and the trim-and-drop-blanks loop `gh.ts` wrote twice 145 lines apart with a third in `autoresearch/helpers.ts`.
- `makeBench` runs an untimed warmup before the timed loop, and prints how many iterations it excluded:
  `js/parseKey: 10.42ms total (0.005209ms/op, 200 warmup)`. It timed the first iteration along with the
  rest, so every figure any bench in this repository has published included JIT tier-up. That distortion is
  largest exactly where these benches are pointed, at functions costing hundreds of nanoseconds, where a few
  hundred microseconds of warmup is a large fraction of the run. The default is a tenth of the iterations,
  clamped to at least 1 and at most 1000, and `defaultWarmup` is exported so a script can report or override
  it deliberately; pass `{ warmup }` when the default is wrong for the case. One bench script already ran
  its own warmup loop, which is why it had never been folded into this harness; it now passes `{ warmup: 20 }`
  and the private copy is gone.
- Every place that reads a subprocess pipe as text now goes through `readPipeText`. Thirty-four
  further sites across five packages spelled `new Response(proc.stdout).text()` inline, four of them
  casting the pipe (`proc.stderr as ReadableStream`) to satisfy the compiler. Reading text out of a
  pipe is one operation, and the helper's null handling means a caller no longer has to decide
  per-site whether a stream that was not piped is an error: it reads as no output, which is what
  every one of these sites wants, since they are assembling a diagnostic about someone else's
  failure. No behaviour change at any of the thirty-four: each either pipes the stream it reads or
  already guarded it by hand. `ptree`'s blob, JSON, ArrayBuffer and bytes readers are different
  operations and stay as they are.
- `bench-harness`: `makeBench`, `benchStats` and `benchFail`, the loop and the two readings every
  bench script here needs. Four scripts across two packages had written their own copy of each, and a
  benchmark's own arithmetic is the last place a difference should be free to hide. `benchFail` exits
  non-zero, because a bench that prints a failure and succeeds is a bench nothing can gate on.
- Added `readPipeText`, which drains a spawned process's pipe to a string and reads an absent pipe (`Bun.spawn` gives `null` for a stream that was not captured) as empty output. Both runtime installers had a private copy of that guard, and each is the code that explains a failed install to an operator: dropping the null case turns the install error into a TypeError about reading a stream.
- `startupMarker` moved into `@veyyon/utils/startup-marker`, a module whose only dependency is `node:fs`, and `logger.startupMarker` re-exports it. It existed twice, in the logger and in the CLI framework, with the second copy documented as deliberate: `veyyon --version` must not pull the winston-backed logger into its import graph. That constraint is real, and a module with one node builtin as its dependency satisfies it without a second definition. The marker's behaviour is unchanged, and now tested: one synchronous `fs.writeSync(2)` line per phase, silent unless `VEYYON_DEBUG_STARTUP` is set.
- Added `isThenable`, the guard that decides whether a value needs a rejection handler attached. It existed twice in `@veyyon/coding-agent` (the IPC `send()` sites and the MCP stdio transport), where one copy's comment justified the other as "battle-tested there"; a missed thenable becomes an unhandled rejection that takes the process down far from the call that made it. Its tests moved here with it.
- Added `createThemeStore`, the light/dark theme store a browser page reads through: it restores the preference a person chose (`system`, `light`, `dark`), resolves it against the browser's, writes it onto `<html>` for CSS and for the native form controls, and notifies its readers. The collab client and the stats dashboard each had a byte-identical copy of it, ~90 lines with no tests in either. Browser access goes through a `ThemeEnvironment`, so the resolution can be asserted without a DOM, and the package stays free of the `dom` lib. It is React-free; each page binds it with `useSyncExternalStore`. Also available as `@veyyon/utils/theme-store`.
- Added `asStrictBytes`, which narrows a `Uint8Array` to one over its own whole `ArrayBuffer`, copying only when it is not one already. `crypto.subtle` reads the entire backing buffer of the array it is handed, so a view into part of a larger buffer (an IV taken with `subarray`, say) has to be copied before it is signed or decrypted, or the neighbouring bytes go in with it. Four packages needed this and each had a private copy, one of which could have been "tidied" into a bare cast without any test noticing. The no-copy path is the common one and is kept: sealing runs per collab frame and signing per request. Also available as `@veyyon/utils/bytes` for browser bundles, which must not import the barrel.
- Added `parseJsonOrYamlByExtension`, which parses a config file's text as YAML when the path ends in `.yaml` or `.yml` and as JSON otherwise. The LSP and DAP config readers each had a private, byte-identical copy of that decision. It throws on malformed input rather than returning nothing, so the caller can name the file and the line.
- Added `visitJsonlBytes`, `parseJsonlBytes` and `decodeJsonlLine`: a byte-level JSONL walk for a file that is still being appended to. It returns the byte offset up to which whole lines were consumed, so a reader stores that offset and reads only the new bytes next time and never holds a large file as a string. A trailing partial line is the ordinary case rather than an error, and a complete line that cannot be decoded is reported with its offset and length instead of vanishing. This is the third reader in the package and each answers a different question: this one for a growing file, `parseJsonlIncremental` for a stream arriving in chunks, `parseJsonlLenient` for a complete buffer.

### Changed

- `file-lock.ts` asks `type-guards` and `json` the questions they own. It wrote out its own
  `isRecord` (`value === null || typeof value !== "object" || Array.isArray(value)`) and its own
  `tryParseJson` (a try/catch around `JSON.parse`), which is two more answers to two questions this
  package already answers once each. The decoder's try/catch stays, and is now visibly about the
  decoder: `TextDecoder` is `fatal`, so a lock file holding bytes that are not UTF-8 really does
  throw, and that is a different failure from JSON that will not parse.
- `structuredCloneJSON` moved from `index.ts` to `json.ts`. The barrel re-exports about eighty leaf
  modules and its whole value is that nobody has to import it: ask for `errorMessage` and you get one
  module, not eighty. That only holds while every name has a leaf to come from, and this one did not,
  so a deep copy cost the whole package. Five files in `@veyyon/ai` were paying it. Import it from
  `@veyyon/utils/json`; the barrel still re-exports it, so nothing that already worked stops working.
- The `estimateTokens` source lock checks its own allowlist for rot. The grandfathered list already failed when an entry stopped matching a file; the permanently-allowed list did not, so a stale entry would quietly stop matching and leave its exemption ready to excuse a hand-rolled copy that landed in that path later. Every allowed path is now asserted to still exist and still define an estimator.
- `session-file.ts` also owns how a moved-aside transcript is named. A backup is written as `<primary>.<snowflake>.bak` by one module and read by four, and the writer's template and the reader's parse had been written independently. `sessionBackupPrimaryName` is the exact inverse and returns nothing rather than a guess for a name it cannot read, because recovery renames the backup over the path it returns.
- `session-file.ts` owns how a session transcript is named: the `.jsonl` extension, the three questions asked about it, and the advisor transcript stem. The extension is a contract between the one module that writes a transcript path and the seven that discover transcripts by scanning for it, and a drift between them raises nothing: sessions keep being written and stop being listed, resumed, garbage-collected or counted. It had been spelled inline at dozens of sites in three packages, under three constant names that did not match, one of which held the length rather than the string. The advisor stem is here rather than in the coding agent because `@veyyon/stats` classifies a transcript as the advisor's by name and cannot import the coding agent, so it had declared the filename itself.
- `app-identity.ts` owns the product's name in the two forms that are not interchangeable: `APP_DIRECTORY_SLUG` for filesystem paths and `APP_DISPLAY_NAME` for what a person reads. `APP_NAME` used to mean `"veyyon"` here and `"Veyyon"` in `@veyyon/tui`, one name for two values, and both are strings so nothing complained when the wrong one crossed a boundary: a slug in a notification title is untidy, and a capitalized name in a path works on a case-insensitive filesystem and splits into two directories elsewhere. `APP_NAME` is unchanged and now reads the slug.
- `AbortError` from `@veyyon/utils` is now the signal-shaped cancellation class, and the class raised when a child process is killed is `ProcessAbortError`. Three unrelated classes answered to the name `AbortError`, two of them in this package, and the barrel exported the process one, so importing `AbortError` and constructing it from an `AbortSignal` failed with "Expected 2 arguments, but got 1" while an `instanceof AbortError` check compiled, passed, and asked about a class the author did not mean. Both classes still report `name === "AbortError"`, so `isAbortError` and every log and message shape are unchanged; only the import name moves. If you constructed the process-abort class through the barrel, import `ProcessAbortError` instead.
- `VEYYON_CONFIG_DIR` set to an absolute path is now refused at startup instead of being reinterpreted. It names the config directory under your home rather than replacing it, so `VEYYON_CONFIG_DIR=/srv/veyyon` was joined onto your home and created `~/srv/veyyon`: you got a brand new tree inside your home, the old one stayed where it was, and nothing said so. The error names the directory that would have been created and points at the `XDG_*_HOME` variables, which do take absolute paths. A value written for the other platform (`C:\veyyon`, a UNC path) is caught the same way, and a whitespace-only value is refused rather than creating a directory whose name is invisible in a listing. An empty value still means "use the default".
- Log output follows the config root when it moves. The rotating file transport resolved its directory once, on the first log line of the process, so anything that changed the config root afterwards kept writing to the old location: the log file where the docs say it should be had no entries, and if the old directory had been removed the lines went to an unlinked file and were gone. If the new location cannot be written to, veyyon keeps using the one that works and says so through a process warning rather than losing logging entirely.
- A log write that fails no longer takes the process down. A winston transport reports failures as an `error` event, and an event with no listener is an uncaught exception, so a log destination that went wrong after startup — its directory removed, the disk full, a volume unmounted — crashed whatever veyyon was doing at the time. The failure is reported once as a process warning and the run continues; a log line is the least important thing happening at that moment.
- `errorMessage` falls back to an error's constructor name when its message is empty. Callers splice the result into a sentence (`renderer threw: <msg>`), and `new TypeError()` produced text that trailed off after the colon and named nothing. A whitespace-only message is still returned as-is: it is a real message, and substituting the class name would hide that the throw site produced junk.

### Fixed

- `renderHelpTable` takes `maxGutterFraction`, how much of the terminal the left column may occupy.
  The cap exists so one long entry cannot set the column for every short one, and a third is right
  when that column is a flag name. It is wrong when the column is inherently longer: `veyyon config
  list`'s left column is a dotted setting path routinely past thirty characters, so a third pushed
  the value onto a second line even when the value was `true`, growing that listing from 470 lines to
  714 without making one of them easier to read. The default is unchanged, and it now lives in one
  place on the `gutter` helper rather than at each call site.
- `cli.ts` owns the help layout, and it now fits the terminal it prints into. Help was laid out for
  an infinite screen: it padded to the widest entry and never wrapped, so `veyyon --help` emitted 85
  lines past 80 columns with a 221-character worst case, and the terminal re-broke every one of them
  at an arbitrary column with no indent. `renderHelpTable(rows)` and `renderHelpParagraph(text)`
  measure with `Bun.stringWidth` rather than `.length`, so a styled entry is not charged for its
  escape bytes, and wrap with `Bun.wrapAnsi(..., { trim: true })`. The gutter is capped at a third of
  the width, because a single long flag was setting the description column for the seventy short ones
  around it and leaving them fifteen usable columns; entries wider than the cap put their description
  on the next line instead of dragging everything right. Width comes from `process.stdout.columns`,
  then the exported `COLUMNS`, then 80, clamped to [60, 100]. Consulting stdout alone was not enough:
  piping help into a pager is how a long one gets read, and that is exactly when stdout reports no
  width, so a 60-column pane was laid out for 80 and put 113 lines past the edge. A line may still
  exceed the width when it is a single token with nowhere to break, such as
  `--approval-mode=<plan|ask|auto-edit|yolo|always-ask|write>` or a session path; force-breaking those
  would leave a flag or a path that cannot be copied. Overflowing a line that has a space in it is the
  defect, and that is what the suite asserts.
- `TempDir` puts its directory in the system temp directory when you give it a bare name. It used to
  hand the prefix straight to `mkdtemp`, which resolves a relative path against `process.cwd()`, so
  `TempDir.createSync("secret-runtime-lifecycle-")` created its scratch directory inside the
  repository and left it there whenever a suite crashed before cleanup. Forty-six of them had
  accumulated. The escape hatch was a leading `@`, which is the wrong way round for a trap: the safe
  spelling looked like a typo and the dangerous one looked ordinary, so every call site written
  without reading `normalizePrefix` got the bad one. An absolute prefix is still honoured exactly as
  given, and the `@` spelling still works and still strips the sigil.
- File-lock recovery no longer lets an old stale-lock reaper delete a newer writer's lock. The reaper carries the owner token it observed and removes the lock only while that owner still matches. An aged ownerless lock is recoverable after its publication grace period, malformed owner metadata is refused, and a valid replacement owner survives a delayed cleanup.
- `stripAnsi` removes a CSI sequence written with colon subparameters. The parameter class was `[0-9;?]`, but the spec's parameter bytes are the whole `0x30-0x3f` range, so `:` `<` `=` `>` were not matched: a true-color SGR of the form `ESC [ 38:2:255:0:0 m`, which libvte and several test runners emit, left `38:2:255:0:0m` behind as visible text in captured output. The class is now the spec's, and the three byte classes are disjoint so the pattern accepts exactly what a greedy scanner accepts. The behaviour is pinned against `fixtures/ansi-strip-corpus.json`, which the Rust `strip_ansi` in the shell minimizer reads too, so the two implementations answer the same cases instead of drifting apart.
- `SQLITE_NOW_EPOCH` is exported from `src/sqlite.ts`. The expression `CAST(strftime('%s','now') AS INTEGER)` was declared in three modules across `@veyyon/ai` and `@veyyon/coding-agent`, each writing a column another module reads, and it had to land here because neither package can own a value both of them write. The unit is what makes a copy dangerous: an edit to milliseconds, or to a Julian day, puts values a thousand times out of range into one table while every reader keeps interpreting them as seconds, and nothing throws. `test/sqlite.test.ts` asserts what SQLite actually computes rather than the string, since the string is interpolated into SQL: seconds bracketed against the JavaScript clock, `typeof` integer with the bare `strftime` TEXT as the control, usable as a column DEFAULT, and one value per statement so a row cannot look edited the moment it is created.
- `moduleReach`, `moduleReachCount` and `moduleGraph` take an optional per-run memo, `createModuleReachCache()`, so a caller that walks many entries over one graph reads each file once. The architecture gates walk one entry per test file, 1,891 of them in `packages/coding-agent`, over a graph whose files overlap almost completely, and every walk was re-reading and re-scanning the same modules: the same read, the same regex pass, the same resolution, thousands of times for one number. It was tolerable while the walk resolved four packages and stopped at every other boundary; resolving the whole workspace took that gate from about forty seconds to minutes, and a gate too slow to run stops catching anything. It is now about one second. The memo is explicit and per-run rather than module-level, because these values come off disk and a process that edits a file and re-walks has to see the edit; `packages/utils/test/module-reach-cache.test.ts` pins that a cached walk answers exactly what an uncached one answers, that a stale entry lives only in the cache that saw it, and that files really are read once, proven by deleting the fixture between two walks rather than by timing anything.
- Added `module-reach-workspace.ts`, which derives the module-reach resolution table from every workspace package's `exports` field, and four architecture gates that used to write that table out by hand now read it. The copies had drifted, and the drift was invisible because every one of those gates is an upper bound: a specifier the table does not know resolves to nothing, the walk stops, and the ceiling passes while measuring less. Two of them listed `@veyyon/agent`, which is not the name of any package here (the directory is `packages/agent`, the package is `@veyyon/agent-core`, and its barrel is 406 modules), so all 569 imports of it were invisible, along with `@veyyon/mnemopi` (398 modules), `@veyyon/stats` (365), `@veyyon/natives` and `@veyyon/tool-render`. One gate recorded `packages/coding-agent/src/thinking.ts` at 6 modules when it was 407. Deriving from `exports` means the gate resolves what the runtime resolves, a package that adds a subpath export is covered without an edit, and a new package cannot join the workspace unresolved and quietly lower every ceiling in the repository. `packages/utils/test/module-reach-workspace.test.ts` tests the derivation against fixture manifests and holds the completeness check.
- A user's `$HOME/.env` now reaches the directory resolver whichever module you imported. Applying a `.env` used to be a module-scope block at the bottom of `env.ts`, and `env.ts` imports `dirs.ts`, so the only thing that applied your `.env` was importing `env.ts` — through `@veyyon/utils` that happened by accident of `export * from "./env"` rather than because anyone asked. That made an ordinary cleanup dangerous: `dirs.ts` caches every path at module load and what those paths ARE is decided by `VEYYON_CODING_AGENT_DIR` and the `XDG_*` variables, so a file that followed this repository's own rule and named `@veyyon/utils/dirs` (15 modules) instead of the barrel (74) got directories resolved before your `.env` was read. Measured in two subprocesses: the barrel returned the configured directory and the leaf returned `~/.veyyon/profiles/default/agent`. No error and no warning, a real path to a tree you never configured, and only in processes whose module graph reached no other importer of `env.ts`. Applying a `.env` is now two phases, split along the line the four locations already draw: `dotenv-home.ts` applies the part of `$HOME/.env` that needs nothing but your home directory, and `dirs.ts` imports it before it resolves anything; `env.ts` scrubs the environment and applies all four layers in full, including the rest of the home file, then refreshes the resolver. Phase one is an allow-list, not the whole file: only the keys that decide WHERE a directory is (`VEYYON_CODING_AGENT_DIR`, `VEYYON_CONFIG_DIR`, the `XDG_*` bases) are applied that early, because everything in the environment at that point is inherited by every subprocess veyyon spawns and the rest of your `.env` is where your API keys are. `VEYYON_PROFILE` is not among them: the profile decides where the other three `.env` files are, so reading it out of one would be circular, and it was never honoured from a `.env` before. `PATH` is not among them either, so a `PATH` you extend in `$HOME/.env` still reaches `$which` through `env.ts` as it always did. The scrub stays there rather than moving down with the home layer, because importing a path resolver must not mutate your environment: a program that wants it asks for the environment. There is no bootstrap call to forget. `dotenv-parse.ts` owns the parser and the rules about which names and values may enter the environment, and takes its unreadable-file reporter as a parameter, because phase one runs before the logger can exist (the logger asks `dirs.ts` where to write) and reports through `process.emitWarning` instead. Precedence is unchanged — the real environment, then `<cwd>/.env`, then `<agentDir>/.env`, then `<configRoot>/.env`, then `$HOME/.env` — which took care: the lowest-priority layer is now applied first, so phase one records the keys it injected and phase two may displace exactly those, and no others.
- `moduleSpecifiersIn` no longer reads prose as a dependency, and no longer hides real imports behind one. The pattern matched `import`/`export` at a line start and then ran `[\s\S]*?` forward to the next `from "…"`, which does not stop at the end of a statement. Most exports are not re-exports, so `export const $env: Record<string, string> = Bun.env as …;` in `env.ts` began a match, found no `from`, and settled 140 lines later on a doc comment offering `import { $env } from "@veyyon/utils"` as advice to the reader. `env.ts` was therefore recorded as importing its own package barrel, and every module that reached it was credited with all 74 of them. The second direction is worse: `matchAll` resumes after a match ENDS, so every genuine import inside a swallowed span was never examined, and one non-re-export `export` above them was enough to hide an arbitrary number of edges. A sweep over all 22,539 source files in the repository found 426 phantom specifiers being counted and 4 real imports invisible. Every architecture gate built on this is an upper bound, so hidden edges passed silently, which is the same blindness this module was created to end one layer further down. The middle of the pattern is now an import CLAUSE character class, so a value declaration cannot leave its own statement, and comments are stripped before matching: block comments entirely, line comments only from the start of a line, because a specifier may legitimately contain `//`.

## [1.0.30] - 2026-07-24

### Added

- Added `atomicWriteFilePreservingMode`: an atomic write that carries the target file's current permission bits forward instead of stamping the `0o600` default (a new file gets `0o644`). Use it when overwriting an existing file whose mode must not change, such as a source file an editor rewrites or a script that must stay executable.

## [1.0.29] - 2026-07-24

### Added

- Added `splitReadSelector`, `stripReadSelector`, and the `READ_SELECTOR_RANGE_LIST_SRC` grammar fragment: the one shared owner of the read-tool path-selector grammar (`file.ts:50-200`, `:raw`, `:conflicts`, and `range:raw` compounds). This grammar was previously hand-duplicated across packages with "keep in sync" comments; consolidating it here removes the drift risk.

## [1.0.26] - 2026-07-24

### Fixed

- Base URL normalization no longer leaves a trailing space when a slash sat directly in front of interior whitespace (`"http://x /"` now normalizes to `"http://x"` instead of `"http://x "`), so a stray space in a configured base URL can no longer break request URL joins.

## [1.0.24] - 2026-07-24

### Added

- Added `atomicWriteFileWith`, and routed the remaining hand-rolled atomic file writers through it, so every atomic write goes through one owner.

### Fixed

- Closed an unhandled-rejection window in `ChildProcess.wait`.
- The CLI parser now rejects positional arguments beyond the declared set instead of ignoring them, and an unknown command exits 1 on the help path with a single message.
- `formatNumber` and `formatBytes` now promote a boundary value that rounds up to a full unit to the next unit, so it reads `1.0 MB` rather than `1024.0 KB`.
- Dotted version components are now detected strictly rather than through `parseInt`, so a component like `1.2abc` is no longer treated as numeric.
- The relaxed and streaming JSON parsers now store a `__proto__` key safely instead of polluting the object prototype.
- Legacy default-profile migration is now resumable, so an interrupted migration can finish on the next run.
