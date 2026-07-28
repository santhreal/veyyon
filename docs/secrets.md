# Secret Obfuscation

Prevents sensitive values (API keys, tokens, passwords) from being sent to LLM providers. When enabled, secrets are replaced before any provider-bound prompt, message, schema, replay payload, or nested model request leaves the process. Reversible placeholders are restored for local display. A resumed transcript is sanitized again before it is sent.

## Enabling

Disabled by default. `/secret add` turns it on for you, because storing a credential for the agent to use is the opt-in, and it says so in the confirmation. To turn it on without storing anything, use the `/settings` UI or `config.yml` directly:

```yaml
secrets:
  enabled: true
```

Nothing turns it back off on your behalf. `/secret rm` removes a credential and leaves protection where it is.

## How it works

1. Secrets are collected from three sources at startup and whenever the live secret runtime is refreshed:
   - **Environment variables** whose names match a keyword from `secrets/env-keywords.yml` (`KEY`, `SECRET`, `TOKEN`, `PASSWORD`, `PASS`, `PASSPHRASE`, `AUTH`, `CREDENTIAL`, `PRIVATE`, `OAUTH`), with values at least 8 characters. Tier B data: a keyword file at `<agent dir>/secret-env-keywords.yml` or `<cwd>/.veyyon/secret-env-keywords.yml` adds to the list and cannot remove from it. See [Env keyword list](#env-keyword-list).
   - **`secrets.yml` files** (see below).
   - **Encrypted vault entries** selected for the current profile and working directory.

2. Outbound strings are replaced before provider dispatch. Named vault values use readable placeholders such as `#GITHUB_TOKEN#`. Unnamed values use a stable machine-keyed HMAC placeholder such as `#0A1B2C3D4E5F678901234567#`. The keyed form is stable across restarts without exposing an index or an offline dictionary oracle.

The final provider boundary works from raw strings before trimming, truncation, serialization, or other lossy transforms. It resolves the live runtime for every physical attempt, including authentication retries, fallback models, delayed queues, compaction, commit analysis, evaluation, benchmarks, memory services, TTS, and image tools. JSON object keys and values are both covered, and key collisions fail closed.

Opaque authenticated replay fields are validated rather than mutated. A live secret in a signature, provider item id, encrypted reasoning block, or provider payload refuses dispatch with a value-free error. Provider-bound images are content-detected, decoded, and canonically re-encoded so EXIF, comments, and other container metadata cannot bypass string obfuscation. URLs that appear to carry credentials bypass cloud reader and enrichment services.

3. Local display restoration expands only live reversible placeholders. Replace-mode substitutions are one-way. Expired and removed values lose expansion rights but retain forward redaction tombstones, so old transcript text cannot become provider-visible.

4. Toggling secret protection and running `/secret` commands rebuilds the runtime immediately. A working-directory move loads the destination project scope transactionally and drops the source project's mappings. If loading fails, both the old directory and runtime are restored. Persisted subagents and resumed sessions initialize from their recorded directory. A same-directory refresh retains only forward redaction history for removed values.

### Spending a secret asks first

Substitution runs on tool arguments just before a tool executes, so the model can put
`#GITHUB_TOKEN#` in a shell command and Veyyon supplies the credential it never showed the model.
That is recorded by `secrets.auditLog`, which answers "which credential did this agent use, and
where" after the fact.

A call whose arguments carry a real credential also needs approval, in the same modes as the
working-directory boundary: `plan`, `ask`, and `auto-edit`. The prompt names the secret and never
shows its value, and it is added to whatever the tier already required, so it can only ask for more
approval and never less. `yolo` opts out of all permission and opts out of this with it, so the
shipped default asks nothing extra. A call that mentions a placeholder without expanding it, such
as one made while `secrets.enabled` is false, carries no credential and does not ask. See
[Approval modes](approval-mode.md).

### What the session file records about the call

Veyyon writes one diagnostic entry when a tool starts, so a session that dies mid-call can tell you
on resume which call was still running. The entry keeps a truncated copy of the `command` or `path`
argument and the model's stated intent.

Those arguments are the expanded ones, because expansion has already happened by then. They are
redacted before the entry is written, so the session file records `printf '%s' '#GITHUB_TOKEN#'`
and never the credential. Redaction runs before truncation, so a value sitting across the
200-character cut cannot leave a readable prefix behind. The redaction survives a `/secret disable`:
the tombstone that keeps an old value hidden from providers keeps it out of this entry too.

The full arguments the model wrote are persisted with the assistant message, and those hold the
placeholder, since the model never saw anything else.

What the command printed is a different matter. Tool output is saved as it was printed and
redacted on its way to the provider, not on its way to disk, so a command that echoes a credential
puts it in the session file. Veyyon redacts what it records itself; it cannot redact what a command
chose to print.

Two modes control what happens to each secret:

| Mode                  | Behavior                                                     | Reversible                                   |
| --------------------- | ------------------------------------------------------------ | -------------------------------------------- |
| `obfuscate` (default) | Replaced with a named or machine-keyed HMAC placeholder      | Yes, while the entry is live                 |
| `replace`             | Replaced with a deterministic safe same-length string        | No                                           |

### The 8-character minimum

`obfuscate` mode replaces every occurrence of the value, so a very short secret would blank out fragments of ordinary words. Values under 8 characters are therefore refused rather than protected, and the refusal is loud:

- A plain `obfuscate` entry under 8 characters **stops startup** with an error naming the entry and the fix. It is not skipped. Skipping it would send the value to the provider while the file said otherwise.
- Use `mode: replace` for a short value. Replace is one-way, needs no reversible placeholder, and has no minimum.
- A **regex** match under the floor is skipped rather than refused, because a short match usually means the pattern reached into ordinary prose. The skip is recorded once per pattern so you can see that the pattern is over-matching. If short matches are genuinely secret, set `minLength` on that entry.

An unreadable or malformed `secrets.yml` also stops startup. A missing file does not: nothing was declared, so there is nothing to protect. The distinction matters because reading a broken file as "no secrets" starts a session that believes it has nothing to hide.

### Per-entry validation is a refusal, not a skip

`validateEntry` refuses. Every branch in it was once `logger.warn` followed by `return false`, which is the failure this subsystem exists to prevent, reached from the inside: the default transport set is `{ file: true }` with no console transport (`logger.ts:219`), so a mistyped `type:` dropped the entry, told nobody, and sent the credential the operator had just declared to the provider in plain text. The handbook promised a refusal while the code warned into a file.

Problems are accumulated and reported together, so an operator with three typos restarts once. The message names the entry index, the field, and the fix. It never quotes the offending `content`: on a plain entry that is the credential, and a malformed declaration is no reason for a secret to appear in an error message.

Unknown fields and fields that do not apply to an entry type are errors. Regex declarations also reject duplicate or incompatible flags, sticky or zero-width matching, and conservatively detected catastrophic-backtracking forms. These checks happen before a session can send provider traffic.

## The vault (`/secret`)

Two stores feed the obfuscator. `secrets.yml` below is declarative and plaintext. The **vault** is imperative and encrypted: entries are added at runtime with `/secret`, are named, and expire.

| Subcommand | Purpose |
| ---------- | ------- |
| `/secret add <name>` | Prompt for the value in a masked field. TUI only; the composer is cleared before the field opens. |
| `/secret add <name> --from-env <VAR>` | Store the value of an environment variable. The credential is never typed. The only form available to a client with no terminal. |
| `/secret add <name> <value>` | Store a value directly. Visible in terminal scrollback, but excluded from persistent editor history. |
| `/secret list` | Names, scopes, lifetimes. Never values, not even a prefix. |
| `/secret rm <name>` | Remove the entry that is currently in effect. |
| `/secret extend <name> --ttl 7d` | Give an entry a fresh lifetime, measured from now. |
| `/secret log [--limit N]` | The expansion log: which placeholder went into which command, when. |

Each option belongs to the subcommands that read it, and `SUBCOMMAND_SHAPES` is the one owner of that mapping:

| Option | Taken by | Values |
| ------ | -------- | ------ |
| `--from-env` | `add` | an environment variable name |
| `--ttl` | `add`, `extend` | `30m`, `12h`, `7d`, `2w`, `never` |
| `--scope` | `add` | `profile` (default), `project`, `global` |
| `--limit` | `log` | a positive whole number |

`SUBCOMMAND_SHAPES` also records how many bare words each subcommand reads: one for `rm` and `extend`, none for `list`, `log` and `help`, and unbounded for `add`. `add` has to be unbounded because everything after the name is rejoined into the credential and a passphrase contains spaces, so a word count there would refuse `/secret add gpg my long pass phrase` as five arguments when it is two.

An option given to a subcommand that does not read it is **refused**, naming the subcommand that does. Previously every option parsed for every verb and each subcommand read only the fields it cared about, so `/secret extend NAME --scope global` reported success and did nothing about the scope, and `/secret rm NAME --scope project` read as "the project copy is gone" when the copy in effect had been removed and the others were untouched. A silent no-op on a command that moves credentials around is the worst place for one.

A bare word the subcommand does not read is refused the same way. `/secret log 50` is the natural way to ask for fifty records, and it used to parse the `50` into `request.name`, which `showLog` never reads: the command printed the default twenty in silence and the operator concluded twenty was all there was. The refusal names `--limit` and echoes the number that was given, because "too many arguments" does not tell somebody what to type instead.

`needsValuePrompt` decides whether a surface prompts, and it lives in the pure command layer so the TUI and text/ACP paths cannot disagree about when a masked field is warranted. A surface that cannot mask must not substitute an unmasked prompt: absent `promptForValue`, `runSecretCommand` refuses the add and names `--from-env`.

### Masked entry

`Input.mask` on the shared TUI component is the single place a value becomes something a terminal can show, so masking is one projection applied in `render` rather than a second text field. `maskValue` emits one mask character per **grapheme** and maps the cursor to the grapheme count before it, so an astral character or a combining sequence counts once. `getValue` still returns what was typed: masking the buffer itself would store a row of bullets as the credential.

The masked prompt is `showHookInput`, which is local only. Unlike the selector and editor dialogs it is never raced against a collab guest, so a masked field cannot be answered from another machine.

`request.maskedEntry` records that a value came from the field rather than the command line, and only the confirmation text depends on it. A scrollback warning that fires when it does not apply is one an operator learns to skip, including on the inline path where it is true.

### Named and unnamed placeholders

A vault entry's placeholder is its name, so the model sees `#GITHUB_TOKEN#`. That is what lets it choose between several credentials deliberately, and it makes the placeholder stable across sessions.

Names are 5 to 64 characters of `A-Z`, `0-9` and `_`, starting with a letter. Unnamed HMAC placeholders start with the reserved digit `0`, so a name can never collide with one. `normaliseSecretName` accepts what people type (`github-token`, `github token`, lowercase) and uppercases it. It rejects non-ASCII input before uppercasing, so Unicode case expansion cannot alias an existing name.

Entries without a name get a generated name (`SECRET_1`), so every vault entry has a placeholder the model can reference. Plain environment and `secrets.yml` values use the machine-keyed unnamed form.

### Storage

| Scope | Path |
| ----- | ---- |
| `global` | `~/.veyyon/vault.json` |
| `profile` (default) | `<agent dir>/vault.json` |
| `project` | `<cwd>/.veyyon/vault.json` |

Narrowest scope wins a name clash. `rm` and `extend` walk scopes narrowest-first, so they act on the entry `list` shows.

Encryption is AES-256-GCM with a fresh 12 byte nonce and a full 16 byte authentication tag per write. The key is 32 random bytes at `~/.veyyon/vault.key`, created on first use and never stored inside a project tree. On POSIX, the key is mode 0600 and its directory must be owned by you and not writable by another user. On Windows, Veyyon applies and verifies a protected owner-only ACL.

Vault updates use a synchronized owner-only temporary file. Kernel no-replace and exchange operations publish the synced inode without overwriting a destination that appeared after the last check. Each transaction keeps the scope directory open and performs file I/O through that descriptor. Replacing the lexical directory during a transaction therefore causes a hard error instead of redirecting the read or write.

Read and write paths reject symlinks, hard links, directories, devices, insecure permissions, and other non-regular files. Scope checks resolve real parent directories. The authenticated location includes the semantic scope, canonical path, and physical scope-directory identity. Copying or backing up `vault.json` preserves confidentiality, but the ciphertext is not a portable restore artifact. Recreate entries with `/secret add` after moving or recreating the scope directory.

The sealed descriptor is limited to 8 MiB before allocation. Writes also enforce a 6,291,402-byte encoded plaintext limit before JSON serialization, encryption, or Base64 expansion.

Failure behavior is fail-closed:

| Condition | Behavior |
| --------- | -------- |
| No vault file | Empty. Nothing was stored. |
| Vault present, key missing | Hard error. Never read as an empty vault. |
| Key of wrong length | Hard error, so a new key is not written beside a recoverable one. |
| Unsafe key directory, key file, or vault permissions | Hard error naming the permission fix. POSIX ownership and modes and Windows owner-only ACLs are checked. |
| Symlink, hard-linked file, or non-regular key/vault path | Hard error. The path is never followed or shared. |
| Ciphertext, nonce, authentication tag, scope, canonical path, or physical scope identity modified | Hard error. GCM authenticates the complete envelope and its location. |
| Legacy version 1 envelope | Hard error directing the operator to re-add the entry in the bound current format. |
| Unknown envelope version | Hard error advising an upgrade rather than deletion. |
| Entry name or value contains ill-formed UTF-16 | Hard error before a write, or after authenticated decryption during a read. Existing ciphertext is left unchanged. |

### Lifetimes

`secrets.defaultTtl` sets the default (`1d`). An absent setting uses the built-in default; a setting that does not parse is an error rather than a silent fallback.

Expiry has two ordered effects. At use time, the live obfuscator revokes placeholder expansion and installs a forward-only HMAC tombstone for the old raw value. This prevents a transcript containing that value from becoming provider-visible. The hot path performs no vault I/O, so the encrypted entry remains on disk until the next successful vault refresh prunes it.

Expiry is enforced at use time as well as at load:

- The check sits on `deobfuscate`, `hasNamedSecret` and `knowsPlaceholder`, so no path reaches a value without passing it.
- `#nextExpiryAt` caches the soonest deadline, so the hot path is one number comparison and the map is scanned only when a deadline is crossed.
- A lapse calls `onExpiry` with explicit persisted-deletion state. `sdk.ts` renders an operator notice that says expansion was revoked and, until a vault refresh succeeds, that encrypted ciphertext remains.
- A successful vault refresh prunes expired entries before rebuilding the runtime.
- `addNamedSecret` takes the deadline, so `/secret extend` moves the moment substitution stops.
- `#forgetPlaceholder` is the one owner of revoking reverse mappings and installing forward redaction tombstones.

`WARN_AT_FRACTIONS` (`[0.5, 0.9]`) is the single owner of when a warning fires, as fractions rather than absolute times so one rule serves `1d` and `90d` alike. `expiryWarnings` consults `warningThresholdCrossed` rather than doing its own comparison: it previously held an inline `0.9`, which meant two owners disagreeing and a halfway warning that could not fire. The wording reads the urgent threshold off the end of the list for the same reason, so adding a `0.99` would not leave a secret with minutes left described as "over halfway through its lifetime". Warnings are raised at session startup through `OperatorNotices`, and the channel collapses repeats so a long-running session is told once. Each line names the `/secret extend` command that prevents the loss, since expiry is not recoverable after the fact.

### The expansion log

`secrets.auditLog` (default on) records each tool call that mentioned a secret, one JSON object per line, to `<profile dir>/secret-audit.jsonl`.

| Field | Meaning |
| ----- | ------- |
| `at` | Epoch milliseconds at expansion. |
| `secrets` | Placeholders substituted, in order of appearance, deduplicated. |
| `tool` | Tool that received them. |
| `session` | Session id. Omitted when the session has none yet. `/secret log` says how many distinct sessions the shown records came from, since the log is per-profile and two windows append to one file. |
| `command` | The arguments as the model produced them, JSON-encoded. |
| `truncated` | `true` when `command` was cut to fit the byte cap. |
| `omittedSecrets` | Number of additional placeholder references omitted to keep the encoded record under the byte cap. |

Written from the arguments **before** substitution, which is the form in which every secret is still a placeholder. That ordering is the safety property: there is no redaction step to get wrong and no way for a value to reach the file. `buildExpansionRecord` receives the pre-expansion arguments and nothing else.

`MAX_RECORD_BYTES` (2048) is a security and concurrency boundary. Every field and placeholder list is bounded before encoding. Placeholder discovery walks JSON string values and object keys in the same order as expansion. A cross-process file lock covers the size check, atomic rotation rename, append, and generation reads, so two sessions cannot overwrite a rotated generation or push a record past the cap.

Failure behaviour differs from the vault's, deliberately. Obfuscation is the preventive control and it fails closed; the log is a detective control, so a failed append raises an operator notice and the command still runs. Refusing to execute a tool because a log file could not be written turns a full disk into an agent outage while nothing is actually unsafe. What is not permitted is silence: a log that stopped recording must not look like a log with nothing to record.

The log lives in the profile directory, never the project one, and is written 0600. It names which credentials exist and when they are used, which is reconnaissance even without values.

Three properties keep the reader honest:

- **Rotation.** `ROTATE_AT_BYTES` (2 MiB, about ten thousand uses) atomically moves the file to `secret-audit.jsonl.1` and starts a fresh one, keeping two generations. The same cross-process lock covers both sessions that race at the boundary. `read` spans both generations, so `--limit 20` immediately after a rotation still answers with twenty records.
- **Full validation on the way back in.** A parsed line is accepted only when every field the renderer reads has the right type. The check was `typeof at === "number" && Array.isArray(secrets)` followed by a cast, so a line missing `tool` printed `undefined` in the middle of a security report. Anything that fails is counted as malformed and the count is shown, never dropped. Terminal control characters in records, paths, and notices are escaped before display. Hard-linked generations are refused, and the 2 MiB generation limit is checked before allocating a read buffer.
- **Flushed on dispose.** Appends are queued so a tool call is never blocked by a write, which means an exit that does not drain the queue loses records silently. `session.dispose` awaits `flush()`, because quitting ends the process rather than waiting for pending work, and the last credential used is exactly the one an incident asks about.

### Operator notices

`OperatorNotices` (`session/operator-notices.ts`) is the one channel for a non-fatal problem the operator must see. It exists because there was none: `logger.warn` writes to a file with no console transport, and `AgentSession.skillWarnings` was a getter that production code never read, so skill-loading problems were discarded silently while the field looked like a surface. Both now route here.

Notices buffer until a sink attaches, because they are raised while a session is being built and the TUI does not exist yet. Interactive mode passes a sink-less collector to `createSession` and attaches its own after the first render; every other mode uses the default, which writes to stderr as notices arrive. A caller that attaches nothing gets its notices in the wrong place, never dropped.

Identical notices collapse on `severity + source + text`, keeping the first timestamp. A problem detected once per turn would otherwise train the operator to ignore the channel, which ends in the same silence by another route.

## Env keyword list

`secrets/env-keywords.ts` owns the keyword list and the boundary rule; nothing else matches an environment variable name. The list was an inline regex in `secrets/index.ts` and is Tier B data now, so an operator can extend it without editing source.

The boundary rule is `(?:<keyword>)(?:_|$)`, case-insensitive: a keyword matches only where it ends the name or is followed by an underscore.

| Candidate | Decision | Reason |
| --------- | -------- | ------ |
| `PASSPHRASE` | **added** | The one genuine gap. `GPG_PASSPHRASE` matched only because of the underscore; a bare `PASSPHRASE` matched nothing, because `PASS` is followed by `P`. No common non-secret variable is named `*PASSPHRASE`, so there is no false positive traded away. |
| `APIKEY` | no entry needed | `KEY` at the end of a name already matches it. |
| `PRIVKEY` | no entry needed | Same. |
| `SECRETKEY` | no entry needed | Same. |
| `PWD` | **refused** | The POSIX current-working-directory variable, present in every shell, with a value that is almost always over the length floor. Detecting it would replace the working directory with a placeholder in every message mentioning a path: text corruption, not protection. `OLDPWD` is the same. |

Three of the five filed candidates turned out to be already covered, which is why the list stays short: the trailing-position half of the boundary rule does most of the work.

User files ADD ONLY. A project file that could remove `TOKEN` would let a cloned repository turn off protection for whoever opens it, which is the wrong direction for a detection list to be configurable in. A missing file is empty; an unreadable or malformed one throws, the same asymmetry `secrets.yml` uses. `buildEnvSecretPattern([])` matches NOTHING rather than emitting an empty alternation that would match every name, and every keyword is regex-escaped because a user file is arbitrary text.

## secrets.yml

Define custom secret entries in YAML. Two locations are checked:

| Level   | Path                                              | Purpose                     |
| ------- | ------------------------------------------------- | --------------------------- |
| Profile | `~/.veyyon/profiles/default/agent/secrets.yml` (active agent dir) | Profile-wide secrets |
| Project | `<cwd>/.veyyon/secrets.yml`                       | Project-specific secrets    |

Project entries override profile entries with matching `content`. The profile level is called `profile` here and everywhere else the agent directory appears, including the vault's scope table above. It was labelled "Global" in this table alone, which read as `~/.veyyon` and is a different directory.

### Schema

Each entry in the array has these fields:

| Field         | Type                         | Required | Description                                       |
| ------------- | ---------------------------- | -------- | ------------------------------------------------- |
| `type`        | `"plain"` or `"regex"`       | Yes      | Match strategy                                    |
| `content`     | string                       | Yes      | The secret value (plain) or regex pattern (regex) |
| `mode`        | `"obfuscate"` or `"replace"` | No       | Default: `"obfuscate"`                            |
| `replacement` | string                       | No       | Custom replacement (replace mode only)            |
| `flags`       | string                       | No       | Regex flags (regex type only)                     |
| `minLength`   | positive integer             | No       | Shortest match this pattern will obfuscate. Regex entries only; default 8 |

### Examples

#### Plain secrets

```yaml
# Obfuscate a specific API key (default mode)
- type: plain
  content: sk-proj-abc123def456

# Replace a database password with a fixed string
- type: plain
  content: hunter2
  mode: replace
  replacement: "********"
```

Generated `replace` aliases use counter-mode HMAC with the machine placeholder key. A custom replacement that looks like `#NAME#` or a machine-keyed placeholder is refused, so one-way output cannot be reinterpreted as a live credential. Emitted placeholders are protected spans: later literal or regex rules cannot scan inside and corrupt them.

#### Regex secrets

```yaml
# Obfuscate any AWS-style key
- type: regex
  content: "AKIA[0-9A-Z]{16}"

# Case-insensitive match with explicit flags
- type: regex
  content: "api[_-]?key\\s*=\\s*\\w+"
  flags: "i"

# Regex literal syntax (pattern and flags in one string)
- type: regex
  content: "/bearer\\s+[a-zA-Z0-9._~+\\/=-]+/i"

# A six-digit one-time code is shorter than the default floor, so say so
- type: regex
  content: "\\b[0-9]{6}\\b"
  minLength: 6
```

Regex entries always scan globally (the `g` flag is enforced automatically). The regex literal syntax `/pattern/flags` is supported as an alternative to separate `content` + `flags` fields. Escaped slashes within the pattern (`\\/`) are handled correctly.

Alternations whose branches can consume concatenated prefixes are refused along with nested ambiguous quantifiers. This prevents exponential backtracking even when the ambiguity is spread across alternatives.

Only standard, bounded global matching is accepted. The sticky `y` flag and expressions that can match an empty string are refused because their scan semantics can skip text or make no progress. Nested ambiguous quantifiers and related catastrophic-backtracking forms are refused before compilation. Regex replacement rewrites exact match spans rather than every equal substring elsewhere in the message.

#### Replace mode with regex

```yaml
# One-way replace connection strings (not reversible)
- type: regex
  content: "postgres://[^\\s]+"
  mode: replace
  replacement: "postgres://***"
```

## Interaction with env var detection

Environment variables are collected first, then file-defined entries are appended. File entries can cover secrets that do not live in environment variables, such as values in local configuration. Equal plain values converge on the same machine-keyed placeholder, so their provider representation is independent of declaration order.

## Key files

- `packages/coding-agent/src/secrets/audit.ts` -- the expansion log: record shape, atomic-append cap, reader
- `packages/coding-agent/src/secrets/env-keywords.ts` + `env-keywords.yml` -- the Tier B keyword list and the boundary rule, one owner
- `packages/coding-agent/src/secrets/index.ts` -- loading, merging, env var collection, refusal of unprotectable entries
- `packages/coding-agent/src/secrets/obfuscator.ts` -- `SecretObfuscator`, message obfuscation, runtime add/forget
- `packages/coding-agent/src/secrets/placeholder.ts` -- both placeholder forms and the rule keeping them apart
- `packages/coding-agent/src/secrets/policy.ts` -- the length rules and the rejection type, defined once
- `packages/coding-agent/src/secrets/regex.ts` -- regex literal parsing and compilation
- `packages/coding-agent/src/secrets/secret-command.ts` -- `/secret` logic, pure and session-free
- `packages/coding-agent/src/secrets/vault.ts` -- entries, lifetimes, scopes, the store
- `packages/coding-agent/src/secrets/vault-crypto.ts` -- the key, the seal, and the threat model
- `packages/coding-agent/src/slash-commands/helpers/secret.ts` -- the session-bound adapter shared by the TUI and text/ACP paths
- `packages/coding-agent/src/session/operator-notices.ts` -- the one channel for a warning that must reach a person
- `packages/tui/src/components/input.ts` -- `Input.mask` and `maskValue`, the one place a value becomes visible text
- `packages/coding-agent/src/config/settings-domains/providers.ts` -- the three settings: `secrets.enabled`, `secrets.defaultTtl`, `secrets.auditLog`

## See also

- [`auth-broker-gateway.md`](./internal/auth-broker-gateway.md) -- remote credential vault and forward-proxy that keep provider OAuth refresh tokens and access tokens off developer hosts entirely (complementary to in-process obfuscation).
