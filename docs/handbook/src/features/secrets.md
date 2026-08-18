# Secrets

You often need the agent to run a command that requires a credential. A deploy needs a token. A database query needs a password. If you paste the value into chat without protection, it can reach the model provider and any session export you create.

Veyyon can keep the value away from the provider while the command still works. This page shows you how, including which local surfaces can still contain it.

## Turning it on

Secret protection is off by default. The quickest way to turn it on is to store a credential: storing one switches protection on and tells you it did, because a stored credential is only useful once the protection that substitutes it is running.

To turn it on without storing anything, use `/settings`, or write it into `config.yml`:

```yaml
secrets:
  enabled: true
```

The setting takes effect in the current session. Veyyon reloads environment variables, `secrets.yml`, and the vault when you toggle protection or run a `/secret` command. Moving to another working directory loads that project's scope and drops the source project's mappings.

## Your first secret

If the credential is already an environment variable, you have nothing to declare to keep its value out of provider requests. Veyyon treats an environment variable as secret when its value is 8 characters or longer and its name ends with, or has an underscore after, one of `KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `PASSPHRASE`, `AUTH`, `CREDENTIAL`, `PRIVATE`, or `OAUTH`.

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

needs no configuration for defensive protection. Start Veyyon and that value is
replaced whenever it appears in provider-bound text. Environment detection does
not give the agent a readable inventory name. When the agent must choose and
spend the credential deliberately, store the same value in the vault:

```text
/secret --from-env DEPLOY_TOKEN
```

That is the form you type in a terminal. Veyyon asks you for a name afterwards and generates one if you skip it. A client with no terminal, such as `--print` mode or an ACP editor, uses `/secret add deploy-token --from-env DEPLOY_TOKEN` instead; see [On a client with no terminal](#on-a-client-with-no-terminal).

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

The model is told two things about a placeholder: that putting one where a credential belongs is expected and works, and that it is opaque otherwise. It does not know the value and cannot ask for it. For named vault entries it is told one more thing, which credentials it currently has, covered under [What the agent knows, and when](#what-the-agent-knows-and-when).

## Using a secret in a command

This is the part that makes the feature useful rather than merely defensive. The model can put a placeholder into a command, and veyyon substitutes the real value before the command runs.

The model writes:

```bash
curl -H "Authorization: Bearer #0A1B2C3D4E5F678901234567#" https://api.example.com/deploy
```

The command that actually executes carries the real token. The substitution happens locally, after the model has produced the command and before the shell sees it. The model never learns the value, and the request still authenticates.

The substituted command is not written down. Veyyon records one diagnostic entry per tool call so that a session interrupted mid-call can tell you on resume what was running, and that entry stores the placeholder form, not the substituted one. This matters because `/share` uploads the session file and backups copy it. What the command prints is a separate question, covered under [What this does not protect](#what-this-does-not-protect).

## What the agent knows, and when

Store `GITHUB_TOKEN` today, quit, and start a new session tomorrow. Ask for your open pull requests, and the agent writes `#GITHUB_TOKEN#` into the `curl` command without you mentioning the credential again.

It can do that because the system prompt carries an **inventory**: the placeholders the agent is able to spend at that moment, listed by name and sorted. The inventory is built from the live secret runtime rather than from the conversation, and that is the whole reason it survives a restart. The vault is stored on disk; a conversation is not. Knowledge kept only in the transcript went away with the transcript, while the credential it described stayed exactly where it was.

The inventory holds names, and nothing else. No value appears in it in any state, and the agent has no way to ask for one. Around the list the agent is told what the list is for: write the placeholder where the credential belongs, the real value is substituted locally just before the tool runs, and a name that is not listed is not available.

Only vault entries are listed, because only they have readable names. A value detected in your environment, or declared in `secrets.yml`, becomes a machine-keyed placeholder instead, which the agent meets where the value would have appeared rather than in a list.

When protection is off, or when nothing is stored, the section is absent rather than empty. An empty heading reads as "you have no credentials", and that is a different statement from "this session cannot spend any". Removing the last credential takes the whole section away again, heading included.

