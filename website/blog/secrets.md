---
title: "Secrets: Let the Agent Use Your Credentials Without Seeing Them"
slug: secrets
date: 2026-07-29
summary: "Store a credential once, let the agent spend it by name, and keep the value out of provider requests. This guide shows the vault commands, local substitution boundary, audit trail, and limits."
draft: false
---

# Secrets: Let the Agent Use Your Credentials Without Seeing Them

You want the agent to run the deploy. The deploy needs a token. So you paste the
token into the chat, and now it is in the provider's logs, the session file on
disk, and your terminal scrollback. Deleting the message does not remove it from
any of those.

veyyon splits reading a credential from spending one. A vault entry gives the
agent a named placeholder such as `#DEPLOY_KEY#`. When it writes that placeholder
into a command, veyyon swaps in the real value just before the command runs. The
command works. The text that goes to the provider says `#DEPLOY_KEY#`.

## Try it in 60 seconds

If the credential is already in your shell, store it without typing it into the
chat or terminal:

```sh
export GITHUB_TOKEN=ghp_your_real_token_here
veyyon
```

```text
/secret add github-token --from-env GITHUB_TOKEN
```

```text
Stored GITHUB_TOKEN in the profile vault, 1d left.
The model sees #GITHUB_TOKEN# and never the value. Write that placeholder where the credential goes.
Secret protection was off, so it is now on for this session and saved for the next one.
```

Now ask for something that needs it:

```text
> list my open pull requests
```

The agent writes a command with `#GITHUB_TOKEN#`. The approval view still shows
the placeholder. After approval, veyyon substitutes the token locally and runs
the command. Check what the provider received with `/dump`: the token is not in
it.

`--from-env` matters here. The credential never enters the editor buffer or
terminal scrollback. The vault gives it a stable name that the agent can use in
this session and after a restart.

Veyyon also detects credential-like environment variables defensively. A value
of 8 characters or longer is protected when its name ends with, or has an
underscore before, one of `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`,
`PASSPHRASE`, `AUTH`, `CREDENTIAL`, `PRIVATE`, or `OAUTH`. If a detected value
appears in provider-bound text, veyyon replaces it with an opaque machine-keyed
placeholder. Detection does not add a readable name to the agent's inventory.
Use `/secret add --from-env` when the agent needs to spend the credential
deliberately.

That is the whole setup. Everything below is detail.

## Every command

```text
/secret add <name> --from-env <VAR>   store the value of an environment variable
/secret list                          show active secrets, never their values
/secret rm <name>                     remove a secret
/secret extend <name> --ttl 7d        give a secret a fresh lifetime
/secret log [--limit 50]              show which secrets were used, and where
/secret discard --scope project       move a broken vault file aside

Options: --ttl 30m|12h|7d|2w|never   --scope profile|project|global
```

In an interactive session you can leave off `--from-env` and be prompted, with
your typing hidden:

```text
/secret add stripe-key
```

`--from-env` is the only form that works where there is no terminal to hide
input on, such as `--print` mode or an ACP editor. On those surfaces veyyon
refuses an inline value rather than accept one that would land in your
scrollback.

### Storing

Names are normalized up, so `deploy-key` becomes `DEPLOY_KEY`, and the
confirmation shows you the name the model will actually see. Use 5 to 64
characters, starting with a letter, then `A-Z`, `0-9`, and underscore. The name
appears inside `#...#` in text the model reads, so it has to be unambiguous
there.

```text
/secret add staging-key --from-env STG --scope project --ttl 12h
```

```text
Stored STAGING_KEY in the project vault, 12h left.
The model sees #STAGING_KEY# and never the value. Write that placeholder where the credential goes.
```

Storing the same name again rotates it, and says which happened:

```text
Replaced DEPLOY_KEY in the profile vault, 1d left.
The previous value is gone. #DEPLOY_KEY# now spends the credential you just stored.
```

### Listing

```text
/secret list
```

```text
3 active secrets. The agent spends one by writing its placeholder; the value is never shown.
  PLACEHOLDER    SCOPE    EXPIRES
  #DEPLOY_KEY#   profile  24h left
  #HOME_LAB#     profile  never expires
  #STAGING_KEY#  project  12h left
```

### Lifetimes

Every entry expires. The default is one day, changed in `/settings` under Secret
Lifetime or per entry with `--ttl`. Accepted forms are `30m`, `12h`, `7d`, `2w`,
and `never`.

```text
/secret extend deploy-key --ttl 7d
```

```text
DEPLOY_KEY in the profile vault now lasts 7d from now (7d left).
```

### Scope

