# Argot

Argot is experimental: off by default, gated to models you explicitly allow, and
still being measured on live benches. The mechanism is fully wired and lossless;
what is unproven is the economics (whether real sessions save enough output
tokens to matter), which is why it ships behind a flag.

Argot is a per-project shorthand that the model writes in. A project keeps a
small table of handles, each one a short name that stands for a longer string it
repeats a lot: a full path, an import root, a canonical build command. The model
writes the handle, and Veyyon restores it to the full string before anything runs
or is shown. This is the largest mechanism the fork adds on top of oh-my-pi.

This chapter explains what Argot is and how the codec works. To turn it on, see
[Save tokens with project shorthand](../using/configuration.md#save-tokens-with-project-shorthand-argot-experimental).

## The idea in one example

Say a project's build command is a long, exact string the agent types over and
over:

```
node --experimental-vm-modules ./scripts/build.mjs --target release --profile ci
```

With Argot, that string gets a handle, for example `§build`. The model writes
`§build`, and by the time the command reaches the shell it is the full string
again. The model carried a short token where it would have carried a long one,
and nothing downstream ever saw the short form.

A handle is a marker followed by a name. The default marker is the section sign
`§`, so the handle is `§build`. A name is lowercase letters, digits, and
underscores. The marker is configurable per project through the dictionary's
`sigil` field, and it may never contain a character that could blur into a name
or into whitespace.

## The dictionary

The handles live in a file named `AGENTS.dict`. It is a small table mapping each
name to its expansion:

```toml
sigil = "§"

[handles]
build = "node --experimental-vm-modules ./scripts/build.mjs --target release --profile ci"
dbconn = "src/server/db/connection.ts"
```

A handle stands for a recurring string, not a document, so an expansion has an
upper bound and a longer one is rejected. The file also declares a format
version. A file that targets a newer major version is refused loudly rather than
read on a guess.

You do not write or commit this file by hand, and Veyyon does not guess which
project you mean. The agent decides: it calls the `argot_load` tool on the folder
it is about to work in, and Veyyon generates the dictionary for that project from
the strings it actually repeats, scores each candidate by how much output it
would save, and keeps the result in a local cache under its own config
directory. In a monorepo the agent loads the one package it is working in, not
the repo root. Nothing is written into your working tree, so there is no file
for a pull request to pick up, and a session where the agent never loads
anything simply behaves as if Argot were off.

## Two directions, two rules

Argot has two directions, and they are gated differently on purpose.

**Decoding** is turning a handle back into its full text. It is unconditional.
Once a dictionary is loaded, every handle expands, always, before the text
reaches a tool, the disk, or your screen. A handle that arrived at a tool
unexpanded would be a broken path, not merely worse text, so decoding is never
something a setting can switch off.

**Encoding** is teaching the model the notation so it writes handles in the first
place. This is a policy choice, and it has two levers:

- A model allowlist. Only the models you name are taught the shorthand. The list
  is empty by default, so turning Argot on without naming a model stays inert.
  This lets you keep shorthand on for a model you trust to recall the dictionary
  and off for one you are still measuring.
- A context-size cutoff. Recall of the dictionary degrades as a conversation
  grows, so past a token threshold Veyyon stops teaching new shorthand and the
  model writes in full.

Because decoding never depends on either lever, it is always safe to stop
encoding. The worst case is the model writing a full string it could have
shortened, never a raw handle leaking through. Switching models mid-session is
safe for the same reason: a handle already in the history expands whatever model
is active now.

## Why it saves tokens

Output tokens cost several times more than input tokens. A handle pays off when
the model would otherwise retype a long string many times across a session, since
each repeat is output the model is charged for at the higher rate. The generator
optimizes for exactly this: it fills the dictionary highest-value first, where
value is how much output a handle removes across the project's text, and it stops
before the dictionary itself grows large enough to cost more to carry than it
saves.

## The cache is immutable and content-keyed

Each cache entry is named by the content it was built from: the git commit for a
git project, or a signature of the file listing for a project with a `.argot`
marker. An entry is never rewritten once it exists. A new commit reads a new
entry, built from the new tree; the old entry stays exactly as it was. Two agents
on the same commit read one entry, agents on different commits read different
entries, and a race to build the same entry produces byte-identical output, so
the write is safe with no lock.

Nothing depends on a handle keeping its name from one entry to the next. The
expansion rule (see "Two directions, two rules" above) expands every handle
before it reaches the saved transcript, so no stored transcript ever holds a raw
handle. Because the history never references a handle, a rebuilt-from-empty cache
would break nothing: the two directions stay correct whatever the dictionary
holds. That is why the cache can be keyed on content and thrown away freely,
rather than pinned and grown forever. To rebuild deliberately, delete the
project's cache directory and let the next session regenerate it.

## Subagents each expand their own output

A subagent veyyon spawns for a task follows the same two rules on its own. Every
agent expands its output before it reaches a tool, the saved transcript, a prompt
it hands to a child, or the result it returns to a parent, so a handle never
crosses between a parent and a child in either direction. A subagent that starts
with no dictionary is already correct: it reads the full text its parent wrote
(the parent expanded it) and writes full text back (the child expands it).
Sharing a dictionary between parent and child is only a way to save tokens, never
a thing correctness rests on. The `argot.subagents` setting picks between no
shorthand, a fresh dictionary from the child's own project, and a copy of the
parent's; see [the configuration
page](../using/configuration.md#choose-how-subagents-start).

## Related

- [Save tokens with project shorthand](../using/configuration.md#save-tokens-with-project-shorthand-argot-experimental): the settings and how to enable it
- [Mechanisms](./innovations.md): the rest of what the fork adds
