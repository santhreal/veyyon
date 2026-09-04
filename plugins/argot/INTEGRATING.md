# Integrating Argot into a harness

This is the complete, step-by-step manual for wiring Argot into a coding-agent
harness. It is written so you can follow it top to bottom in one pass. Every hard
part lives in this library behind a named function; your job is to call those
functions at the right places. There is no codec logic to write and no edge case
to reason about on the harness side. If you find yourself thinking about how a
handle might split across a token boundary, or which of two handles wins, stop:
that belongs to Argot, and this manual points you at the function that already
handles it.

Read the two rules first, then wire the seams, then run the checklist.

## The two rules everything follows

1. **Decode at every seam.** A handle exists only in the model's own history.
   The instant text crosses out of that history to anywhere else, expand it
   first. "Anywhere else" is an exact, finite list, given below. Miss one and a
   raw `§handle` leaks to that place.
2. **Teach only when you choose.** Whether the model writes handles is a policy
   you gate (by model, by context size, or off entirely). Decoding never consults
   that policy. So teaching is safe to turn on or off at any time: the worst case
   of turning it off is the model writing full strings, never a leaked handle.

Rule 1 is correctness and is not optional. Rule 2 is savings and is entirely up
to you. The rest of this manual is rule 1 applied to each seam, plus how to set
up rule 2.

## Step 0: install and hold one session per agent

```ts
import { ArgotSession } from "argot";

const argot = new ArgotSession();
```

