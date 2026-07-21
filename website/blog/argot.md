---
title: "Argot: Per-Project Vocabularies for Token-Efficiency in Frontier Coding Agents"
slug: argot
date: 2026-07-19
summary: "Coding agents retype the same long strings all day, and output tokens are the expensive ones. A per-project dictionary fixes it, if you treat it as a codec instead of context."
draft: true
---

# Argot: Per-Project Vocabularies for Token-Efficient Coding Agents

Open a session on a real monorepo and watch what the agent types. It spells out
`packages/server/src/database/connection.ts` for the fortieth time. It writes the
same sixty-character typecheck command on every verification turn. It repeats the
same import roots all day. This repetition is mechanical. The model has no
shorter way to name these things, so it types them out in full every time.

That costs money. Output tokens cost about 5-6x times the price of input tokens for opus and gpt sol respectively. A path the model writes
forty times is forty full spellings at the expensive rate. Over a day of
sessions that is real money spent on decoding on something that requires zero nuance or frontier intelligence.

The repository does know them. Argot is a way to let the model lean on that
shared knowledge through a macro system that allows for compression of inputs and expansion of outputs.

## The idea

You already have a place to tell an agent things: `AGENTS.md`, where you write
down the style, the footguns, the way you like work done. Argot adds a second
layer that saves tokens, and you do not write this one. Instead of prose, it is a
small shorthand: a set of names that each stand for a repeated string. veyyon
reads the project and builds it for you, and it looks like this:

```toml
version = 1
sigil = "§"

[handles]
dbconn = "packages/server/src/database/connection.ts"
tsc    = "CARGO_TARGET_DIR=/dev/null bunx tsgo -p packages/coding-agent/tsconfig.json --noEmit"
migr   = "packages/server/src/database/migrations"
```

Each entry defines a *handle* and its *expansion*. In the block above, `dbconn`
is a handle, and `packages/server/src/database/connection.ts` is the expansion it
stands for. The `§` in front is the *sigil*, a marker that tells the harness a
handle is coming, so it can tell `§dbconn` from an ordinary word in a sentence.

Let's follow one through a turn. Instead of writing the full path, the model
writes `§dbconn`. Before that output reaches anything (a tool, the screen, the
transcript, another agent), the harness replaces `§dbconn` with the full path.
The tool runs against the real path, and you read the real path. The model spent
a few tokens, and everything downstream ran on the full string.

That substitution, shorthand going in and full text coming out, is a *codec*, and it applies both ways. When the agent reads files there is repetition everywhere: boilerplate, function calls, and the like. Almost never is a repeated phrase itself cheaper than about 10 cached input tokens.

Is a handle worth the space it takes in the prompt? Usually, yes. The definition
is paid for once, and it sits in the cached part of the prompt, so after the
first turn it is nearly free. The entries worth the most are the strings a
project already leans on: the long paths, the canonical commands, the database
entrypoint. veyyon ranks candidates by the tokens each would save and keeps the
ones that pay for their space, so the shorthand stays dense without anyone
curating it by hand. Every time the model uses a handle, you save the gap between
the long expansion and the short handle, at the output rate, which is the
expensive one. The break-even is about one reuse. Anything the model writes twice
has already paid for its definition.

## It runs on the models you already have

You might expect this to need a very large model with a million-token window. It
does not, and it helps to see why by looking at what the model is actually asked
to do.

The dictionary lives in the prompt, in the part that gets cached, and the model's
only job is to reach a small lookup table while it works. That is a question of
recall: can the model reliably find something it was told earlier in the same
context? For a table this small, the answer is yes. Modern frontier models have
effectively perfect recall out to around 200k tokens, which is far more room than
a focused coding session ever uses. A handful of handles, held in a window the
model reads well, is an easy thing to ask for.

Far beyond 200k tokens is counterproductive either way because of performance degradation and increasing costs, especially considering modern compaction methods preserve almost all detail without noticeable loss. But despite this if you insist on staying at a higher context window argot wont work against you. For a cost of a few 100 cached input tokens it will certainly be far more token efficient up until the point where the model starts losing recall(this will vary between models, as models like fable can probably recall repeatedly used canaries up to its max token window). But after the model forgets the *sigil* and the handles it will gracefully degrade and the model will go back to using tool calls the normal slightly less token efficient way. 

This is also why heavier and more aggressive dictionaries for even slightly repeated phrases may help for the most advanced frontier models like fable. Fable has near perfect recall and somewhat manageable cached input tokens. But its output token pricing is absolutely brutal so cost saving strategies should focus on maximally reducing the output tokens instead of delicately preserving input.

## The one thing that makes it safe

Earlier I called this a *codec*. A codec only works when both sides share the same encoding. If one side encodes and the other
does not decode, the data stream breaks.

The solution is simple. Implement the sdk properly into an argon supported harness and the processing should only happen at two points. When the model reads, it must be first processed by the encoder so it receives a compressed mapping. When the model outputs, it must be first processed by the decoder(this applies to before the user sees visual output and before the model emits tool calls). Following those two principles alone the user notices nothing different both in terms of code quality and visual output from the model. 

