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

That costs money. Output tokens cost several times more than input tokens. A path the model writes
forty times is forty full spellings at the expensive rate. Over a day of
sessions that is real money spent on output that requires zero nuance or frontier intelligence.

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

Running far beyond 200k tokens is counterproductive either way, because of recall degradation and rising cost, and because modern compaction preserves almost all of the detail without noticeable loss. But if you do stay at a larger context window, Argot does not work against you. For the cost of a few hundred cached input tokens it stays more token efficient up to the point where the model starts to lose recall, which varies between models: a model with strong long-context recall can hold repeated handles well out toward its full window. Once the model forgets the *sigil* and the handles, it degrades gracefully and goes back to writing the strings in full, the ordinary and slightly less efficient way.

This is also why a heavier dictionary, one that shortens even lightly repeated phrases, can pay off for the strongest frontier models. A model with near-perfect recall and manageable cached-input cost but expensive output tokens rewards a strategy that reduces output aggressively rather than one that carefully preserves input.

## The one thing that makes it safe

Earlier I called this a *codec*. A codec only works when both sides share the same encoding. If one side encodes and the other
does not decode, the data stream breaks.

The solution is simple. Implement the SDK properly in an Argot-supported harness and the processing happens at only two points. When the model reads, the text is first run through the encoder, so the model receives the compressed mapping. When the model outputs, the text is first run through the decoder, which applies both before the user sees any visual output and before the model emits a tool call. Follow those two principles and the user notices nothing different, in code quality or in what the screen shows.

I mention display because if a harness tries to support Argot but implements it incorrectly you get a TUI
full of `§dbconn`. Done right, the user's view is byte-for-byte identical whether
the dictionary is on or off, and only the cost changes.

## How a harness adopts it

The obvious design is to keep the dictionary as a file in the repo and read it
when the process starts. Two problems. People often launch an agent from
somewhere other than the project they mean to work in, so a harness that reads
`./AGENTS.dict` finds the wrong one or none at all. And a committed dictionary is
a file someone has to write, review, and keep current as the paths it names move
around.

veyyon takes both jobs off you, and it also refuses to guess which project you
mean. Nothing is committed, and nothing is loaded automatically at session
start: the agent itself decides. The system prompt teaches it the notation and
hands it two tools, `argot_load` and `argot_unload`, and when it starts work in a
project it calls `argot_load` on that folder. veyyon resolves the folder to its
real project root by walking up until it sees a `.git` (or a `.argot` marker for
a project with no git), reads the project's files, the ones git tracks, and
proposes handles for the strings that would save the most tokens. In a monorepo
that means the agent loads the one package it is working in, not the repo root a
launch directory would have foisted on it. Loading is a real action with side
effects on the local cache, so in the approval-gated modes veyyon asks before it
runs, showing the resolved root; unloading never needs asking, because it
teaches less and breaks nothing.

The result is not written back to the tree. It goes into a local cache under
veyyon's own config directory, keyed by a stable id for that project root, so two
checkouts never collide and a pull request never has a dictionary to pick up. Each
cache entry is immutable and named by the content it was built from: the git
commit for a git project, or a signature of the file listing for one with a
`.argot` marker. On the next session, if the commit has not moved, veyyon loads
that entry as is; if it has, veyyon reads a different entry, built from the new
tree, and leaves the old one untouched. A project with no git keys on the file
listing instead.

Nothing depends on a handle keeping its name from one entry to the next, because
veyyon expands every handle before it reaches the saved transcript. No stored
transcript ever holds a raw handle, so an entry never has to agree with an older
one, and a rebuilt-from-empty cache would break nothing. That is what lets the
cache be keyed on content and thrown away freely, rather than pinned and grown
forever.

Teaching is two pieces, both in the cached part of the system prompt. The fixed
notation block is there from the first turn: it explains what a handle is and
tells the model to activate a project itself with `argot_load`. Once the model
has loaded one, veyyon adds the generated handle table, and that listing is the
whole of what the model is told about it: each line is a name and the expansion
it stands for, plus the fixed note that you write `§name` wherever you would
have written the expansion. The model reads no file and the harness watches no
reads, and a session where the model never loads anything simply writes full
strings, exactly as if the feature were off.

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
