# Secrets

You often need the agent to run a command that requires a credential. A deploy needs a token. A database query needs a password. If you paste the value into chat without protection, it can reach the model provider and any session export you create.

Veyyon can keep the value away from the provider while the command still works. This page shows you how, including which local surfaces can still contain it.

## Turning it on

Secret protection is off by default. Turn it on in `/settings`, or write it into `config.yml`:

```yaml
secrets:
  enabled: true
```

The setting takes effect in the current session. Veyyon reloads environment variables, `secrets.yml`, and the vault when you toggle protection or run a `/secret` command. Moving to another working directory loads that project's scope and drops the source project's mappings.

## Your first secret

If the credential is already an environment variable, you have nothing to declare. Veyyon treats an environment variable as secret when its value is 8 characters or longer and its name ends with, or has an underscore after, one of `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `PASSPHRASE`, `AUTH`, `CREDENTIAL`, `PRIVATE`, or `OAUTH`.

That boundary matters, so read each keyword as a whole word rather than a substring:

| Detected | Not detected |
| -------- | ------------ |
| `DEPLOY_TOKEN` | `TOKENIZER` |
| `API_KEY` | `SECRETIVE_THING` |
| `KEY_FILE` | `AUTHORIZED_USER` |
| `GPG_PASSPHRASE` | `PASSTHROUGH` |
| `APIKEY`, `PRIVKEY` | `PWD` |

The exclusions are the point of the rule, not a gap in it. Obfuscation replaces every occurrence of a value, so detecting `AUTHORIZED_USER` would blank out that username wherever it appeared in your transcript. `PWD` is excluded for the same reason and more sharply: it is your current working directory, it exists in every shell, and detecting it would replace your paths with a placeholder in every message that mentions one.

`APIKEY` and `PRIVKEY` need no keyword of their own, because `KEY` at the end of a name already matches them.

### Adding your own keywords

The keyword list is data, not code. Drop a file at either location and its keywords are added to the built-in ones:

| Level | Path |
| ----- | ---- |
| Profile | `<agent dir>/secret-env-keywords.yml` |
| Project | `<project>/.veyyon/secret-env-keywords.yml` |

```yaml
keywords:
  - VAULTPASS
  - SCANSEED
```

Your keywords follow the same boundary rule, so `VAULTPASS` matches `VAULTPASS` and `MY_VAULTPASS` and not `VAULTPASSWORDLESS`.

A user file can only **add**. It cannot remove a built-in keyword, so a repository you clone cannot turn off detection of `TOKEN` for you. A file that exists but cannot be read or parsed stops startup, because carrying on would cover fewer variables than you wrote down.

If a variable of yours is still not detected, do not assume it is covered: declare it in `secrets.yml` as shown below, or store it with `/secret`.

So a shell that already has this:

```bash
export DEPLOY_TOKEN=ghp_R2d2c3poIHRva2VuIGV4YW1wbGU
```

needs no configuration. Start veyyon and that value is protected.

## What the model sees

Every occurrence of a known value is replaced before provider dispatch. This boundary covers messages, dynamic system prompts, tool descriptions and schemas, resumed assistant text, replay payloads, and nested model calls such as title generation, image analysis, memory summaries, and speech rewriting.

The replacement happens from raw text before trimming, truncation, JSON serialization, or other lossy preparation. Veyyon resolves the live profile, project, environment, and vault runtime again for each physical provider attempt. This includes authentication retries, fallback models, delayed queues, compaction, commit analysis, evaluation, benchmarks, memory services, TTS, and image tools. A refresh cannot leave a retry using an old set of secret values.

Provider fields that are authenticated or signed cannot be rewritten safely. If a live value appears in a signature, provider item id, encrypted reasoning block, or other opaque replay payload, the request is refused with a value-free error. Structured fields are rewritten recursively, including JSON object keys. A rewrite that would collapse two keys into one is also refused.

Suppose a file you read contains this token:

```text
DEPLOY_TOKEN=ghp_R2d2c3poIHRva2VuIGV4YW1wbGU
```

The provider receives a machine-keyed placeholder:

```text
DEPLOY_TOKEN=#0A1B2C3D4E5F678901234567#
```

The placeholder is stable across restarts on the same machine. It contains a keyed HMAC rather than a load-order index, so seeing it does not give the provider an offline dictionary test for the value. A named vault entry instead uses its readable name, such as `#GITHUB_TOKEN#`, so the model can choose the right credential.

