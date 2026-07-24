# Argot: a per-project shorthand vocabulary for coding agents

**Status:** draft v0
**Kind:** standalone library (TypeScript reference implementation; a Rust core and
other-language bindings are deferred), consumed by any harness
**Companion to:** `AGENTS.md`

## What this is

Argot gives a project an optional, shared shorthand vocabulary. Frequent long
strings (absolute paths, boilerplate commands, recurring call shapes) get short
handles. A harness that adopts Argot teaches the model the notation, lets the
model read the project's vocabulary, and expands handles deterministically before
anything leaves the process. A harness that does not adopt it does nothing, and
the project behaves exactly as it does today.

Think of it as the codec companion to `AGENTS.md`. `AGENTS.md` carries your
conventions in prose. `AGENTS.dict` carries a shared shorthand the agent and the
harness both understand.

The vocabulary is authored by the repository owner, the same person who writes
`AGENTS.md`. It is not learned, and Argot keeps no derived state. The owner
already knows the strings that recur in their project, which are the entries
worth the most.

Argot is a lossless substitution codec over a shared vocabulary. It is not a
memory system, not retrieval, and not a summarizer. It never abstracts or drops
information. A handle expands to exactly its defined bytes.

The primary saving is on output tokens, which cost several times what input
tokens cost. The model writes a short handle where it would have spelled out a
long string, and the definition it read is paid for once. Interning repeated
input spans is a separate, deferred idea (see Open questions).

## Design goals

- **Inert by default.** No `AGENTS.dict`, or a harness that does not support
  Argot, means byte-identical behavior. Absence is handled inside the library,
  so the harness code is unconditional.
- **Impossible to partially adopt wrong.** Encode and decode are always
  co-located in one process. The compressed form never crosses a process
  boundary. A harness that never teaches the model the notation never receives a
  handle, so there is no wire where a half-adopter meets a compressed stream.
- **Trivial to adopt.** One import, one fixed preamble, and expansion over
  output.
- **Human-authored, like `AGENTS.md`.** One committed file, reviewed like code.
  No machine-written artifact, no cache, no churn.
- **Zero cost when absent.** A three-file project pays nothing and sees no new
  ceremony. Argot only earns its keep on large, long-lived, shared repos.

### Non-goals

- The codec is not learned. The `expand` codec maintains no frequency state and
  never writes; it substitutes a fixed vocabulary and nothing more. Frequency and
  files live only in the two optional helpers layered around it: the build-time
  generator, which reads a corpus to *propose* a dictionary, and the runtime
  cache, which a harness may write outside the repository as a local decode aid.
  Both are opt-in and separate from the codec and the standard.
- Not a summarizer or a lossy compressor. If you want fewer facts, look
  elsewhere; Argot preserves every byte it substitutes.
- Not a cross-process protocol. The compressed form is a private, in-memory
  optimization, never a serialized interchange format.

## One file

The entire vocabulary is a single committed file at the repo root:
`AGENTS.dict`. There is no second layer and nothing gitignored, because nothing
is derived. You author it, you review it in diffs, you share it. That is the
whole model.

## File format: `AGENTS.dict`

TOML. The common case is one line per handle. Metadata is opt-in.

```toml
version = 1
sigil = "§"

# handle = "expansion"
[handles]
dbconn = "packages/server/src/database/connection.ts"
tsc    = "CARGO_TARGET_DIR=/dev/null bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit"
migr   = "packages/server/src/database/migrations"

# optional per-handle metadata; omit entirely for simple entries
[meta.dbconn]
note  = "main database entrypoint" # shown to reviewers, never to the model
scope = "packages/server/**"        # activate only under matching paths
```

Field rules:

- `version` (required): format major the file targets. An integer at least 1. A
  loader refuses a major newer than it understands, loudly, rather than guessing.
- `sigil` (optional, default `§`): the reserved marker every handle carries. Must
  be non-empty and contain no letters, digits, underscores, or whitespace, so it
  can never blur into a handle name.
- `[handles]` (required, non-empty): a map of `handle` to `expansion`. `handle`
  matches `[a-z0-9_]+`. `expansion` is literal bytes, non-empty, at most 8192
  bytes, and must not contain the sigil, so expansion is a single lossless pass
  and no handle can expand into another. No interpolation in v0.
- `[meta.<handle>]` (optional): `note` and `scope`, both strings. Each key must
  name a handle defined in `[handles]`.

A malformed dict is a loud failure, never a silent skip. Argot reports the file
and the offending key and refuses to load, so a typo can never quietly drop a
handle and change behavior.

## Handles and the sigil

Every handle carries the reserved sigil so it can never collide with literal
content. A handle is the sigil followed by its name: `§dbconn`.

The sigil solves the one real correctness risk. Without it, a project whose
vocabulary contains `db` would corrupt any literal `db` the model legitimately
wrote. With it, expansion rewrites only `§db`, and literal text is untouchable.
`§` is chosen because it is rare in code and prose; it is configurable per
project via the `sigil` field.

Expansion is literal, lossless, and idempotent. Idempotence is enforced, not
merely conventional: because an expansion may not contain the sigil, expanded
text carries no `§handle` for a second pass to match, and no handle can expand
into another handle. It matches the longest
handle first, so `§dbconn` wins over `§db` when both are defined, and it fires
only when the match is not run into more name characters, so `§dbextra` (not a
handle) is left untouched rather than expanding `§db`. An unknown handle passes
through verbatim, so it reaches the tool as written and fails there in the open.

## The SDK surface

Language-neutral contract first, then the TypeScript binding. Every codec method
is a no-op or passthrough when the vocabulary is empty. That is the
inert-by-default guarantee made mechanical.

