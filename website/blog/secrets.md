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

Use `/secret add` instead. Veyyon stores the value locally and tells the agent only a
placeholder such as `#SECRET_1#`. The agent writes the placeholder into a tool
call. Veyyon replaces it with the real value immediately before execution.

This guide starts with the shortest path. The later sections add control only
when you need it.

## Store one now

A `/secret` line leads with a command. `add` is the one that stores something, and
sending it by itself is the most private way in:

```text
/secret add
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
private. Everything after `add` is the credential, first word included:

```text
/secret add sk_test_example_not_a_real_key
```

Veyyon stores that the same way, and says plainly that the value is now in your
scrollback.

A first word that is not a command is refused, and nothing is stored. If that word
was a credential, it is in your scrollback and the vault never saw it, so the
refusal says to rotate it. It does not repeat the word.

A client with no terminal, such as `--print` mode or an ACP editor, has no field
to hide typing in. There `add` takes a name and reads the value only from the
environment, described under If your client has no terminal.

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

To rename something already stored, run `/secret rename STRIPE_TEST_KEY BILLING_KEY`.
The value stays where it is and is never re-entered.

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
/secret add --from-env STRIPE_TEST_KEY
```

Veyyon reads the inherited environment variable and asks for a name as usual. The
value never enters the Veyyon editor or its terminal output.

`--from-env` has to be the first word after `add`, and the variable name has
to be the only thing after it. Anything else on the line is a credential again,
so Veyyon refuses rather than storing something you did not mean.

Do not type a real assignment such as `export STRIPE_TEST_KEY=...` merely to
follow this example. A literal shell assignment can remain in shell history. Use
the credential facility you already trust to populate the environment.

`--from-env` is also the only entry form available in non-interactive surfaces
such as `--print` mode and ACP clients. Those surfaces cannot hide what is typed,
so Veyyon refuses an inline credential there.

## Manage what you stored

Everything you do to a credential after storing it is a verb on the same command.
The first word decides: a word from the table below runs that verb, and anything
else is a value again.

```text
/secret add                           paste into a hidden field
/secret add <value>                   store it now, then name it (optional)
/secret add --from-env <VAR>          store the value of an environment variable
/secret list                          show active secrets, never their values
/secret rm <name> [--scope global]    remove a secret
/secret clear --scope profile         remove every secret in one vault
/secret rename <name> <new-name>      give a secret a different name
/secret value <name>                  replace a secret's value, keeping its name and lifetime
/secret scope <name> global           move a secret to another vault
/secret copy <name>                   copy #NAME#, the placeholder, never the value
/secret extend <name> --ttl 7d        give a secret a fresh lifetime
/secret log [--name X] [--limit 50]   show which secrets were used, and where
/secret discard --scope project       move a broken vault file aside
```

A command stays a command however much follows it, so a credential that begins
with one of those words goes behind `add`: `/secret add list 8891` stores the text
`list 8891`. A bare `/secret`, and `/secret help`, print that table with the
options footer under it.

## Choose where it is available

A new entry lands in the `profile` scope. Move it with `/secret scope
STRIPE_TEST_KEY project`. The value is written to the destination vault before it
is removed from the old one, so an interrupted move never loses a credential.

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
terminal `add` line carries no lifetime, so set one afterwards with `/secret
extend STRIPE_TEST_KEY --ttl 7d`, taking a form such as `30m`, `12h`, `7d`, `2w`,
or `never`. The new lifetime is measured from the moment you set it.

An expired entry stops expanding immediately. Veyyon removes its placeholder
from the active inventory and tells the agent that it can no longer use it.

## See what is active

`/secret list` is the answer to that question. It prints placeholders, scope, and
expiry, and never a value, not even a prefix, because a prefix on screen is a
prefix in a screenshot. A row picks up a status of `past halfway` or `expires
soon` as it approaches its deadline.

The table holds the effective live entries for your current profile and working
directory.

## Check how a credential was used

`/secret log` records the placeholder, the tool, the command context, and the
time. It never records the value. `--name STRIPE_TEST_KEY` narrows the record to
one credential, and `--limit 5` keeps the last few lines of whatever is left. The
`secrets.auditLog` setting controls this record and is on by default.

The log answers a different question from masking. Masking shows what the model
could not read. The log shows where an available placeholder was spent.

## Remove or rotate it

Run `/secret rm STRIPE_TEST_KEY` to revoke that credential. Without `--scope` it
takes the narrowest match, which is the one currently in effect.

Revoking retires the entry you name. If a project entry shadows a profile or
global entry with the same name, revoking one layer reveals the entry under it,
so revoke each layer you intend to retire.

During the running process, a tool call that still carries the retired placeholder
is refused before execution. The error names the placeholder and never the value.
Text that was never a stored credential, such as `#TODO#`, is unaffected.

Rotate a credential with `/secret value STRIPE_TEST_KEY`, which asks for the new
value in the hidden field and keeps the name, the scope, and the lifetime it
already has. Veyyon replaces the old value atomically.

## Repair a vault that no longer opens

A disk failure or file-sync conflict can leave an encrypted vault unreadable.
Veyyon will not guess how to repair authenticated ciphertext. `/secret discard
--scope project` moves that scope's file aside, so you can store the entries it
held again.

The file is moved rather than deleted, because it still holds real credentials.
`discard` refuses a scope whose vault still reads correctly.

## If your client has no terminal

`--print` mode and an ACP editor cannot hide what is typed, so they refuse an
inline credential and read the value from the environment instead. Every
management verb is the same one you use at a terminal:

```text
/secret add stripe-test-key --from-env STRIPE_TEST_KEY --scope project --ttl 12h
/secret list
/secret extend stripe-test-key --ttl 7d
/secret rm stripe-test-key
/secret log --limit 5
/secret discard --scope project
```

Only the shape of `add` differs between the two surfaces. Both require a command
first, and every other command above parses at a terminal in the same order and
with the same options; what a terminal adds is the inline value and the hidden
paste, and what those clients add is nothing, because a value they cannot hide has
to come from somewhere they can read it.

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
Use `/secret add --from-env` when you deliberately want the agent to use that
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
