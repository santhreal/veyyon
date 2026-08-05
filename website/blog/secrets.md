---
title: "Secrets: Give the Agent a Token Without Giving It to the Model"
slug: secrets
date: 2026-07-29
summary: "Start with one masked paste, use the credential through a placeholder, then add names, scopes, lifetimes, environment imports, auditing, and repair when you need them."
draft: false
---

# Secrets: Give the Agent a Token Without Giving It to the Model

You need the agent to call an API now. The API needs a token. You could paste the
token into chat, but that sends it to the model provider and leaves it in your
session history and terminal scrollback.

Use `/secret` instead. Veyyon stores the value locally and tells the agent only a
placeholder such as `#SECRET_1#`. The agent writes the placeholder into a tool
call. Veyyon replaces it with the real value immediately before execution.

This guide starts with the shortest path. The later sections add control only
when you need it.

## Store one now

In a terminal, everything you type after `/secret` is the credential. There is no
verb to spell and no name to invent first. Send the command by itself:

```text
/secret
```

Veyyon opens a hidden field. Paste the credential and press Enter. Your typing is
never shown. Veyyon then asks what to call it, in a field that does show what you
type, because a label is not a secret. Press Enter there and a name is generated
for you.

The first generated name is `SECRET_1`:

```text
Stored SECRET_1 in the profile vault, 1d left.
The model sees #SECRET_1# and never the value. Write that placeholder where the credential goes.
Secret protection was off, so it is now on for this session and saved for the next one.
```

That is enough. The agent can use `#SECRET_1#` immediately, and a later session
will be told that the placeholder is available.

You can also put the value straight on the line, which is quicker and less
private:

```text
/secret sk_test_example_not_a_real_key
```

Veyyon stores that the same way, and says plainly that the value is now in your
scrollback.

A client with no terminal, such as `--print` mode or an ACP editor, has no field
to hide typing in. There `/secret` keeps a verb grammar, described under If your
client has no terminal.

## Use it

Suppose the credential is a Stripe test-mode API key. Ask:

```text
Use #SECRET_1# to fetch my Stripe test-mode balance.
```

The agent can produce a command such as:

```sh
curl -sS https://api.stripe.com/v1/balance -u '#SECRET_1#:'
```

The model provider receives the placeholder. The approval view shows the
placeholder. Veyyon expands the real key locally just before `curl` starts.

Run `/dump` if you want to inspect the provider request. The key should not be
there.

## Give it a useful name

`SECRET_1` is useful when you are in a hurry. A descriptive name is easier to
recognize when you have several credentials.

The name field takes whatever you want to call it:

```text
stripe test key
```

Veyyon normalizes that to `STRIPE_TEST_KEY`, and the agent uses
`#STRIPE_TEST_KEY#`.

Names are 5 to 64 characters. They begin with a letter and normalize to `A-Z`,
`0-9`, and underscore. For example, `staging deploy key` becomes
`STAGING_DEPLOY_KEY`.

To rename something already stored, press `n` on its row in the manager. The
value stays where it is and is never re-entered.

Storing a value under a name that already exists in the same scope rotates it.
The old value is replaced:

```text
Replaced STRIPE_TEST_KEY in the profile vault, 1d left.
The previous value is gone. #STRIPE_TEST_KEY# now spends the credential you just stored.
```

## Import a value that is already in the environment

A hidden paste is the fastest interactive path. An environment import is better
when your shell, password manager, service manager, or CI runner already
provides the credential.

Make the variable available before Veyyon starts, then run:

```text
/secret --from-env STRIPE_TEST_KEY
```

Veyyon reads the inherited environment variable and asks for a name as usual. The
value never enters the Veyyon editor or its terminal output.

`--from-env` has to be the first word after `/secret`, and the variable name has
to be the only thing after it. Anything else on the line is a credential again,
so Veyyon refuses rather than storing something you did not mean.

