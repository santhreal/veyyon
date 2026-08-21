# Whole-Product Rust Conformance and Bug-Discovery Engine

Technical architecture and implementation plan for replacing the TypeScript test surface and the simulations package (`packages/simulations`) with a unified Rust conformance crate (`crates/veyyon-conformance`).

Tracking issue: [#877](https://github.com/santhreal/veyyon/issues/877).

## System Architecture

The conformance engine is an out-of-process verification and differential testing harness located at `crates/veyyon-conformance`. It validates observable product behavior against formal specifications, deterministic state machines, and independent reference oracles.

```
+-----------------------------------------------------------------------------------+
|                            crates/veyyon-conformance                              |
+-----------------------------------------------------------------------------------+
|  +---------------------+  +----------------------+  +--------------------------+  |
|  |  Corpus Generator   |  | Materialized Corpus  |  |   Independent Oracles    |  |
|  | (proptest/grammar)  |  |  (250,000 JSONL)     |  | (Differential/Algebraic) |  |
|  +----------+----------+  +----------+-----------+  +------------+-------------+  |
|             |                        |                           |                |
|             +------------------------v---------------------------+                |
|                                      |                                            |
|                         +------------v------------+                               |
|                         |    Conformance Runner   |                               |
|                         +------------+------------+                               |
|                                      |                                            |
|             +------------------------+------------------------+                   |
|             |                        |                        |                   |
|  +----------v----------+  +----------v-----------+  +---------v----------------+  |
|  | Virtual Environment |  | Discovery Engines    |  | Mutation & Shrink Engine |  |
|  | - Virtual PTY       |  | - State Machine Fuzz |  | - AST / Sequence Shrink  |  |
|  | - Fault VFS         |  | - Concurrency Stress |  | - 1,000+ Killed Mutants  |  |
|  | - Deterministic Clk |  | - AFL++ / libFuzzer  |  | - Trace Minimizer        |  |
|  | - Mock Provider Srv |  | - Differential Spec  |  |                          |  |
|  +----------+----------+  +----------------------+  +--------------------------+  |
+-------------|---------------------------------------------------------------------+
              | (Drives un-instrumented compiled binary via PTY, VFS, and stdio)
+-------------v---------------------------------------------------------------------+
|                      Compiled Veyyon Product Binary                               |
|                 (CLI, TUI, Workers, Core Runtime Engine)                          |
+-----------------------------------------------------------------------------------+
```

### Module Organization

The `crates/veyyon-conformance` crate is partitioned into targeted modules:

- `src/corpus/`: Schema definitions, deterministic serialization, materialization, and canonical BLAKE3 deduplication.
- `src/generator/`: Combinatorial, grammar-based, and property-based case generators using reproducible PRNG seeds.
- `src/oracle/`: Independent reference models, algebraic invariants, state-transition assertions, and schema validators.
- `src/vfs/`: In-memory copy-on-write virtual filesystem with configurable POSIX fault injection (`EIO`, `ENOSPC`, `EACCES`, partial reads/writes, race windows).
- `src/vpty/`: VT100/xterm pseudoterminal emulator capturing ANSI escape streams, terminal resize events, raw input feeds, and 2D cell-grid states.
- `src/vclock/`: Virtual monotonic time provider controlling timers, tick schedules, timeout expirations, and deadline accelerations without wall-clock sleeps.
- `src/vmock/`: HTTP/1.1 and HTTP/2 mock engine serving deterministically chunked Server-Sent Events (SSE), protocol jitter, token streaming, and simulated upstream outages.
- `src/render/`: Dual-ground rasterizer and cell-grid comparator rendering ANSI output to pixel grids on `#1e2127` (grey) and `#000000` (black) grounds.
- `src/fuzz/`: libFuzzer and AFL++ harnesses for raw parser inputs, wire formats, Argot codec tokens, and hashline patches.
- `src/model_check/`: State-machine model checker verifying session tree invariants, state transitions, tool execution lifecycles, and lock acquisition graphs.
- `src/mutation/`: Source AST and bytecode mutation engine verifying test sensitivity with a mandatory gate of >= 1,000 killed mutants.
- `src/shrink/`: Hierarchical delta-debugging engine that minimizes failing input sequences, environment sizes, and VFS trees into minimal reproducing test cases.
- `src/report/`: Deterministic JUnit, SARIF, and JSON artifact reporter recording complete failure bundles with seed, VFS state, PTY log, and shrink traces.

---

## Corpus Allocation and Subsystem Contracts

The materialized conformance corpus contains exactly 250,000 distinct JSONL test vectors. It enforces 4,496 exact expected-error contracts across all sixteen production subsystems.

### Subsystem Allocation Matrix

| ID | Subsystem | Scope | Total Cases | Exact Error Contracts |
|---|---|---|---|---|
| 01 | Rendering & Terminal UI | Cell-grid layouts, ANSI sanitization, dual-ground raster proofs, streaming HUD, transcript rebuilds, wide/combining glyphs | 20,000 | 384 |
| 02 | AI Providers & Streaming | SSE parser, token accumulator, chunk streaming, error boundaries, auth retry, backoff jitter, thinking blocks | 24,000 | 480 |
| 03 | Tool Execution Runtime | Tool dispatch, parameter validation, schema checks, process lifecycles, streaming preview decoders, timeout traps | 26,000 | 512 |
| 04 | Session & Tree Engine | Fork, resume, branch switching, history serialization, compaction checkpoints, export/share formats, tree merges | 20,000 | 320 |
| 05 | Persistence & Mnemopi | SQLite storage, WAL lifecycle, schema migrations, triple index, vector recall, cache coherence, crash recovery | 16,000 | 256 |
| 06 | Concurrency & Agent Mesh | Swarm mesh, IRC bus routing, subagent spawning, task worker pools, deadlock avoidance, lock hierarchies | 14,000 | 256 |
| 07 | Security & Sandbox | Path traversal guards, credential boundary isolation, secret redaction, prompt injection fences, environment isolation | 14,000 | 384 |
| 08 | CLI Engine & Modes | Argv parser, flag resolution, command dispatch, pipe mode, headless execution, TUI bootstrap, worker selectors | 16,000 | 256 |
| 09 | Installers & Distribution | POSIX `install.sh`, Windows `install.ps1`, GitHub release asset verification, SHA-256 sidecars, self-updater | 10,000 | 192 |
| 10 | Workers & Subprocesses | Tiny inference worker, JS eval worker, stats sync worker, tab worker, host entrypoint dispatch, IPC channels | 12,000 | 192 |
| 11 | Configuration & Settings | Domain schema validation, cascade resolution (Home -> Profile -> Project), conditions, env overrides, flag bindings | 12,000 | 192 |
| 12 | Context & Compaction | Token budget accounting, sliding-window truncation, message compaction, TTSR injection, handoff generation | 14,000 | 224 |
| 13 | Memory Engine & Vectors | Fact extraction, embedding vector math, similarity recall, query ranking, SQLite store, cache eviction | 12,000 | 160 |
| 14 | Editing & Hashline Engine | Hashline syntax parsing, snapshot tag verification, hunk application, conflict resolution, AST rewrites, undo/redo | 16,000 | 288 |
| 15 | LSP Client & Diagnostics | JSON-RPC transport, protocol framing, document synchronization, diagnostic parsing, symbol resolution, crash restart | 10,000 | 160 |
| 16 | Wire Protocol & Argot | Collab wire messages, guest client relay, Argot shorthand codec, token boundary expansion, handle streaming | 14,000 | 240 |
| **Total** | | | **250,000** | **4,496** |

The manifest generator computes both total columns from the sixteen allocations and rejects the manifest unless they equal 250,000 and 4,496. The rendered total row is generated from those computed values; it is never an independently maintained literal.

---

## Production-Path Execution Rules

To eliminate self-fulfilling tests and mock drift, the test harness adheres to strict execution invariants:

1. **Zero Production Logic in Fakes**: No shadow reimplementations of TypeScript or Rust production logic exist in test helpers. All production code paths run from compiled binaries or un-instrumented native crates.
2. **Migration Precedence**: Production logic must be ported to Rust crates (`crates/veyyon-*`) before Rust unit tests claim to cover it directly. TypeScript production logic is exercised strictly by driving the compiled CLI binary through virtual PTY, VFS, and virtual network interfaces.
3. **Black-Box Process Boundaries**: The conformance harness drives `target/release/veyyon` via standard POSIX streams (`stdin`, `stdout`, `stderr`), pseudo-terminal devices, and injected virtual filesystem environments.
4. **Observable Contract Verification**: Assertions check observable output streams, filesystem state changes, exit codes, PTY cell grids, and wire packets. Internal function pointers, private variables, and memory layouts are not asserted.
5. **No Mock Libraries**: Production code paths cannot link against mock-injecting libraries. All environment manipulation occurs outside the process boundary via interception at the operating system interface.

---

## Virtual Environment Subsystems

The execution harness provides complete isolation and determinism without requiring root privileges or external containers.

```
+-----------------------------------------------------------------------------------+
|                           Virtual Execution Harness                               |
+-----------------------------------------------------------------------------------+
|  +--------------------+  +--------------------+  +-----------------------------+  |
|  |     Virtual PTY    |  |     Virtual VFS    |  |     Virtual Time & Mock     |  |
|  |  (vpty::Terminal)  |  |   (vfs::Overlay)   |  |      (vmock::Engine)        |  |
|  +---------+----------+  +---------+----------+  +--------------+--------------+  |
|            |                       |                            |                 |
|            | Terminal IO           | Filesystem IO              | HTTP/SSE Wire   |
|            v                       v                            v                 |
|  +-----------------------------------------------------------------------------+  |
|  |                        Target Veyyon Process                                |  |
|  +-----------------------------------------------------------------------------+  |
+-----------------------------------------------------------------------------------+
```

### 1. Virtual PTY (`vpty`)

- Emulates standard terminal dimensions (configurable cols/rows from 20x5 to 400x120).
- Implements full ANSI X3.64 / VT100 / xterm escape code parsing.
- Maintains a real-time 2D cell grid containing character codepoints, foreground/background 24-bit RGB colors, bold, dim, italic, underline, inverse, and strikethrough attributes.
- Simulates arbitrary terminal resize events (`SIGWINCH`) at designated clock ticks.
- Injects raw byte sequences (keystrokes, bracketed paste, mouse events, signal keys `Ctrl+C`, `Ctrl+D`) with microsecond-accurate virtual timestamps.

### 2. Virtual Filesystem (`vfs`)

- In-memory hierarchical filesystem implementing POSIX file semantics.
- Provides copy-on-write isolation per test shard to eliminate test crosstalk.
- Programmable Fault Injection Engine:
  - `InjectFault::Eio(path_glob, operation_mask)`
  - `InjectFault::Enospc(path_glob, threshold_bytes)`
  - `InjectFault::Eacces(path_glob, permission_bits)`
  - `InjectFault::PartialWrite(path_glob, max_bytes_per_call)`
  - `InjectFault::Latency(path_glob, virtual_delay_micros)`
  - `InjectFault::TornWrite(path_glob, crash_at_byte)`
- Tracks all path operations (reads, writes, stats, readdirs, unlinks) for post-run invariant assertions.

### 3. Virtual Clock and Deterministic Scheduler (`vclock`)

- Intercepts time query syscalls (`clock_gettime`, `gettimeofday`) and runtime APIs.
- Replaces wall-clock sleeps with instant discrete-event simulation ticks.
- Guarantees identical execution ordering across varying CPU architectures and core counts.
- Enforces deadline expiration and watchdog triggers deterministically.

### 4. Virtual Mock Provider Engine (`vmock`)

- Embedded HTTP/1.1 and HTTP/2 loopback server bound to ephemeral UNIX domain sockets.
- Intercepts all outgoing LLM provider API requests (`OpenAI`, `Anthropic`, `Gemini`, `Ollama`, custom endpoints).
- Delivers chunked Server-Sent Events (SSE) token by token, supporting:
  - Custom streaming chunk sizes (1 byte to 1024 bytes per chunk).
  - Mid-stream network drops (`ECONNRESET`, `ETIMEDOUT`).
  - Injected upstream HTTP errors (`401 Unauthorized`, `429 Rate Limit Exceeded` with `Retry-After`, `500 Internal Server Error`, `503 Service Unavailable`).
  - Malformed SSE payloads (truncated JSON, invalid utf-8, unexpected thinking block structures).

### 5. Source-Derived Provider Conformance Matrix

Provider conformance begins at raw HTTP bytes and ends after session persistence
and tool execution. Replacing a provider module with normalized events is not a
provider conformance test because it bypasses framing, decoding, accumulation,
terminal classification, and transport error handling.

The corpus generator derives its provider population from production data:

1. Enumerate every registered provider descriptor and bundled/custom model.
2. Resolve each model's production API and compatibility policy.
3. Group models by the parser and policy that execute them.
4. Require every group to name a conformance policy and corpus allocation.
5. Reject an unclassified provider, API, compatibility flag, or terminal policy.

Provider names are metadata on cases, not a hardcoded test list. Adding a
provider that resolves to `openai-completions`, for example, automatically
places it in that wire matrix and makes the corpus count/digest gate red until
the materialized cases are regenerated and reviewed.

#### Raw framing dimensions

For each applicable API and policy, `vmock` emits:

- LF and CRLF SSE records;
- comments, blank events, multiple `data:` fields, and unknown fields;
- one SSE event per transport chunk;
- several SSE events in one transport chunk;
- every meaningful JSON token split boundary;
- every UTF-8 code-point split boundary;
- terminal and usage events in separate or combined transport chunks;
- HTTP/1.1 chunked bodies and HTTP/2 data frames;
- a socket that remains open after an authoritative terminal event.

#### Semantic output dimensions

The framing dimensions cross with:

- no output and whitespace-only output;
- text;
- reasoning only;
- reasoning followed by text;
- one and several complete tool calls;
- interleaved parallel tool-call deltas;
- tool calls missing an id or name;
- empty, truncated, malformed, primitive, array, and object arguments;
- text plus complete or incomplete tool calls;
- reasoning plus complete or incomplete tool calls.

#### Terminal and failure dimensions

The output shapes cross with:

- `finish_reason` values `stop`, `tool_calls`, `length`, and content filtering;
- provider refusal records;
- usage before, with, and after the terminal event;
- usage without an explicit finish reason;
- `[DONE]` with and without semantic terminal output;
- clean HTTP body EOF;
- empty EOF;
- `ECONNRESET`, `ETIMEDOUT`, DNS failure, TLS failure, and caller cancellation;
- first-event and next-event timeouts;
- malformed SSE, truncated JSON, and invalid UTF-8;
- HTTP 401, 403, 408, 409, 429, 500, 502, 503, and 504;
- `Retry-After` seconds and dates;
- retry exhaustion and replay-unsafe partial batches.

The generator uses pairwise/covering-array selection for noninteracting
dimensions and exhaustive multiplication where dimensions interact, such as
terminal signal by output completeness and transport fault by retry safety. The
24,000 provider cases are fixed after semantic deduplication, not by truncating
an oversized generated list.

#### Required provider invariants

Every matching case asserts all applicable invariants:

- Clean EOF succeeds only for semantically self-contained output.
- Reasoning-only clean EOF becomes bounded incomplete-output recovery, not a
  successful empty answer.
- Empty EOF remains a retryable incomplete-stream failure.
- A transport exception never becomes clean EOF.
- No incomplete tool call reaches execution.
- A partial structured call wins over accompanying text or reasoning.
- Complete parallel tool batches preserve ids, ordering, arguments, and replay
  safety.
- An authoritative terminal event settles within its deadline even when the
  provider keeps the socket open.
- Retry policy preserves the structured failure and never duplicates committed
  output.
- Persisted history contains the delivered attempt and excludes discarded retry
  fragments.
- Every retry, backoff, and timeout path terminates within its asserted bound.

Each case records the exact emitted event sequence, final stop reason,
structured content, error identity, retryability, recovery decision, persisted
messages, tool side effects, and virtual-clock duration.

#### Production incident intake

Fleet incidents enter the corpus as synthetic structural fixtures. Raw sessions,
prompts, assistant content, credentials, paths, and logs never enter the
repository. A reducer maps each incident to:

`API + compatibility policy + terminal signal + output shape + framing + fault + expected outcome`

The canonical value is hashed before insertion. An existing hash links the
incident to established coverage; a new hash creates a minimized generated case
and mutation target. This closes a defect class without publishing conversation
content or accumulating one fixture per model report.

#### Compiled-product proof

The direct parser corpus is necessary but insufficient. A compiled-product arm:

1. Creates an isolated profile with generated provider/model configuration.
2. Launches the release-mode Veyyon binary in noninteractive mode.
3. Routes the selected model to `vmock`.
4. Drives the raw wire case through model resolution, provider dispatch,
   parsing, session policy, persistence, and tool execution.
5. Asserts stdout/stderr, exit status, bounded termination, provider requests,
   persisted session state, and filesystem side effects.

The compiled arm samples every semantic family for every production provider
policy. The direct parser arm performs exhaustive framing fragmentation. A
generated coverage manifest proves that every provider policy appears in both.

---

## Rendering Cell-Grid and Raster Proofs

Terminal UI verification strictly rejects tmux dump verification. Visual proof requires dual-ground rendering and exact cell-grid state checks.

### 1. Terminal Dimensions and Geometry Matrix

All UI components are rendered and verified across six standardized terminal viewports:

| Viewport Profile | Width (Cols) | Height (Rows) | Focus |
|---|---|---|---|
| `Micro` | 40 | 10 | Extreme overflow, aggressive truncation, boundary ellipsis |
| `Standard POSIX` | 80 | 24 | Default compatibility baseline, standard wrapping |
| `Medium Modern` | 100 | 30 | Standard developer terminal, side-by-side split panels |
| `Large Modern` | 120 | 40 | Multi-column layouts, expanded tool previews, status rails |
| `Ultra-Wide` | 200 | 50 | Full horizontal expansion, trace dashboards, diff panels |
| `Mega Display` | 300 | 80 | Maximized canvas, complex swarm topology rendering |

### 2. Dual-Ground Rasterization Protocol

Visual artifacts are verified by rasterizing ANSI terminal buffers to lossless 24-bit PNG images under two distinct background grounds:

1. **Grey Ground (`#1e2127`)**: Standard editor/terminal theme ground.
2. **Black Ground (`#000000`)**: Pure dark terminal ground.

```
ANSI Escape Stream
        |
        v
+-----------------------+
|  Cell-Grid Parser     | --> Extract 2D Matrix of (Glyph, FG, BG, Modifiers)
+-----------+-----------+
            |
            v
+-----------------------+
| Software Rasterizer   |
+-----+-----------+-----+
      |           |
      v           v
Grey PNG       Black PNG
(#1e2127)      (#000000)
      \           /
       v         v
+-----------------------+
|   Pixel Diff & Slab   | --> Fail if dark background fill produces invisible contrast
|   Detection Engine    |     on black or un-themed slab on grey
+-----------------------+
```

### 3. Unicode, Width, and Typography Assertions

- **Grapheme Clustering**: Verifies single-width allocation for complex extended grapheme clusters (UAX #29).
- **East Asian Width**: Enforces exact column-width calculations (East Asian Wide `W` and Fullwidth `F` take 2 cells; Narrow `Na` and Neutral `N` take 1 cell according to UAX #11).
- **Combining Marks**: Validates zero additional cell width for combining diacritics and zero-width joiner sequences (ZWJ emoji sequences).
- **ANSI Sanitization**: Ensures tabs are converted to spaces via `replaceTabs()`, line breaks are sanitized, and terminal control sequences are stripped from user-generated content.

### 4. Streaming vs. Rebuild Path Equivalence

The rendering engine verifies frame-by-frame equivalence between:
- **Live Streamed Preview**: Incremental frame updates pushed via `decodeStreamedToolArgs` / `ToolArgsRevealController` during active tool execution.
- **Static Transcript Rebuild**: Complete re-render of completed turns constructed from saved session JSON logs.
- Invariant: The cell-grid state of a completed live-streamed tool run must be identical to the cell-grid state of the reconstructed transcript item.

---

## Corpus Generation, Deduplication, and Shrinking

### 1. Case Generation Pipeline

Corpus records are generated via deterministic pseudorandom property engines:

```rust
pub struct ConformanceTestCase {
    pub case_id: [u8; 32],
    pub subsystem_id: u16,
    pub contract_id: u32,
    pub input_vector: serde_json::Value,
    pub env_config: VirtualEnvironmentConfig,
    pub fault_plan: Option<FaultPlan>,
    pub oracle_spec: OracleSpecification,
    pub expected_outcome: ExpectedOutcome,
}
```

- **Combinatorial Parameter Sweeps**: Systematic coverage of enum states, configuration flags, boundary values (`0`, `1`, `u32::MAX - 1`, `u32::MAX`, empty strings, 64KB strings, non-UTF8 buffers).
- **Grammar-Based Fuzzing**: Structural generators producing syntactically valid and invalid ASTs, JSONL traces, tool calls, and Argot shorthand scripts.
- **State-Machine Exploration**: Random walk and exhaustive transition matrix traversal across valid and invalid session lifecycles.

### 2. Deduplication and Collision Rejection

Every test case is identified by a canonical BLAKE3 content digest calculated over its normalized semantic payload:

$$\text{Digest} = \text{BLAKE3}\left(\text{subsystem} \parallel \text{contract} \parallel \text{canonical\_json}(\text{input}) \parallel \text{fault\_plan} \parallel \text{oracle\_spec}\right)$$

- The corpus builder indexes all 250,000 cases in a lock-free hash set.
- Duplicate case detection during generation immediately aborts the build with a duplicate key error.
- All 250,000 cases in the committed corpus are mathematically unique.

### 3. Independent Oracles

Tests are judged against three independent oracle architectures:

1. **Differential Specification Oracles**: Pure mathematical implementations of core algorithms (e.g., token counters, diff patchers, text search engines) written from specification standards without shared code.
2. **Algebraic Property Invariants**:
   - Invertibility: $\text{decode}(\text{encode}(x)) == x$ (Argot codec, wire framing, session persistence).
   - Commutativity / Idempotence: $\text{format}(\text{format}(x)) == \text{format}(x)$, $\text{apply}(\text{apply}(s, p_1), p_2) == \text{apply}(\text{apply}(s, p_2), p_1)$ for disjoint patches.
   - Monotonicity: Token compaction never increases token length; progress counters strictly increment.
3. **State Machine Assertions**: Formal invariant guards asserting that unauthorized transitions (e.g., executing tools in an uninitialized session or mutating a closed channel) strictly trigger expected-error contracts.

### 4. Shrinking Engine

When a test failure occurs during discovery or fuzzing, the shrinking engine reduces the failure vector before writing the failure report:

```
Unshrunk Failing Case (e.g., 2,000 tool steps, 50KB payload, 10 VFS faults)
                         |
                         v
          +------------------------------+
          | Hierarchical Delta Debugging |
          +--------------+---------------+
                         |
                         v
           [Step 1: Slice Action Sequence]
           [Step 2: Minimize VFS Tree]
           [Step 3: Binary-Shrink Byte Buffers]
           [Step 4: Prune Inactive Faults]
                         |
                         v
Minimized Minimal Reproducer (3 tool steps, 42 bytes, 1 precise VFS fault)
```

The resulting minimal reproducer is serialized as a standalone JSONL record with a replay harness.

---

## Discovery Engines

`crates/veyyon-conformance` integrates specialized bug-discovery engines:

```
+-----------------------------------------------------------------------------------+
|                            Bug Discovery Engines                                  |
+-----------------------------------------------------------------------------------+
|  +---------------------+  +----------------------+  +--------------------------+  |
|  | State-Machine Check |  | Concurrency Stress   |  | Parser & Protocol Fuzz   |  |
|  | - Session Tree Walk |  | - ThreadSanitizer/TSAN| | - AFL++ & libFuzzer      |  |
|  | - Tool Lifecycle    |  | - Loom Permutations  |  | - Argot / Wire Formats   |  |
|  | - Lock Acquisition  |  | - Preemption Jitter  |  | - Hashline / Diff Engine |  |
|  +---------------------+  +----------------------+  +--------------------------+  |
+-----------------------------------------------------------------------------------+
```

### 1. State-Machine Model Checking

- Models the complete lifecycle of sessions, tasks, subagents, and tools as formal state graphs.
- Generates exhaustive sequences up to depth $k=12$ to detect unreachable states, unhandled events, and unexpected terminal deadlocks.
- Validates that state persistence (SQLite snapshots) correctly resumes into equivalent in-memory state models.

### 2. Concurrency Stress and Lock Discovery

- Uses Loom and ThreadSanitizer (TSAN) harnesses to explore all thread preemption interleavings in worker pools, swarm routers, and native caches.
- Detects data races, double-checked locking defects, lock inversion deadlocks, and missed channel wakeups.
- Injects microsecond scheduling delays around atomic compare-and-swap operations.

### 3. Fuzzing Harnesses (AFL++ and libFuzzer)

- Integrated continuous fuzzing targets:
  - `fuzz_hashline`: Validates patch parsing against adversarial and corrupted patch strings.
  - `fuzz_argot_codec`: Fuzzes handle expansion against pathological byte sequences and boundary splits.
  - `fuzz_wire_proto`: Fuzzes collab-web guest protocol deserialization.
  - `fuzz_catalog_resolver`: Fuzzes model-thinking and provider catalog matching against unstructured JSON dictionaries.

---

## Mutation Testing Engine

To ensure test effectiveness, the conformance suite is validated against a comprehensive mutation test pipeline.

```
+-----------------------------------------------------------------------------------+
|                              Mutation Engine Pipeline                             |
+-----------------------------------------------------------------------------------+
|  +---------------------+  +----------------------+  +--------------------------+  |
|  | AST Mutation Engine |  | Sandboxed Execution  |  | Sensitivity Verification |  |
|  | - 1,200+ Mutants    |  | - Sharded Conformance|  | - Assert >= 1,000 Killed |  |
|  | - 8 Mutation Kinds  |  | - Early-Exit on Red  |  | - Zero Surviving Critical|  |
|  +---------------------+  +----------------------+  +--------------------------+  |
+-----------------------------------------------------------------------------------+
```

### Mutation Operators

The mutation engine injects the following structural defects into compiled crates and native modules:

1. **Boundary Mutation**: Modifying comparison operators (`<` to `<=`, `>` to `>=`, `==` to `!=`).
2. **Conditional Inversion**: Inverting branch conditions (`if cond` to `if !cond`).
3. **Arithmetic Substitution**: Swapping arithmetic operators (`+` to `-`, `*` to `/`, bitwise shifts).
4. **Statement Deletion**: Removing authorization checks, cache invalidations, and flush calls.
5. **Constant Replacement**: Mutating numeric constants (`0` to `1`, `timeout_ms` to `0` or `u64::MAX`).
6. **Error Suppression**: Replacing `Err(e)` with `Ok(default)` or dropping propagated `?` operators.
7. **Lock Bypassing**: Removing lock acquisition guards around shared memory structures.
8. **String / Identifier Corruption**: Mutating configuration keys, SQL queries, and prompt template strings.

### Mutation Gate Requirement

- The engine evaluates a minimum of **1,200 distinct mutations** across critical production paths.
- **Pass Requirement**: The test suite must kill at least **1,000 mutations** (minimum mutation score of **83.3%**).
- Any mutant on security boundaries, path traversal guards, or hash verifiers that survives execution constitutes an immediate gate failure.

---

## Migration Waves and Decommissioning Plan

The migration from TypeScript test suites and `packages/simulations` to `crates/veyyon-conformance` proceeds in five sequential waves.

```
+-----------------------------------------------------------------------------------+
|                            Five-Wave Migration Plan                               |
+-----------------------------------------------------------------------------------+
| [Wave 0: Infrastructure]  --> Scaffold crates/veyyon-conformance, VFS, VPTY, vmock |
|           |                                                                       |
| [Wave 1: Stateless Core]  --> Migrate Argot, Hashline, Wire, Utils, Catalog      |
|           |                                                                       |
| [Wave 2: Native & State]  --> Migrate Natives, Persistence, Memory, AI Providers  |
|           |                                                                       |
| [Wave 3: Agent & Runtime] --> Migrate Coding Agent, Tools, Sessions, Compaction   |
|           |                                                                       |
| [Wave 4: UI & CLI Binary] --> Migrate TUI, Renderers, Workers, CLI Subcommands    |
|           |                                                                       |
| [Wave 5: Decommission]   --> Delete TS tests, Delete packages/simulations, CI Cut |
+-----------------------------------------------------------------------------------+
```

### Wave 0: Harness & Virtual Infrastructure Construction

- Construct `crates/veyyon-conformance` crate structure and dependencies.
- Implement `vfs`, `vpty`, `vclock`, and `vmock` engines.
- Build the 250,000-case generator, deduplication validator, and JSONL materializer.
- Establish baseline JUnit and SARIF reporting.

### Wave 1: Stateless Core, Parsers, Wire Protocols, and Argot

- Migrate each production implementation before claiming direct Rust coverage:
  - `packages/argot` -> a production `veyyon-argot` crate
  - `packages/hashline` -> a production `veyyon-hashline` crate
  - `packages/wire` -> a production `veyyon-wire` crate
  - `packages/catalog` -> production Rust catalog crates
- Keep independent conformance oracles declarative: they describe invariants and expected records but never reimplement the production algorithm.
- Materialize 35,000 cases and 560 error contracts.
- **Gate**: 100% pass on the Wave 1 corpus through the migrated production crates and compiled product; delete each corresponding TypeScript test only after the generated migration inventory proves one-for-one contract coverage.

### Wave 2: Native Subsystems, Persistence, Memory, and AI Providers

- Port and verify contracts for:
  - `packages/natives` & `crates/veyyon-natives`
  - `packages/mnemopi` & SQLite persistence
  - `packages/ai` streaming and token accumulation
- Materialize 60,000 cases and 1,024 error contracts.
- **Gate**: 100% pass on Wave 2 corpus; delete tests in `packages/natives/test`, `packages/mnemopi/test`, `packages/ai/test`.

### Wave 3: Agent Runtime, Tool Execution, Sessions, and Compaction

- Port and verify contracts for:
  - `packages/agent` core runtime
  - `packages/coding-agent` tool execution pipeline, enumerated from the live registry so every current or newly added tool requires coverage
  - Session branching, resume, checkpoints, compaction, TTSR
- Materialize 75,000 cases and 1,408 error contracts.
- **Gate**: 100% pass on Wave 3 corpus; delete tests in `packages/agent/test`, `packages/coding-agent/src/tools/**/test`.

### Wave 4: TUI Rendering, CLI Modes, Workers, and Installers

- Port and verify contracts for:
  - Terminal UI rendering across all viewports and dual grounds
  - Worker subprocess lifecycles (`stats`, `js_eval`, `tiny_inference`, `tab`)
  - CLI flag parsing, dispatch, and error output
  - Distribution installers (`install.sh`, `install.ps1`)
- Materialize 80,000 cases and 1,504 error contracts.
- **Gate**: 100% pass on Wave 4 corpus; delete tests in `packages/tui/test`, `packages/coding-agent/src/modes/**/test`, `scripts/install-tests`.

### Wave 5: Parity Certification, Simulation Deletion, and Final Cutover

1. **Parity Certification**: Run complete 250,000-case suite against release binary; assert zero failures.
2. **Mutation Gate Run**: Execute mutation engine; certify >= 1,000 killed mutants.
3. **Simulation Package Fold & Deletion**:
   - Transfer any remaining non-redundant scenario definitions from `packages/simulations` into `crates/veyyon-conformance`.
   - Delete `packages/simulations` directory and remove workspace entries from `package.json` and `tsconfig.json`.
4. **Final TS Test Elimination**: Delete all remaining `.test.ts` files across the workspace.
5. **CI Pipeline Migration**:
   - Update `.github/workflows/ci.yml` and `checks.yml` to remove `bun test` jobs.
   - Wire `cargo test -p veyyon-conformance` with parallel sharding into the primary CI gate.

---

## CI Sharding and Reproducible Reporting

### 1. Parallel Sharding Strategy

The 250,000-case corpus is sharded across $N$ parallel CI runners (default $N=16$ or $N=32$):

$$\text{Shard}(c) = \text{BLAKE3}(c.\text{case\_id}) \pmod N$$

- Deterministic hashing guarantees even distribution across shards without dynamic scheduling overhead.
- Shards run concurrently with an execution budget ceiling of **< 3 minutes per shard** on standard 4-core runners.

### 2. Deterministic Reporting Artifacts

When any case fails, the runner writes an isolated artifact directory named by case ID:

```
target/conformance-reports/
  ├── summary.json                 # Aggregate execution statistics and timings
  ├── junit.xml                    # Standard CI test matrix integration
  └── failures/
      └── [CASE_ID]/
          ├── case.json            # Exact input vector and environment spec
          ├── seed.txt             # 64-bit PRNG seed for standalone reproduction
          ├── vfs_snapshot.tar.gz  # Serialized VFS state at failure point
          ├── pty_transcript.raw   # Exact binary ANSI output stream
          ├── pty_grid.txt         # 2D cell-grid state dump
          ├── render-grey.png      # Rasterized screenshot on #1e2127 ground
          ├── render-black.png     # Rasterized screenshot on #000000 ground
          └── shrink_trace.log     # Step-by-step delta debugging log
```

### 3. Standalone Reproduction CLI

Any failure is replayed locally with a single self-contained command:

```sh
cargo run -p veyyon-conformance --bin replay -- --case [CASE_ID]
```

Or replaying by seed:

```sh
cargo run -p veyyon-conformance --bin replay -- --seed [SEED_U64] --subsystem [SUBSYSTEM_ID]
```

---

## Measurable Acceptance Criteria

The conformance migration is complete when all the following quantitative criteria are satisfied:

- [ ] **Corpus Integrity**: Exactly 250,000 unique JSONL cases are materialized and checked in, one executable case per line, with a pinned generator seed and a canonical digest proving no duplicate semantic payloads.
- [ ] **Error Coverage**: Exactly 4,496 specific expected-error contracts tested and verified across the 16 subsystems.
- [ ] **No Parallel Fakes**: 100% of end-to-end conformance tests drive the compiled production binary or un-instrumented Rust crates.
- [ ] **UI Dual-Ground Verification**: All TUI components verified on both `#1e2127` and `#000000` grounds across all 6 terminal dimension profiles.
- [ ] **Mutation Proof**: Mutation engine executes >= 1,200 mutants and successfully kills at least 1,000 mutants (mutation score >= 83.3%).
- [ ] **Simulations Deletion**: `packages/simulations` is deleted from disk and removed from workspace manifests.
- [ ] **TypeScript Test Deletion**: Zero `*.test.ts` files remain in `packages/` and `scripts/`.
- [ ] **CI Performance**: Complete 250,000-case suite passes in < 3 minutes wall-clock time across 16 parallel CI shards.
- [ ] **Zero Unresolved Mismatches**: Every corpus mismatch is fixed or represented by an explicit reviewed contract change across Linux x86_64, Linux aarch64, macOS x86_64, macOS aarch64, and Windows x86_64.
