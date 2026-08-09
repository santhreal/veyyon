# Changelog

> **Fork notice.** Veyyon is a source fork of oh-my-pi ([can1357/oh-my-pi](https://github.com/can1357/oh-my-pi), MIT). Every version entry **at or below `16.5.2`** is inherited upstream oh-my-pi release history — not a veyyon release (see [UPSTREAM.md](../../UPSTREAM.md)). Veyyon's own release line starts at **`1.0.0`**.

## [Unreleased]

### Breaking Changes

- The home-derived path constants are functions. `DEFAULT_DATA_DIR`, `FASTEMBED_CACHE_DIR`, `MODEL_CACHE_DIR`, `DEFAULT_PLUGIN_DIR`, `DEFAULT_LOG_DIR` and `DEFAULT_LOG_DB` computed `os.homedir()` at import time, which is what made them impossible to redirect, so they are replaced by `dataDir()`, `fastembedCacheDir()`, `modelCacheDir()`, `pluginRoot()` and `costLogDb()`, each taking an optional environment. The paths they answer with are unchanged.

### Fixed

- Every root this package can create answers to one lever, `MNEMOPI_HOME`. Five paths were baked from `os.homedir()` at module scope and reachable by no configuration at all: the blob store, the plugin directory, the fastembed cache, the model cache and the cost log, whose root is `~/.mnemopi` and which nothing had ever watched. `storeBlob()` therefore wrote into the operator's real home however carefully the caller had set `VEYYON_CONFIG_DIR` and `MNEMOPI_DATA_DIR`, and CI's `Test TS workspace fast` went red on mnemopi's own home guard finding a `.hermes` its suite created and could not prevent. `mnemopiHome()` resolves `MNEMOPI_HOME`, then `HOME`, then `os.homedir()`, and every root now derives from it: one variable moves all of them, the production paths are byte-identical, and `home-derived-roots-answer-to-one-lever.test.ts` reads the resolver inventory off the modules at run time so a new root that skips the owner is red on arrival.
- The process default bank has one owner. `core/banks.ts` carried its own `defaultBank` module variable behind `setBank`, `getBank` and `resetBankForTests`, and `core/memory.ts` carried a second one behind the same three names. Both were re-exported, `memory.ts` last, so which copy a caller reached depended on export order in a barrel: setting the bank through one and reading it through the other returned "default" forever, and only the `memory.ts` copy actually routed the singleton. The dead copy is gone, and `bankDbPath` now requires the bank name rather than defaulting to a variable nobody could set.
- Asking where a bank lives no longer creates it. `BankManager`'s constructor ran `mkdirSync(this.banksDir)`, and every read in the package builds a manager to answer one question: `bankDbPath`, `bankExists`, `listBanks` and `getBankStats` each construct one, and `resolveDbPath` constructs one with no argument purely to spell a path. With no argument the data dir is `dataDir()`, which is `~/.hermes/mnemopi/data` unless `MNEMOPI_DATA_DIR` says otherwise, so a pure query wrote a directory tree into the operator's real home. `createBank` is the one caller that needs the directory and its own recursive `mkdirSync` already makes it, so this is a pure subtraction. The two dead module-scope exports that recomputed the same home path at import, `DEFAULT_DATA_DIR` and `BANKS_DIR`, go with it: they duplicate `config.ts` and have no consumers.
- The shared test env isolates both of this package's home-derived roots, not one. `useMnemopiTestEnv()` moved `VEYYON_CONFIG_DIR`, which cannot reach `dataDir()`, whose only lever is `MNEMOPI_DATA_DIR`, so any suite touching the module-level facade opened a SQLite database, a `-wal` and a `-shm` in the real home and initialized the whole schema there. The `afterAll` guard could not have caught it either, because it listed only `.veyyon*` entries and that root is `.hermes`. The env now sets an absolute `MNEMOPI_DATA_DIR` inside the isolated root and restores it, and the guard lists both prefixes for all 108 mnemopi files.
- Embedding misconfiguration is reported through `reportEmbeddingFailure` instead of disabling semantic recall in silence. Two paths returned `null` before any reporting branch could run: a local embedding model name this build cannot load, and an API embedding model configured against the hosted endpoint with no key. Both left recall silently degraded to keyword-only, at no log level and with no warning, which is indistinguishable from a corpus that simply has no semantic matches. Each has a one-line remedy the operator can only apply once they know it is needed, and the local case is usually a typo in a model name.
- The mnemopi test suite runs in CI. The package was listed as local-only in `scripts/ci-test-ts.ts` and was named by no CI job at all, on the recorded grounds that its embedding suites need a ~270MB fastembed model the runners do not have. That is true of no suite here: every one injects a fake provider or a fake initializer, and the local model path returns null outright under the test runner, so all of them pass with the model cache empty and the network unreachable. A property of a subset had been recorded as a property of the package, and the triple store, the schema, the migrations, the query paths and the recall ranking went unrun in CI for as long as it stood. The download itself is now refused rather than avoided by omission: a preload throws from `FlagEmbedding.init`, so a suite that starts needing the real weights fails by name instead of pulling them into a runner.
- Every mnemopi suite now proves its config root stayed out of the home directory rather than assuming it. `useMnemopiTestEnv()` lists the `.veyyon*` entries in `os.homedir()` before it enters its isolated root and requires the same list afterwards, and `the-config-root-never-lands-in-the-home.test.ts` supplies the write that makes the check bite, by creating the fastembed cache the resolver hands it. The isolation itself was already correct; what was missing was any way to notice if it stopped being correct, because a config root inside the home resolves to an absolute, writable, entirely plausible path when read from inside the suite. The pattern it replaces, a fresh `VEYYON_CONFIG_DIR` NAME joined onto `os.homedir()`, left 131 abandoned `~/.veyyon-mnemopi-profile-iso-*` directories in one operator's home.

## [16.3.9] - 2026-07-06

### Fixed

- Fixed extractor JSON parsing to correctly unwrap object-shaped facts, instructions, preferences, and timeline items from known text fields instead of persisting literal `[object Object]` rows.

## [16.3.7] - 2026-07-05

### Added

- Added `RecallOptions.contentPreviewChars` to allow customizing or disabling the content preview cap (default is 500, set to 0 for full content).
- Added `RecallResult.truncated` and `RecallResult.full_length` properties to easily identify clipped previews without parsing trailing markers.

### Fixed

- Fixed background LLM fact extraction to preserve specific extractor categories (`instructions`, `preferences`, `timelines`, and `kg` triples) in MEMORIA tables and graph triples instead of flattening them into generic `fact/entity` rows.
- Improved recall previews and `factLine` context to append a trailing ellipsis (`…`) when content is clipped, preventing mid-word truncation without a marker.

## [16.3.5] - 2026-07-04

### Fixed

- Fixed `remember(..., { embedText })` so hosts can store full transcripts while embedding, FTS-indexing, and rebuild-reembedding a marker-free projection. ([#4395](https://github.com/can1357/oh-my-pi/issues/4395))

## [16.2.2] - 2026-06-27

### Fixed

- Improved resilience during API extraction calls by enhancing the handling of rate limits and transient errors.

## [16.1.17] - 2026-06-24

### Fixed

- Fixed `remember(..., { extract: true })` fact/entity extraction accepting an `extractText` override so hosts can store full transcripts while mining facts from a safer projection; also tightened deterministic `Instruction:` extraction to require an explicit `I`/`you` subject instead of treating every `always`/`never` clause as a user instruction. ([#3372](https://github.com/can1357/oh-my-pi/issues/3372))

## [16.1.8] - 2026-06-20

### Fixed

- Capped per-input length in `embed()` at `MNEMOPI_EMBEDDING_MAX_INPUT_CHARS` (default 8192 chars, override via the env var or `embeddings.maxInputChars` runtime option; `0` disables) so a long retention transcript can no longer overflow the embedding model's context window. Oversized inputs are clipped with a head/tail split so chronological transcripts keep both the opening setup and the most recent turns instead of losing the latest content under a naive prefix slice. llama.cpp's `/embeddings` server used to reject the request with `request (N tokens) exceeds the available context size`, silently dropping vector recall for that memory ([#3126](https://github.com/can1357/oh-my-pi/issues/3126)).
- Fixed the proactive-linking write path ignoring host configuration: `proactiveLinkIfEnabled` read `MNEMOPI_PROACTIVE_LINKING` directly, so a host that enabled proactive linking through `configureRecallFeatures()` had no effect unless the environment variable was also set. `proactiveLinking` is now a `RecallFeatureFlags` option resolved through a `proactiveLinkingEnabled()` fallback, matching the existing polyphonic and enhanced recall flags, with the `MNEMOPI_PROACTIVE_LINKING` environment variable still taking precedence whenever it is set. ([#2440](https://github.com/can1357/oh-my-pi/issues/2440))

## [16.1.3] - 2026-06-19

### Added

- Exposed `setLocalModelInitializer` (and the `LocalEmbeddingModel`, `LocalModelInitializer`, `LocalModelInitOptions`, `StandardEmbeddingModel` types) so hosts can route fastembed loads through a dedicated subprocess and keep `onnxruntime-node`'s NAPI constructor + finalizer out of their own address space. Same wipe semantics as the existing `setLocalModelInitializerForTests` seam; the agent CLI uses it to crash-proof Windows when `memory.backend: mnemopi` is enabled ([#3031](https://github.com/can1357/oh-my-pi/issues/3031)).

### Fixed

- Fixed background fact extraction skipping runtime-configured remote LLM endpoints when `MNEMOPI_LLM_BASE_URL` was unset, so `remember(..., { extract: true })` now stores remote-distilled facts from `mnemopi.llm` config instead of falling back to regex heuristics. ([#3041](https://github.com/can1357/oh-my-pi/issues/3041))
- Fixed local fastembed startup on macOS ARM64 by letting `fastembed@2.1.0` install its matching `onnxruntime-node@1.21.0` native runtime instead of forcing `1.26.0`, and by repairing missing tokenizer sidecars from the upstream Hugging Face model cache when a stale fastembed archive lacks them. ([#3054](https://github.com/can1357/oh-my-pi/issues/3054))

## [16.0.6] - 2026-06-18

### Fixed

- Forced the on-demand fastembed runtime install to override fastembed's archived `onnxruntime-node@1.21.0` transitive pin with Mnemopi's `onnxruntime-node@1.26.0` pin, fixing local embedding startup on macOS ARM64. ([#2920](https://github.com/can1357/oh-my-pi/issues/2920))

### Changed

- Updated OpenRouter request headers to use standard shared headers from the pi-ai package

## [16.0.5] - 2026-06-17

### Fixed

- Capped `sleep_consolidation` episodic rows at `maxEpisodeChars` (default 100KB, `MNEMOPI_MAX_EPISODE_CHARS`) so raw session transcripts cannot be stored and extracted as multi-megabyte episodes. ([#2869](https://github.com/can1357/oh-my-pi/issues/2869))
- Skipped regex-only entity and pattern fact extraction for oversized raw transcripts so progress/log noise cannot flood MEMORIA with junk facts. ([#2868](https://github.com/can1357/oh-my-pi/issues/2868))

## [15.13.1] - 2026-06-15

### Added

- Added a wipe-and-rebuild reconcile (`reconcileEmbeddingModel`) that runs when the configured embedding model changes. At store open, if the model stamped on stored `memory_embeddings` rows differs from the active `currentEmbeddingModel()`, the stale embeddings and their binary vectors are dropped and every existing memory is enqueued for background re-embedding (in bounded batches) at the new model/dimension. The destructive wipe is skipped whenever it could not be rebuilt — embeddings disabled via the runtime option or the `MNEMOPI_NO_EMBEDDINGS` env, an unresolved (empty) active model, or a read-only open (`reconcile: false`, used by ephemeral stats readers that would exit before the async rebuild finished) — so a stale-but-valid corpus is never destroyed without a replacement. Recall degrades gracefully (FTS-only) for memories whose vectors are not yet rebuilt ([#2476](https://github.com/can1357/oh-my-pi/issues/2476))

### Fixed

- Normalized enhanced recall fact scoring against lexical coverage so high-confidence facts that only match generic query tokens no longer outrank exact working-memory hits. ([#2441](https://github.com/can1357/oh-my-pi/issues/2441))

## [15.12.4] - 2026-06-13

### Fixed

- Fixed `consolidateToEpisodic` (the function backing `sleep` / `sleepAllSessions`) never populating the episodic graph: the `gists` and `graph_edges` tables stayed at 0 rows across every bank even after multiple consolidation cycles, so Polyphonic Recall's `graph` voice (BFS over `findGistsByParticipant` / `findRelatedMemories`) always returned nothing. Consolidation now best-effort ingests the new episodic memory into `EpisodicGraph` so the gist row, gist→memory `ctx` edge, fact edges, and cross-memory similarity/entity/temporal edges land alongside the episodic row. Independent of the existing `MNEMOPI_PROACTIVE_LINKING` flag, which still gates the same enrichment on the `remember()` write path. ([#2435](https://github.com/can1357/oh-my-pi/issues/2435))

## [15.12.0] - 2026-06-12

### Changed

- Moved `fastembed` and `onnxruntime-node` from `dependencies` to optional `peerDependencies` pinned to exact versions. When the peers are absent (bundled CLI, compiled binary, or installs that skip optional peers), the local embedding path `bun install`s the pinned pair into `~/.veyyon/cache/fastembed-runtime/<version-key>` on first use and loads fastembed from there — restoring local embeddings in bundled distributions and removing ~270MB of eager native downloads from default installs ([#2389](https://github.com/can1357/oh-my-pi/issues/2389))

## [15.11.4] - 2026-06-12

### Added

- Added `configureRecallFeatures()` (exported from the package root, `core`, and `config`) so hosts can enable the polyphonic recall engine and the enhanced recall query cache programmatically. `polyphonicRecallEnabled()`, `enhancedRecallEnabled()`, and `isEnhancedRecallEnabled()` now fall back to these configured defaults, with the `MNEMOPI_POLYPHONIC_RECALL` / `MNEMOPI_ENHANCED_RECALL` environment variables still taking precedence whenever they are set. ([#2323](https://github.com/can1357/oh-my-pi/issues/2323))

### Fixed

- Fixed the embedding pipeline's silent `catch {}` blocks (`runEmbedding()`, `getLocalModel()`, and the local-model path of `embed()`) swallowing failures with zero diagnostics. These best-effort paths still degrade gracefully (return `null` / skip the write), but now emit structured `logger.debug` entries with the error and per-site context (item count, model name). The `mnemopi.debug` config flag now propagates into the core library via runtime options (`MnemopiOptions.debug` → `ResolvedMnemopiRuntimeOptions.debug`) and escalates these logs to `warn` so they surface at the default log level. ([#2322](https://github.com/can1357/oh-my-pi/issues/2322))

### Changed

- Extraction, embedding, and remote-LLM clients now accept an `ApiKey` (static string or resolver) and resolve it per request through `withAuth`, so 401s force-refresh and rotate credentials via the central auth-retry policy instead of failing with a stale key. Empty-key setups (local/proxy endpoints without `Authorization`) and pinned literal keys behave exactly as before.
- Embedding and remote-LLM 401 errors now throw pi-ai's typed `ProviderHttpError` instead of `Object.assign`-patched `Error`s, keeping the same structural `.status` contract for the auth-retry classifier.
- SHMR consolidation clustering (`core/shmr`) now uses the real embedding provider when one is configured instead of always hashing: `embed()`, the new `embedBatch()`, `clusterBySimilarity()`, `computeHarmonyScore()`, `harmonize()`, and `recallBeliefs()` are now async, batch-embed candidate texts in a single provider call, and reuse precomputed vectors from `memory_embeddings` for episodic candidates. The SHA1 bag-of-words hash remains as the deterministic fallback when no provider is available or embedding fails. ([#2324](https://github.com/can1357/oh-my-pi/issues/2324))

## [15.10.12] - 2026-06-10

### Changed

- Reworked the in-memory fallback vector search to build a normalized exact vector index per query, matching the shape needed for future quantized or TurboVec-style backends without adding a new dependency yet.

## [15.10.11] - 2026-06-10

### Fixed

- Fixed embedding provider detection to match `openrouter` by URL host, so custom embedding endpoints are now recognized correctly instead of being misclassified by substring matching
- Fixed the check for OpenRouter base URLs so only true `openrouter` hosts are treated as non-custom

## [15.10.8] - 2026-06-09

### Added

- Added a `fetch` option to `ExtractionClient` to inject a custom fetch implementation for remote LLM requests
- Added an optional `fetch` option to `extractFacts` to control the transport used for remote extraction calls
- Added support for passing a custom `fetch` implementation through `complete` and `summarizeMemories` via remote LLM options

## [15.9.1] - 2026-06-04

### Breaking Changes

- Changed `Mnemopi.recall()`, `Mnemopi.recallEnhanced()`, `Mnemopi.search()`, `Mnemopi.query()`, the module-level `recall`/`recallEnhanced`/`search`/`query` exports, the `BeamMemory.recall`/`recallEnhanced` methods, the free `recall`/`recallEnhanced` functions in `core/beam/recall`, and `orchestrateRecall` to return `Promise<RecallResult[]>` so the recall pipeline can auto-derive `queryEmbedding` from the query text via `embedQuery`. Callers must `await` recall calls; pass `queryEmbedding: null` to opt out of auto-embedding and stay on FTS-only.
- Changed the MCP entrypoints `handleToolCall`, `callToolJson`, and `handleJsonRpc` in `mcp-server`/`mcp-tools` to async so the recall/shared-recall handlers can await the new `Promise<ToolResult[]>` shape; external MCP transports must `await` these.

### Fixed

- Fixed `memory_embeddings` never being populated by the production `remember`/`rememberBatch`/`updateWorking`/`consolidateToEpisodic` paths; embedding generation is now scheduled as a background task on `beam.pendingExtractions` (mirroring `scheduleFactExtraction`), so configured providers (fastembed, OpenAI-compatible API, custom) actually run and rows land in `memory_embeddings(memory_id, embedding_json, model)`. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `recall()`/`recallEnhanced()` never deriving a query embedding from the query text, which silently degraded every deployment to FTS-only regardless of provider configuration. The recall pipeline now auto-calls `embedQuery(query)` when `options.queryEmbedding` is undefined; pass `null` to keep the old FTS-only behaviour. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832))
- Fixed `toRecallOptions` dropping `queryEmbedding` between the `Mnemopi` facade and the beam layer, so callers can now explicitly pin or disable the query vector through the public API.
- Fixed `withMemory` (CLI) and `withBeam`/`withSharedBeam` (MCP) closing the SQLite handle before background fact-extraction and embedding tasks finished, so short-lived `mnemopi store`/`mnemopi sleep` and MCP `remember`/`update` paths now drain `flushExtractions` before close instead of silently dropping `memory_embeddings` rows. CLI handlers and MCP `handleRemember`/`handleUpdate`/`handleSleep`/etc. are async as a result. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)
- Fixed the process-wide `embedQuery()` cache in `core/embeddings.ts` keying by query text alone, which let two `Mnemopi` instances in the same process with different providers/models cross-contaminate their `dense_score` rankings. The cache key now includes a WeakMap-assigned provider identity, the resolved model name, and the configured `apiUrl`, so disjoint runtimes never read each other's cached vectors. ([#1832](https://github.com/can1357/oh-my-pi/issues/1832), follow-up to [#1833](https://github.com/can1357/oh-my-pi/pull/1833) review)

## [15.7.4] - 2026-05-31

### Fixed

- Fixed the `darwin-x64` release build failing in `bun build --compile` because the Windows ORT 1.24 preload pulled `onnxruntime-node` into the static graph and there is no `darwin/x64` prebuilt for that line. The preload is now guarded behind a `process.platform === "win32"` literal that Bun dead-code-eliminates on non-Windows targets; macOS/Linux load fastembed's bundled ORT 1.21 binding as before.

## [15.7.3] - 2026-05-31

### Changed

- Changed embedding result normalization to return `Float32Array` vectors so `embed` and `embedQuery` now cache and emit float32 rows
- Changed the embedding provider contract to a single typed `EmbeddingOutput` (`AsyncIterable<number[][]>`) instead of `unknown`, matching fastembed's `embed()`, so `EmbeddingProvider.embed` and the `provider` runtime option stream the embedding matrix as async batches (`async *embed(texts) { yield texts.map(embedOne); }`)
- Changed local model cache directory resolution for `fastembed` to use `getFastembedCacheDir` instead of the hard-coded `~/.hermes/cache/fastembed` path

### Fixed

- Fixed cosine similarity behavior across retrieval, clustering, and caching to consistently handle mismatched vector lengths as zero-padded and ignore non-finite values
- Fixed embedding API requests to retry transient failures with backoff via shared retry logic before returning null
- Fixed compiled `omp` binaries losing local Mnemopi embeddings by keeping `fastembed` and `onnxruntime-node` reachable to Bun's static compiler while preserving lazy runtime loading.

## [15.7.2] - 2026-05-31

### Fixed

- Fixed Windows startup crashes by keeping fastembed's older ONNX Runtime binding lazy until local embeddings are used.
- Fixed a segfault at startup from eagerly loading fastembed: importing the embeddings module pulled in `fastembed`, which eagerly loads the `onnxruntime-node` native addon. The import is now deferred until a local fastembed model is actually initialized, so API-model, disabled-embeddings, and test runtimes never load the native addon.

## [15.6.0] - 2026-05-30

### Added

- Added `llm.extractionPrompt` runtime option to override the fact-extraction prompt template using `{text}` and `{lang}` placeholders
- Added `llm.consolidationPrompt` runtime option to override the consolidation sleep prompt template using `{memories}`, `{source}`, and `{memory_count}` placeholders
- Published `@veyyon/mnemopi` to npm: the local SQLite memory engine is now built, checked, tested, and released through the monorepo CI pipeline alongside the other workspace packages.
- Exported the diagnostic inspector as the `@veyyon/mnemopi/diagnose` subpath for coding-agent memory maintenance commands.
- Added `flushExtractions()` (on `Mnemopi`, `BeamMemory`, and as a module-level export) to drain in-flight background fact extraction; used by tests and graceful shutdown so facts are persisted before the database closes.

### Changed

- Changed fact extraction to prefer a configured runtime LLM completion path before host extraction, with automatic fallback when the configured completion returns no output or fails

### Fixed

- Fixed `rememberBatch(..., { extract: true })` to run background fact extraction for batch uploads (including per-item `extract` flags) so extracted facts are generated and recallable after extraction
- Fixed `extract: true` fact extraction to continue safely when no LLM is configured by turning extraction failures into no-op background tasks
- Fixed configured LLM fact extraction by using temperature 0 so re-ingesting the same text is deterministic and avoids near-duplicate extractions
- Fixed `remember(..., { extract: true })` silently dropping the flag: it now schedules the LLM fact extractor (`extractFactsSafe`) over the stored content and persists the extracted facts so they become recallable. Previously the LLM extractor had no production callers and `extract` was dead.

## [1.0.38] - 2026-07-31

### Changed

- Class privacy is `#` throughout `core/`. Sixty-seven fields and methods carried a `private` or
  `protected` keyword, which TypeScript erases at build time, so every one of them was reachable at
  runtime from anywhere holding the object. They are ES private fields now, enforced by the
  workspace gate `scripts/class-privacy-is-the-hash.test.ts`. No public API changed.
- Remembering something no longer loads a model provider. The memory LLM client answered two questions in one module: whether an LLM is configured and how to build a prompt, which is configuration and text, and how to send that prompt, which is a round trip through the streaming engine. Fact extraction asks the first kind on every path and the memory engine sits behind extraction, so a provider was on the graph of every module that can remember something. The configuration half is now `core/local-llm-config.ts` and extraction loads the calling half only when it actually calls a model. `core/extraction.ts` went from 307 modules to 89, `core/beam/index.ts` from 341 to 144, and the MCP server from 406 to 148. A failed load rejects and is recorded like any provider error, so nothing degrades quietly.
- Two modules stopped importing far more than they use. `diagnose.ts` runs schema and integrity checks and took `initBeam` from the memory-engine barrel, 402 modules for a helper declared in `core/beam/schema.ts` that reaches one; it went from 403 modules to 92. `core/local-llm.ts` split its mixed `@veyyon/ai` clause into a type-only import plus the three modules that declare the functions it calls, going from 369 to 306 and taking `core/extraction.ts` from 370 to 307 with it.
- The embedding client and the extraction client name the modules that declare what they use, `@veyyon/ai/auth-retry` for the retry wrapper and `@veyyon/ai/utils/openrouter-headers` for the header builder, instead of the `@veyyon/ai` entry point. Two small helpers were carrying the whole streaming engine, and because this package's modules import each other the cost landed everywhere: `embeddings.ts` went from 369 modules to 110, `extraction/client.ts` from 367 to 105, and recall, the orchestrator and shmr from the high 300s to 124, 125 and 114.
- The OpenRouter base URL is trimmed with `trimTrailingSlashes` from `@veyyon/utils`, which this file already imported and then hand-rolled a line later.
- The OpenRouter host is read from `@veyyon/catalog/provider-endpoints`. It was declared three times in this package: as `DEFAULT_EMBEDDING_API_URL` in `config.ts`, again inline as the last term of the env-var chain in `core/embeddings.ts`, and as `OPENROUTER_BASE_URL` in `core/extraction/client.ts`. `config.ts` re-exports its published name from the owner.
- `core/banks.ts` reads the database filename from `config.ts`, which already exported it, instead of declaring a second copy. Two code paths opening different files is not something a filename typo announces.
- A veracity read back out of the database is typed `StoredVeracity` (any string) rather than
  the closed `Veracity`. The column is `TEXT` with no CHECK constraint, so a row from an older
  version or an imported store can hold anything, and the old type said otherwise while ending
  in `| string`, which collapsed the union to `string` and checked nothing. Values handed IN are
  the closed vocabulary and are clamped at the facade and MCP boundaries.
- The `memory_remember` and shared-memory MCP tools declare the eight veracity values as an
  `enum` with a generated description. The schema said only "Confidence label" and named no
  values, so a model guessed a word and the guess was clamped to `unknown`, costing the memory
  its weight.
- `Vector` means one thing again. It was declared four times inside this package with three different meanings: the wide `Float32Array | readonly number[]` in `types.ts`, a dense `Float32Array` in both `core/embeddings.ts` and `core/shmr.ts`, and a plain `number[]` in `core/beam/helpers.ts`. Which one you got depended on which module you imported from, and the wide one accepts plain arrays in places that then require the dense one. `types.ts` now declares both `Vector`, what you may hand to this package, and `DenseVector`, what it produces; the two modules that meant the dense one re-export it under the name they always used, so nothing they publish changes.
- `JsonValue`, `JsonPrimitive` and `Metadata` are declared once. This package declared JSON three times, in `src/types.ts`, `src/core/beam/types.ts` and `src/mcp-tools.ts`, and `Metadata` twice; every copy was the same type, which is what made them easy to keep adding and impossible to notice. The two type modules now re-export from `src/types.ts`, which takes JSON from `@veyyon/utils`, so every existing import path still works. `JsonScalar` stays as an alias of `JsonPrimitive` because it is exported from a published package; `JsonPrimitive` is the spelling new code should use.

### Fixed

- Remote memory extraction, consolidation, summarization, and API embeddings now transform provider-bound text with the live secret runtime on every physical request. The transform runs before token caps and serialization, then runs again after credential refresh or retry backoff. Local, FastEmbed, and on-device paths remain byte-identical and never take the remote transform.
- `recall()` refuses a `topic` filter instead of quietly applying it to the `source` column.
  Working and episodic memory have no topic column, only the `memoria_*` tables do, and the clause
  pushed `source = ?` bound to the topic value. Both outcomes looked like data rather than a bug:
  `{ topic: "chat" }` returned every memory whose SOURCE is `chat`, a plausible result set
  answering a different question, and `{ source, topic }` together emitted
  `source = 'a' AND source = 'b'`, always empty, reading as "you have no memories like that". The
  error names the value that was passed and both alternatives: filter on `source`, or query the
  `memoria_preferences` and `memoria_instructions` tables, which do carry a topic. A null or empty
  `topic` is not a filter and is still ignored, which is what every ordinary recall passes.
- The vector packer and the embedder agree on how wide a vector is. Two resolvers answered that
  question and they resolved the MODEL NAME differently: the embedder read the active
  `withMnemopiRuntimeOptions` scope first and the environment second, while `config.embeddingDim()`
  read `MNEMOPI_EMBEDDING_MODEL` alone, and it is the one `core/binary-vectors.ts` sized packed
  vectors from. Under a scope naming a 1024-dimension model the embedder produced 1024 and the
  packer assumed 384, with no width check anywhere between them, so the store filled with rows whose
  recorded width was a lie and it surfaced as similarity scores quietly getting worse rather than as
  an error. `config.embeddingModel()` is the one resolver now, and `embeddingDimFor` moved beside it
  because those two copies had diverged as well, on where each read `MNEMOPI_EMBEDDING_DIM` from.
- The width is asked for rather than frozen. `EMBEDDING_DIM` and `BYTES_PER_VECTOR` were module
  constants evaluated the first time `core/binary-vectors.ts` was imported, so a runtime scope
  entered afterwards could not move them however early it was entered. They are functions now.
  `DEFAULT_MODEL` and `EMBEDDING_DIM` in `core/embeddings.ts` were the same trap with no importers
  at all and are gone; ask `embeddingModel()` and `embeddingDim()`.
- Storing an embedding with no dimensions fails instead of succeeding. A zero-length vector packs
  to an empty blob and records a width of `0`, and search then compares nothing against nothing and
  scores the row, so an embedder that failed and returned an empty array left rows in the store that
  had never held a vector, scoring against every query, with nothing to say so. A width that merely
  differs from the configured one is still stored: rows carry their own width and search compares at
  the narrower of the two, which is what lets a store outlive a model change.
- A memory recorded as `false` now stays out of recall results. `Veracity` was declared five
  times in this package with different value sets, and the narrowest of them validated writes:
  `clampVeracity("false")` returned `"unknown"`, so a fact something had checked and rejected
  was rewritten to unlabelled on the way in and scored 0.8 instead of 0 on the way out, which
  is most of the way to being retrieved normally. The same clamp demoted `true` and
  `likely_true` from 1.0 to 0.8, `aggregateVeracity(["true", "true"])` returned `"unknown"`
  because the guard filtered both inputs out before counting them, and each of those printed a
  warning about a value this package writes itself. `remember()` had a sixth private table that
  omitted `likely_true` and clamped it away with no warning at all. The vocabulary now lives in
  `core/veracity.ts` and is derived from the weight table, so a value cannot exist without a
  weight, and the read path indexes that table instead of falling through
  `?? VERACITY_WEIGHTS.unknown ?? 0.8`. The five weights that were already live are unchanged,
  so an existing store is not re-ranked.
- `contested` is gone from the veracity vocabulary. It was a member of the nine-value union in
  `core/beam/types.ts` and appeared nowhere else: nothing wrote it, no table weighted it, and it
  reached recall's fallback chain and scored exactly like an unlabelled memory.
- The `onnxruntime-node` peer pin is back to the version `fastembed` actually links against. It read `1.26.0` while `fastembed@2.1.0` declares an exact `onnxruntime-node: 1.21.0`, so a consumer that installed what the manifest asked for provided an ORT the native addon does not link, which shows up as a load failure at the first embed rather than as an install error. The pin is `1.21.0` again, and the test that guards the pairing now reads fastembed's own declared dependency instead of a hardcoded number, so the next fastembed bump either agrees or fails the check.

### Removed

- Removed the local-GGUF LLM tier, which had no implementation behind it. `callLocalLlm` was a
  one-line `return null` with a `_prompt` it did not read, and `localGgufAvailable` was declared
  `(): false`, so its return type said it could never be anything else. Nothing in the package
  loaded a GGUF model, and the README has said local GGUF is unavailable since 1.0.0. Fact
  extraction still ran the tier around those stubs: every extraction that reached it recorded an
  attempt, called the stub, and wrote a `model_not_loaded` failure into the diagnostics before
  falling through to the pattern extractor that was always going to do the work. Reading those
  diagnostics, an operator saw a missing model where nothing had ever tried to load one, which is a
  cause that cannot be acted on. The tier is gone, the diagnostics now report only the tiers that
  exist, and the `local` tier means the pattern extractor. `MNEMOPI_FORCE_LOCAL` keeps its spelling
  and its effect, suppressing the remote backend, since renaming it would silently re-enable network
  calls for anyone who had set it; it never selected a local backend.
- Removed three directory barrels that nothing imported, `src/core/migrations/index.ts`, `src/dr/index.ts` and `src/migrations/index.ts`, together with the whole `src/migrations/` directory. Both files in it only re-exported `src/core/migrations/e6-triplestore-split.ts`, so the migration's public surface was declared in three places at once and none of them was the one callers used. Import the module directly: `@veyyon/mnemopi/core/migrations/e6-triplestore-split` for the triplestore-split migration and `@veyyon/mnemopi/dr/recovery` for disaster recovery, which is what the tests and `core/beam` already did. The removed subpaths (`@veyyon/mnemopi/dr/index`, `@veyyon/mnemopi/migrations/*`, `@veyyon/mnemopi/core/migrations/index`) resolved through the wildcard export rather than a declared entry.

## [1.0.33] - 2026-07-24

### Fixed

- `BankManager.renameBank` now validates the source bank name, not only the destination. Every other bank operation rejects a name containing a path separator or `..`, but rename validated only the new name, so a source name like `../outside` escaped the bank store and silently moved an out-of-tree directory into it. Both names are now validated before any filesystem change.

## [1.0.32] - 2026-07-24

### Fixed

- Content-addressed blob storage now writes crash-atomically. `storeBlob` wrote the extracted blob straight to its final `sha256`-named path with `writeFileSync`, so a crash mid-write left a truncated file whose bytes no longer matched its name; the `existsSync` fast-path then treated that corrupt blob as present forever and every reader silently got wrong bytes. The write now goes through a sibling temp and rename, so a blob is always either absent or the exact correct bytes.
- The one-time legacy triples-database migration now copies crash-atomically. It wrote the old database into its new location with `copyFileSync`, which streams bytes into the destination, so a crash mid-copy left a truncated SQLite file that the `existsSync` guard then treated as a completed migration, silently losing the triple store. The copy now goes through a sibling temp and rename, so the destination only ever appears as the whole, valid database.

## [1.0.24] - 2026-07-24

### Fixed

- A throwing memory-stream listener now surfaces its error instead of being swallowed.
- Conversation text is now substituted into the extraction prompt verbatim.
- The SHMR and scratchpad environment tunables are now parsed through `envInt`/`envFloat`, so a malformed value is handled consistently rather than silently.
- Named times (for example `noon`) are now matched as whole words rather than substrings.
- Removed decorative voice weights that never reached RRF scoring, so recall ranking reflects only the weights that actually apply.