The model is told that placeholders are opaque strings. It does not know the value and cannot ask for it.

## Using a secret in a command

This is the part that makes the feature useful rather than merely defensive. The model can put a placeholder into a command, and veyyon substitutes the real value before the command runs.

The model writes:

```bash
curl -H "Authorization: Bearer #0A1B2C3D4E5F678901234567#" https://api.example.com/deploy
```

The command that actually executes carries the real token. The substitution happens locally, after the model has produced the command and before the shell sees it. The model never learns the value, and the request still authenticates.

## The vault: storing a credential with `/secret`

Environment detection covers credentials that are already in your shell. For anything else, hand it to the vault. A vault entry is encrypted on disk, has a name, and expires.

Name it and veyyon asks for the value with a field that shows nothing as you type:

```text
/secret add github-token
```

```text
Paste the value for GITHUB_TOKEN. It is hidden as you type and stored encrypted.
> ••••••••••••••••••••
  enter submit  esc cancel
```

Your composer is cleared before the field opens, so the value never enters the input buffer and never reaches your scrollback. Press escape and nothing is stored.

If the credential is already an environment variable, read it from there and skip typing altogether. This is the only form that works in a client with no terminal to hide anything on, such as `--print` mode or an ACP editor:

```text
/secret add github-token --from-env GITHUB_PAT
```

You can also pass the value on the command line. It works, and veyyon tells you plainly that the value is now in terminal scrollback:

```text
/secret add github-token ghp_your_token_here
```

Every exact `/secret` command shape, including malformed input, is excluded from persistent editor history. This prevents the command from being recovered with the Up key or written to `history.db`. It cannot erase terminal scrollback that was already rendered.

The inline form preserves the credential bytes exactly, including trailing whitespace. Once credential data has started, a later word that looks like an option is refused instead of being silently discarded. Use the masked prompt or `--from-env` when a value could be mistaken for command syntax.

Any of the three shows the model a placeholder built from the name:

```text
Stored GITHUB_TOKEN in the profile vault, 1d left.
The model sees #GITHUB_TOKEN# and never the value.
```

The agent is told, in that same turn, that a credential exists and that it should write `#GITHUB_TOKEN#` where the value belongs. It is never told the value and cannot ask for it.

### Seeing and removing what you stored

```text
/secret list                      names, scopes and lifetimes, never values
/secret rm github-token           remove it
/secret extend github-token --ttl 7d
```

`list` shows no part of any value. A prefix of a credential is still a disclosure.

### Lifetimes

Every entry expires. The default is one day, which you can change in `/settings` under Secret Lifetime, or per entry:

```text
/secret add deploy-key --from-env DEPLOY_KEY --ttl 30m
/secret add signing-key --from-env SIGNING_KEY --ttl never
```

Lifetimes are written as `30m`, `12h`, `7d`, `2w`, or `never`. Weeks are accepted and reported back in days.

You are warned before a lifetime runs out, once at the halfway point and again near the end:

```text
Warning: secrets: #DEPLOY_KEY# expires soon, 2h left. Extend it with
/secret extend DEPLOY_KEY --ttl 7d, or it will be deleted.
```

The thresholds are fractions of the lifetime rather than fixed times, so one rule fits every entry. A one-day secret is mentioned after twelve hours; a ninety-day secret is mentioned on day forty-five, not on day eighty-nine. Each warning names the command that prevents the loss, because expiry deletes the value and there is nothing to do about it afterwards.

**Expiry deletes the value.** It does not merely stop hiding it. That distinction matters: if an expired secret simply stopped being obfuscated, the value would start flowing to the model provider at the moment its protection lapsed, which is the opposite of what you asked for.

The deadline is enforced at the moment the credential is used, not only when a session starts. A session you leave open over a weekend stops substituting a one-day secret on the day it runs out, and tells you it has:

