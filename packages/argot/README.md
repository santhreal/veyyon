# argot

**Per-project shorthand vocabularies for coding agents.** A lossless substitution
codec over one file, `AGENTS.dict`, that any harness can adopt in three lines.

A coding agent retypes the same long strings all day: an absolute path, a
canonical build command, an import root. Output tokens are the expensive ones
(roughly 5-6x input), so that repetition is real money spent respelling strings
the repository already knows. Argot lets a project define short handles for those
strings. The model writes the handle, the harness restores the full text before
anything runs or is shown, and nothing a human reads or a tool executes ever
changes. Only the token bill does.

It is the codec companion to `AGENTS.md`: where `AGENTS.md` carries prose
guidance, `AGENTS.dict` carries a compact, reviewed vocabulary.

For the design essay and the reasoning behind every decision here, see
**[the Argot write-up](https://veyyon.dev/blog/argot)**. For the full formal
design, see [`SPEC.md`](./SPEC.md). To wire Argot into a harness, follow the
step-by-step **[integration manual](./INTEGRATING.md)**: it lists every seam and
the exact function to call at each, so adoption is a mechanical, one-pass job with
no codec logic on the harness side.

## Install

```sh
bun add argot   # or: npm install argot
```

## Quick start

`ArgotSession` is the whole integration. A harness does three things:

```ts
import { ArgotSession } from "argot";

const argot = new ArgotSession();

// 1. once, at session start:
systemPrompt += argot.preamble;

// 2. on every file the agent reads:
argot.observe(path, content); // loads the vocabulary when it sees AGENTS.dict

// 3. on every model output, before it leaves the loop:
const clean = argot.expand(modelOutput);
```

That is it. The session owns the "inert until the agent reads a dictionary"
state, so you never manage a codec or check filenames yourself, and `expand` is
identity until a dictionary loads, so the code above is safe to run
unconditionally. A project with no `AGENTS.dict` behaves exactly as it does today.

The vocabulary loads when the *agent* reads the file, not at process start,
because an agent is often launched from a directory other than the project it
works in. `observe` picks up the dictionary for whatever project is actually in
front of the agent.

## Decoding a live stream

`expand` is the right call everywhere text arrives whole: a finished message, a
tool argument, a saved transcript. A live token display is the one place it is
not enough, because the text arrives in pieces and a handle can split across two
of them. A model streaming `§dbconn` may deliver `§db` then `conn`; expanding each
piece alone would either show a raw `§db…` on screen or expand the shorter `§db`
before the name finished and the longer handle won. Deciding the longest match
needs the whole name and its trailing boundary in hand.

`StreamDecoder` handles that for you. It buffers exactly the trailing fragment
that could still become a handle and returns everything before it already
expanded, so what you render is always safe to show.

```ts
const decoder = argot.streamDecoder(); // one per streamed message

// on every token/delta, render ONLY what push returns:
render(decoder.push(delta));

// once, when the message finishes streaming:
render(decoder.flush());
```

The concatenation of every `push` return plus the final `flush` is byte-identical
to `expand` of the whole message, for any way the stream was chunked. Call
`decoder.reset()` to drop the buffer if a stream aborts. With nothing armed the
decoder is a pure pass-through, so wiring it in is safe whether or not a project
has a dictionary. This is seam 3 in the [integration
manual](./INTEGRATING.md#step-3-decode-at-every-seam-the-load-bearing-step); the
finished message and the live preview are two separate seams and both decode.

## The file

`AGENTS.dict` is TOML, at the project root. You write it by hand and review it
like code.

```toml
version = 1
sigil = "§"

[handles]
dbconn = "packages/server/src/database/connection.ts"
tsc    = "CARGO_TARGET_DIR=/dev/null bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit"
migr   = "packages/server/src/database/migrations"

# optional per-handle metadata, for reviewers and scope-aware harnesses
[meta.dbconn]
note  = "the one database entrypoint"
scope = "packages/server/**"
```

- Each `[handles]` entry maps a **handle name** to its **expansion**. The
  **sigil** (`§` by default) precedes a name, so `§dbconn` is a handle and
  `dbconn` on its own is an ordinary word.
- A handle name is `[a-z0-9_]+`, so `§dbconn`, `§m7`, and `§1` are all legal.
  Numeric handles are the densest (`§1` is two tokens, versus three for
  `§dbconn`); readable handles are self-documenting in a diff. See the SPEC for
  the tradeoff.
- An expansion is literal, non-empty, at most 8192 bytes, and may not contain the
  sigil, so expansion is a single lossless pass and no handle expands into
  another.

## Generating a dictionary

You do not have to write the first `AGENTS.dict` by hand. The recommended
starting point is your repository: what a coding agent types all day (file
paths, import roots, build commands) is already in the tree, so the repo
predicts the agent's output without needing any transcript. Point
`generateDictFromRepo` at your files and it proposes the handles that would save
the most output tokens, packed into a dictionary that itself stays under a token
budget. You review and commit the result; nothing is generated at runtime.

```ts
import { generateDictFromRepo } from "argot";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

// The repo's files: every path is a candidate, and contents add frequency.
const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map(path => ({ path, content: tryRead(path) }));

const { toml, handles, dictTokens, estimatedSavings } = generateDictFromRepo(files, {
  tokenBudget: 1000, // the generated dictionary stays under this; the default
});

console.log(`${handles.length} handles, dictionary ~${dictTokens} tokens, ~${estimatedSavings} output tokens saved per pass`);
if (toml) writeFileSync("AGENTS.dict", toml);

function tryRead(path: string) {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}
```

Every path in the listing becomes a candidate, because a path in the tree is a
string the agent will type whether or not another file mentions it. When you
pass contents too, the strings that recur across the repo gain frequency: a
widely referenced module path or a repeated command ranks above a one-off, which
is the same centrality that predicts how often the agent will write it. Contents
are optional: with the listing alone, ranking falls back to path length
(longest first).

The budget is on the dictionary itself, because the dictionary is what a harness
reads into context. The generator fills it highest value first, where a
candidate's value is the output tokens it removes (how much longer the string is
than its handle, times how often it appears), and stops before the next entry
would breach the budget. The default budget is 1000 tokens.

### Other corpora

`generateDictFromRepo` is a thin wrapper over `generateDict`, which takes any
text corpus (one string or many). Use it directly when the repo is not the right
source:

- **Transcripts** (the model's own past output) catch commands and phrasings that
  never appear in source. They are a useful supplement, not the primary source:
  they need history to exist and reflect only the tasks you happened to run.
- **A command list** proposes handles for your build, test, and deploy lines.

Useful options for either entry point: `minFrequency` (least occurrences to
consider; `generateDict` defaults to 2, `generateDictFromRepo` to 1 since the
listing guarantees one), `minExpansionLength` (least characters, default 8),
`naming` (`"mnemonic"`, the default: short readable handles — a bare stem when it
is unique, else a minimal hash suffix only on a stem collision, deterministic
across runs; `"numeric"` for the densest; `"content"` for a stem plus a fixed
8-char hash on every handle, globally unique but longer and so fewer tokens saved,
see [Runtime cache](#runtime-cache-generated-never-committed)),
`maxHandles`, and `countTokens` (pass your model's real tokenizer for exact
accounting instead of the built-in heuristic). The result is empty (`toml === ""`)
when nothing clears the thresholds; that is a normal outcome, not an error, and
the emitted TOML always re-parses through `parseDict` to the same vocabulary.

## Runtime cache (generated, never committed)

You do not have to commit a dictionary at all. Instead of writing `AGENTS.dict`
into the repository, a harness can keep a generated one in its own state
directory and regenerate it as the repository moves. Nothing lands in the working
tree, so there is no file for a pull request to pick up and no ignore rule to
maintain. This is safe whenever the harness expands handles on every path that
leaves the machine (display, export, resume), so the encoded form never crosses a
machine boundary and the dictionary is a pure local decode cache.

The whole flow — find the project, sign its state, gather the corpus, resolve or
generate the entry — is one call, `resolveProjectVocab`. It is identical for every
harness, so it lives here, not in your integration. You supply only the two things
Argot cannot do itself: run git (an `io` object), and name the machine path where
the cache lives (`cacheDir`).

```ts
import { ArgotSession, type ProjectVocabIO, renderPreamble, resolveProjectVocab } from "argot";

// Adapt your harness's git to the two calls Argot needs. `null` => not a git repo,
// and Argot then walks a `.argot` project's tree itself.
const io: ProjectVocabIO = {
  gitHead: (root, signal) => myGit.headSha(root, signal),          // string | null
  listTrackedFiles: (root, signal) => myGit.lsFiles(root, signal), // string[] | null
};

// The canonical arming flow is agent-driven: the session starts unarmed and the
// model loads the project it works in through the argot_load tool, whose handler
// is exactly this resolve + load pair. Auto-arming from the launch directory at
// session start is the legacy path and picks the wrong project in a monorepo.
async function argotLoadTool(argot: ArgotSession, folderPath: string) {
  const resolved = await resolveProjectVocab({
    folder: folderPath,        // resolved up to its nearest .git/.argot root
    cacheDir: stateDir,        // stateDir is yours
    io,
    tokenBudget,               // optional; an invalid value is surfaced, not swallowed
    onNotice: n => log(n.message, n.data), // wire to your logger; never drop a notice
  });
  if (resolved === undefined || resolved.vocab.handles.size === 0) return resolved;
  argot.load(resolved.root, resolved.vocab); // arm, keyed on the resolved root
  return resolved;
}

const argot = new ArgotSession();
systemPrompt += renderPreamble({ tools: true }); // teach the notation AND the tools
systemPrompt += argot.promptFragment();          // the handle table, "" until the model loads
```

`resolveProjectVocab` returns `undefined` when the folder has no `.git` or
`.argot` marker (a normal "nothing to arm" answer), and never throws for a missing
project. On a cache hit it reads no listing at all; on a miss it lists the tree,
gathers bounded file content (so handles are ranked by how central a string is,
not by path length), generates once, and writes atomically. Because the tool
reads a project tree and writes the cache, gate it behind operator approval at
the same tier as a file write in any non-autonomous mode (show the resolved
root); `argot_unload` needs no approval, and expansion is never gated.

Do not reimplement this in your harness. If you find yourself running `git
ls-files`, hashing a content signature, or reading files to build a corpus, you
are rewriting `resolveProjectVocab` and it will drift from every other harness.
The lower-level primitives it composes (`resolveProjectCache`, `gatherRepoFiles`,
`listingSignature`, `cacheDictPath`, `readDictFile`) are exported for a harness
that genuinely needs to drive one stage directly, but the whole flow is the one
call above.

The cache is content-keyed and immutable, which is what makes it safe under many
agents and across many commits:

- **Immutable, per-state entries.** The entry is named by `contentSig`, so a
  repository that moves produces a new entry and the old one stays put.
  `resolveProjectCache` reads an existing entry verbatim and never mutates it. Two
  agents on the same state read one entry, two on different states read different
  entries, and nothing writes over a file another reader holds. There is no shared
  mutable `rev` marker and no monotonic pinning: handles never persist (every
  boundary expands them), so nothing depends on a handle keeping its name across
  sessions.
- **Short deterministic names.** The cache defaults to `naming: "mnemonic"`. A
  name is a pure function of the expansion set: a bare short stem when unique
  (`connec`), else the shortest hash suffix that separates a stem collision. Two
  agents that independently generate the same entry produce byte-identical text
  (the name never depends on iteration order), so the atomic temp-and-rename write
  (`writeDictFileAtomic`) makes the racing writes harmless. Short names are what
  make a handle actually shorter than the string it replaces — the token win. The
  trade: a bare stem is unique only within one dictionary, so a within-context
  union of two different folders (`argot_load` of a second project) can hit a name
  collision; that never mis-expands — `unionVocabularies` throws loudly. The old
  `naming: "content"` default was globally unique but put a fixed 8-char hash on
  every handle, so handles were nearly as long as short expansions and saved almost
  nothing.

A malformed cache is never silently discarded and rebuilt from empty:
`readDictFile` and `resolveProjectCache` throw `ArgotParseError` instead, so a
corrupt cache surfaces to the operator rather than stripping every handle already
written into live transcripts.

For a harness that loads several folders into one context (a monorepo agent
working two crates), use `argot.load(key, vocab)` per project instead of
`loadVocab`; `expand` then unions them and `unionVocabularies` throws on a genuine
conflict. Each subagent owns its own session: `argot.fork()` hands a child the
parent's shorthand (`inherit`), or a child starts empty and loads its own scope
(`fresh`). See the SPEC's [Subagents](./SPEC.md#subagents) section.

## API

The recommended surface is `ArgotSession`. The primitives it is built from are
exported too, for harnesses that drive the flow directly.

| Export | What it does |
| --- | --- |
| `class ArgotSession` | The session integration, holding a keyed set of vocabularies. `session.preamble` is the fixed notation block; `session.load(key, vocab, opts?)` arms a project under `key` (unions with other keys; `opts.teach` gates teaching; throws `ArgotConflictError` on a genuine clash); `session.unload(key)` stops teaching a key while decode stays on; `session.observe(path, content)` loads on read of an `AGENTS.dict`, keyed by its directory (throws `ArgotParseError` on a malformed dict); `session.loadVocab(vocab)` arms from one vocabulary, clearing the set first (the single-project cache flow); `session.fork()` returns a detached copy for a subagent (`inherit`); `session.promptFragment()` lists the handles it currently teaches; `session.expand(text)` restores handles from every loaded key, identity until a dict loads; `session.streamDecoder()` returns a `StreamDecoder` for a live token stream (see [Decoding a live stream](#decoding-a-live-stream)); `session.loaded` reports whether any is active. |
| `renderPreamble(options?): string` / `ARGOT_PREAMBLE: string` | The fixed, model-facing notation block. Inject once, always. `renderPreamble({ tools: true })` also tells the model it can call the load/unload tools (use only when the harness registers them); `ARGOT_PREAMBLE` is the tools-off default. |
| `ARGOT_LOAD_TOOL` / `ARGOT_UNLOAD_TOOL: string` | The canonical names (`"argot_load"`, `"argot_unload"`) of the two optional agent tools; register your tools under exactly these names so the preamble and the harness agree. |
| `unionVocabularies(vocabs): Vocabulary` | Combine several projects' vocabularies into one. Deduplicates a handle bound to the same expansion; throws `ArgotConflictError` on the same name bound to different expansions, or on different sigils. |
| `parseDict(content, source): Vocabulary` | Parse and validate dictionary text. `source` names the file in error messages. Throws `ArgotParseError`. |
| `makeDict(vocab): AgentDict` / `emptyDict(): AgentDict` | Build the codec from a parsed vocabulary, or the inert codec. |
| `load(projectRoot): Promise<AgentDict>` | Convenience when the harness already knows the root. Inert codec if the file is absent, throws on a malformed one, rethrows any read error other than "not found". |
| `AgentDict.promptFragment(): string` | Alternative to the preamble: a block listing every handle inline, for placing the whole vocabulary in the system prompt. `""` when empty. |
| `AgentDict.expand(text): string` | Restore every known handle to its expansion. Identity when empty. |
| `shouldEncode(gate, input): boolean` | Decide whether to teach the model shorthand this turn (model allowlist + context cutoff). Gates only encoding; decoding is never affected. See [Controlling when the model encodes](#controlling-when-the-model-encodes). |
| `ArgotGate` / `ArgotGateInput` | The gate you build from settings (`models`, `disableAboveTokens`) and the per-turn inputs you measure (`model`, `contextTokens`). |
| `EMPTY_GATE: ArgotGate` | The inert gate: no model listed, no cutoff. `shouldEncode` is always `false`. |
| `generateDictFromRepo(files, options?): GeneratedDict` | Propose an `AGENTS.dict` from a repo file listing (with optional contents). The recommended starting point. See [Generating a dictionary](#generating-a-dictionary). |
| `generateDict(corpus, options?): GeneratedDict` | The underlying generator over any text corpus, packed under a token budget. |
| `estimateTokens(text): number` / `extractCandidates(text): string[]` | The default token heuristic and candidate extractor `generateDict` uses. Exported so you can reuse or replace either. |
| `resolveProjectRoot(startDir, options?): string \| undefined` | Walk up from `startDir` for a project marker (`.git`, or a `.argot` opt-in for non-git projects) and return the root, or `undefined`. The marker set and existence test are injectable. |
| `projectCacheId(rootPath): string` | A stable, fs-safe id for a project, derived from its absolute root path alone (per-machine, no git needed). The same root always yields the same id. |
| `cacheDictPath(baseDir, cacheId, contentSig): string` | The immutable cache entry path `<baseDir>/<cacheId>/<contentSig>.dict`. `baseDir` is the harness's own state directory; `contentSig` names the repository state. |
| `listingSignature(files): string` | A content signature for a project with no git HEAD: a hash of the sorted listing (paths, plus content hashes when supplied), so it changes exactly when a file is added, removed, renamed, or edited. |
| `readDictFile(path): Promise<Vocabulary \| undefined>` | Read a cache into a vocabulary. `undefined` when absent; throws `ArgotParseError` on a malformed file rather than discarding it. |
| `writeDictFileAtomic(path, content): Promise<void>` | Write dictionary text via a temp file and atomic rename, creating the parent directory. Safe under concurrent writers. |
| `resolveProjectCache({ baseDir, cacheId, contentSig, files, options? }): Promise<ResolvedCache>` | Resolve a project's cache entry for one state: read the existing immutable entry (`hit: true`) or generate content-named handles and write atomically (`hit: false`). Never mutates an existing entry. See [Runtime cache](#runtime-cache-generated-never-committed). |
| `resolveProjectVocab({ folder, cacheDir, io, tokenBudget?, onNotice?, signal? }): Promise<ResolvedProjectVocab \| undefined>` | The whole cache flow in one call, so no harness reimplements it: resolve `folder` to its project root, read the immutable entry for the current repository state or generate it once on a miss, and return `{ root, vocab }`. You inject only `io` (a `ProjectVocabIO` wrapping `git rev-parse HEAD` / `git ls-files`) and `cacheDir`. `undefined` when `folder` has no `.git`/`.argot` marker. See [Runtime cache](#runtime-cache-generated-never-committed). |
| `ProjectVocabIO` / `ProjectVocabNotice` / `ResolvedProjectVocab` | The git access `resolveProjectVocab` needs (`gitHead`, `listTrackedFiles`, each `null` for a non-git folder), the notices it surfaces (a reached content budget, an invalid budget) so no degrade is silent, and its `{ root, vocab }` result. |
| `resolveTokenBudget(raw, onNotice?): number` / `budgetKeyedSignature(sig, budget): string` | The budget validation and cache-key derivation `resolveProjectVocab` uses. An invalid budget is surfaced through `onNotice` and defaulted (never a silent empty dict); a non-default budget derives a distinct cache signature so two budgets over one state are two entries. |
| `gatherRepoFiles(root, paths, onNotice?)` / `walkProjectTree(root)` / `shouldScanContent(path)` | The corpus policy `resolveProjectVocab` applies: read bounded, deterministic file content (skipping lockfiles/assets/binaries via `CONTENT_SKIP_*`, capped by `MAX_FILE_CONTENT_BYTES` / `TOTAL_CONTENT_BUDGET_BYTES`), and the non-git tree walk (`WALK_IGNORE_NAMES`, `WALK_FILE_CAP`). Exported so a harness driving a stage directly gathers the corpus identically. |
| `PROJECT_MARKERS: readonly string[]` | The default markers `resolveProjectRoot` looks for (`.git`, `.argot`). Pass your own set through its `markers` option to change what counts as a project. |
| `makeExpander(vocab)` / `makePromptFragment(vocab)` | The expander function and the prompt block that `makeDict` composes, exposed for a harness that wants one without the `AgentDict` wrapper. |
| `class StreamDecoder` / `makeStreamDecoder(vocab)` | A stateful decoder for text that arrives in pieces, so a live token display never shows a raw handle even when one splits across chunks. `decoder.push(chunk)` returns the newly safe expanded text; `decoder.flush()` releases the final fragment at end of stream; `decoder.reset()` drops the buffer on an abort. `session.streamDecoder()` builds one from the session's current vocabulary. See [Decoding a live stream](#decoding-a-live-stream). |
| `DEFAULT_SIGIL` / `DICT_FILENAME` / `MAX_EXPANSION_BYTES` / `SUPPORTED_VERSION` | The format constants: `§`, `AGENTS.dict`, `8192`, and `1`. |

## Controlling when the model encodes

Argot has two directions, and they follow opposite rules.

- **Decoding**, `expand` turning a handle back into its full text, is not
  optional. Once a dictionary is loaded, run it over every model output, always.
  A handle that reaches a tool or the disk unexpanded is a broken path, not
  merely worse text.
- **Encoding**, teaching the model the notation so it writes handles in the
  first place, is a choice you can vary. It is the only thing the controls in
  this section touch.

Because decoding is unconditional, every control here is safe. The worst case of
turning encoding off is the model writing full text; it is never a leaked
handle, and a handle already in the history still expands.

The quick-start integration teaches encoding to every model on every turn: you
append `argot.preamble` unconditionally. If that is what you want, you are done
and can skip this section. `shouldEncode` is for harnesses that want to vary
encoding by which model is active or how large the context has grown.

### The gate

Build an `ArgotGate` from your settings once, then consult it each turn, right
before the point where you would inject the preamble:

```ts
import { type ArgotGate, ArgotSession, shouldEncode } from "argot";

const argot = new ArgotSession();

const gate: ArgotGate = {
  models: ["anthropic/claude-opus-4"], // model ids allowed to write shorthand; empty = none
  disableAboveTokens: 400_000,         // stop teaching past this context size; <= 0 = no limit
};

// each turn, before building the system prompt:
if (shouldEncode(gate, { model: activeModelId, contextTokens: currentContextTokens })) {
  systemPrompt += argot.preamble;
}

// unchanged, and still unconditional; decoding never consults the gate:
argot.observe(path, content);
const clean = argot.expand(modelOutput);
```

Two levers:

- **Model allowlist** (`models`). Only the model ids you list are taught the
  notation. Runtime ids are provider-qualified as `provider/model-id` (for
  example `google-antigravity/gemini-2.5-flash`), and each entry is matched two
  ways: a provider-qualified entry matches only that exact id, so it stays
  specific to one provider; a bare entry (no `/`, for example `gemini-2.5-flash`)
  is a provider wildcard that matches the model under any provider. Matching is
  otherwise exact and case-sensitive, with no substring fallback: a bare `flash`
  never matches `gemini-2.5-flash`. An empty list teaches no one, so adopting
  Argot without naming a model stays inert. Use it to keep shorthand off for
  models you have not yet trusted to produce handles reliably, and to turn it on
  model by model.
- **Context cutoff** (`disableAboveTokens`). Once the context reaches this many
  tokens, stop teaching shorthand, so a large, recall-degraded context writes in
  full rather than risking a garbled handle. Set it to `0` or less to never stop
  on size. You supply `contextTokens`, the prompt tokens the model last saw; if
  you cannot measure that cheaply, pass `0` and only the model allowlist
  applies.

`shouldEncode` is a pure function of the gate and those two inputs, so you can
unit-test your policy with no running agent. `EMPTY_GATE` is the inert gate (no
model, no cutoff) for an explicit "encode for nothing".

### Where each input comes from

Any harness has these three values to hand; the names differ but the concepts do
not.

| Gate input | What to pass | Notes |
| --- | --- | --- |
| `gate.models` | Your "models allowed to encode" setting | An array of model ids. Empty is the safe default. |
| `gate.disableAboveTokens` | Your "context cutoff" setting | `0` or less disables the cutoff. |
| `input.model` | The active model id for this turn | The same id you match settings against. |
| `input.contextTokens` | The prompt size the model last saw | Usually `input + cachedInput` tokens from the previous response's usage. Pass `0` before the first response. |

The gate governs only whether you append the preamble (or an inline
`promptFragment()`), so it composes with any prompt-assembly strategy. Nothing
else in the integration changes: `observe` still arms the codec when the agent
reads `AGENTS.dict`, and `expand` still runs at every boundary regardless of the
gate.

## Benchmarks

The repository ships a deterministic bench so you can measure the codec on your
own tree instead of trusting a headline number. It reads every tracked file,
generates a dictionary at the shipped default budget, and reports what the
handles actually cost and save. It makes no network calls, so the numbers are
reproducible byte for byte.

Run it against any repository:

```sh
bun bench/argot-bench.ts /path/to/repo
```

Here is a real run over the veyyon coding agent (about 4,000 tracked files, 14.5
million tokens of content), at the default 1,000-token dictionary budget:

```text
handles chosen                  5 (budget 1000 tokens)
dict token cost                 998
teach cost (encode arm)         1114 tokens / turn
aggregate output saved          185,255 (1.3%) losslessly
files containing a handle       152 / 3965 (3.8%)
best real file                  Cargo.lock
  full / encoded tokens         64,091 / 47,997
  saved on that file            16,094 (25.1%)
expansion latency               85 µs/call
```

Read those numbers as a distribution, not a single rate. The generator picks the
strings that recur most, and on this tree those are repeated assets: inlined
fontawesome SVG blocks, license headers, and `Cargo.lock` registry lines. So the
savings are concentrated. A turn that reproduces `Cargo.lock` writes it a quarter
shorter; a turn that reproduces prose containing none of the handles saves
nothing and still pays the teach fragment. The whole-corpus figure of 1.3% is
the average across every byte, most of which is unique code no handle covers.

Two consequences follow, and both are levers you already control:

- **The corpus decides what is worth a handle.** A tree whose repetition is real
  vocabulary (long import paths, recurring type names, fixed command lines) yields
  handles a normal turn reuses, not just handles a file dump reuses. If the
  generated dictionary is asset-heavy, feed `generateDict` a transcript or command
  list instead of the raw repo (see [Other corpora](#other-corpora)).
- **Encoding only pays when the turn emits handled content.** The teach fragment
  is a fixed per-turn cost, so teaching a model that will write plain prose is a
  small loss. That is why encoding is gated by model and context size (see
  [Controlling when the model encodes](#controlling-when-the-model-encodes)) and
  why decoding, which is free to leave on, never is.

The bench also asserts that expanding the encoded corpus returns the original
bytes exactly, so a run that prints numbers has also proved the round-trip is
lossless on real data.

### The live arm

The offline bench measures the codec ceiling. Whether a model actually writes
handles when taught is a separate question you answer by running the same task
three times against a real model, changing only two keys: `argot.enabled` and
`argot.models` (off, then `enabled` with an empty allowlist, then `enabled` with
your model named). Read adoption from the provider's output token count, not from
the printed answer: an adopted handle expands back to full text before you see
it, so the answer never shows a sigil even when the model used one. The token
count is where a shorter emission shows up.

A run against Gemini 3.5 Flash over this repository, one identical prose task per
arm, came out like this:

```text
arm             total    cacheRead   answer output (excl. reasoning)
off             37,380   28,530      ~183
expand-only     37,394   28,530      ~170
encode+expand   37,679   32,610      ~170
```

Two things stand out, and both are honest results rather than a win. The encode
arm's cacheRead rose about 4,080 tokens: that is the dictionary and notation
preamble entering the prompt, so the gate fired for the named model and stayed
off for the other two arms, which is the wiring working. But the answer output
is about the same taught or not, so Flash did not measurably adopt handles on a
natural prose turn, and the encode arm cost a few hundred tokens more for no
saving. That is the regime the offline numbers predict: teaching pays only when
the turn emits handled content the model actually shortens, which a short prose
explanation does not. A model that adopts more readily, or a task that
reproduces handled files, is where the encode arm turns positive.

## Guarantees

- **Wire-only.** Handles exist only between the harness and the model. Every
  argument a tool runs and everything a human sees is the expanded form.
- **Lossless and idempotent.** `expand` restores the exact bytes, matches the
  longest handle first (`§dbconn` beats `§db`), and leaves an unknown handle like
  `§dbextra` untouched rather than partially expanding it. Because an expansion
  may not contain the sigil, expanded text has nothing left to match, so a second
  pass is a no-op.
- **Inert by default.** A harness that does not adopt Argot never teaches the
  model the notation, so nothing changes and nothing can break. Adopt it or do
  not; not adopting is always safe.
- **Encoding is gated, decoding is not.** You may stop teaching the notation at
  any time, per model, past a context size, or entirely (see [Controlling when
  the model encodes](#controlling-when-the-model-encodes)). Decoding stays
  unconditional, so a handle already written always expands. Turning encoding
  off can only make the model write full text; it can never leak a handle.
- **Fails loud.** A malformed dictionary is refused with a clear error naming the
  offending key, never silently ignored.

## License

MIT