Do not type a real assignment such as `export STRIPE_TEST_KEY=...` merely to
follow this example. A literal shell assignment can remain in shell history. Use
the credential facility you already trust to populate the environment.

`--from-env` is also the only entry form available in non-interactive surfaces
such as `--print` mode and ACP clients. Those surfaces cannot hide what is typed,
so Veyyon refuses an inline credential there.

## Open the manager

Everything you do to a credential after storing it happens in one card:

```text
/secret manager
```

`manager` is the only word `/secret` reserves. Anything longer is a credential
again, so `/secret manager key 8891` stores the text `manager key 8891`.

The card has two views. Secrets is the roster: one row per entry, carrying the
placeholder, the scope it lives in, and how long it has left. Log is the record
of where a placeholder was spent. Left and right move between the two views.

On a row, `c` copies its placeholder, `n` renames it, `e` extends how long it
lasts, `m` moves it to another scope, `r` revokes it, `u` shows the log narrowed
to its uses, and `i` inspects what it has been used for. `a` adds a credential,
`s` sorts the table by another column, `/` filters the rows, `?` shows the whole
key map, and `esc` or `q` closes the card.

## Choose where it is available

A new entry lands in the `profile` scope. Press `m` on its row to move it to a
narrower or broader one.

### Keep it with one repository

Use `project` for a credential that belongs to the codebase in your current
working directory.

When you move to another project, that project entry is no longer available.
Use this for a repository's staging key or a project-specific service account.

### Keep it with your line of work

Use `profile` for credentials you normally use across several repositories in
the same Veyyon profile.

This is the default. A work profile and a personal profile can carry different
credentials with the same name.

### Make it available to every profile

Use `global` only when the same machine-wide credential should be available in
every profile.

This is the broadest scope. Prefer project or profile when either describes the
real ownership boundary.

When the same name exists in more than one scope, project overrides profile, and
profile overrides global. The narrower entry shadows only the matching name.
Other entries remain available.

## Set a lifetime

A new entry lasts one day unless your settings specify another default. A
terminal entry line carries no lifetime, so set one from the manager: press `e`
on the row and give a form such as `30m`, `12h`, `7d`, `2w`, or `never`. The new
lifetime is measured from the moment you set it.

An expired entry stops expanding immediately. Veyyon removes its placeholder
from the active inventory and tells the agent that it can no longer use it.

## See what is active

The Secrets view is the answer to that question. It shows placeholders, scope,
and expiry, and never a value, not even a prefix, because a prefix on screen is
a prefix in a screenshot. A row picks up a status of `past halfway` or `expires
soon` as it approaches its deadline.

The roster holds the effective live entries for your current profile and working
directory.

## Check how a credential was used

The Log view records the placeholder, the tool, the command context, and the
time. It never records the value. Press right from the Secrets view to reach it,
or `u` on a row to see the log narrowed to that one credential. The
`secrets.auditLog` setting controls this record and is on by default.

The log answers a different question from masking. Masking shows what the model
could not read. The log shows where an available placeholder was spent.

## Remove or rotate it

Press `r` on a row to revoke that credential.

Revoking retires the entry the row names. If a project entry shadows a profile or
global entry with the same name, revoking one layer reveals the entry under it,
so revoke each layer you intend to retire.

During the running process, a tool call that still carries the retired placeholder
is refused before execution. The error names the placeholder and never the value.
Text that was never a stored credential, such as `#TODO#`, is unaffected.

Rotate a credential by storing the new value and answering the name field with
the existing name, in the same scope. Veyyon replaces the old value atomically.

## Repair a vault that no longer opens

A disk failure or file-sync conflict can leave an encrypted vault unreadable.
Veyyon will not guess how to repair authenticated ciphertext. An unreadable vault
file gets a row of its own in the manager. Press `d` on it to move the file
aside, then store the entries it held again.

The file is moved rather than deleted, because it still holds real credentials.
`d` refuses a vault that still reads correctly.