Create exactly one `ArgotSession` per agent (the top-level agent, and one per
subagent, see [Subagents](#subagents)). The session owns all state: which
vocabularies are loaded, what the model is taught, and how to decode. It starts
inert, so every call below is safe to run before any dictionary exists. A project
with no dictionary behaves byte-for-byte as it did before you added Argot.

## Step 1: teach the model (the encode seam)

At the point where you assemble the system prompt, append the notation block. Do
it every turn.

```ts
systemPrompt += argot.preamble;         // the fixed notation block
systemPrompt += argot.promptFragment(); // the handle table (empty string until armed)
```

`argot.preamble` teaches the notation. `argot.promptFragment()` lists the handles
the session currently teaches, and returns `""` until a vocabulary is armed, so
appending it unconditionally is safe.

To vary teaching by model or context size (rule 2), gate this one seam with
`shouldEncode`. Nothing else changes:

```ts
import { type ArgotGate, shouldEncode } from "argot";

const gate: ArgotGate = {
  models: ["anthropic/claude-opus-4"], // ids allowed to write handles; empty = none
  disableAboveTokens: 400_000,         // stop teaching past this context size; <= 0 = never
};

if (shouldEncode(gate, { model: activeModelId, contextTokens: lastPromptTokens })) {
  systemPrompt += argot.preamble;
  systemPrompt += argot.promptFragment();
}
```

That is the whole of encoding. If you skip this step entirely, Argot is inert:
the model is never taught, never writes a handle, and every decode seam below is
identity. Adopting Argot is exactly adding this step plus arming a vocabulary.

## Step 2: arm a vocabulary

Pick one of two flows. Both leave the session ready to decode.

**Load-on-read** (the dictionary is a committed `AGENTS.dict` in the tree): feed
every file the agent reads to `observe`. When it sees `AGENTS.dict`, it arms.

```ts
argot.observe(path, content); // on every file read; ignores anything but AGENTS.dict
```

**Cache flow** (the dictionary is generated and kept outside the repo): call
`resolveProjectVocab`. It owns the entire resolve lifecycle — find the project
root, key the immutable cache by the repository's content signature, gather the
corpus, and generate the dictionary once on a miss. You do not write any of that;
it is identical for every harness, so it lives in Argot, not in your code.

You supply only the two things Argot cannot do itself: run git, and name the
machine path where the cache lives. Git is an `io` object with two methods —
`gitHead` (`git rev-parse HEAD`) and `listTrackedFiles` (`git ls-files`, which
respects `.gitignore`) — each returning `null` for a folder that is not a git
repo, in which case Argot walks the tree itself.

```ts
import { type ProjectVocabIO, resolveProjectVocab } from "argot";

// Adapt your harness's git to the two calls Argot needs. `null` => not a git repo.
const io: ProjectVocabIO = {
  gitHead: (root, signal) => myGit.headSha(root, signal),          // string | null
  listTrackedFiles: (root, signal) => myGit.lsFiles(root, signal), // string[] | null
};

const resolved = await resolveProjectVocab({
  folder: agentCwd,            // resolved up to its nearest .git/.argot root
  cacheDir: myArgotCacheDir,   // a harness-owned path on this machine
  io,
  tokenBudget,                 // optional; invalid values are surfaced, not swallowed
  onNotice: n => log(n.message, n.data), // wire to your logger; never drop a notice
  signal,
});

if (resolved !== undefined && resolved.vocab.handles.size > 0) {
  argot.load(resolved.root, resolved.vocab); // key on the resolved root
}
```

`resolveProjectVocab` returns `undefined` when `folder` has no `.git`/`.argot`
marker (a normal "nothing to arm" answer, not an error), and never throws for a
missing project. The arming call it feeds is:

```ts
argot.loadVocab(vocab);        // single project, unkeyed
// or, for several projects in one context (what resolveProjectVocab pairs with):
argot.load(projectKey, vocab); // unions; throws ArgotConflictError on a genuine clash
```

Do not reimplement the resolve, cache-keying, or corpus-gathering logic in your
harness. If you are reading files to build a corpus, hashing a signature, or
deciding when to regenerate, stop: that is `resolveProjectVocab`'s job, and a
second copy will drift from every other harness.

### Who decides what to load: the agent (canonical) or the harness (legacy)

The recommended flow is agent-driven loading. Start the session unarmed, register
the load and unload tools under their canonical names where the model can
actually call them (never behind a discovery step the preamble does not mention),
and inject `renderPreamble({ tools: true })` at the encode seam. The model then
loads the project it intends to work in:

```ts
systemPrompt += renderPreamble({ tools: true }); // teaches the notation AND the tools
systemPrompt += argot.promptFragment();          // the handle table, "" until the model loads
```

The alternative, auto-arming from the launch directory at session start, is the
legacy convenience path. It picks the wrong project whenever the launch directory
is not the work unit — a monorepo root when the agent works one package, a
sibling checkout — and the model has no way to correct it. New integrations
should not auto-arm; an agent that never loads anything is simply inert, which is
safe (every decode seam stays identity).

Agent-driven loading carries a fixed approval contract so every harness gates
identically. `argot_load` reads a project tree, possibly outside the session's
working directory, and writes the generated dictionary into your cache directory,
so in any mode where you gate side effects behind operator approval it MUST be
approval-worthy at the same tier as a file write, with the resolved project root
shown in the approval prompt. `argot_unload` mutates no working tree and never
strips meaning (decoding stays on), so it is read-tier and needs no approval.
Expansion itself is never gated.

## Step 3: decode at every seam (the load-bearing step)

This is the list. Each row is a place text leaves the model's history. At each
one, call the given function on the text before it reaches that place. These are
all the seams; there are no others.

| # | Seam (where text leaves the model's history) | Call |
| - | --- | --- |
| 1 | **Tool-call arguments**, before the tool runs | `argot.expand(args)` |
| 2 | **Assistant content shown to the user** (the finished message) | `argot.expand(text)` |
| 3 | **The streaming token preview** shown live as the model types | a `StreamDecoder`, see below |
| 4 | **The persisted transcript / export / resume file** | `argot.expand(text)` |
| 5 | **A prompt handed to a spawned subagent** | `argot.expand(prompt)` |
| 6 | **A result a subagent returns to its parent** | `argot.expand(result)` |

Seams 1, 2, 4, 5, and 6 are the same call: run `argot.expand` on the string (or
on each string field of a structured value) before it crosses. `expand` is
lossless, idempotent, and identity until a dictionary is armed, so calling it on
text that has no handle, or that was already expanded, costs nothing and changes
nothing. When in doubt, expand: a double expand is a no-op, a missed expand is a
leak.

Seam 3, the live streaming preview, is the one seam a plain `expand` cannot do,
because the text arrives in pieces and a handle can split across two pieces
(`§db` then `conn`). Expanding each piece on its own would either show a raw
`§db…` on screen or expand the wrong (shorter) handle before the name finished.
Use a `StreamDecoder`, which buffers exactly the fragment that could still be a
handle and emits everything else already expanded:

```ts
const decoder = argot.streamDecoder(); // build one per streamed message

// on every token/delta, render ONLY what push returns:
render(decoder.push(delta));

// once, when the message finishes streaming:
render(decoder.flush());
```

`decoder.push(delta)` returns text that is always safe to show: never a raw
handle, never a handle expanded under an incomplete name. `decoder.flush()`
releases the final buffered fragment at end of stream. The concatenation of every
`push` return plus `flush` is byte-identical to `expand` of the whole message, for
any way the stream was chunked. If a stream aborts, call `decoder.reset()` to drop
the buffer. When nothing is armed, the decoder is a pure pass-through with zero
added latency, so wiring it in unconditionally is safe.

Do not try to hand-roll seam 3 with `expand` on a growing buffer, and do not
"expand the finished message and skip the live preview." Both are the mistake this
library exists to prevent. The finished message (seam 2) and the live preview
(seam 3) are two different seams and both must decode.

## Subagents

Each subagent is its own agent with its own `ArgotSession`, and the six seams
apply to it exactly as to the parent. Two of those seams are the parent/child
wire: seam 5 (the prompt the parent hands the child) and seam 6 (the result the
child hands back). Because each side expands its own output at its own boundary, a
handle never crosses between them, and a child that starts empty is already
correct.

Choose how much of the parent's shorthand a child starts with. This only trades
tokens; correctness never depends on it.

```ts
// off: child gets no codec. Cheapest, trivially correct.
const child = new ArgotSession();

// fresh: child gets its own session and loads its task's project itself
// through the tools (shown here armed directly for brevity).
const child = new ArgotSession();
child.loadVocab(childProjectVocab);

// inherit: child starts from a detached copy of the parent's shorthand,
// so it writes the parent's handles from its first turn.
const child = parentArgot.fork();
```

Under every mode, seams 5 and 6 still expand. `inherit` lets you additionally
leave the spawn prompt unexpanded as an optimization (the child can decode what
the parent wrote), but the safe default is to expand it like any other seam. The
return boundary (seam 6) always expands, because the child may have loaded a
project the parent never had.

See the SPEC's [Subagents](./SPEC.md#subagents) section for the full model.

## Step 4: verify (the checklist)

Wiring is correct when every row below is true. Each is a concrete test you can
write against your harness, not a judgment call.

- [ ] **Encode is gated by one place.** Teaching (`preamble` + `promptFragment`)
      is appended only through your `shouldEncode` check (or unconditionally if you
      teach everyone). Turning the gate off makes the model write full strings and
      nothing breaks.
- [ ] **Seam 1**: a tool receives the expanded string. Feed the model a turn that
      writes a handle in a tool argument; assert the tool ran with the full string,
      never the handle.
- [ ] **Seam 2**: the finished assistant message shown to the user contains no
      `§handle` for any armed handle.
- [ ] **Seam 3**: stream a message whose handle is split across two deltas; assert
      the rendered preview never contains the raw handle at any point and shows the
      full string once complete. (Argot's own `StreamDecoder` tests cover the codec;
      this test covers that your renderer reads `push`/`flush` and nothing else.)
- [ ] **Seam 4**: save and reload a transcript that used handles; assert the saved
      bytes hold the expansions, not the handles, and a reload shows full text.
- [ ] **Seam 5**: spawn a subagent from a parent that used handles; assert the
      child's prompt holds full strings.
- [ ] **Seam 6**: have a subagent return a handle it wrote; assert the parent
      receives the expansion, not the raw handle. Prove the wiring by reverting the
      expand call and watching this test fail.
- [ ] **Inert path**: with Argot disabled (no vocabulary armed), every seam above
      is identity and the harness behaves byte-for-byte as it did before.

The last row is the whole promise: Argot on or off, the user's view is identical.
Only the token bill changes.

## The one-paragraph summary

Hold one `ArgotSession` per agent. Register the load/unload tools and append
`renderPreamble({ tools: true })` + `promptFragment()` to the system prompt (gate
it with `shouldEncode` if you want); the model arms vocabularies itself through
the tools (cache flow: the tool feeds `resolveProjectVocab` + `load`, supplying
only git `io` and a cache dir), or you arm with `observe` (load-on-read). Then
call `argot.expand` at seams 1, 2, 4, 5, and 6, and
use `argot.streamDecoder()` at seam 3. Subagents are their own sessions; pick
`off`, `fresh` (unarmed; the child loads its own project), or `fork` for
`inherit`. Run the checklist. That is the entire integration.
