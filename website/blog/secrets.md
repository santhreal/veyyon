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

In an interactive Veyyon session, run:

```text
/secret add
```

Veyyon opens a masked input. Paste the credential and press Enter. Your typing is
hidden. You do not need to choose a name, scope, or lifetime first.

The first unnamed credential is stored as `SECRET_1`:

```text
Stored SECRET_1 in the profile vault, 1d left.
The model sees #SECRET_1# and never the value. Write that placeholder where the credential goes.
Secret protection was off, so it is now on for this session and saved for the next one.
```

That is enough. The agent can use `#SECRET_1#` immediately, and a later session
will be told that the placeholder is available.

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

Remove the temporary entry and add it again with a name:

```text
/secret rm secret-1
/secret add stripe-test-key
```

Paste the value into the masked input again. Veyyon normalizes the name to
`STRIPE_TEST_KEY`, and the agent uses `#STRIPE_TEST_KEY#`.

Names are 5 to 64 characters. They begin with a letter and normalize to `A-Z`,
`0-9`, and underscore. For example, `staging deploy key` becomes
`STAGING_DEPLOY_KEY`.

Adding the same normalized name again in the same scope rotates it. The old
value is replaced:

```text
Replaced STRIPE_TEST_KEY in the profile vault, 1d left.
The previous value is gone. #STRIPE_TEST_KEY# now spends the credential you just stored.
```

## Import a value that is already in the environment

A masked paste is the fastest interactive path. An environment import is better
when your shell, password manager, service manager, or CI runner already
provides the credential.

Make the variable available before Veyyon starts, then run:

```text
/secret add stripe-test-key --from-env STRIPE_TEST_KEY
```

Veyyon reads the inherited environment variable. The value never enters the
Veyyon editor or its terminal output.

Do not type a real assignment such as `export STRIPE_TEST_KEY=...` merely to
follow this example. A literal shell assignment can remain in shell history. Use
the credential facility you already trust to populate the environment.

`--from-env` is also the only add form available in non-interactive surfaces such
as `--print` mode and ACP clients. Those surfaces cannot provide a masked input,
so Veyyon refuses an inline credential.

## Choose where it is available

The default scope is `profile`. Add `--scope` when you want a narrower or broader
boundary.

### Keep it with one repository

Use `project` for a credential that belongs to the codebase in your current
working directory:

```text
/secret add stripe-test-key --scope project
```

When you move to another project, that project entry is no longer available.
Use this for a repository's staging key or a project-specific service account.

### Keep it with your line of work

Use `profile` for credentials you normally use across several repositories in
the same Veyyon profile:

```text
/secret add stripe-test-key --scope profile
```

This is the default. A work profile and a personal profile can carry different
credentials with the same name.

### Make it available to every profile

Use `global` only when the same machine-wide credential should be available in
every profile:

```text
/secret add shared-service-key --scope global
```

This is the broadest scope. Prefer project or profile when either describes the
real ownership boundary.

When the same name exists in more than one scope, project overrides profile, and
profile overrides global. The narrower entry shadows only the matching name.
Other entries remain available.

## Set a lifetime

A new entry lasts one day unless your settings specify another default. Set a
lifetime when you add it:

```text
/secret add stripe-test-key --scope project --ttl 12h
```

Accepted forms include `30m`, `12h`, `7d`, `2w`, and `never`.

Extend an existing entry from the current time:

```text
/secret extend stripe-test-key --ttl 7d
```

An expired entry stops expanding immediately. Veyyon removes its placeholder
from the active inventory and tells the agent that it can no longer use it.

## See what is active

Run:

```text
/secret list
```

The list shows placeholders, scope, and expiry. It never shows values:

```text
3 active secrets. The agent spends one by writing its placeholder; the value is never shown.
  PLACEHOLDER       SCOPE    EXPIRES
  #STRIPE_TEST_KEY# project  12h left
  #DEPLOY_KEY#      profile  24h left
  #HOME_LAB#        profile  never expires
```

The list contains the effective live entries for your current profile and
working directory.

## Check how a credential was used

Run:

```text
/secret log --limit 5
```

Each audit entry records the placeholder, tool, command context, and time. It
never records the value. The `secrets.auditLog` setting controls this log and is
on by default.

The log answers a different question from masking. Masking shows what the model
could not read. The audit log shows where an available placeholder was spent.

## Remove or rotate it

Remove the effective entry by name:

```text
/secret rm stripe-test-key
```

`rm` removes the narrowest active match. If a project entry shadows a profile or
global entry with the same name, removing the project entry reveals the entry
under it. Run `/secret list` again and remove the name once more if you intend to
revoke every layer.

During the running process, a tool call that still carries the retired placeholder
is refused before execution. The error names the placeholder and never the value.
Text that was never a stored credential, such as `#TODO#`, is unaffected.

Rotate a credential by adding the same name again in the same scope. Veyyon
replaces the old value atomically.

## Repair a vault that no longer opens

A disk failure or file-sync conflict can leave an encrypted vault unreadable.
Veyyon will not guess how to repair authenticated ciphertext. Move the damaged
scope aside, then add its entries again:

```text
/secret discard --scope project
```

The scope is mandatory. `discard` refuses to move a vault that still reads
correctly.

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

- `secrets.enabled`, default `false`: turns substitution and protection on. `/secret add` enables it for the current session and persists the setting.
- `secrets.defaultTtl`, default `1d`: controls a new vault entry when `--ttl` is absent.
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
