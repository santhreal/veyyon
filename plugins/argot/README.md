# argot

Shorthand vocabulary codec for coding agents. Provides a lossless substitution codec over `AGENTS.dict` files.

A project defines short handles for recurring strings such as paths, import roots, and build commands. The model emits the handle, and the harness expands it to full text before execution, storage, or display.

Specifications and integration guides:
- [`SPEC.md`](./SPEC.md): Formal design specification.
- [`INTEGRATING.md`](./INTEGRATING.md): Step-by-step harness integration manual.

## Installation

```sh
bun add argot   # or: npm install argot
```

## Quick start

```ts
import { ArgotSession } from "argot";

const argot = new ArgotSession();

// 1. Append preamble to system prompt:
systemPrompt += argot.preamble;

// 2. Observe files read by the agent (loads vocabulary from AGENTS.dict):
argot.observe(path, content);

// 3. Expand model output before execution or display:
const clean = argot.expand(modelOutput);
```

`expand` is an identity function until a dictionary is loaded.

## Stream decoding

`StreamDecoder` buffers incomplete handles across streaming chunks:

```ts
const decoder = argot.streamDecoder();

// On each stream delta:
render(decoder.push(delta));

// When the stream ends:
render(decoder.flush());
```

Call `decoder.reset()` to clear the buffer if a stream aborts.

## The AGENTS.dict file

`AGENTS.dict` uses TOML syntax at the project root:

```toml
version = 1
sigil = "§"

[handles]
dbconn = "packages/server/src/database/connection.ts"
tsc    = "bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit"
migr   = "packages/server/src/database/migrations"

[meta.dbconn]
note  = "Database entry point"
scope = "packages/server/**"
```

- Handle names match `[a-z0-9_]+`.
- Expansions are non-empty strings up to 8192 bytes and cannot contain the sigil.
- The default sigil is `§`.

## Generating a dictionary

`generateDictFromRepo` inspects repository files and generates an `AGENTS.dict` within a token budget:

```ts
import { generateDictFromRepo } from "argot";
import { execSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";

const files = execSync("git ls-files", { encoding: "utf8" })
  .split("\n")
  .filter(Boolean)
  .map(path => ({ path, content: tryRead(path) }));

const { toml, handles, dictTokens, estimatedSavings } = generateDictFromRepo(files, {
  tokenBudget: 1000,
});

if (toml) writeFileSync("AGENTS.dict", toml);

function tryRead(path: string) {
  try { return readFileSync(path, "utf8"); } catch { return undefined; }
}
```

Options for `generateDict` and `generateDictFromRepo`:
- `tokenBudget`: Maximum token size of the generated dictionary (default: 1000).
- `savingsCoverage`: Stop generation when covering this fraction of reachable savings (default: 0.9).
- `minFrequency`: Minimum occurrences to qualify (default: 1 for repos, 2 for raw corpora).
- `minExpansionLength`: Minimum character length of candidate strings (default: 8).
- `naming`: `"mnemonic"` (default), `"numeric"`, or `"content"`.
- `toolCallStructureShare`: Share of line-structure tokens occurring inside JSON tool calls (default: 0.4176).

## Runtime cache

`resolveProjectVocab` resolves or generates project vocabularies in a local cache directory without modifying the workspace:

```ts
import { ArgotSession, type ProjectVocabIO, renderPreamble, resolveProjectVocab } from "argot";

const io: ProjectVocabIO = {
  gitHead: (root, signal) => myGit.headSha(root, signal),
  listTrackedFiles: (root, signal) => myGit.lsFiles(root, signal),
};

async function argotLoadTool(argot: ArgotSession, folderPath: string) {
  const resolved = await resolveProjectVocab({
    folder: folderPath,
    cacheDir: stateDir,
    io,
    tokenBudget,
    onNotice: n => log(n.message, n.data),
  });
  if (!resolved || resolved.vocab.handles.size === 0) return resolved;
  argot.load(resolved.root, resolved.vocab);
  return resolved;
}

const argot = new ArgotSession();
systemPrompt += renderPreamble({ tools: true });
systemPrompt += argot.promptFragment();
```

Cache entries are stored at `<cacheDir>/<cacheId>/<contentSig>.dict` using atomic file writes.

## API Reference