```text
Warning: secrets: #GITHUB_TOKEN# has expired and is no longer being substituted. Its value
was deleted, so store it again with /secret add GITHUB_TOKEN --from-env <VAR> if you still
need it.
```

If a command still refers to a secret that has expired, the placeholder stays visible in the command rather than being replaced with nothing. A command that fails loudly is better than one that runs without a credential it needed, and an empty `Authorization:` header reads like a request the agent meant to send unauthenticated.

The deleted raw value remains a forward-only redaction tombstone for the life of the same working-directory runtime. Veyyon will not substitute it into a command, but old transcript text containing it is still replaced before a provider request.

### Scope

An entry belongs to one scope and is invisible from the others:

| Scope | Where it lives | Use it for |
| ----- | -------------- | ---------- |
| `profile` (default) | the active profile's agent directory | credentials for one line of work |
| `project` | `<project>/.veyyon/vault.json` | credentials for one repository |
| `global` | `~/.veyyon/vault.json` | credentials you want everywhere |

```text
/secret add scan-token --from-env SCAN_TOKEN --scope project
```

Profile is the default because that is usually the boundary you want. A credential you use for one kind of work should not be reachable from a session you opened in another profile.

When the same name exists in more than one scope, the narrowest wins, and `/secret rm` removes the one that is in effect. Run it again to remove the next one out.

`--scope` belongs to `add`, and only to `add`. Each option is refused by the subcommands that do not read it, naming the one that does:

```text
/secret rm github-token --scope project

/secret rm does not take --scope, and ignoring it would look like it had been applied.
/secret add takes it.
```

That refusal exists because the alternative is worse than an error. An accepted-and-ignored `--scope` on `rm` reads as "the project copy is gone" when what actually happened is that the copy in effect was removed and the others are still there.

### Encryption, and what it does not do

Vault files use AES-256-GCM. Each write uses a fresh 12 byte nonce and the full 16 byte authentication tag. The key is a 32 byte file at `~/.veyyon/vault.key`, created on first use. It never lives inside a project directory.

On POSIX, the key is mode 0600. Its directory must be owned by you and not writable by another user. On Windows, Veyyon applies and verifies a protected owner-only ACL. Existing vault files receive the same platform permission checks before they are read.

A project-scoped vault can sit in a directory you commit or export. The ciphertext is unusable without the machine key, but it is not a portable backup. The authenticated location includes the semantic scope, canonical path, and physical scope-directory identity. If you move or recreate that directory, re-add the entries with `/secret add`.

Updates use a synchronized owner-only temporary file. Kernel no-replace and exchange operations publish the synced inode without overwriting a destination that appeared after the last check. Veyyon holds the scope directory open during the transaction, so replacing the lexical parent cannot redirect the read or write.

Veyyon refuses symlinks, hard-linked files, directories, devices, insecure permissions, and paths whose resolved parent crosses the requested scope. It also refuses ciphertext copied to a different scope or physical directory.

The sealed descriptor is limited to 8 MiB before it is read into memory. Writes enforce a separate 6,291,402-byte encoded plaintext limit before serialization, encryption, or Base64 expansion. A legacy version 1 envelope is refused because it is not bound to its scope and path. Re-add those entries with `/secret add` so they use the current authenticated format.

These failures are deliberately loud:

- A vault file present with no readable key stops the session. It is never treated as empty.
- A vault whose nonce, ciphertext, authentication tag, or bound location changed is refused.
- An unsafe directory, symlink, non-regular path, hard link, or insecure permission is refused with the path and fix.

What this encryption does not protect against is someone who is already running as you. The key is readable by your own account by design. If you need to defend against a compromised account, use a hardware token or an external secret manager.

### Seeing which credential was used where

Hiding a value from the provider tells you what the agent could not see. It does not tell you what the agent did with what it could. `/secret log` answers that:

```text
/secret log
```

```text
3 most recent use(s), oldest first:
  12m ago  bash  #GITHUB_TOKEN#
    {"command":"curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com/user"}
  4m ago  bash  #DEPLOY_KEY#
    {"command":"scp -i #DEPLOY_KEY# build.tar deploy@host:/srv"}
  just now  bash  #GITHUB_TOKEN# #DEPLOY_KEY#
    {"command":"./release.sh --token #GITHUB_TOKEN# --key #DEPLOY_KEY#"}
```