## If your client has no terminal

`--print` mode and an ACP editor cannot hide typing and have no screen to draw
the manager on. There `/secret` keeps the verb grammar:

```text
/secret add stripe-test-key --from-env STRIPE_TEST_KEY --scope project --ttl 12h
/secret list
/secret extend stripe-test-key --ttl 7d
/secret rm stripe-test-key
/secret log --limit 5
/secret discard --scope project
```

Those forms belong to that surface only. Typed at a terminal prompt, each of them
is stored as a credential, because there the argument line is the value. Going
the other way, `/secret manager` on a client with no terminal is refused and told
why, rather than reported as an unknown command.

`list` prints a table:

```text
3 active secrets. The agent spends one by writing its placeholder; the value is never shown.
  PLACEHOLDER       SCOPE    EXPIRES
  #STRIPE_TEST_KEY# project  12h left
  #DEPLOY_KEY#      profile  24h left
  #HOME_LAB#        profile  never expires
```

## Declare protection rules without using the vault

The vault is the right place for an encrypted value the agent should be able to
spend. `secrets.yml` is for additional protection rules.

Veyyon merges two optional files:

- `<agent dir>/secrets.yml` for the active profile.
- `<project>/.veyyon/secrets.yml` for the current project.

Protect one exact value:

```yaml
- type: plain
  content: sk_test_example_not_a_real_key
```

Protect values that match a pattern:

```yaml
- type: regex
  content: "AKIA[0-9A-Z]{16}"
```

`obfuscate` is the default mode and can expand its placeholder locally.
`replace` is one-way and cannot reconstruct the original value.

A `secrets.yml` file is plain text. Anyone who can read it can read an exact
value declared there. Put real credentials in the encrypted vault instead.

## Automatic environment protection

Veyyon also detects credential-like values already present in its inherited
environment. A value of at least 8 characters is protected when the variable
name ends with, or has an underscore before, a credential keyword such as
`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `AUTH`, `CREDENTIAL`, `PRIVATE`, or
`OAUTH`.

This is defensive masking. It does not give the agent a useful name to spend.
Use `/secret --from-env` when you deliberately want the agent to use that
credential.

## What crosses each boundary

Three sources feed the runtime: detected environment variables, `secrets.yml`
declarations, and encrypted vault entries.

On the way to a model provider, Veyyon replaces every known value before
messages, prompts, tool descriptions, resumed text, or nested model calls leave
the process.

On the way to a tool, Veyyon expands a placeholder immediately before execution.
The tool receives the real bytes. The transcript keeps the placeholder.

The active model prompt includes an `AVAILABLE SECRETS` section containing vault
names only. Add `STRIPE_TEST_KEY` now and a later session can use
`#STRIPE_TEST_KEY#` without you repeating the value or the name.

Vault files use AES-256-GCM with a fresh nonce and authentication tag for every
write. The machine key lives at `~/.veyyon/vault.key`, outside project
directories.

## Settings

The relevant settings are:

- `secrets.enabled`, default `false`: turns substitution and protection on. Storing a credential enables it for the current session and persists the setting.
- `secrets.defaultTtl`, default `1d`: controls a new vault entry when no lifetime is given.
- `secrets.auditLog`, default `true`: records placeholder use without recording values.
- `share.redactSecrets`, default `true`: keeps known values out of a shared session.

If you turn protection off after using stored names, those names remain retired
for tool execution until the process exits. A stale command is refused rather
than run with a literal placeholder.

## Know the execution boundary

A tool that receives a credential can still print it, write it to a file, or
send it to another service. Veyyon masks provider-bound output again, but the
process already received the real value. Raw command output is also retained in
the session history as the command produced it.

Use approval controls and narrow credential scopes as you would without the
vault. `/secret` removes the model-provider exposure and gives the agent a named,
auditable way to spend a value. It does not make an untrusted command safe.

The handbook contains the complete field schema, merge rules, and environment
detection details.
