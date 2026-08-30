# Whole-Product Rust Conformance and Bug-Discovery Engine

Technical architecture and implementation plan for replacing the TypeScript test surface and the simulations package (`packages/simulations`) with a unified Rust conformance crate (`tests/conformance`).

Tracking issue: [#877](https://github.com/santhreal/veyyon/issues/877).

## System Architecture

The conformance engine is an out-of-process verification and differential testing harness located at `tests/conformance`. It validates observable product behavior against formal specifications, deterministic state machines, and independent reference oracles.

```
+-----------------------------------------------------------------------------------+
|                                tests/conformance                                  |
+-----------------------------------------------------------------------------------+
|  +---------------------+  +----------------------+  +--------------------------+  |
|  |  Corpus Generator   |  | Materialized Corpus  |  |   Independent Oracles    |  |
|  | (plans and sweeps)  |  |  (250,000 JSONL)     |  | (Differential/Algebraic) |  |
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

The `tests/conformance` crate is partitioned into targeted modules:

- `src/corpus/`: Schema definitions, deterministic serialization, materialization, and canonical BLAKE3 deduplication.
- `src/generator/`: Sixteen per-subsystem plans, the family that walks their axis product to fill each allocation exactly, greedy covering arrays, and the boundary-value tables.
- `src/oracle/`: Independent reference models, algebraic invariants, state-transition assertions, and schema validators.
- `src/vfs/`: Trait-backed copy-on-write filesystem and POSIX fault injector for in-process Rust targets; real-workspace fixture materialization for compiled-product targets.
- `src/vpty/`: Cross-platform PTY/ConPTY driver plus VT100/xterm parser capturing ANSI streams, resize events, raw input, and 2D cell-grid states.
- `src/vclock/`: Virtual monotonic time and deterministic scheduling for in-process Rust targets; bounded real-time assertions for compiled-product targets.
- `src/vmock/`: Cross-platform loopback HTTP/1.1 and HTTP/2 engine serving deterministically chunked Server-Sent Events (SSE), protocol jitter, token streaming, and simulated upstream outages.
- `src/render/`: Dual-ground rasterizer and cell-grid comparator rendering ANSI output to pixel grids on `#1e2127` (grey) and `#000000` (black) grounds.
- `src/fuzz/`: libFuzzer and AFL++ harnesses for raw parser inputs, wire formats, Argot codec tokens, and hashline patches.
- `src/model_check/`: State-machine model checker verifying session tree invariants, state transitions, tool execution lifecycles, and lock acquisition graphs.
- `src/mutation/`: Source AST and bytecode mutation engine verifying test sensitivity with a mandatory gate of >= 1,000 killed mutants.
- `src/shrink/`: Hierarchical delta-debugging engine that minimizes failing input sequences, environment sizes, and VFS trees into minimal reproducing test cases.
- `src/report/`: Deterministic JUnit, SARIF, and JSON artifact reporter recording complete failure bundles with seed, VFS state, PTY log, and shrink traces.

### Canonical Case Record

Every materialized JSONL line is one self-contained `ConformanceCase`. The
schema is versioned independently from production persistence formats:

```json
{
  "schemaVersion": 1,
  "caseId": "blake3:...",
  "generator": { "family": "provider-terminal-matrix", "seed": 1592639215 },
  "subsystem": "ai-providers-streaming",
  "contract": { "id": "provider.clean-eof.complete-tool-batch" },
  "target": { "kind": "compiled-product", "entry": "veyyon" },
  "dimensions": {
    "api": "openai-completions",
    "fault": "none",
    "framing": "utf8-split",
    "outputShape": "complete-tool-batch",
    "terminal": "clean-eof"
  },
  "environment": {
    "platform": "linux-x64",
    "clock": "real-bounded",
    "filesystemFixture": "blake3:...",
    "providerFixture": "blake3:..."
  },
  "stimulus": [{ "kind": "prompt", "value": "fixture:provider/basic-tool-turn" }],
  "oracle": {
    "exitCode": 0,
    "stopReason": "toolUse",
    "maxMs": 2500,
    "toolExecutions": { "inspect": 1 },
    "stdoutFixture": "blake3:...",
    "persistedStateFixture": "blake3:..."
  },
  "coverage": {
    "registryMembers": ["api:openai-completions", "provider:fixture"],
    "requirements": ["provider-terminal-completeness", "tool-arguments-complete"]
  },
  "provenance": "generated"
}
```

`tests/conformance/src/corpus/mod.rs` is the authority for this shape;
the JSON above is what it serializes. An absent optional field is absent rather
than null, so an oracle constrains exactly what its contract names and cannot
silently accept a wider outcome than it was written for.

`caseId` is the BLAKE3 digest of `schemaVersion`, `subsystem`, `contract`,
`target.kind`, `dimensions`, `environment`, `stimulus`, and `oracle`. Those
fields are declared as their own `IdentityPayload` struct rather than derived
from the record, so adding a field to `ConformanceCase` cannot move an id unless
someone names it there. Excluded: `caseId` itself, generator metadata,
`target.entry`, coverage labels, provenance, and every execution observation, so
two generators cannot claim distinct coverage for one semantic case and
re-seeding cannot inflate the corpus. `schemaVersion` IS included, because a
schema change is a change of meaning and the ids should move with it. Fixture
values are content-addressed and secrets are forbidden.

Six field shapes are deliberate, and each of them is the fix for a way the
obvious spelling breaks the identity:

- **`dimensions` values are strings, not `serde_json::Value`.** This workspace
  builds `serde_json` with `preserve_order`, which makes a `Value` object
  insertion-ordered. A dimension map of `Value` would therefore serialize
  differently depending on which generator inserted which axis first, giving one
  case two ids. The map itself is a `BTreeMap` for the same reason.
- **`subsystem` is one kebab-case token, not `{id, name}`.** A numeric id beside
  a name is two spellings of one fact, and renaming the name would move every id
  in the subsystem.
- **`generator` names the family, not a git revision.** The family is what
  triage needs and what lets one family be regenerated without touching the
  rest. A revision would date the corpus without identifying anything in it.
- **`target.artifactDigest` does not exist.** Which binary a case ran against
  belongs to the run report: the digest changes with every release, so
  committing it into a case would invalidate the corpus on every version bump.
- **`oracle.maxMs`, not `maxVirtualMs`.** `environment.clock` already says
  whether time is virtual or real, and a compiled-product case is bounded in
  real milliseconds, so a field named for virtual time would be a lie on 5,000
  rows.
- **`oracle.toolExecutions` is a map, not a list.** A list is order-dependent
  and can name one tool twice; a map cannot, and the expectation is about counts
  rather than sequence.

The materializer writes rows sorted by `caseId`, validates every referenced
fixture digest, rejects an unknown `schemaVersion`, refuses a row whose id does
not match its own semantics, and writes the corpus only after the unique-case
and exact-error counts match their allocations. It also cross-checks target kind
against clock mode: a compiled-product case can never run on virtual time,
because the harness is outside the process and cannot advance a clock it does
not own, and a direct-rust case can never run on real bounded time, because that
would be flaky by construction. Execution results live in separate replay/report
artifacts; a run never rewrites the committed oracle.

The corpus has exactly 245,000 `direct-rust` cases and 5,000
`compiled-product` cases. Direct cases exhaust parser, state-machine, scheduling,
and fault combinations against migrated production crates. Compiled cases launch
the unmodified release artifact and prove process wiring, configuration,
persistence, PTY, provider transport, worker, installer, and distribution
contracts. The manifest computes both target totals, requires compiled coverage
for all sixteen subsystems and every source-enumerated boundary family, and
rejects drift. A case executes only the target declared in its record.

The target/platform allocation is also exact:

| Target | Platform | Cases |
|---|---|---:|
| `direct-rust` | platform-independent (`any`) | 240,000 |
| `direct-rust` | Linux x86_64 | 1,000 |
| `direct-rust` | Linux aarch64 | 1,000 |
| `direct-rust` | macOS x86_64 | 1,000 |
| `direct-rust` | macOS aarch64 | 1,000 |
| `direct-rust` | Windows x86_64 | 1,000 |
| `compiled-product` | Linux x86_64 | 1,000 |
| `compiled-product` | Linux aarch64 | 1,000 |
| `compiled-product` | macOS x86_64 | 1,000 |
| `compiled-product` | macOS aarch64 | 1,000 |
| `compiled-product` | Windows x86_64 | 1,000 |

Platform-independent direct cases run once, not once per operating system.
Platform-specific cases execute only on a matching runner. Each platform's
compiled allocation must cover all sixteen subsystems and every
platform-applicable source-enumerated boundary family.

---

## Corpus Allocation and Subsystem Contracts

The materialized conformance corpus contains exactly 250,000 distinct JSONL test vectors. It enforces 4,496 exact expected-error contracts across all sixteen production subsystems.

Materializing a row is not a claim that the row can execute. Each row names the
entry point it requires; `plan::RESOLVED_ENTRIES` names the entry points a driver
can call today and is empty, so `plan::migration_debt()` is 245,000 — every direct
case in the corpus. The number is asserted against the manifest rather than
narrated, and it falls only as a subsystem's production code migrates. Fixtures
are absent rather than invented for the same reason: a content-addressed digest of
a string nothing will produce is a reference to a fixture that does not exist.

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
| 10 | Native Services, Workers & Subprocesses | Native text/image/search bindings, tiny inference worker, JS eval worker, stats sync worker, tab worker, host dispatch, IPC channels | 12,000 | 192 |
| 11 | Configuration & Settings | Domain schema validation, cascade resolution (Home -> Profile -> Project), conditions, env overrides, flag bindings | 12,000 | 192 |
| 12 | Context & Compaction | Token budget accounting, sliding-window truncation, message compaction, TTSR injection, handoff generation | 14,000 | 224 |
| 13 | Memory Engine & Vectors | Fact extraction, embedding vector math, similarity recall, query ranking, SQLite store, cache eviction | 12,000 | 160 |
| 14 | Editing & Hashline Engine | Hashline syntax parsing, snapshot tag verification, hunk application, conflict resolution, AST rewrites, undo/redo | 16,000 | 288 |
| 15 | LSP Client & Diagnostics | JSON-RPC transport, protocol framing, document synchronization, diagnostic parsing, symbol resolution, crash restart | 10,000 | 160 |
| 16 | Wire Protocol & Argot | Collab wire messages, guest client relay, Argot shorthand codec, token boundary expansion, handle streaming | 14,000 | 240 |
| **Total** | | | **250,000** | **4,496** |

The manifest generator computes both total columns from the sixteen allocations and rejects the manifest unless they equal 250,000 and 4,496. The rendered total row is generated from those computed values; it is never an independently maintained literal.

### How an expected-error contract is chosen

Every plan declares one axis named `fault`. Its first value is `none` and each
remaining value names one failure, paired positionally with one entry of the
plan's error list; the value is the error id's last segment, so the pairing is
readable at the call site and asserted by exact equality.

A row's expected error is therefore a function of the failure the row injects.
A row holding `fault = none` must complete and declares no expected error; every
other row expects exactly the diagnostic its fault value names. The count still
comes from the manifest: the fault-bearing rows are the ones the Bresenham
spread selects, so a subsystem carries exactly its allocated number of error
contracts and they land in every target and platform bucket.

The success rows all hold the fault axis clean, so their dimension space is the
axis product with that axis removed. Each plan's clean space is asserted to be
at least `cases - expected_errors`, which is what stops a subsystem from
reaching its count by repeating a tuple.

---

## Production-Path Execution Rules

To eliminate self-fulfilling tests and mock drift, the test harness adheres to strict execution invariants:

1. **Zero Production Logic in Fakes**: No shadow reimplementations of TypeScript or Rust production logic exist in test helpers. Cases execute the compiled release artifact or migrated production crates through their production interfaces.
2. **Migration Precedence**: Production logic must be ported to Rust crates (`natives/*`) before direct-Rust cases claim to cover it. Remaining TypeScript behavior is exercised by driving the compiled CLI through external PTY/ConPTY, real isolated workspaces, and TCP loopback endpoints.
3. **Black-Box Process Boundaries**: The conformance harness drives `target/release/veyyon` through standard streams, PTY/ConPTY devices, isolated profile/workspace directories, and configured loopback services. It does not inject code or virtual I/O implementations into the process.
4. **Observable Contract Verification**: Assertions check observable output streams, filesystem state changes, exit codes, PTY cell grids, and wire packets. Internal function pointers, private variables, and memory layouts are not asserted.
5. **No Mock Libraries**: Production paths do not link against mock-injecting libraries. Direct-Rust cases substitute only external I/O traits; compiled-product cases manipulate the environment strictly outside the process and never interpose syscalls or dynamic libraries.

---

## Virtual Environment Subsystems

The harness provides target-appropriate isolation without root privileges or external containers. Direct-Rust cases are deterministically virtualized; compiled-product cases use black-box operating-system resources with deterministic external scripts and bounded real time.

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
- Drives terminal resizes through `SIGWINCH` on POSIX and ConPTY resize calls on Windows.
- Injects ordered raw byte sequences (keystrokes, bracketed paste, mouse events, signal keys `Ctrl+C`, `Ctrl+D`) and records the resulting ANSI stream.

### 2. Virtual Filesystem (`vfs`)

- Implements an in-memory filesystem behind the same narrow Rust I/O traits used by migrated production crates. Production builds bind those traits to the operating-system filesystem.
- Provides copy-on-write isolation per direct-Rust shard.
- Injects `EIO`, `ENOSPC`, `EACCES`, partial writes, latency, and torn writes at that trait boundary and logs every operation for invariant checks.
- Never claims to interpose operating-system syscalls in an unmodified binary.
- Compiled-product cases instead launch in a unique real temporary workspace populated from the same content-addressed fixture. They use real permissions, quotas where portable, and crash boundaries; fault variants that cannot be induced portably remain direct-Rust cases.
- The harness waits for child exit and PTY/ConPTY closure before workspace cleanup. On Windows it retries only `ERROR_ACCESS_DENIED` and sharing violations with bounded exponential backoff capped at five seconds per workspace; other cleanup errors fail immediately. A shard does not pass until its cleanup queue drains.

### 3. Virtual Clock and Deterministic Scheduler (`vclock`)

- Direct-Rust cases bind production timer interfaces to virtual monotonic time and a deterministic discrete-event scheduler.
- Compiled-product cases use the production system clock. The harness controls external event delivery, uses short real deadlines, asserts termination plus an upper bound, and never asserts exact elapsed time.
- No compiled-product case depends on `clock_gettime`/`gettimeofday` interposition, dynamic-library injection, or privileged clock control.

### 4. Virtual Mock Provider Engine (`vmock`)

- Embedded HTTP/1.1 and HTTP/2 server bound to ephemeral TCP loopback ports on every supported platform.
- Routes provider traffic through production-configurable base URLs. A network-deny guard fails any unexpected non-loopback connection rather than replacing a provider module after parsing.
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
#[serde(rename_all = "camelCase")]
pub struct ConformanceCase {
    pub schema_version: u16,
    pub case_id: CaseId,
    pub generator: GeneratorMetadata,
    pub subsystem: SubsystemRef,
    pub contract: ContractRef,
    pub target: TargetSpec,
    pub dimensions: BTreeMap<String, serde_json::Value>,
    pub environment: EnvironmentSpec,
    pub stimulus: Vec<Stimulus>,
    pub oracle: OracleSpec,
    pub coverage: CoverageSpec,
    pub provenance: Provenance,
}
```

- **Per-subsystem sweeps** (`generator/plan.rs`, `generator/subsystem.rs`): sixteen
  plans, one per allocated subsystem, each naming six axes, its contract ids, its
  error ids and the requirements it covers. One family walks the axis product by
  mixed-radix decomposition of a running index, so a tuple never repeats and the
  axis product is asserted to exceed the allocation. The walk is seed-independent
  apart from which contract a row discharges; `PINNED_SEED` is the seed the
  committed corpus carries. Expected-error rows are spread by Bresenham rather
  than taken as a prefix, so every target and platform bucket carries diagnostics.
- **Covering arrays** (`generator/sweep.rs`): greedy pairwise selection for
  noninteracting dimensions, with pair coverage derived from the axes at run time.
- **Boundary values** (`generator/boundary.rs`): `0`, `1`, `u32::MAX - 1`,
  `u32::MAX`, empty strings, 64 KB strings, non-UTF-8 buffers.
- **Grammar-based generation is not implemented.** Argot scripts, hashline patch
  bodies and JSONL traces are swept as named axis values, not produced from a
  grammar. A grammar arrives with the migrated parser it would generate against;
  written now it would generate against a Rust reimplementation, which is what
  the production-boundary rule forbids.
- **State-machine exploration is exhaustive, not a random walk** (`model_check/`):
  breadth-first enumeration under a state budget, with safety invariants and a
  minimal counterexample trace. Random walks are absent by choice; a budgeted BFS
  reports the shortest witness and a walk reports the one it happened to find.

### 2. Deduplication and Collision Rejection

Every test case is identified by a canonical BLAKE3 content digest:

$$\text{Digest} = \text{BLAKE3}\left(\text{canonical\_json}\left(\{\text{subsystem},\text{contract},\text{target.kind},\text{dimensions},\text{environment},\text{stimulus},\text{oracle}\}\right)\right)$$

This is the same field set defined by the canonical record above. It excludes
`caseId`, generator metadata, `target.entry`, `target.artifactDigest`, coverage
labels, provenance, and execution observations. The corpus builder indexes all
250,000 digests, rejects the first duplicate semantic identity, and writes rows
in digest order.

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

`tests/conformance` integrates specialized bug-discovery engines:

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

`src/model_check/` explores a machine's reachable states breadth-first and
checks every named invariant at every one of them. Breadth-first is what makes
a counterexample usable: the first violating state found is at minimal depth,
so its trace is the shortest action sequence that reaches it. Exploration is
bounded by a state budget, and hitting the budget reports exhaustion rather
than a pass.

Three machines ship:

- `lifecycle`: one tool call from arrival to settlement. Invariants: no side
  effect before validation, exactly one settlement, a finished call has settled.
- `session`: fork, append, switch and compact over a four-node tree.
  Invariants: the root is its own parent, the active node exists, every node
  reaches the root, a compaction leaves a turn behind.
- `locks`: workers taking ordered sets of locks. A wedged state is a state with
  no successor that the model does not declare terminal, so a deadlock is
  reported with the shortest acquisition sequence that reaches it.
  `order_inversions` answers the same question from the plans alone, and the
  suite asserts the two agree over every pair of two-lock plans.

Each machine carries switches that inject its own defect, and the suite asserts
each switch produces one named outcome. The properties are safety properties:
an invariant is a predicate over a single state, so bounded termination is
asserted by the executing case instead. Persistence resume equivalence arrives
with the persistence migration in Wave 2.

### 2. Concurrency Stress and Lock Discovery

The lock machine above is the deterministic half of this: it enumerates the
interleavings of a set of acquisition plans without threads, so a wedge is
found by exhaustion rather than by luck. Loom and ThreadSanitizer coverage
instruments migrated production synchronization, so it arrives with the code it
instruments in Wave 3. Nothing instruments the TypeScript worker pools; those
are reached through compiled-product cases.

### 3. Fuzzing Harnesses (AFL++ and libFuzzer)

`src/fuzz/` owns the target bodies and the registry. A libFuzzer or AFL++
binary is a three-line wrapper that hands its bytes to one target, and those
three lines need nightly and a linker flag, so they live outside the library.
The property a target exists for is checkable without a fuzzer, and `drive`
asserts it over a deterministic seed corpus during `cargo test`: no input
panics, and every target both accepts and rejects something.

Registered targets:

- `vt-sequence-parser`: escape sequences into a 20x5 grid through the VT parser.
- `corpus-row-reader`: JSONL bytes back through `Corpus::from_jsonl`.

`Surface` enumerates the raw-byte entry points, and a surface with neither a
target nor a row in `AWAITING_MIGRATION` fails the crate. Four surfaces are
named gaps today: SSE wire framing, hashline patches and Argot tokens are still
TypeScript parsers, and HTTP/2 frame framing belongs to `h2`, which is fuzzed
upstream. A target written against a Rust reimplementation of a TypeScript
parser would test the reimplementation, which this design forbids.

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
|  | - 6 Ops, 4 AST Gaps |  | - Early-Exit on Red  |  | - Zero Surviving Critical|  |
|  +---------------------+  +----------------------+  +--------------------------+  |
+-----------------------------------------------------------------------------------+
```

### Mutation Operators

`src/mutation/` plans mutants, applies one to a text buffer, and accounts for
the campaign. It compiles nothing and runs nothing: a build and a shard run are
the driver's resources to spend.

Six operators are token substitutions in Rust source:

1. `comparison-boundary`: `<=` for `<` and the rest of the off-by-one family.
2. `conditional-inversion`: an equality or a guard that means the opposite.
3. `terminal-state-deletion`: a loop that never leaves, a rejection that
   becomes an acceptance.
4. `validation-deletion`: an error that stops propagating, a permission that
   defaults open.
5. `timeout-relaxation`: a deadline three orders of magnitude further away.
6. `parser-acceptance-broadening`: a parser that takes more than its format
   allows.

Four classes the issue requires have no operator, because none of them is a
substitution of bytes: `retry-backoff-change` changes a numeric policy whose
literal is not identifiable by its bytes, `persistence-version-bypass` deletes
a guard expression rather than a token inside one,
`tool-execution-before-validation` reorders two statements, and
`sanitizer-removal` deletes a call and rebinds its argument. Each is listed in
`AWAITING_AST` with that reason, and the suite asserts by exact equality that
every class the issue names is either an operator or a listed gap. A class with
neither turns the crate red.

A short operator refuses to fire inside a longer one, so `<` never matches the
`<` of `<=` and no build is spent proving that `<==` does not compile. A mutant
identity is a BLAKE3 digest over operator, file, offset and rewrite, so two
campaigns agree on what a mutant is. Applying a mutant to bytes that no longer
match its plan is refused rather than relocated to the nearest match: a
relocated mutant makes the survivor triage read a line the report does not
name.

### Mutation Gate Requirement

- At least **1,200 mutants built and ran**. A mutant that did not build is
  `NotViable`, is counted separately, and satisfies nothing: counting it is the
  cheapest way to reach the floor without testing anything.
- At least **1,000 killed**, a mutation score of 83.3% of the floor.
- Every critical path has at least one executed mutant, and none of them
  survives. Zero survivors on a path nobody mutated is vacuous, so an uncovered
  path is its own named shortfall rather than a clean sheet.
- One mutant is recorded once. A duplicate id is refused, because a duplicate
  inflates the executed count and the kill ratio together.

The critical paths are credentials, path traversal, checksum verification,
authorization, tool completeness, and persisted-version rejection. A seventh
added to the enum is demanded of every campaign from that moment on.

### The campaign runner

`src/bin/campaign.rs` is what spends the CPU. It enumerates the Rust sources of
`veyyon-conformance` and `veyyon-natives`, plans every mutant the six operators
can produce (4,012 today), interleaves them round-robin across file and operator
so a truncated run is not one hot file, then for each mutant writes the byte,
runs the owning package's library suite, and restores the file — on a panic too,
through a `Drop` guard, because an aborted campaign must not leave broken source
behind.

Results append to a resumable JSONL ledger under `.internal/`, one row per
mutant, carrying a schema version. A row is read back by re-planning the file it
names and matching the mutant id, so the sites come from the `'static` rewrite
tables; a row whose site no longer exists is refused rather than attributed to
whatever now sits at that offset. `--report` prints the verdict over the ledger
without running anything.

Inline `#[cfg(test)]` modules are excluded from planning. A mutant inside a test
mutates the oracle, and a suite that kills it has proved nothing.

**Five of the six critical paths have no Rust owner yet.** Credentials, path
containment, artifact checksums, authorization and tool completeness are all
still TypeScript, so no mutant can land on them and the gate reports each as
uncovered. Only persisted-version rejection has a Rust owner: the corpus refuses
a record from another schema version. The gate is therefore red for the same
reason `RESOLVED_ENTRIES` is empty, and it clears as the migration lands rather
than by mutating a Rust reimplementation of TypeScript, which the
production-boundary rule forbids.

---

## Migration Waves and Decommissioning Plan

The migration from TypeScript test suites and `packages/simulations` to `tests/conformance` proceeds in six sequential waves, numbered 0 through 5.

```
+-----------------------------------------------------------------------------------+
|                             Six-Wave Migration Plan                              |
+-----------------------------------------------------------------------------------+
| [Wave 0: Infrastructure]  --> Scaffold tests/conformance, VFS, VPTY, vmock        |
|           |                                                                       |
| [Wave 1: Stateless Core]  --> Subsystems 11 Configuration, 14 Editing, 16 Wire |
|           |                                                                       |
| [Wave 2: State & Protocol] --> Subsystems 02 Providers, 05 Persistence,          |
|           |                13 Memory, 15 LSP                                      |
| [Wave 3: Agent & Safety]   --> Subsystems 03 Tools, 04 Sessions, 06 Concurrency, |
|           |                07 Security, 12 Context                                |
| [Wave 4: Product Surfaces] --> Subsystems 01 Rendering, 08 CLI, 09 Distribution,|
|           |                10 Native Services & Workers                           |
| [Wave 5: Decommission]     --> Delete superseded TS tests and simulations; cut CI |
+-----------------------------------------------------------------------------------+
```

### Wave 0: Harness & Virtual Infrastructure Construction

- Construct `tests/conformance` crate structure and dependencies.
- Implement `vfs`, `vpty`, `vclock`, and `vmock` engines.
- Build the 250,000-case generator, deduplication validator, and JSONL materializer.
- Establish baseline JUnit and SARIF reporting.
- Benchmark complete direct-Rust and compiled-product cases on every applicable platform. Before any wave joins the three-minute CI gate, direct-Rust p95 must be <= 1.5 ms, compiled-product p95 must be <= 500 ms, and three consecutive cold runs of every exact shard manifest must each finish in <= 144 seconds.

### Wave 1: Stateless Core, Configuration, Wire Protocols, and Argot

- Migrate Subsystems 11, 14, and 16 before claiming direct Rust coverage:
  - `packages/argot` -> a production `veyyon-argot` crate
  - `packages/hashline` -> a production `veyyon-hashline` crate
  - `contracts/wire` -> a production `veyyon-wire` crate
  - Catalog classification and configuration schema logic -> production Rust crates
- Keep independent conformance oracles declarative: they describe invariants and expected records but never reimplement the production algorithm.
- Materialize exactly 42,000 cases and 720 error contracts.
- **Gate**: 100% pass on the Wave 1 corpus through the migrated production crates and designated compiled-product cases; delete each corresponding TypeScript test only after the generated migration inventory proves one-for-one contract coverage.

### Wave 2: Providers, Persistence, Memory, and LSP

- Port and verify Subsystems 02, 05, 13, and 15:
  - `packages/mnemopi` & SQLite persistence
  - `packages/ai` streaming and token accumulation
  - LSP JSON-RPC transport and diagnostics
- Materialize exactly 62,000 cases and 1,056 error contracts.
- **Gate**: 100% pass on the Wave 2 corpus; delete superseded tests in `packages/mnemopi/test` and `packages/ai/test` only after inventory parity.

### Wave 3: Agent Runtime, Tools, Sessions, Concurrency, Security, and Context

- Port and verify Subsystems 03, 04, 06, 07, and 12:
  - `packages/agent` core runtime and concurrency
  - `packages/coding-agent` tool execution pipeline, enumerated from the live registry so every current or newly added tool requires coverage
  - Session branching, resume, checkpoints, compaction, TTSR, and security boundaries
- Materialize exactly 88,000 cases and 1,696 error contracts.
- **Gate**: 100% pass on the Wave 3 corpus; delete superseded tests in `packages/agent/test` and `packages/coding-agent` only after inventory parity.

### Wave 4: TUI Rendering, Native Services, CLI Modes, Workers, and Distribution

- Port and verify Subsystems 01, 08, 09, and 10:
  - Terminal UI rendering across all viewports and dual grounds
  - `packages/natives` and `natives/bridge/addon` text, image, search, and filesystem services
  - Worker subprocess lifecycles (`stats`, `js_eval`, `tiny_inference`, `tab`)
  - CLI flag parsing, dispatch, and error output
  - Distribution installers (`install.sh`, `install.ps1`)
- Materialize exactly 58,000 cases and 1,024 error contracts.
- **Gate**: 100% pass on the Wave 4 corpus; delete superseded native/package tests and executable installer scenarios after inventory parity. Retain repository-policy and release-safety checks under `scripts/` unless they move to Rust repository-linter tooling with contract parity.

### Wave 5: Parity Certification, Simulation Deletion, and Final Cutover

1. **Parity Certification**: Run all 250,000 cases through the target declared by each canonical record; assert zero failures. The 5,000 compiled-product cases use the release artifact.
2. **Mutation Gate Run**: Execute at least 1,200 mutations; certify at least 1,000 killed and zero critical-path survivors.
3. **Simulation Package Fold & Deletion**:
   - Transfer any remaining non-redundant scenario definitions from `packages/simulations` into `tests/conformance`.
   - Delete `packages/simulations` directory and remove workspace entries from `package.json` and `tsconfig.json`.
4. **Final Product-Test Elimination**: Delete all superseded `.test.ts` files under `packages/`. Retain or explicitly port repository-governance checks under `scripts/`.
5. **CI Pipeline Migration**:
   - Remove superseded package `bun test` jobs while preserving repository-governance script gates.
   - Wire `cargo test -p veyyon-conformance` with bounded parallel sharding into the primary CI gate.

---

## CI Sharding and Reproducible Reporting

### 1. Parallel Sharding Strategy

The corpus uses eight CI runners, leaving capacity under the repository's
account-wide job ceiling:

| Runner pool | Runners | Eligible cases |
|---|---:|---|
| Linux x86_64 | 4 | `platform:any` plus Linux x86_64 |
| Linux aarch64 | 1 | Linux aarch64 |
| macOS x86_64 | 1 | macOS x86_64 |
| macOS aarch64 | 1 | macOS aarch64 |
| Windows x86_64 | 1 | Windows x86_64 |

The dispatcher maps `platform:any` to the Linux x86_64 pool, maps every other
case to its exact platform pool, then assigns:

$$\text{slot}(c) = \text{BLAKE3}(c.\text{case\_id}) \pmod \text{runners\_in\_pool}(c)$$

Each runner enforces a fixed four-slot compiled-product worker queue. A
“complete compiled case” spans process launch, case execution, child exit,
PTY/ConPTY closure, and normal workspace deletion or handoff to the bounded
Windows cleanup queue. A complete direct-Rust case includes fixture reset and
oracle evaluation. Wave 0 establishes p95 limits of 1.5 ms for direct-Rust and
500 ms for compiled-product cases on every applicable platform. Before each
wave's exact manifest enters CI, three consecutive cold calibration runs of
every shard must each finish in <= 144 seconds, preserving a 20% reserve below
the hard deadline.

A non-Linux runner's nominal p95 work is 1.5 seconds for 1,000 direct cases plus
125 seconds for 1,000 compiled cases across four slots: 126.5 seconds. A Linux
runner's nominal p95 work is 90.375 seconds for about 60,250 direct cases plus
31.25 seconds for 250 compiled cases: 121.625 seconds. The manifest rejects
target/platform drift, missing runner eligibility, shard skew, or calibration
failure. A runner fails if its cleanup queue has not drained by the 180-second
shard deadline. No claim depends on running the corpus once per platform or on
250,000 independent process starts.

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
- [ ] **Production Boundaries**: Every case drives either a migrated production Rust crate through its production boundary or the unmodified compiled release artifact. Test doubles exist only for external I/O.
- [ ] **Target Allocation**: Exactly 245,000 cases execute in-process against production Rust and exactly 5,000 launch the compiled product; every subsystem and source-enumerated boundary family has compiled coverage.
- [ ] **Platform Allocation**: Exactly 240,000 platform-independent direct cases plus 1,000 direct and 1,000 compiled cases for each of the five supported platform/architecture pairs execute on matching runners.
- [ ] **UI Dual-Ground Verification**: All TUI components verified on both `#1e2127` and `#000000` grounds across all 6 terminal dimension profiles.
- [ ] **Mutation Proof**: Mutation engine executes >= 1,200 mutants, kills at least 1,000, and leaves zero survivors on credentials, authorization, path traversal, checksum verification, tool-call completeness, and persisted-version rejection.
- [ ] **Simulations Deletion**: `packages/simulations` is deleted from disk and removed from workspace manifests.
- [ ] **TypeScript Product-Test Deletion**: Zero superseded `*.test.ts` files remain in `packages/`; repository-governance checks under `scripts/` are retained or ported with parity.
- [ ] **CI Performance**: Direct-Rust p95 is <= 1.5 ms, compiled-product p95 is <= 500 ms, three cold calibrations of every exact shard finish in <= 144 seconds, and the complete 250,000-case CI run finishes in < 180 seconds across eight runners.
- [ ] **Zero Unresolved Mismatches**: Every corpus mismatch is fixed or represented by an explicit reviewed contract change across Linux x86_64, Linux aarch64, macOS x86_64, macOS aarch64, and Windows x86_64.