Each line is one tool call that mentioned a secret: when it happened, which tool received it, which placeholders were substituted, and the command as the model wrote it. Pass `--limit 50` for more than the last twenty.

The log belongs to the profile rather than to one session, so two veyyon windows in the same profile append to the same file. When the records you are shown come from more than one, the output says so:

```text
These records come from 2 sessions sharing this profile's log.
```

Without that line the rows read as one session's history, and you would count uses another window made.

The recorded command holds the **placeholder**, not the value, and that is a property of how the record is built rather than a promise about care taken. Veyyon writes the arguments as they were before substitution, which is the form in which every secret is still a placeholder, so there is no redaction step that could be got wrong and no way for a value to reach the file.

Placeholder discovery follows the same recursive string and object-key walk as command expansion. The reader escapes terminal control characters in records, paths, and notices before display. Hard-linked log files are refused, and generation reads check the 2 MiB bound before allocating a buffer.

Recording is on by default and writes to `secret-audit.jsonl` in your active profile's directory. Turn it off under Record Secret Use in `/settings`:

```yaml
secrets:
  auditLog: false
```

The file is mode 0600 and lives in the profile rather than the project. If veyyon cannot append to it, it says so and the command still runs. The value is still protected either way.

At two megabytes, roughly ten thousand uses, the log is atomically moved to `secret-audit.jsonl.1` and a fresh one is started. A cross-process lock covers the size check, rotation, append, and read snapshot, so two sessions cannot overwrite a generation or exceed the record cap at the boundary. Oversized rows bound every field and report how many placeholder references were omitted. `/secret log` reads both generations.

## Declaring secrets yourself

Environment variable detection covers the common case. For anything else, list entries in a `secrets.yml` file. Two locations are read:

| Level   | Path                          | Use for                    |
| ------- | ----------------------------- | -------------------------- |
| Profile | `<agent dir>/secrets.yml`     | Credentials for one line of work |
| Project | `<project>/.veyyon/secrets.yml` | Credentials specific to one repository |

Both levels are read and merged. A project entry with the same `content` as a profile entry replaces it, so a repository can override a declaration without duplicating the rest of the file.

A minimal file protects one literal value:

```yaml
- type: plain
  content: sk-proj-abc123def456
```

A `regex` entry protects anything matching a pattern, which is how you cover credentials you have not seen yet:

```yaml
- type: regex
  content: "AKIA[0-9A-Z]{16}"
```

Patterns always scan globally. You do not need the `g` flag.

Veyyon refuses regexes that can make no progress, use sticky matching, or contain conservatively detected catastrophic-backtracking forms. Replacement changes only the exact matched span. Equal text outside the regex context is left alone.

## The two modes

Each entry chooses what happens to the value.

`obfuscate`, the default, is **reversible**. The value becomes a placeholder on the way out and the placeholder becomes the value again on the way back in. Use it when the agent needs to work with the credential.

`replace` is **one way**. The value is swapped for a fixed or generated string and nothing restores it. Use it when the agent has no business using the credential at all and you only want it out of the context:

```yaml
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

A generated replacement is derived with the machine placeholder key, so it does not expose a cross-machine dictionary oracle. A custom replacement cannot look like a named or machine-keyed placeholder. That restriction prevents one-way text from becoming a request to expand a live credential.

## The 8-character minimum

`obfuscate` mode replaces every occurrence of the value. A three-character secret would blank out fragments of unrelated words, so short values are not obfuscated.

Veyyon refuses them rather than ignoring them. A plain `obfuscate` entry under 8 characters stops startup with an error naming the entry and the fix. This is deliberate: a session that starts cleanly while sending your declared secret to the provider in plain text is worse than a session that will not start.

The fix is `mode: replace`, which is one way and has no minimum.

A regex match under the floor behaves differently. A short match usually means the pattern reached into ordinary prose, so the match is skipped and the over-matching pattern is reported once. If short matches really are secret, say so on the entry:

```yaml
- type: regex
  content: "\\b[0-9]{6}\\b"
  minLength: 6