I mention display because if a harness attempts to support argon but implements it incorrectly you get a TUI
full of `§dbconn`. Done right, the user's view is byte-for-byte identical whether
the dictionary is on or off, and only the cost changes.

## How a harness adopts it

The obvious design is to keep the dictionary as a file in the repo and read it
when the process starts. Two problems. People often launch an agent from
somewhere other than the project they mean to work in, so a harness that reads
`./AGENTS.dict` finds the wrong one or none at all. And a committed dictionary is
a file someone has to write, review, and keep current as the paths it names move
around.

veyyon takes both jobs off you. Nothing is committed. When Argot is on, the
harness finds the real project root by walking up from the working directory
until it sees a `.git` (or a `.argot` marker for a project with no git), so it
roots itself in the project you mean even when you launched from elsewhere. Then
it reads the project's files, the ones git tracks, and proposes handles for the
strings that would save the most tokens.

The result is not written back to the tree. It goes into a local cache under
veyyon's own config directory, keyed by a stable id for that project root, so two
checkouts never collide and a pull request never has a dictionary to pick up. The
cache carries a marker for the git commit it was built from. On the next session,
if the commit has not moved, veyyon loads the cache as is; if it has, veyyon
regenerates from the new tree. A project with no git rebuilds each session from a
bounded walk.

Regeneration grows the dictionary monotonically. A handle the model has already
been taught keeps its exact meaning, and its expansion is never given a second
name, so any text that once used a handle still expands the same way after the
codebook grows. New strings earn new handles on top; the old ones are frozen.

Teaching is a single step at the start of a session. veyyon lists the generated
handles in the system prompt, in the cached part, and that listing is the whole
of what the model is told: each line is a name and the expansion it stands for,
plus the fixed note that you write `§name` wherever you would have written the
expansion. The model reads no file and the harness watches no reads. The session
is armed directly from the cache, and expansion runs for the rest of the turn.

## Under the hood

The parser is strict on purpose. The version has to be one it understands, the
sigil cannot contain letters or whitespace, every handle name has to match
`[a-z0-9_]+`, and every expansion has to be non-empty, under a size bound, and
free of the sigil itself, so a handle can never expand into another handle and
expansion stays a single pass. A malformed file is refused with a clear error
rather than quietly ignored, because a repo that ships a dictionary and silently
gets no expansion is worse off than one that sees the error and fixes it.

Expansion has two details that keep it honest. It matches the longest handle
first, so `§dbconn` wins over `§db` when both are defined. And it fires only when
the match is not run into more name characters, so `§dbextra`, which is not a
handle, is left alone instead of expanding `§db` and stranding `extra`. An unknown
handle passes through verbatim, so a stray `§foo` reaches the tool as `§foo` and
fails there in the open, rather than disappearing.

## Levers a harness can pull

Notice that loading the vocabulary and expanding output are separate steps.
Expansion is a safety net you can leave on at all times: if nothing was loaded,
the model was never taught any handles, so it emits none, and `expand()` is just
identity. Loading is the real decision, which handles to activate for this
session, and the harness makes it per session. That opens a few levers.

**Gate the codec by model.** A dictionary is only as useful as the model's
recall, and models differ. You can activate the full vocabulary for a model you
trust with it, a smaller set for one you are less sure of, and nothing at all for
a model you have not measured. Expansion stays on the whole time, so activating
fewer handles is always safe; it just saves you less. Over time you can tune this
from real data: track how often each model uses a handle and how often it slips,
and keep the handles that pay off for that model.

**Gate handles by scope.** A big repo has vocabulary that only matters in one
corner of the tree. The `[meta]` table lets an entry carry a scope, a glob for
where it applies:

```toml
[meta.dbconn]
note  = "the one database entrypoint"
scope = "packages/server/**"
```

A harness can read that and activate `dbconn` only when the session is working
under `packages/server`. A smaller active codebook is easier for the model to
keep straight, so scoping helps recall and cost together.

**Budget the codebook.** When a project has more handles than you want to spend
context on, rank them by the tokens each would save, roughly its length times how
often it shows up, and keep the top slice that fits your budget. The long-tail
handles wait until they earn the room.

**Give sub-agents their own vocabulary.** A sub-agent doing one narrow job does
not need the whole repo's shorthand. You can hand it a denser, task-specific
slice, which is cheaper and easier for it to use well.

None of these touch the format or the safety story. They are the same two hooks,
loading and expansion, with the harness choosing how much to activate.

## One path we skipped

We looked at supporting harnesses that are closed source, or open ones that do
not want to adopt it, with a proxy in front of the model API that rewrites the
traffic. We dropped it. It is flaky, and it fights prompt caching once you no
longer control the exact system prompt. If you are convinced it is worth building
we would take a PR, though it stays the experimental fallback path.