| Export | Description |
| --- | --- |
| `class ArgotSession` | Session state container managing active vocabularies, preamble generation, and expansion. |
| `renderPreamble(options?)` | Returns the model-facing notation prompt fragment. |
| `ARGOT_PREAMBLE` | Static preamble string with tool descriptions omitted. |
| `ARGOT_LOAD_TOOL` / `ARGOT_UNLOAD_TOOL` | Standard tool names (`"argot_load"`, `"argot_unload"`). |
| `unionVocabularies(vocabs)` | Merges multiple vocabularies into one; throws `ArgotConflictError` on conflicting expansions for the same handle. |
| `parseDict(content, source)` | Parses TOML dictionary text into a `Vocabulary` structure. Throws `ArgotParseError`. |
| `makeDict(vocab)` / `emptyDict()` | Constructs an `AgentDict` codec from a vocabulary. |
| `load(projectRoot)` | Loads and parses `AGENTS.dict` from a project root directory. |
| `AgentDict.promptFragment()` | Formats active handles for inclusion in the system prompt. |
| `AgentDict.expand(text)` | Restores handles in text to their full expansions. |
| `shouldEncode(gate, input)` | Evaluates model and token constraints to determine if shorthand should be taught for the current turn. |
| `ArgotGate` / `ArgotGateInput` | Configuration and turn input types for encoding gates. |
| `EMPTY_GATE` | Gate configuration with encoding disabled. |
| `modelAllowed(entry, activeModel)` | Matches model identifiers against allowlist patterns. |
| `modelIdSegment(id)` | Extracts the model name from a provider-qualified identifier. |
| `generateDictFromRepo(files, options?)` | Generates a vocabulary from repository file paths and contents. |
| `generateDict(corpus, options?)` | Generates a vocabulary from an arbitrary text corpus. |
| `estimateTokens(text)` / `extractCandidates(text)` | Token counting heuristic and string candidate extractor. |
| `resolveProjectRoot(startDir, options?)` | Locates the nearest parent directory containing `.git` or `.argot`. |
| `projectCacheId(rootPath)` | Computes a stable filesystem identifier for a project path. |
| `cacheDictPath(baseDir, cacheId, contentSig)` | Constructs the cache file path for a given repository state. |
| `listingSignature(files)` | Computes a content digest from a file listing. |
| `readDictFile(path)` | Reads and parses a cached dictionary file. |
| `writeDictFileAtomic(path, content)` | Writes dictionary content using a temporary file and atomic rename. |
| `resolveProjectCache(options)` | Loads or generates a cached dictionary for a project state. |
| `resolveProjectVocab(options)` | End-to-end project vocabulary resolution and caching. |
| `makeExpander(vocab)` | Creates a standalone text expansion function. |
| `class StreamDecoder` / `makeStreamDecoder(vocab)` | Incremental decoder for streaming text chunks. |
| `DEFAULT_SIGIL` | Default sigil string (`"§"`). |
| `DICT_FILENAME` | Default dictionary filename (`"AGENTS.dict"`). |
| `MAX_EXPANSION_BYTES` | Maximum expansion length in bytes (8192). |
| `SUPPORTED_VERSION` | Supported dictionary schema version (1). |

## Controlling model encoding

Use `shouldEncode` to gate teaching shorthand to the model while keeping decoding active:

```ts
import { type ArgotGate, ArgotSession, shouldEncode } from "argot";

const argot = new ArgotSession();

const gate: ArgotGate = {
  models: ["anthropic/claude-opus-4"],
  disableAboveTokens: 400_000,
};

if (shouldEncode(gate, { model: activeModelId, contextTokens: currentContextTokens })) {
  systemPrompt += argot.preamble;
}

argot.observe(path, content);
const clean = argot.expand(modelOutput);
```

Parameters:
- `models`: Allowlist of model identifiers (exact `provider/model` or bare `model` wildcard).
- `disableAboveTokens`: Context token ceiling above which encoding is disabled (0 disables cutoff).

## Benchmarking

Run the benchmark script against a repository:

```sh
bun bench/argot-bench.ts /path/to/repo
```

Sample output (coding agent repository, 1000-token budget):

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

Live model comparison output (Gemini 3.5 Flash, identical task per arm):

```text
arm             total    cacheRead   answer output (excl. reasoning)
off             37,380   28,530      ~183
expand-only     37,394   28,530      ~170
encode+expand   37,679   32,610      ~170
```

## Guarantees

- **Wire-only:** Expansions occur before execution or user-visible rendering.
- **Idempotent:** `expand` restores original text and is a no-op on previously expanded text.
- **Longest match first:** Longer handles take precedence over shorter prefixes.
- **Fails closed on parse errors:** Malformed dictionary syntax throws `ArgotParseError`.

## License

MIT