```

A malformed or unreadable `secrets.yml` also stops startup, and so does a single entry inside it that is not a valid declaration. A mistyped `type:`, a missing `content:`, or `minLength` on a plain entry each name the entry number and the fix:

```text
Refusing to start: 2 entries in /home/you/.veyyon/secrets.yml are not valid secret
declarations, and skipping them would leave the values they declare unprotected.
  - entry 0 has type "plaintext", which must be "plain" (an exact value) or "regex" (a pattern).
  - entry 3 sets minLength, which applies to regex entries only. A short plain secret needs
    "mode: replace", which is one-way and has no minimum.
```

Every problem in the file is listed at once, so you fix them in one pass rather than finding the next one on each restart. A missing file does not stop startup, because nothing was declared.

Unknown fields are errors too. A misspelled `replacement`, a plain-only field on a regex entry, duplicate flags, or an option that conflicts with the entry type cannot be silently ignored.

## When something cannot be protected

Two kinds of problem can arise, and veyyon treats them differently on purpose.

A problem that would mean a credential reaches the provider **stops the session**. A declared `obfuscate` entry under the minimum, a vault file whose key is missing, a `secrets.yml` that cannot be parsed: each of these is a refusal with the entry and the fix named. A session that starts cleanly while sending your secret out in plain text is worse than one that will not start.

A problem that leaves protection intact but degrades something appears **in your session as a warning**, prefixed with the subsystem that raised it:

```text
Warning: secrets: pattern matched a 3-character value, under this entry's 8-character floor.
Set "minLength" on the entry if short matches are real secrets, or tighten the pattern.
```

An over-matching pattern is the usual example. It is discovered while obfuscating a message rather than at startup, so it cannot be a refusal, and it is worth seeing because you cannot otherwise tell a working pattern from one that is quietly reaching into prose.

In `--print` mode and other non-interactive clients the same warnings go to stderr, so a scripted run does not lose them.

Nothing important goes only to the log file. That was the previous behaviour and it amounted to silence: the log has no console output by default, and nobody opens it.

## Where the value goes

| Destination | Sees the real value? |
| ----------- | -------------------- |
| Model provider | No, a placeholder |
| Local session transcript | It can. User and tool text is kept locally as written. |
| A session you `/share` | No, a placeholder |
| The vault file on disk | No, encrypted |
| The secret-use log | No, a placeholder |
| `secrets.yml` on disk | Yes, it is a plain file you wrote |
| Your terminal | Yes, local display restores live placeholders |
| A command the agent runs | Yes, substituted before execution |

The provider boundary is applied again whenever a local transcript is sent. Resuming a session can restore placeholders for display without giving the resumed raw text a path back to the provider.

Changing the working directory is transactional. Veyyon loads the destination runtime before committing the move, and restores both the old directory and old runtime if loading fails. A resumed session or persisted subagent starts from its recorded directory before loading project-scoped secrets.

## What this does not protect

Be clear about the boundary.

**The two stores differ on disk.** Vault entries added with `/secret` are encrypted. `secrets.yml` is a plain file: it holds declarations you wrote, in the clear, and anyone who can read it has those credentials. If a value needs to be encrypted at rest, put it in the vault rather than in `secrets.yml`.

**A command the agent runs receives the real value.** So a command that prints the credential prints it for real. Its output is obfuscated again before it goes back to the model, but it reached the process, and anything that process wrote elsewhere is outside veyyon's reach.

**Protection begins when the value is known.** Once you enable protection or store a value, old local transcript text containing that value is sanitized on subsequent provider requests. The local transcript is not rewritten in place.

**A value you type on the command line is visible on screen.** `/secret add NAME <value>` puts the credential in your scrollback. It is excluded from persistent editor history, but the obfuscator cannot scrub a terminal after the fact. Use `/secret add NAME` on its own, which prompts with the value hidden, or `--from-env`.

**The secret-use log records use, not intent.** It tells you which credential went into which command. It cannot tell you what the command did with it once the process had it.

## Reference

The field-by-field schema, the merge rules between the two files, and the interaction with environment detection are in `docs/secrets.md`.

For provider credentials specifically, `veyyon` keeps OAuth tokens and API keys in its own credential store rather than in your context. See [Signing in](../using/authentication.md).
