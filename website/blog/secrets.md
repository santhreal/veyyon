---
title: "Secrets: Letting a Coding Agent Spend a Credential It Never Sees"
slug: secrets
date: 2026-07-28
summary: "A coding agent needs your deploy key to run the deploy. It does not need to read it. Separating those two facts turns out to be a design problem about where text is allowed to expand, not an encryption problem."
draft: true
---

# Secrets: Letting a Coding Agent Spend a Credential It Never Sees

You want the agent to run the deploy. The deploy needs a token. So you paste the
token into the chat, and now it lives in three places you did not choose: the
provider's logs, the session transcript on disk, and your terminal scrollback.
Delete the message and it is still in all three.

The reflex is to say the agent should not touch credentials at all. That does not
survive contact with real work. Half of what you want an agent for is the part
that talks to something authenticated. Refusing it a token means doing that half
yourself, which is the half that is tedious.

The interesting observation is that the agent does not need to *read* the token.
It needs to *spend* it. Those are different capabilities, and once you separate
them the design falls out.

## Placeholders

`/secret` stores a credential and gives the model a name for it:

```
/secret add DEPLOY_KEY --from-env REAL_KEY
```

```
Stored DEPLOY_KEY in the profile vault, 1d left.
The model sees #DEPLOY_KEY# and never the value. Write that placeholder where the credential goes.
```

The model is told `#DEPLOY_KEY#` exists. It writes that placeholder where the
credential goes, the same way it would write any other argument:

```sh
curl -H "Authorization: Bearer #DEPLOY_KEY#" https://api.example.com/deploy
```

Between the model's output and the process that runs, the placeholder is replaced
with the real bytes. The command that executes is complete. The text the model
wrote, which is the text that goes into the transcript and back to the provider on
the next turn, contains `#DEPLOY_KEY#` and nothing else.

Note where the value came from. `--from-env` reads it out of a variable in the
veyyon process, so it never passes through the chat, and the message you typed is
safe to have in your history. In an interactive session you can also be prompted
for it, and the prompt hides what you type. What is refused is the obvious
convenience: on a surface with no way to mask input, veyyon will not accept the
value inline, because that path looks safe while putting the credential in your
scrollback.

## Naming is part of the boundary

The name has rules. Five to sixty-four characters, starting with a letter,
containing only `A-Z`, `0-9` and underscore. `clé_privée` is refused.

That is stricter than it needs to be for a lookup key, and the reason is that the
name is not only a key. It appears inside `#...#` in text the model reads and
writes, so it has to be unambiguous *there*. A name containing a `#`, or spaces,
or characters that render differently in one terminal than another, is a name
whose boundaries the substitution step has to guess at. Guessing is how you get
either a placeholder that silently fails to expand or one that swallows the text
next to it.

Lowercase input is accepted and normalized up, so `/secret add deploy_key`
stores `DEPLOY_KEY`. The confirmation shows you the name the model will actually
see, rather than the one you typed, so you do not learn a placeholder that does
not exist.

## Where the value rests

The vault on disk is sealed with AES-256-GCM. The authenticated part matters more
than the encrypted part: a hand edit does not produce a file that decrypts to
something slightly different, it produces a file that fails to open. There is no
path where a corrupted vault yields a plausible wrong credential.

The key is not in the vault. If the key is gone, the vault is gone, and veyyon
says so rather than starting up with silently empty secrets. That is the correct
direction for a failure here: a session that thinks it has protection and does not
is worse than one that refuses to start.

Secrets have a scope. A profile secret follows you across projects; a project
secret stays in the repository you stored it in. And they expire. `/secret list`
shows what is live and how long it has left:

```
1 active secret. The agent spends one by writing its placeholder; the value is never shown.
  PLACEHOLDER    SCOPE    EXPIRES
  #DEPLOY_KEY#   profile  24h left
```

Storing the same name again rotates it, and says so, because "stored" and
"replaced" are different events and only one of them destroyed something:

```
Replaced DEPLOY_KEY in the profile vault, 1d left.
The previous value is gone. #DEPLOY_KEY# now spends the credential you just stored.
```

## Expansion is not one operation

Here is the part that took the longest to get right, and it is not about
cryptography.