An entry belongs to one scope and is invisible from the others. Project
overrides profile, which overrides global. The default is profile.

| Scope | Lives with | Use for |
| --- | --- | --- |
| `project` | one repository | credentials for that codebase |
| `profile` | your line of work | your usual tokens |
| `global` | every profile | machine-wide credentials |

Moving to another working directory loads that project's scope and drops the old
one's.

### Auditing

Hiding a value tells you what the agent could not see. It does not tell you what
it did with what it could:

```text
/secret log --limit 5
```

Each entry records which placeholder was spent and in what command, never the
value. Turn it off with the `secrets.auditLog` setting.

### Repair

Veyyon will not guess at repairing an encrypted vault that no longer opens. If
a disk filled up mid-write or a sync client merged two copies, move that scope's
file aside and re-add what it held:

```text
/secret discard --scope project
```

It requires the scope, with no default, and refuses when the vault reads fine.

## Declaring secrets yourself

Environment detection covers what is already in your shell. For anything else,
list entries in a `secrets.yml`. Two files are read and merged, profile at
`<agent dir>/secrets.yml` and project at `<project>/.veyyon/secrets.yml`.

An exact value:

```yaml
- type: plain
  content: sk-proj-abc123def456
```

A pattern, which covers credentials you have not seen yet:

```yaml
- type: regex
  content: "AKIA[0-9A-Z]{16}"
```

Each entry picks a mode. `obfuscate` is the default and is reversible: the
placeholder expands back to the value on its way into a command. `replace` is
one-way, for values that should never be reconstructed.

Two limits worth knowing. Values under 8 characters are not obfuscated, because
replacing a three-character string would blank out fragments of unrelated words.
And veyyon refuses a regex that cannot make progress, uses sticky matching, or
looks like catastrophic backtracking.

`secrets.yml` is a plain file. It holds your declarations in the clear, and
anyone who can read it has those credentials. If a value needs to be encrypted
at rest, put it in the vault instead.

## How it works

Three sources feed one runtime: detected environment variables, your
`secrets.yml` declarations, and the vault. Each contributes values to protect.
Reversible declarations and vault entries also contribute placeholders that map
back locally.

**On the way out**, every known value is replaced before provider dispatch. That
covers messages, dynamic system prompts, tool descriptions and schemas, resumed
assistant text, replay payloads, and nested model calls such as title
generation, image analysis, and memory summaries.

**On the way in**, a placeholder the model wrote is expanded just before a
command executes. The process gets the real bytes. The transcript keeps the
placeholder.

**The agent is told what it can spend.** An `AVAILABLE SECRETS` section is
rebuilt from the live runtime on every prompt, listing vault names only. Store
`GITHUB_TOKEN` today and start a fresh session tomorrow: the agent writes
`#GITHUB_TOKEN#` without you mentioning the credential again. Remove it and the
name stops being rendered.

**Screen and execution are separate.** A placeholder expands for execution
always, but on your terminal only a `type: regex` pattern you declared yourself
is painted back. Vault entries, detected environment variables, and plain
declarations stay masked on screen, because a scrollback buffer is not a private
channel and a screenshot travels.

**Vault files use AES-256-GCM**, a fresh 12-byte nonce per write and the full
16-byte authentication tag. The key is a 32-byte file at `~/.veyyon/vault.key`,
created on first use, never inside a project directory. Because the ciphertext
is authenticated, a damaged vault fails to open rather than decrypting to
something subtly wrong.

**Failures that would leak stop the session.** A missing vault key, an
unparseable `secrets.yml`, a declared `obfuscate` entry under the length floor:
each refuses with the entry and the fix named. Failures that only degrade
something warn instead and say what is not protected.

## Settings

| Setting | Default | What it does |
| --- | --- | --- |
| `secrets.enabled` | `false` | Master switch, shown as Hide Secrets |
| `secrets.defaultTtl` | `1d` | Lifetime for a new entry without `--ttl` |
| `secrets.auditLog` | `true` | Record which secret was used where |
| `share.redactSecrets` | `true` | Keep values out of a shared session |

`/secret add` turns `secrets.enabled` on and persists it, because a stored
credential is only useful once the substitution is running.

## What this does not protect

A command the agent runs receives the real value, so a command that prints the
credential prints it for real. Its output is obfuscated again before returning
to the model, but the process saw it, and whatever that process wrote elsewhere
is outside veyyon's reach. That output is also saved to the session file as
printed. veyyon redacts the arguments it records itself; it cannot redact what a
command chose to print.

Full field-by-field schema, merge rules, and the interaction with environment
detection are in the handbook.