Four moments, and what the agent learns at each:

**At session start, or on resume.** The inventory, rebuilt from whatever the vault holds right then. Nothing else is needed. A credential you stored last week does not have to be introduced again.

**When you add one.** The inventory is rebuilt so the new name is in it, and the agent is told directly, in that turn, that the credential now exists and where its placeholder goes.

**When you remove or extend one.** Both again: the inventory is rebuilt, and the agent is told what changed. A revocation says the placeholder is revoked and must not be used. A fresh lifetime says the credential is still available under the same placeholder. Neither notice quotes a lifetime, because a duration written into the history is wrong a minute later, and your terminal already shows you the exact time left.

**When a lifetime runs out on its own.** Substitution stops at the deadline itself, not a moment after, and the name leaves the inventory on the next rebuild. There is no notice on this path, because no command ran and so there is no turn to put one in. You are warned twice before it happens, which is covered under [Lifetimes](#lifetimes).

In none of these does the agent learn a value.

### Why a removal is stated rather than left to the list

Dropping the name from the inventory would be the quieter design, and on paper it says the same thing. It does not work. Noticing that something has stopped being present in a long prompt is the kind of thing a model reliably fails at, so it goes on writing a placeholder that worked ten minutes ago.

A revoked placeholder cannot reach a tool during the running process. Veyyon remembers the exact name it retired and refuses the call before execution:

```text
Stored secret #STRIPE_TEST_KEY# is no longer available. Store the credential again and update the command.
```

Text that was never a live credential, such as `#TODO#`, remains ordinary input. The revocation notice gives the agent the same fact before it tries the call; the refusal is the backstop when the agent keeps using stale history.

For the same reason, the removal notice is delivered even when secret protection is off. The add and extend notices are not: with protection off there is no working placeholder to advertise. A revoked one is different, because it is already sitting in the agent's history, and the agent needs to hear that it stopped working whatever the setting says.

Turning secret protection off also marks every name advertised in the running
process as retired for tool execution. Redaction keeps using the same readable
placeholders in provider-bound text, but a stale tool call cannot spend or send
them after expansion has been disabled.

## The vault: storing a credential with `/secret`

Environment detection covers credentials that are already in your shell. For anything else, hand it to the vault. A vault entry is encrypted on disk, has a name, and expires.

### Storing a credential

In a terminal, everything you type after `/secret` is the credential. There is no verb to spell and no name to invent first:

```text
/secret ghp_R2d2c3poIHRva2VuIGV4YW1wbGU
```

Veyyon takes the value off the line and asks what to call it, in a field that shows what you type, because a label is not a secret:

```text
Name this secret (optional). The model spends it by writing #NAME#. Leave empty to have one generated.
>
  enter submit  esc cancel
```

Press Enter on the empty field and veyyon generates a name, `SECRET_1` and upwards. Type one and it is cleaned up and uppercased for you, so `github token` becomes `GITHUB_TOKEN`. Press escape and nothing is stored at all:

```text
Cancelled. Nothing was stored.
```

That order is deliberate. The credential is what you came to store, so nothing stands between you and storing it, and the name is asked afterwards where you are free to skip it.

#### Pasting into a hidden field

A bare `/secret` opens a field that shows nothing as you type:

```text
/secret
```

```text
Paste the secret value here. You can name it afterwards.
> ••••••••••••••••••••
  the value, not a name · hidden as you type, stored encrypted  ·  enter submit  esc cancel
```

Your composer is cleared before the field opens, so the value never enters the input buffer and never reaches your scrollback. Press escape and nothing is stored. Submit an empty field and nothing is stored either, and veyyon says so rather than storing an empty credential. The name field follows, the same one as above.

#### Reading it out of the environment

If the credential is already an environment variable, read it from there and type nothing:

```text
/secret --from-env GITHUB_PAT
```

This is the recommended form, because the value never enters the input buffer and never reaches your scrollback. `--from-env` has to be the first word on the line and the variable name has to be the only thing after it. Anything else on the line is a credential again, so the parser refuses rather than storing something you did not mean:

```text
--from-env needs the name of an environment variable, and nothing else.
```

The name field follows here too.

#### A value on the command line stays in your scrollback

The one-paste form is on screen until you clear the terminal. Veyyon says so rather than leaving you to work it out:

```text
The value was typed on screen, so it is in your scrollback. Use --from-env next time to avoid that.
```

Every exact `/secret` command shape, including malformed input, is excluded from persistent editor history. This prevents the command from being recovered with the Up key or written to `history.db`. It cannot erase terminal scrollback that was already rendered.

The line is kept byte for byte from its first non-space character to its last, so a passphrase may contain spaces and no part of the value is trimmed away. Use the hidden field or `--from-env` when you would rather the value were never on screen at all.

#### The verbs are the reserved words

`/secret` reserves one list of words: `add`, `list`, `rm`, `rename`, `value`, `scope`, `copy`, `extend`, `log`, `discard` and `help`, plus the second spellings `remove`, `delete`, `name`, `replace`, `move`, `renew` and `audit`. A line beginning with one of those is that command. A line beginning with anything else is a credential.

A reserved word stays a command however much follows it, so a malformed one is refused rather than quietly stored: `/secret log 50` is a `log` with an unreadable argument, not a new secret called `SECRET_1`. If a credential of yours really does begin with one of those words, say so with `--`:

```text
/secret -- list of words that is really a passphrase
```

Everything after `--` is stored byte for byte, first word included.

### What you are told when it is stored

Whichever form you used, veyyon confirms with the name it filed the credential under and the placeholder the model will write:

```text
Stored GITHUB_TOKEN in the profile vault, 1d left.
The model sees #GITHUB_TOKEN# and never the value. Write that placeholder where the credential goes.
```

Storing over a name that already exists is called a replacement rather than a store. That write is how you rotate a credential, and it is also what a fumbled name does, so it is never reported as if nothing had been overwritten:

```text
Replaced GITHUB_TOKEN in the profile vault, 1d left.
The previous value is gone. #GITHUB_TOKEN# now spends the credential you just stored.
```

The agent is told at once that a credential exists and that it should write `#GITHUB_TOKEN#` where the value belongs. It is never told the value and cannot ask for it. It also keeps knowing after this session ends, because the inventory in the system prompt is rebuilt from the vault rather than remembered from the conversation. See [What the agent knows, and when](#what-the-agent-knows-and-when).

### Managing what you stored

Every verb below works in a terminal and on a client that has none. The value forms above are the only part of `/secret` that depends on where you are typing.

| Command | What it does |
| ------- | ------------ |
| `/secret list` | one row per credential: placeholder, scope, time left |
| `/secret rename <name> <new-name>` | relabel it, keeping the value, the creation time and the deadline |
| `/secret value <name>` | replace the value, keeping the name and the deadline |
| `/secret scope <name> project` | move it to another vault |
| `/secret copy <name>` | put `#NAME#` on the clipboard, never the value |
| `/secret extend <name> --ttl 7d` | give it a fresh lifetime, measured from now |
| `/secret rm <name> [--scope global]` | revoke it |
| `/secret clear --scope profile` | remove every credential in one vault, naming what it removed |
| `/secret log [--name <name>] [--limit 50]` | which credentials were spent, and where |
| `/secret discard --scope project` | move aside a vault file that cannot be read |
| `/secret help` | every form, on the surface you are on |

`value` is how you correct a credential. It keeps the name, the scope, the creation time and the expiry, so a token pasted with one character missing does not have to be revoked and stored again: storing it again mints a new name while every prompt in the session still spends the old placeholder, and it re-dates the entry, so a secret with two days left would come back with the default lifetime. The field it opens is hidden as you type, and `--from-env <VAR>` works with it too.

`copy` copies the placeholder and only the placeholder. `#GITHUB_TOKEN#` is the thing you paste into a prompt; copying the value would be the disclosure you stored the credential to avoid.

`clear` empties one vault. It names the scope because there is no default: the vault is three files, project overriding profile overriding global, and the copy you can reach is the one that gets spent, so a guess would empty whichever happened to be in front and leave the other two full. It reports the placeholders it dropped. A name that a wider vault still holds is reported as removed but not as revoked, because `#NAME#` goes on expanding to that copy. `wipe`, `purge`, `empty` and `reset` are the same command.

`scope` refuses a move onto a name the destination vault already holds, rather than overwriting it. It also carries the time REMAINING rather than the original lifetime, so moving a secret cannot lengthen its life. The copy is written to the destination before the source is removed, so an interrupted move leaves two copies you can see rather than none.

No verb prints a value: not on a row, not truncated onto one, not behind a key. A value put into the vault has stopped being visible, and the surface most likely to end up in a screenshot is the one that must not break that.

Every change reloads the live secret runtime, so a credential you revoke stops being spendable in the session you are sitting in rather than at the next restart. A reload that fails is reported rather than swallowed, because the vault write is already durable and you are the only one who can decide what to do about the gap.

**Names are never completed.** The dropdown after `/secret ` offers verbs and nothing else. Completing a stored name would put part of your vault on screen on a keystroke, and accepting one would type a name onto a line whose first word decides between a command and a credential. `/secret list` is where names are read.

### On a client with no terminal

`--print` mode and an ACP editor have no field that can hide what you type, so they cannot accept a credential you type at all. Every verb is the same there. What differs is `add`:

```text
/secret add github-token --from-env GITHUB_PAT
```

The name is a positional argument there, because there is no field to ask for one afterwards, and `--from-env` is the only source. An inline value is refused, because that surface keeps its requests in a history you cannot clear:

```text
This non-interactive client refuses inline credentials because they would be retained in command
history. Use /secret add <name> --from-env MY_TOKEN instead.
```

`list` prints a table:

```text
2 active secrets. The agent spends one by writing its placeholder; the value is never shown.
  PLACEHOLDER         SCOPE    EXPIRES  STATUS
  #GITHUB_TOKEN#      profile  6d left
  #PROD_DB_PASSWORD#  project  1d left  expires soon
Extend one before it lapses: /secret extend <name> --ttl 7d.
```

No part of any value appears there. A prefix of a credential is still a disclosure, and one on screen is one in a screenshot.

The `STATUS` column and the closing line appear only when at least one entry has crossed a warning threshold, so a table of healthy entries is one column narrower. A cell reads `past halfway` or `expires soon`, and those are the same two thresholds that raise the warnings described under [Lifetimes](#lifetimes). The table and the warnings cannot disagree about which entry is in trouble.

With nothing stored, `list` says so and shows the one entry form that surface has, rather than printing an empty table.

Removing and extending each tell the agent what changed, whichever surface you did it from, so a placeholder you revoked stops being used instead of arriving at a command as literal text. See [What the agent knows, and when](#what-the-agent-knows-and-when).

### When a vault file cannot be read

Sometimes a vault file survives on disk and stops being readable: a disk filled up mid-write, a
backup tool restored half of it, a sync client merged two copies. Veyyon tells you which scope, what
it means, and what to run:

```text
Your profile vault at /home/you/.veyyon/profiles/work/agent/vault.json exists but could not be
read, so it was skipped and the secrets stored in it are unavailable for the rest of this session:
their placeholders will NOT expand. Every OTHER scope loaded normally, and masking of known secret
values is unaffected. The vault is encrypted, so a hand edit cannot repair it: run /secret discard
--scope profile to move the unreadable file aside. Then store the secrets it held again. The reason
it could not be read was <what the parser complained about>
```

A vault can also fail in a way Veyyon cannot step around, where nothing in it can be read: the key
is gone, the key is not the one the vault was sealed with, or the file is truncated. The session
still starts, and says so:

```text
Your vault could not be read, so this session started WITHOUT it: nothing you have stored is
available, and every #NAME# placeholder it held will be refused rather than sent as literal text.
Masking of secrets from your environment and secrets.yml is unaffected and still running.
Affected: project (/home/you/work/repo/.veyyon/vault.json). Run /secret discard --scope project to
move the unreadable file aside. Then store the secrets it held again. The reason it could not be
read was <what the parser complained about>
```

Both notices name one command, because a notice raised by the vault loader cannot know which client
is about to print it, and `discard` runs on all of them. It moves the file aside rather than deleting
it: the bytes still hold a real credential under a live key, and a repair that destroyed them would
be worse than the fault it was fixing.

Read the second sentence of the second notice carefully, because it is the part that keeps a broken
vault from becoming a leak. A scope Veyyon could not read is treated as unreadable, never as empty.
`#NAME#` in a prompt is refused rather than passed through as the literal text `#NAME#`, and Veyyon
will not act as though you had stored nothing.

The session starts because the repair is a command inside it. If a vault that would not open also
stopped Veyyon from launching, the only way out would be deleting the file by hand, which is the
one thing an encrypted store exists to stop you doing casually.

Either route runs the same repair, and prints the same result:

```text
Moved the unreadable profile vault to
/home/you/.veyyon/profiles/work/agent/vault.json.unreadable-1753660800000-8e3a8d58, so that scope
works again. The file still holds your sealed entries, so re-add the secrets it held rather than
assuming they are gone.
```

The scope keeps working from there. You can store secrets in it again immediately, and the other two
scopes were never affected: only the file you named moved.

**Your file is moved, not deleted.** The name it moved to is in the message because that file is the
only route back to what it held. It is still encrypted with a key that is still on disk, so if the
damage is a truncated tail, the entries before the damage are still in there. Veyyon will not destroy
a credential store to make itself usable again, so the cleanup is yours to do once you are sure you
no longer need it.

**You have to name the scope.** Every other command that takes `--scope` defaults to `profile`,
because there it chooses where to put something and `/secret list` shows you the result. Here it
chooses a file to move aside, so a default would let a bare `/secret discard` move a working vault
out from under the session you are sitting in. A bare invocation is refused and tells you the flag.

Two things the repair refuses, both on purpose:

- **A scope that reads normally.** This is not a second way to delete secrets. Revoke the entry
  instead with `/secret rm <name>`, which tells you what it removed. The check happens at the moment
  you run the repair rather than from the earlier warning, so a file that was fixed in between is
  left alone.
- **A scope that shares its file with another scope.** If your profile directory is your config
  root, the profile and global vaults are one file, and moving it aside as one would take the other
  with it. The refusal names the other scope so you can decide which you meant.

The repair is reachable from every client, not only the terminal, because a broken vault is most
likely to turn up in a headless run.

### Lifetimes

Every entry expires. The default is one day, which you can change in `/settings` under Secret Lifetime.

In a terminal that setting is the whole answer at the moment you store something, because the
argument line is the credential and there is no room on it for an option. To give one entry a
different lifetime, store it, then run `/secret extend <name> --ttl 30m`. The lifetime you name
there is measured from now, not from when the credential was stored.

On a client with no terminal the lifetime is an option on `add` as well:

```text
/secret add deploy-key --from-env DEPLOY_KEY --ttl 30m
/secret add signing-key --from-env SIGNING_KEY --ttl never
```

Lifetimes are written the same way in both places: `30m`, `12h`, `7d`, `2w`, or `never`. Weeks are accepted and reported back in days.

You are warned before a lifetime runs out, once at the halfway point and again near the end:

```text
Warning: secrets: #DEPLOY_KEY# expires soon, 2h left. Extend it with
/secret extend DEPLOY_KEY --ttl 7d, or it will be deleted.
```

The remedy is one command, and it runs wherever the warning is read: a notice raised while the vault
is loading cannot know which client is about to print it.

The thresholds are fractions of the lifetime rather than fixed times, so one rule fits every entry. A one-day secret is mentioned after twelve hours; a ninety-day secret is mentioned on day forty-five, not on day eighty-nine. Each warning names the command that prevents expansion from being revoked.

**Expiry revokes substitution immediately.** If an expired secret merely stopped being obfuscated, its value could flow to the model provider when protection lapsed. Veyyon instead removes the in-memory expansion mapping and keeps a forward-only redaction tombstone.

The deadline is enforced when the credential is used, not only when a session starts. A session left open over a weekend stops substituting a one-day secret on the day it expires and reports both the runtime and persisted state:

```text
Warning: secrets: #GITHUB_TOKEN# has expired and its in-memory expansion has been
revoked. Its encrypted value has not yet been deleted from the vault; a successful
vault refresh will prune it. Store it again with /secret --from-env <VAR> if you still
need it, or /secret add GITHUB_TOKEN --from-env <VAR> in a client with no terminal.
```

In a terminal the name field that follows is where you type `GITHUB_TOKEN` to get the same
placeholder back.

The hot-path expiry check does not write to the vault. The encrypted entry remains on disk until the next successful vault refresh prunes it. It remains encrypted and cannot be expanded after the deadline.

If a command still refers to an expired secret, Veyyon refuses it before the tool starts and names only the retired placeholder. It does not send an empty header or the literal placeholder to a remote service. Old transcript text containing the raw value remains covered by the forward-only redaction tombstone for the life of the same working-directory runtime.

### Scope

An entry belongs to one scope and is invisible from the others:

| Scope | Where it lives | Use it for |
| ----- | -------------- | ---------- |
| `profile` (default) | the active profile's agent directory | credentials for one line of work |
| `project` | `<project>/.veyyon/vault.json`, kept out of your commits | credentials for one repository |
| `global` | `~/.veyyon/vault.json` | credentials you want everywhere |

A credential you store in a terminal goes to the profile vault. Scope is an option, the argument line there is the credential, so there is no place on it to put one. Profile is the default because that is usually the boundary you want: a credential you use for one kind of work should not be reachable from a session you opened in another profile.

A credential already stored can be moved with `/secret scope <name> project`. To file one somewhere else as you store it, name the scope on a client that takes a verb and a value on one line:

```text
/secret add scan-token --from-env SCAN_TOKEN --scope project
```

When the same name exists in more than one scope, `/secret list` says so. The table stays one row
per name, because one row per name is what the agent can spend, and a sentence underneath names the
copies it is not spending:

```text
2 active secrets. The agent spends one by writing its placeholder; the value is never shown.
  PLACEHOLDER     SCOPE    EXPIRES
  #SHARED_TOKEN#  project  24h left
  #SOLO_TOKEN#    profile  24h left
  #SHARED_TOKEN# is also stored in the global vault, shadowed by the project one. Only the project
  copy is spent. Remove it with /secret rm SHARED_TOKEN --scope global.
```

That copy is inert, not gone. It is still on disk, still decryptable, and it becomes the live one
the moment the copy in front of it is removed. Before the list mentioned it, the only way to find
out was to remove the copy in effect and read what the removal told you, which is late: you learn
about a credential at the moment it starts being spent.

The narrowest copy is the one that wins, and a removal without `--scope` takes it. Removing that
copy uncovers the next one out, and the command tells you that too:

```text
/secret rm shared-token

Removed SHARED_TOKEN from the project vault. A profile secret of the same name was underneath it,
so #SHARED_TOKEN# still spends a credential, now that one. Run /secret rm SHARED_TOKEN --scope
profile to remove that one too.
```

That second sentence is the part that matters, because the placeholder keeps working. Without it
you would read a removal, assume the name was dead, and leave a live credential reachable under a
name you believe you revoked. The agent is told the same thing, so it does not treat the name as
revoked either.

To take a particular copy rather than the one in effect, name its scope:

```text
/secret rm shared-token --scope profile
```

Naming the scope of a copy that is already shadowed removes it without changing what the
placeholder spends, and the command says that rather than implying something changed.

`--scope` belongs to `add`, to `rm`, and to the `discard` repair. Each option is refused by the
subcommands that do not read it, naming the ones that do:

```text
/secret extend github-token --scope global

/secret extend does not take --scope, and ignoring it would look like it had been applied.
/secret add, /secret rm, /secret clear and /secret discard take it.
```

That refusal exists because the alternative is worse than an error. An accepted-and-ignored
`--scope` on `extend` reads as "the global copy was given a fresh lifetime" when what actually
happened is that the copy in effect was re-dated and the others were left alone. It is a rule of
the verb grammar, and `--scope` is refused by `extend` wherever you run it.

### Encryption, and what it does not do

Vault files use AES-256-GCM. Each write uses a fresh 12 byte nonce and the full 16 byte authentication tag. The key is a 32 byte file at `~/.veyyon/vault.key`, created on first use. It never lives inside a project directory.

On POSIX, the key is mode 0600. Its directory must be owned by you and not writable by another user. On Windows, Veyyon applies and verifies a protected owner-only ACL. Existing vault files receive the same platform permission checks before they are read.

A project-scoped vault lives inside the repository you are working in, so Veyyon keeps it out of your commits. The first time it stores a project secret, it writes `.veyyon/.gitignore` covering `vault.json` and the `vault.json.unreadable-*` file that a discarded vault is renamed to. If that file already exists, Veyyon adds the two rules and leaves your own lines alone. Only the vault is ignored, so anything else you keep in `.veyyon/`, such as prompt templates, stays trackable. Commit the generated `.veyyon/.gitignore` along with the rest of your project.

Committing a vault would not expose the credentials directly, because the ciphertext is unusable without the machine key. It would still put a credential store in your history, and nobody who clones the repository can open it, including you on another machine. A vault is not a portable backup. The authenticated location includes the semantic scope, canonical path, and physical scope-directory identity. If you move or recreate that directory, store those entries again.

Updates use a synchronized owner-only temporary file. Kernel no-replace and exchange operations publish the synced inode without overwriting a destination that appeared after the last check. Veyyon holds the scope directory open during the transaction, so replacing the lexical parent cannot redirect the read or write.

Veyyon refuses symlinks, hard-linked files, directories, devices, insecure permissions, and paths whose resolved parent crosses the requested scope. It also refuses ciphertext copied to a different scope or physical directory.

The sealed descriptor is limited to 8 MiB before it is read into memory. Writes enforce a separate 6,291,402-byte encoded plaintext limit before serialization, encryption, or Base64 expansion. A legacy version 1 envelope is refused because it is not bound to its scope and path. Store those entries again so they use the current authenticated format.

These failures are deliberately loud:

- A vault file present with no readable key stops the session. It is never treated as empty.
- A vault whose nonce, ciphertext, authentication tag, or bound location changed is refused.
- An unsafe directory, symlink, non-regular path, hard link, or insecure permission is refused with the path and fix.

What this encryption does not protect against is someone who is already running as you. The key is readable by your own account by design. If you need to defend against a compromised account, use a hardware token or an external secret manager.

### Seeing which credential was used where

Hiding a value from the provider tells you what the agent could not see. It does not tell you what the agent did with what it could. The expansion log answers that, and `/secret log` prints it:

```text
3 most recent use(s), oldest first:
  12m ago  bash  #GITHUB_TOKEN#
    {"command":"curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com/user"}
  4m ago  bash  #DEPLOY_KEY#
    {"command":"scp -i #DEPLOY_KEY# build.tar deploy@host:/srv"}
  just now  bash  #GITHUB_TOKEN# #DEPLOY_KEY#
    {"command":"./release.sh --token #GITHUB_TOKEN# --key #DEPLOY_KEY#"}
```

One use is when it happened, which tool received it, which placeholders were substituted, and the command as the model wrote it. The last twenty are shown; `/secret log --limit 50` asks for more.

#### Narrowing it to one credential

`--name` answers the question worth asking just before a revoke, which is what stops working:

```text
/secret log --name GITHUB_TOKEN

Uses of #GITHUB_TOKEN#:
2 most recent use(s), oldest first:
  12m ago  bash  #GITHUB_TOKEN#
    {"command":"curl -H 'Authorization: Bearer #GITHUB_TOKEN#' https://api.github.com/user"}
  just now  bash  #GITHUB_TOKEN# #DEPLOY_KEY#
    {"command":"./release.sh --token #GITHUB_TOKEN# --key #DEPLOY_KEY#"}
```

The whole log is read, then narrowed to that credential, and only then cut to the limit. So `--name X --limit 20` means the last twenty uses OF that credential, not the last twenty records of which some happened to be it. The heading names the credential even when nothing follows it, because an empty log for one secret and an empty log altogether support opposite conclusions: the first says this credential has never been spent, the second says nothing has.

#### An empty log, and a log that is off

An empty log names the file it is empty at, so it reads as "nothing has happened here" rather than "something failed to load":

```text
No secret has been used yet. The log is ~/.veyyon/profiles/work/secret-audit.jsonl.
```

A log that is switched off names the setting instead:

```text
Secret use is not being recorded, so there is no log to show. Turn on "Record Secret Use" in
/settings (secrets.auditLog) to start recording.
```

Nothing recorded and nothing being recorded support opposite conclusions about whether a credential was spent, and as an empty list they are the same picture.

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

At two megabytes, roughly ten thousand uses, the log is atomically moved to `secret-audit.jsonl.1` and a fresh one is started. A cross-process lock covers the size check, rotation, append, and read snapshot, so two sessions cannot overwrite a generation or exceed the record cap at the boundary. Oversized rows bound every field and report how many placeholder references were omitted. Both generations are read, so a report asked for right after a rotation still fills up.

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

The same floor applies to a credential you store in the vault, and the field that takes the value applies it there. Type something shorter than 8 characters into the hidden field and it is refused as you leave it, while the value is still in front of you, rather than after you have also named the secret.

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
| Your terminal | Only a `type: regex` pattern you declared in `secrets.yml`. A vault entry, a detected environment variable, and a plain declaration stay masked on screen. |
| A command the agent runs | Yes, substituted before execution |

The provider boundary is applied again whenever a local transcript is sent. Resuming a session can restore placeholders for display without giving the resumed raw text a path back to the provider.

Changing the working directory is transactional. Veyyon loads the destination runtime before committing the move, and restores both the old directory and old runtime if loading fails. A resumed session or persisted subagent starts from its recorded directory before loading project-scoped secrets.

## What this does not protect

Be clear about the boundary.

**The two stores differ on disk.** Vault entries added with `/secret` are encrypted. `secrets.yml` is a plain file: it holds declarations you wrote, in the clear, and anyone who can read it has those credentials. If a value needs to be encrypted at rest, put it in the vault rather than in `secrets.yml`.

**A command the agent runs receives the real value.** So a command that prints the credential prints it for real. Its output is obfuscated again before it goes back to the model, but it reached the process, and anything that process wrote elsewhere is outside veyyon's reach. That output is also saved to the session file as it was printed, so a command that echoes a credential puts it there. The arguments veyyon itself records are redacted, but it cannot redact what a command chose to print.

**Protection begins when the value is known.** Once you enable protection or store a value, old local transcript text containing that value is sanitized on subsequent provider requests. The local transcript is not rewritten in place.

**A value you type on the command line is visible on screen.** `/secret <value>` puts the credential in your scrollback, and the confirmation says so. It is excluded from persistent editor history, but the obfuscator cannot scrub a terminal after the fact. Use a bare `/secret`, which opens a field that hides what you type, or `/secret --from-env <VAR>`, which types nothing at all.

**The secret-use log records use, not intent.** It tells you which credential went into which command. It cannot tell you what the command did with it once the process had it.

## Reference

The field-by-field schema, the merge rules between the two files, and the interaction with environment detection are in `docs/secrets.md`.

For provider credentials specifically, `veyyon` keeps OAuth tokens and API keys in its own credential store rather than in your context. See [Signing in](../using/authentication.md).