A placeholder has to expand on the way to a tool, or the command does not work.
It also seems like it should expand on the way to your screen: you are the
operator, you already know the credential, and reading a transcript full of
`#DEPLOY_KEY#` is worse than reading one with the value in it.

Those two expansions look like the same operation with the same inputs. They are
not, and treating them as one is a leak. Your screen is not a private channel. It
is a scrollback buffer, it is whatever is recording your terminal, it is the
screenshot you paste into an issue when something breaks. A credential that was
kept out of the provider's logs and then painted back onto the screen has been
protected from the wrong party.

So the two are separate seams, and display expansion is deliberately weaker than
execution expansion. A stored credential expands for execution and is withheld
from display. What does expand back on screen is a narrower thing: a pattern you
declared in your own config, matching text that was never a stored secret in the
first place. The predicate is one line, and the shape of it is the whole policy:

```ts
function mayRestoreForDisplay(entry: SecretEntry): boolean {
	return entry.type === "regex" && entry.origin === "config";
}
```

The `origin` field exists only to make this decision possible. Without it the
runtime knows a secret's *kind* but not its *provenance*, and provenance is
exactly what separates "you wrote this pattern down in a config file" from "this
is a credential I sealed so it would never be displayed." Every source declares
its true origin at the point it is loaded, which is what stops a stored value from
being restored to the screen out of model-authored prose or a tool-call argument.

The second half of the same problem: veyyon also masks known credential values on
the way *out*. If a command echoes the token, or an error message embeds it, the
value is replaced before it is displayed. Expansion and masking pull in opposite
directions, and both have to hold, so a credential is neither shown when the model
names it nor shown when a subprocess spills it.

## When it breaks

An encrypted vault that will not open cannot be repaired by hand. That is a
property of the design, not a gap in it, and it means veyyon owes you a way out
that is not "delete a file we never told you the path of."

```
/secret discard --scope project
```

This moves one scope's vault aside so the session can carry on. Three things about
its shape are deliberate. It requires the scope, with no default, because
discarding a scope you did not mean would pull a working vault out from under a
running session. It refuses when the vault reads normally, and points you at
`/secret rm` instead, which can tell you what it removed. And it is a slash
command rather than a documented file deletion, because a repair step that lives
only in a handbook page is a repair step nobody performs at the moment they need
it.

When a vault is unreadable, the session says so, names the scope, and tells you
which placeholders will not expand for the rest of it. It does not quietly proceed
with those secrets missing. A placeholder that fails to expand becomes a literal
`#DEPLOY_KEY#` in a command, which fails in a way that is confusing precisely
because it looks like a working command.

## Two bugs, and what found them

Both of the following had passing tests over them. Both took under a minute to
find by running the real CLI.

The first: storing your first credential turns protection on and the confirmation
says it was "saved for the next one." The write went through a settings API whose
`set` only *queues* a debounced save, and nothing on that path flushed it. Any
short-lived surface, a `-p` run or a single request, exited before the timer
fired. The next launch came up with protection off and the credential already in
the vault, which is the one state the feature exists to prevent. The test that
covered it asserted the write against a fake that had no notion of durability, so
it agreed with the code and both were wrong together.

The second: `--from-env` with a variable that is set but empty reported that the
variable "is not set in this process." Unset and set-to-nothing shared one
message. The refusal was correct and the explanation was false, which is worse
than an unhelpful error: it sends you to re-check an export that was already
right. The test asserted the unset case only, so the message was pinned for the
situation where it happened to be true.

Neither is exotic. They are the two most ordinary things that can go wrong at a
boundary: a write that was never made durable, and a message that describes a
different cause than the one that fired. What they have in common is that a test
can hold them in place. A fake with no flush cannot distinguish a persisted
setting from a lost one, and an assertion about one branch says nothing about the
branch next to it.

The general version, which is now a written rule in this repository rather than a
habit: before reporting that something works, use it. Real entrypoint, throwaway
config root, read the actual bytes, and check that every surface tells the same
story as the one before it. In this case that is three surfaces and one question.
`/secret add` says protection was saved. Does `/secret list` in a *new* process
agree? Does `config get secrets.enabled` agree with both? When the answer was
"the first one says yes and the other two say no," the bug was not in any of the
three. It was in the sentence that claimed something the code had not done.