The surface has five groups: the session that owns the lifecycle, the codec
primitives it is built from, the encoding gate, the dictionary generator, and the
project-resolution and cache helpers. A harness that adopts the recommended
integration touches only the session; the rest are exposed for harnesses that
drive the flow directly.

### The session

The recommended integration is one object that owns the "inert until armed"
state, so a harness never manages a mutable codec itself. A session is armed by
one of two flows:

- **Load-on-read.** The dictionary is a committed `AGENTS.dict` in the tree, and
  the same read that shows the model the table arms the codec.
- **Cache flow.** The dictionary is generated and kept outside the repository, so
  the harness arms the session from a vocabulary directly and teaches the handles
  in the prompt (see [Project resolution and the runtime cache](#project-resolution-and-the-runtime-cache)).

- **`ArgotSession`**
  - `session.preamble` is `ARGOT_PREAMBLE`.
  - `session.load(key, vocab, opts?)` arms a project's vocabulary under `key` (a
    folder path or cache id). Loading several distinct keys is how one session
    works across several projects at once; the keys keep the vocabularies separate
    so one can be dropped without disturbing the others. `opts.teach` (default
    `true`) controls whether the model is taught these handles; decoding is on
    regardless. Throws `ArgotConflictError` when the new vocabulary disagrees with
    an already-loaded one (a shared handle name bound to a different expansion, or
    a different sigil), leaving the session untouched.
  - `session.unload(key)` stops teaching the vocabulary at `key`: the model is no
    longer shown those handles, but they still decode, so anything the model
    already wrote keeps expanding. Returns whether anything changed.
  - `session.observe(path, content)` is the load-on-read entry: when it sees a file
    named `AGENTS.dict` it loads that vocabulary under the file's directory as the
    key (so reading dictionaries in two directories unions both), returns whether
    it did, and throws `ArgotParseError` on a malformed dict. Any other file is
    ignored.
  - `session.loadVocab(vocab)` is the single-project cache-flow entry: it arms the
    session from one vocabulary directly, discarding anything already loaded.
    Passing a vocabulary with no handles re-arms the inert codec. For a session
    that loads more than one project, use `load` with distinct keys.
  - `session.fork()` returns a detached copy of the session, for handing a subagent
    the parent's shorthand at spawn (see [Subagents](#subagents)). The copy is
    independent: the child loading or unloading never reaches back into the parent.
  - `session.promptFragment()` is the system-prompt block listing the handles the
    session currently *teaches* (the union of every loaded key still taught), `""`
    when it teaches none. In load-on-read the model learns the handles from the
    file it read, so this stays unused; in the cache flow the file is off in a
    state directory, so inject this once (after the preamble) to teach the handles.
  - `session.expand(text)` restores handles from *every* loaded key, taught or not,
    and is identity until a dict loads. Decoding is unconditional so a handle the
    model wrote always expands, even for a key whose teaching was turned off.
  - `session.loaded` reports whether any vocabulary is loaded this session.

  A session holds a **keyed set** of vocabularies. `load`/`unload` manage the set
  by key and `expand` unions all of them; `loadVocab` is the one-project shortcut
  that clears the set first. Combining vocabularies is collision-*safe* (never
  silently wrong): if two loaded projects assign the same short name to different
  strings, `unionVocabularies` throws `ArgotConflictError` rather than resolving to
  one side. It is not collision-*free*: cache-flow names are short mnemonics unique
  only within one dictionary (see the runtime-cache section), so a multi-project
  union can legitimately hit that loud error. See
  [`unionVocabularies`](#the-codec-primitives).

### The codec primitives

- **`renderPreamble(options?) -> string`** / **`ARGOT_PREAMBLE: string`**
  The fixed, model-facing notation block. The harness injects it into the system
  prompt once, always, whether or not a project has an `AGENTS.dict`. It teaches
  the model the notation and how it comes to know a project's handles. It is small
  and never changes for a given `options`, so it stays in the cached prompt.
  `renderPreamble({ tools: true })` additionally tells the model it can activate a
  folder's shorthand itself by calling the load and unload tools; it must be used
  only when the harness actually registers those tools, because you must never
  instruct a model to call a tool it does not have. `ARGOT_PREAMBLE` is the
  tools-off default, equal to `renderPreamble()`.

- **`unionVocabularies(vocabs) -> Vocabulary`**
  Combine several vocabularies into one, for a context that loaded more than one
  project. The result is the union of every handle; a handle bound to the *same*
  expansion in two inputs is deduplicated, while the same name bound to two
  *different* expansions, or two different sigils, throws `ArgotConflictError`.
  This is the primitive behind the keyed `ArgotSession`.

- **`ARGOT_LOAD_TOOL` / `ARGOT_UNLOAD_TOOL: string`**
  The canonical names (`"argot_load"`, `"argot_unload"`) of the two agent tools a
  harness exposes so the model activates a folder's shorthand on demand. The
  preamble names them from these constants, so the model and the harness agree in
  one place: a harness registers its tools under exactly these names.

  Agent-driven loading is the canonical arming flow: the session starts unarmed,
  the harness registers both tools where the model can actually call them (never
  hidden behind a discovery step the preamble does not mention), injects
  `renderPreamble({ tools: true })`, and the model loads the project it intends
  to work in. Auto-arming from the launch directory at session start is the
  legacy convenience path and picks the wrong project whenever the launch
  directory is not the work unit (a monorepo root, a sibling checkout), so new
  integrations should not do it.

  The approval contract is fixed so every harness gates identically. `argot_load`
  reads a project tree (possibly outside the session's working directory) and
  writes the generated dictionary into the harness's cache directory, so in any
  mode where the harness gates side effects behind operator approval it MUST be
  approval-worthy at the same tier as a file write, with the resolved project
  root shown in the prompt. `argot_unload` mutates no working tree and never
  strips meaning (decoding stays on), so it is read-tier and needs no approval.
  Expansion is never gated by anything.

- **`parseDict(content, source) -> Vocabulary`**
  Parses and validates dictionary text. `source` names the file in error
  messages. Throws `ArgotParseError` on a malformed dict. This is the primitive
  behind load-on-read: when the agent reads `AGENTS.dict`, the harness parses that
  content out of the agent's own input.

- **`makeDict(vocab) -> AgentDict`** / **`emptyDict() -> AgentDict`**
  Build the codec from a parsed vocabulary, or the inert codec. The lower-level
  `makeExpander(vocab)` and `makePromptFragment(vocab)` are exposed too, for a
  harness that wants the expander or the fragment without the wrapper.

- **`load(projectRoot) -> Promise<AgentDict>`**
  Convenience for a harness that already knows the project root. Reads
  `<projectRoot>/AGENTS.dict`, returns the inert dict on absence, throws
  `ArgotParseError` on a malformed file, and rethrows any read error other than
  "not found". It never degrades a broken dict to an empty one.

- **`AgentDict.promptFragment() -> string`**
  A per-dictionary block listing the handles, for a harness that prefers to place
  the whole vocabulary in the system prompt instead of relying on the agent's
  read. Returns `""` when empty.

- **`AgentDict.expand(text) -> string`**
  Replaces every `§handle` with its expansion. Identity when empty. Deterministic
  and lossless. The harness runs this over model output before it reaches a tool,
  the filesystem, a persisted transcript, the display, or another agent.

- **`StreamDecoder` / `makeStreamDecoder(vocab) -> StreamDecoder`**
  A stateful decoder for the one seam `expand` cannot serve: a live token stream,
  where text arrives in pieces and a handle can split across a chunk boundary
  (`§db` then `conn`). Expanding each piece alone would leak a raw fragment to the
  display or expand a shorter handle before the longer name completes, since
  longest match is only decidable once the whole name and its boundary are in
  hand. The decoder buffers exactly the fragment that could still form a handle
  and returns everything before it already expanded: `push(chunk)` yields the
  newly safe expanded text, `flush()` releases the final fragment at end of
  stream, and `reset()` drops the buffer on an abort. The concatenation of every
  `push` return plus `flush` is byte-identical to `expand` of the whole text, for
  any chunking, and the retained buffer is bounded by the sigil plus the longest
  handle name. Identity pass-through when empty. `ArgotSession.streamDecoder()`
  builds one from the session's current decode vocabulary.

The constants the format is pinned to are exported as well: `DEFAULT_SIGIL`
(`§`), `DICT_FILENAME` (`AGENTS.dict`), `MAX_EXPANSION_BYTES` (`8192`), and
`SUPPORTED_VERSION` (`1`).

### The encoding gate

Encoding and decoding follow opposite rules: decoding is unconditional once a
dictionary loads, encoding is a policy a harness may vary. The gate governs only
encoding.

- **`shouldEncode(gate, input) -> boolean`**
  A pure predicate: return whether to teach the notation this turn. `false` when
  no model is allowed, when the active model is not on the allowlist, or when the
  context has grown past the cutoff.
- **`ArgotGate`** carries the settings: `models` (an allowlist; a
  provider-qualified entry `provider/model-id` matches only that id, a bare entry
  matches the model under any provider, and an empty list teaches no one) and
  `disableAboveTokens` (stop teaching past this context size; `0` or less means no
  cutoff).
- **`ArgotGateInput`** carries the per-turn measurements: `model` and
  `contextTokens`.
- **`EMPTY_GATE`** is the inert gate (no model, no cutoff); `shouldEncode` is
  always `false`.
- **`modelAllowed(entry, activeModel) -> boolean`** exposes the single allowlist
  matching rule `shouldEncode` uses: a provider-qualified entry matches only its
  exact id; a bare entry matches the active id's segment after the last `/`.
  Exported so a caller (for example an eval harness) can decide ahead of a run
  whether a model would be encoded under a gate, using the same rule the runtime
  applies rather than a re-derived copy that could drift.
- **`modelIdSegment(id) -> string`** returns the part of an id after the last
  `/`, the segment a bare allowlist entry is compared against.

### The generator

A build-time generator proposes a first dictionary; nothing generates at runtime.

- **`generateDictFromRepo(files, options?) -> GeneratedDict`**
  The recommended entry: propose an `AGENTS.dict` from a repo file listing (with
  optional contents). Every path is a candidate; contents add frequency.
- **`generateDict(corpus, options?) -> GeneratedDict`**
  The underlying generator over any text corpus, packed under a token budget
  (`tokenBudget`, default `1000`). `naming` selects `"mnemonic"` (short and
  readable, the default: a bare stem when unique, else a minimal hash suffix only
  on a stem collision — deterministic across runs), `"numeric"` (densest), or
  `"content"` (a stem plus a fixed 8-char hash on every handle: globally unique but
  long, so it saves fewer tokens). `pinned` carries an existing
  vocabulary forward verbatim, keeping its chosen names stable when you regenerate
  over a prior dict (the immutable runtime cache does not use it; it keys a new
  entry per state instead).
- **`estimateTokens(text)`** and **`extractCandidates(text)`** are the default
  token heuristic and candidate extractor, exported so either can be reused or
  replaced.

### Project resolution and cache helpers

These locate a project and manage a generated dictionary kept outside the tree.
They are described in full under [Project resolution and the runtime
cache](#project-resolution-and-the-runtime-cache).

- **`resolveProjectRoot(startDir, options?)`** walks up for a project marker and
  returns the root or `undefined`; **`PROJECT_MARKERS`** is the default set
  (`.git`, `.argot`).
- **`projectCacheId(rootPath)`** derives a stable, fs-safe id from the absolute
  root path.
- **`cacheDictPath(baseDir, cacheId, contentSig)`**, **`readDictFile(path)`**,
  **`writeDictFileAtomic(path, content)`**, **`listingSignature(files)`**, and
  **`resolveProjectCache({ baseDir, cacheId, contentSig, files, options? })`** are
  the disk contract for the cache. The cache is content-keyed and immutable: an
  entry is named by a content signature (the git HEAD, or `listingSignature` for a
  project with no git) and is never mutated once written.
- **`resolveProjectVocab({ folder, cacheDir, io, tokenBudget?, onNotice?, signal? })`**
  is the whole cache flow composed into one call, so no harness reimplements it: it
  resolves `folder` to its root, reads the immutable entry for the current
  repository state or generates it once on a miss, and returns `{ root, vocab }`
  (or `undefined` when `folder` has no marker). A harness injects only **`io`** (a
  **`ProjectVocabIO`** wrapping `git rev-parse HEAD` and `git ls-files`, each
  returning `null` for a non-git folder) and `cacheDir`; everything that decides
  which dictionary a state gets — the git-vs-walk decision, budget keying, corpus
  gathering, when it regenerates — lives here, so every harness behaves
  identically. The corpus policy itself (**`gatherRepoFiles`**, **`walkProjectTree`**,
  **`shouldScanContent`**, and the `CONTENT_SKIP_*` / `WALK_*` bounds) and the
  budget helpers (**`resolveTokenBudget`**, **`budgetKeyedSignature`**) are exported
  for a harness driving one stage directly, but the whole flow is the single call.
  Notices it must not swallow (a reached content budget, a truncated or
  partially-unreadable non-git tree, an invalid budget) are surfaced through
  `onNotice` as a **`ProjectVocabNotice`**, never dropped.

```ts
class ArgotSession {
  readonly preamble: string;
  load(key: string, vocab: Vocabulary, opts?: { teach?: boolean }): void; // throws ArgotConflictError
  unload(key: string): boolean;
  observe(path: string, content: string): boolean; // throws ArgotParseError / ArgotConflictError
  loadVocab(vocab: Vocabulary): void;
  fork(): ArgotSession;
  promptFragment(): string;
  expand(text: string): string;
  streamDecoder(): StreamDecoder;
  get loaded(): boolean;
}

interface AgentDict {
  promptFragment(): string;
  expand(text: string): string;
}

class StreamDecoder {
  constructor(vocab: Vocabulary);
  push(chunk: string): string; // newly safe expanded text; buffers a possible handle tail
  flush(): string;             // release the final buffered fragment at end of stream
  reset(): void;               // drop the buffer (aborted stream)
  get pending(): string;       // the buffered tail, for tests and diagnostics
}
function makeStreamDecoder(vocab: Vocabulary): StreamDecoder;

function renderPreamble(options?: { tools?: boolean }): string;
const ARGOT_PREAMBLE: string; // renderPreamble()
const ARGOT_LOAD_TOOL: string;   // "argot_load"
const ARGOT_UNLOAD_TOOL: string; // "argot_unload"
function parseDict(content: string, source: string): Vocabulary; // throws ArgotParseError
function makeDict(vocab: Vocabulary): AgentDict;
function emptyDict(): AgentDict;
function unionVocabularies(vocabs: Vocabulary[]): Vocabulary; // throws ArgotConflictError
function load(projectRoot: string): Promise<AgentDict>; // inert if absent, throws if malformed

function shouldEncode(gate: ArgotGate, input: ArgotGateInput): boolean;
interface ArgotGate { readonly models: readonly string[]; readonly disableAboveTokens: number }
interface ArgotGateInput { readonly model: string; readonly contextTokens: number }
const EMPTY_GATE: ArgotGate;

function generateDictFromRepo(files: RepoFile[], options?: GenerateOptions): GeneratedDict;
function generateDict(corpus: string | string[], options?: GenerateOptions): GeneratedDict;

function resolveProjectRoot(startDir: string, options?: ResolveProjectOptions): string | undefined;
function projectCacheId(rootPath: string): string;
function cacheDictPath(baseDir: string, cacheId: string, contentSig: string): string;
function listingSignature(files: RepoFile[]): string;
function readDictFile(path: string): Promise<Vocabulary | undefined>; // throws on malformed
function writeDictFileAtomic(path: string, content: string): Promise<void>;
function resolveProjectCache(params: ResolveCacheOptions): Promise<ResolvedCache>;

// The whole cache flow in one call; a harness injects only git access and a cache dir.
interface ProjectVocabIO {
  gitHead(root: string, signal?: AbortSignal): Promise<string | null>;        // git rev-parse HEAD
  listTrackedFiles(root: string, signal?: AbortSignal): Promise<string[] | null>; // git ls-files
}
interface ResolvedProjectVocab { root: string; vocab: Vocabulary }
function resolveProjectVocab(options: {
  folder: string;
  cacheDir: string;
  io: ProjectVocabIO;
  tokenBudget?: number;
  onNotice?: (notice: ProjectVocabNotice) => void;
  signal?: AbortSignal;
}): Promise<ResolvedProjectVocab | undefined>; // undefined when folder has no .git/.argot marker

// The corpus and budget policy resolveProjectVocab composes (exported for direct drivers).
function resolveTokenBudget(raw: number | undefined, onNotice?: (n: ProjectVocabNotice) => void): number;
function budgetKeyedSignature(rawSig: string, tokenBudget: number): string;
function gatherRepoFiles(root: string, paths: readonly string[], onNotice?: (n: CorpusNotice) => void): Promise<RepoFile[]>;
function walkProjectTree(root: string, onNotice?: (n: CorpusNotice) => void): Promise<string[]>;
function shouldScanContent(relPath: string): boolean;
```

### The drop-in

The vocabulary loads when the agent reads the file, not when the process starts,
because an agent is often launched from a directory other than the project it
works in. `ArgotSession` owns that flow, so a harness injects the preamble once,
feeds it every file the agent reads, and expands output. A project with no
`AGENTS.dict` gets byte-identical behavior.

```ts
import { ArgotSession } from "argot";

const argot = new ArgotSession();

systemPrompt += argot.preamble;         // once, at session start
argot.observe(path, content);           // on every file the agent reads
const clean = argot.expand(modelOutput); // identity until a dictionary is loaded
```

Because the preamble carries the meaning, the dictionary itself needs no prose. It
is a dense table of names and expansions, read through the decoder the preamble
already gave the model.

## The codec contract

Three rules. Follow them and partial adoption is impossible to get wrong.

1. **Expand before any boundary.** The compressed form must never reach the
   user's display, a tool, the filesystem, a persisted transcript, another
   agent, or a non-adopting harness. Run `expand()` at model-output ingestion,
   before the harness fans output out to any of them. Persist and hand off the
   expanded form. The user sees real commands, saved logs stay readable, and
   downstream tools see real text. A live token display is the same boundary
   arriving in pieces: decode it with a `StreamDecoder`, which never shows a raw
   fragment and never resolves a handle before its name completes. The finished
   message and its streamed preview are two distinct boundaries and both decode.
2. **Co-location.** The same process that taught the model the notation must own
   the `expand()` applied to that model's output. Never teach the vocabulary on
   one instance and expand on another.
3. **Identity when empty.** Every codec method is a no-op or passthrough with no
   vocabulary present.

The consequence is the safety property: a non-adopter never teaches the model the
notation, so its model never emits a handle, so there is nothing to corrupt.
Ignoring Argot costs forgone savings and nothing else.

## Integration

Argot has exactly one integration path: a harness imports the SDK and calls it at
its hook points. There is no proxy and no MCP mode. A harness either adopts Argot
or ignores it, exactly like `AGENTS.md`. This keeps the surface small, keeps
correctness in one place, and lets the standard spread by adoption rather than
interception.

### The hook points

1. **System-prompt assembly.** Append `ARGOT_PREAMBLE` to the system prompt,
   always. It is the fixed decoder: it teaches the notation and tells the model to
   read `AGENTS.dict` from the project root when present. A harness that prefers to
   place the whole vocabulary in the prompt instead of relying on the agent's read
   can append `promptFragment()` in place of the preamble once a dict is loaded;
   it is self-contained and carries its own instruction line, so use one or the
   other, not both.
2. **Vocabulary load.** Parse `AGENTS.dict` from the agent's own file read and
   activate the handles for the session. Because the agent chose the file, it is
   the dictionary for the project actually in front of it, which sidesteps the
   launch-directory problem.
3. **Model-output ingestion.** Run `expand()` over the model's output at the
   earliest point, before the harness fans it out to the renderer, the transcript
   log, the tools, or another agent. This placement is load-bearing: expand
   before display, not only before execution, or the user reads raw handles. For a
   live token display, where output arrives incrementally, use a `StreamDecoder`
   (`session.streamDecoder()`) rather than `expand` on each delta, so a handle
   split across two deltas is never shown raw or resolved early.

The complete, mechanical seam list a harness wires (tool arguments, finished
display, streamed preview, transcript, spawn prompt, subagent return) is given in
the [integration manual](./INTEGRATING.md).

### The wire-only invariant

Handles exist only between the harness and the model. The model learns them from
the dictionary it read and emits them in its output, and the API traffic carries
them. That is the entire blast radius. Everything a human reads and every argument
a tool runs is always the expanded form, because `expand()` runs before any of
those boundaries. With Argot on or off, the user's view is byte-identical; only
the token bill changes.

### Reach across harnesses

Reach comes from making adoption trivial in each ecosystem, not from intercepting
traffic. The codec is small, so each harness ecosystem can get a thin
implementation of the same contract (TypeScript is the reference; Python, Go, and
a native Rust core may follow). A harness adds one import and the hook points
above. This is the `AGENTS.md` model: universal because it is trivial to honor,
and inert when unhonored.

### Rejected: proxy and MCP

Both were considered and dropped, recorded here so the decision is not reopened.

- A model-API **proxy** would reach harnesses without code changes, but it cannot
  intercept subscription-authenticated harnesses (their auth is not a swappable
  endpoint), it is fragile around prompt caching (a rewrite that shifts a cache
  breakpoint can cost more than the handles save), and it is an operational and
  trust liability as a man in the middle on model traffic. The maintenance cost
  buys only partial, flaky reach. If anyone wants it, it stays an experimental
  fallback path.
- An **MCP** integration can inject the vocabulary but cannot expand handles in a
  harness's native tool calls, only in tools routed through an Argot gateway.
  That is partial by construction and breaks output handles, so it is not a
  correct standalone path.

## Levers a harness can pull

Loading the vocabulary and expanding output are separate steps. Expansion is a
safety net that is always cheap to leave on: with nothing loaded, the model was
never taught any handles, so `expand()` is identity. Loading is the real decision,
which handles to activate for a session, and it opens a few levers. None of them
touch the format or the safety story.

The model and context-size levers ship as a concrete primitive, `shouldEncode`,
a pure predicate over an `ArgotGate` (`models`, `disableAboveTokens`) and the
per-turn inputs a harness measures (`model`, `contextTokens`). It governs only
encoding (whether the harness teaches the notation this turn) and never
decoding, which stays unconditional. The remaining levers (scope, budget,
sub-agent slices) act on the loaded vocabulary and compose with it. See
[README: Controlling when the model encodes](./README.md#controlling-when-the-model-encodes).

- **Gate the codec by model.** A dictionary is only as useful as the model's
  recall. Teach the notation to a model you trust with it and not to one you have
  not measured, via the `ArgotGate.models` allowlist (empty means no model, the
  safe default). Expansion stays on throughout, so declining to teach a model
  only trades away savings. Tune it from real data: track how often each model
  uses a handle and how often it slips.
- **Gate encoding by context size.** Recall of the vocabulary degrades as the
  context grows, so `ArgotGate.disableAboveTokens` stops teaching the notation
  once the context passes a token threshold; the model then writes in full and
  cannot garble a handle. Handles already written still expand losslessly, since
  the cutoff touches encoding only.
- **Gate handles by scope.** `[meta.<handle>].scope` is a glob for where a handle
  applies. Activate it only when the session works under a matching path. A
  smaller active codebook is easier for the model to keep straight, so scoping
  helps recall and cost together.
- **Budget the codebook.** When a project has more handles than you want to spend
  context on, rank by tokens saved (length times frequency) and activate the top
  slice that fits your budget.
- **Give sub-agents their own vocabulary.** Each subagent owns its own session, so
  a subagent doing one narrow job can start empty and load a denser, task-specific
  slice (`fresh`), inherit the parent's (`inherit`), or run without shorthand
  (`off`). Correctness never depends on the choice; see [Subagents](#subagents).

## Economics

- **A handle pays from about one reuse.** Output tokens cost roughly six times
  input tokens, and the definition amortizes in the read that the model already
  performs, so even a handle used twice is token-positive. One-shots are the only
  clear exclusion.
- **Reading a handle is no harder than the recall tool calls already demand.**
  The model only has to reach a small, fixed table it read earlier in the same
  context. That is a smaller demand than one correct tool call, which requires
  holding the file being edited, the paths, the task, and the conventions at
  once. A model whose recall could lose a cached table would already be making
  unreliable tool calls, so the handles ask for no trust you have not already
  extended. Long-context window size is not the enabling property.
- **And when recall does eventually run out, it degrades gracefully.** Push far
  enough past a model's reliable window and it will stop reaching the sigil and
  the handles. Nothing breaks: it falls back to writing the full strings, which
  `expand` passes through unchanged, and you are back to ordinary, slightly less
  efficient tool calls. There is no cliff, only a return to the baseline, so a
  large context costs you savings at worst, never correctness.
- **The frontier is where it pays most, for pricing not recall.** A top model
  like Fable 5 has steep output pricing, so each handle use is worth more. The
  recall is there on any capable model; the savings are largest exactly where
  output is dearest.

## Generating a dictionary

Authoring by hand is the baseline, but the first draft can be generated. The SDK
ships `generateDictFromRepo` (and the lower-level `generateDict` over any text
corpus), a pure, build-time function: nothing generates at runtime.

The recommended corpus is the repository itself, not agent transcripts. The value
of a handle is the output tokens it removes: how much longer the string is than
its handle, times how often the model writes it. What an agent writes in a repo
is overwhelmingly derived from the repo (file paths, import roots, build
commands), so the tree predicts output directly, with three advantages over
transcripts: it exists on day one (no cold start), it covers the whole surface
evenly (no task bias), and a string's cross-file frequency is exactly the
centrality that predicts how often it will be typed. Transcripts add only the
commands and phrasings that never appear in source, a useful supplement rather
than the primary source.

The generator enumerates every path in the listing as a candidate (a path in the
tree is worth a handle even if nothing else references it), adds frequency from
file contents when given, scores by tokens saved, and fills the dictionary
highest value first up to a token budget. The budget is on the dictionary,
because the dictionary is what a harness reads into context; the default is 1000
tokens. The emitted TOML always re-parses through `parseDict`, so generation
never produces a dictionary the loader would reject. You then curate the result:
the guidance below applies to a generated draft exactly as to a hand-written one.

## Project resolution and the runtime cache

The committed `AGENTS.dict` is the baseline, but a harness does not have to commit
a dictionary at all. It can generate one, keep it in its own state directory, and
regenerate it as the repository moves. Nothing lands in the working tree, so
there is no file for a pull request to pick up and no ignore rule to maintain.
This is safe whenever the harness expands handles on every path that leaves the
machine, so the encoded form never crosses a machine boundary and the dictionary
is a pure local decode cache.

### Finding the project

The cache is keyed to a project, so the first question is where a project starts.
`resolveProjectRoot(startDir)` walks up from `startDir` and returns the first
ancestor that contains a marker, or `undefined` at the filesystem root. The
default markers (`PROJECT_MARKERS`) are:

- **`.git`**, the usual signal, so an ordinary repository needs no setup.
- **`.argot`**, an explicit opt-in a user drops into a project that has no git,
  or into a subtree they want treated as its own root. This is the answer to
  both the no-git case and the case where the real work unit is a directory
  inside a larger tree: put a `.argot` marker at that directory and resolution
  stops there.

Because the walk returns the **nearest** marker, a repository nested inside a
larger tree resolves to itself. A crate with its own `.git` inside a monorepo
resolves to the crate, not the monorepo, so its cache is scoped to the crate's
own vocabulary. When neither marker is present anywhere up to the root,
resolution returns `undefined` and the harness keeps the session inert; a project
with no marker is not an error.

`projectCacheId(rootPath)` then turns the resolved root into a stable, fs-safe id
derived from the absolute path alone (no git, no network, no reading the tree).
The same root always yields the same id, so several agents on one project share
one cache directory while separate projects never overlap.

### Resolving the cache

The cache is **content-keyed and immutable**. `cacheDictPath(baseDir, cacheId,
contentSig)` gives the file path `<baseDir>/<cacheId>/<contentSig>.dict`, where
`baseDir` is the harness's own state directory and `contentSig` names the state of
the repository the entry was generated from: the git HEAD for a git project, or
`listingSignature(files)` for a project opted in with a bare `.argot` marker and
no HEAD to key on. `resolveProjectCache({ baseDir, cacheId, contentSig, files })`
reads the entry for that signature if it exists (returning it verbatim, `hit:
true`) and otherwise generates a fresh dictionary from `files` and writes it
atomically (`hit: false`). An entry is never mutated once written. Two properties
make this safe under many sessions and subagents at once:

- **Immutable, per-state entries.** A repository that moves produces a new
  signature and a new entry; the old one stays put. Two agents on the same state
  read the same entry, two agents on different states (two commits, two worktrees,
  two branches) read different entries, and nothing ever writes over a file another
  reader holds. There is no shared mutable file to contend on, so there is no `rev`
  marker and no monotonic pinning: handles never persist (every boundary expands
  them, including the persisted transcript), so nothing depends on a handle keeping
  its name across sessions, and pinning would defend a property nothing needs.
- **Short deterministic names.** The cache defaults to `naming: "mnemonic"`. A
  name is a pure function of the expansion SET: an expansion whose short stem is
  unique gets the bare stem (`connec` for `.../connection-pool.ts`), the shortest
  name that still saves tokens; only expansions that collide on a stem pay a
  disambiguator, and only the shortest hash prefix that separates them. Because the
  name depends on the set and not on iteration order, two agents that independently
  generate the same entry produce byte-identical text, so the atomic
  temp-and-rename write (`writeDictFileAtomic`) makes the racing writes harmless.
  This replaced an earlier `naming: "content"` default (`stem_` plus a fixed
  8-char hash on every handle): content names were globally unique but nearly as
  long as a short expansion, so a handle saved almost no tokens — the whole point
  of the codec. Short names restore the win. The one cost: a bare stem is unique
  only *within* its own dictionary, so a within-context union of two different
  folders' dictionaries (the multi-project `argot_load` case) can now assign the
  same short name to two different strings. That does not corrupt anything —
  `unionVocabularies` detects it and throws `ArgotConflictError` loudly (fail
  closed, never a silent mis-expansion). Handles never persist (every boundary
  expands them, including the persisted transcript), so a name is only ever live
  within the session that taught it; nothing downstream depends on a name being
  globally stable.

A malformed cache is never silently discarded and rebuilt from empty:
`readDictFile` and `resolveProjectCache` throw `ArgotParseError` instead, so a
corrupt cache surfaces to the operator rather than stripping every handle already
written into live transcripts.

A harness does not run those stages itself. `resolveProjectVocab({ folder,
cacheDir, io, tokenBudget?, onNotice? })` composes the whole flow — resolve the
root, decide git-vs-walk, key the immutable entry by the budget-folded content
signature, gather the bounded corpus, and read-or-generate — into one call that
returns `{ root, vocab }` (or `undefined` when `folder` has no marker). It exists
so every harness runs this identically instead of reimplementing it: the harness
supplies only the git access it owns (an `io` wrapping `git rev-parse HEAD` and
`git ls-files`, each `null` for a non-git folder) and the `cacheDir` path, and
wires `onNotice` to its logger so a reached content budget, files that could not
be read (path-only, with a count), a truncated or partially-unreadable non-git
tree, or an invalid budget is surfaced, never swallowed. The stage functions above (`resolveProjectRoot`,
`projectCacheId`, `resolveProjectCache`, `gatherRepoFiles`, `listingSignature`)
stay exported for a harness that must drive one stage directly, but the composed
call is the intended entry point and a harness should not hand-roll a second copy
of it.

The harness then arms the session from the resolved vocabulary. For a single
project it can use `loadVocab`; for a harness that loads several folders into one
context it uses `load(root, vocab)` per project (what `resolveProjectVocab` pairs
with, keying on the root it returns). Either way it teaches the handles with
`promptFragment` (the model never reads an `AGENTS.dict` in this flow, so it must
learn the table from the prompt).

## Subagents

A harness that spawns subagents needs each one to be correct without leaking
handles between parent and child. The load-bearing rule is not vocabulary
sharing, it is the boundary rule from [the codec contract](#the-codec-contract),
applied to the spawn seam: **every agent expands its own output at every boundary
it emits across**: a tool call, the persisted transcript, the prompt it hands a
spawned child, and the result it returns to a parent. Because each side only ever
emits fully expanded text to the other, a handle never crosses the parent-child
wire, and no child ever needs the parent's vocabulary to be correct. A subagent
that starts with an empty session is already correct.

On that foundation, a harness picks how much of the parent's shorthand a child
starts with. Three modes, all resting on the boundary rule:

- **`off`.** The child gets no codec, no tools, no teaching. The parent's spawn
  prompt is expanded at the boundary, so the child reads and writes full text.
  Cheapest, and trivially correct.
- **`fresh`.** The child gets its own `ArgotSession`, independent of the parent,
  and loads the project of its own task through the load tool (the canonical
  agent-driven flow). Use it when the child works a different project than the
  parent (a monorepo parent, a crate-scoped child). This is the correct baseline:
  spawn prompt and returned result are both expanded at the boundary, so parent
  and child share nothing.
- **`inherit`.** The child's session begins as `parent.fork()`, a detached copy of
  the parent's keyed entries and teach flags. This is a pure token optimization:
  the child writes the parent's shorthand from its first turn, and a harness may
  additionally leave the spawn prompt unexpanded because the child decodes what the
  parent wrote. The return boundary stays safe regardless, because the child
  expands its own result, which covers any handle it added by loading a project the
  parent lacked. The fork is a copy, so the child loading or unloading never
  mutates the parent.

The modes compose recursively: a child's own children follow the child's mode.
Teaching is additionally gated per context by `shouldEncode` (the child's own
model and context size), so a scout or a long-context child is never taught even
under `inherit`, and still decodes for free.

## Authoring guidance

Argot has little runtime intelligence, so the quality of the vocabulary is mostly
in how you author or curate it. A short guide:

- **Add the strings you repeat.** The long package paths, the canonical
  build/test/typecheck commands, the database entrypoint, the common import
  roots. If you find yourself typing it often, it belongs here.
- **Keep it to the few dozen that matter.** The binding constraint is not
  reaching a handle, which is easy, but choosing among many. A large vocabulary
  is prompt weight the model must scan to pick the right entry, and the long tail
  of rarely-used handles rarely pays for that room. Prefer a small, high-value
  set.
- **Handle style is your call, and denser is cheaper.** A handle name is just
  `[a-z0-9_]+`, so `§dbconn`, `§m7`, and `§1` are all legal. Numeric handles are
  the densest: `§1` is two tokens, and stays two tokens through `§999`, against
  three for `§dbconn`. So a numeric scheme saves roughly one token per use over a
  readable one and is trivial to generate. The one cost is a correctness one, and
  it is unmeasured: a dense numeric space makes every short code a live handle, so
  a slipped digit lands on another real handle and expands silently to the wrong
  string, where a slipped name usually lands on an undefined handle and fails in
  the open. For a high-recall model reading an in-context table, that slip may be
  vanishingly rare. Treat the choice as measurable, not settled: run both and
  compare adoption and wrong-handle rate on your target models. The examples in
  this document use readable handles only because a reader needs to see the
  meaning; a deployed dict can number them.

## Security

The expansion, not the handle, is what enters model context. A committed
`AGENTS.dict` is therefore a prompt-injection surface with the same trust model
as `AGENTS.md`: trusted repo content, reviewed like code.

It is slightly sharper than prose, because a short handle can hide a larger
payload that a diff reviewer skims past. v0 enforces two concrete guards: every
expansion is bounded (at most 8192 bytes), and a malformed dict fails loud rather
than loading partially. Richer review tooling (rendering expansions in review,
flagging entries that read as instructions) is future work, not part of v0.

## Versioning and compatibility

`AGENTS.dict` carries `version` and `sigil` in its header. A loader pins the
format major it understands and refuses a newer major loudly instead of guessing.

## v0 scope

Shipped in the TypeScript reference implementation:

- the `AGENTS.dict` format, the `§` sigil, and collision-proof, longest-match
  expansion,
- the codec surface: `ArgotSession` (keyed multi-project `load`/`unload`, `fork`,
  `observe`, `loadVocab`, `streamDecoder`), `parseDict`, `makeDict`, `emptyDict`,
  `unionVocabularies`, `load`, `renderPreamble` / `ARGOT_PREAMBLE`, the tool-name
  constants `ARGOT_LOAD_TOOL` / `ARGOT_UNLOAD_TOOL`,
  `AgentDict.promptFragment` / `AgentDict.expand`, and the streaming decoder
  `StreamDecoder` / `makeStreamDecoder` for live token displays,
- the encoding gate: `shouldEncode`, `ArgotGate`, `ArgotGateInput`, `EMPTY_GATE`,
- the build-time generator: `generateDictFromRepo` and `generateDict`, with
  `estimateTokens` and `extractCandidates`,
- project resolution and the immutable runtime cache: `resolveProjectRoot`,
  `projectCacheId`, `cacheDictPath`, `listingSignature`, `readDictFile`,
  `writeDictFileAtomic`, and `resolveProjectCache`, composed into the one call a
  harness actually uses, `resolveProjectVocab` (with `ProjectVocabIO`,
  `ResolvedProjectVocab`, `ProjectVocabNotice`), over the corpus policy
  `gatherRepoFiles` / `walkProjectTree` / `shouldScanContent` and the budget
  helpers `resolveTokenBudget` / `budgetKeyedSignature`,
- keyed multi-project sessions and the subagent model (boundary rule plus
  `off`/`fresh`/`inherit` via `fork`),
- veyyon as the first consumer, with a measured before/after token delta to lead
  the public pitch.

Deferred, and tracked as follow-on work:

- **A Rust core and other-language bindings** (Python, Go, native Rust), once the
  contract has proven out in TypeScript.
- **Lazy per-token injection.** Instead of holding the whole vocabulary in the
  prompt, inject a handle's expansion the instant the model reaches for it, using
  a stream rule. This removes the vocabulary's standing prompt cost and lifts the
  practical cap on entry count.
- **A transcript-driven discovery helper.** The shipped generator learns from a
  repo listing or any text corpus at build time. A detached, stateful helper that
  mines real session logs or git history for candidate phrasings that never
  appear in source is a separate, later addition, outside the codec and the
  standard.
- **Scope-aware activation** wired end to end. The `scope` field is defined and
  validated now, but no code path honors it yet; activating a handle only under a
  matching path is a harness lever still to build.
- **Shared cross-repo base vocabularies** (a language or framework ships a starter
  dict).

## Open questions

- Sigil default. `§` is rare but non-ASCII. Measure whether target models emit it
  reliably with a canary before committing. An ASCII-safe alternative may recall
  better even at a small collision-avoidance cost.
- Input interning. Whether Argot ever compresses repeated input spans (large tool
  outputs, pasted logs) in addition to output handles. The model must hold the
  vocabulary to read a compressed span, so the tradeoff is the vocabulary's prompt
  cost against the interning savings; quantify it.
- The soft cap on entry count and the per-model recall ceiling. Both are
  empirical and set by the canary and the veyyon token-delta measurement.
