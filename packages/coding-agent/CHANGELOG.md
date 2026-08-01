# Changelog

## [Unreleased]

### Added

- Expanded `session.instrumentation` into a complete session-study record. `basic` adds lifecycle checkpoints, task transitions, tool and model timing, and effective model request parameters; `rich` adds context attribution, directional agent-message delivery, result weight, and model throughput; `ultra` adds compaction links, per-task transitions, routes, fingerprints, and provider provenance. `veyyon session stats` reports each available family. `off` adds no telemetry but still stores the normal conversation and tool history required to resume.
- First-run setup now includes a **Choose subagents** step. Only the general `task`
  worker starts enabled; bundled specialists and user or project agent definitions
  require an explicit grant there or in **Settings → Subagents → Agents**. Delegation
  guidance now preserves each concrete agent role, uses `task` only as the
  general-purpose fallback, keeps unmatched specialist work in the main session,
  and collapses homogeneous triage fan-outs into one retrieval and classification operation.
  The classifier uses the shared Unicode alphanumeric matcher, so non-ASCII labels follow the
  same token boundaries as the rest of the CLI.

- Auto QA can upload grievances to `https://veyyon.dev/api/grievances`, where a Cloudflare Pages
  Function validates the batch and stores it in D1. Upload is controlled by
  **Auto-upload Grievances** in each profile and defaults to off. Local recording remains separate,
  and `veyyon grievances push` performs one explicit upload without changing the toggle.
- The Subagents HUD, the `/agents` roster, and the inline task widget now show the reasoning effort each agent is actually running at, including an effort it inherited. Previously the effort appeared only when a `:level` suffix had been typed into the model pattern, so every stock agent rendered as a bare model id and two agents running at different efforts looked identical.
- `/secret rm` and `/secret extend` complete the names of the credentials you have stored, so you no
  longer have to recall an exact name with nothing on screen to recognise it by. That is a worse
  position than any other command's arguments put you in, because the whole point of a stored secret
  is that its value is never displayed, and a mistyped name is a silent no-op rather than something
  the surface can correct: `/secret list` was the only way to recover a name. The names come from the
  running obfuscator rather than the vault on disk, because the vault means file I/O plus a decrypt on
  every keystroke and `load()` throws on a malformed or key-missing vault, which would turn a bad
  vault into a dropdown that crashes as you type. `extend` completes to `extend NAME ` with the cursor
  ready for `--ttl` while `rm` completes to a finished command, read off each subcommand's declared
  usage rather than naming `extend` a second time in the completion code. `add` is deliberately left
  out, since the name you give it is one you are inventing and offering existing names there would
  read as a list of things to overwrite. No secret VALUE reaches the dropdown in any field.
- The model is told which credentials it can spend, in an `AVAILABLE SECRETS` section rebuilt from the
  live secret runtime every time the base system prompt is built. Storing a secret told the model
  about it in that turn and only that turn, so a session started the next day had `GITHUB_TOKEN`
  active and obfuscating while the model had no way to know it existed. Rebuilding from the runtime
  rather than remembering from the conversation also fixes revocation and expiry structurally: a name
  the runtime stops returning simply stops being rendered. Names only, sorted so the bytes are stable
  for prompt caching, and the section is absent rather than empty when protection is off or nothing is
  stored.
- Both installers answer `--help` (`-Help` on Windows) with their option list. `sh install.sh --help` used to print `Unknown option: --help` and exit 1, and an unknown option printed the complaint and nothing else. The options were documented in a comment at the top of each script, which is precisely what an install run as `curl … | sh` or `irm … | iex` never shows anyone: there was no way to discover `--source`, `--ref`, `--local` or `VEYYON_INSTALL_DIR` short of opening the raw file on GitHub. Each script now has one usage printer, its header points at that printer rather than carrying a second list to go stale, and an unknown option prints the list on stderr alongside the complaint. `scripts/installer-help-parity.test.ts` runs the POSIX one for real and pins that both installers offer the same six options under their two spellings.
- `argot.autoload` decides whether the project you launched in is loaded for the session, or every
  load is left to the agent's `argot_load` calls. The startup load already existed and was
  unconditional, and the handbook described the opposite behaviour ("veyyon does not guess which
  project you mean: the agent decides"), so an operator could not predict whether their repository
  would be walked as the session came up, and had no way to say no. The default is `true`, which is
  the behaviour that shipped. The decision has one owner, `shouldAutoloadArgotAtStartup`, rather than
  the conditions spelled out inline at the SDK's call site, so a second startup path cannot honour
  the setting on one route and ignore it on another. It changes WHEN a dictionary is built and
  nothing else: the codec is still built, the model still gets `argot_load` and `argot_unload`, and
  expansion stays unconditional, so a handle written after an agent-driven load still expands to
  exact bytes.
- `veyyon prompt --statements` prints what each individual rule of the system prompt costs, with the
  condition that decides whether it is in this prompt at all, and lists every rule this configuration
  leaves out. The section breakdown could not answer the question an operator actually has: TOOL
  POLICY is one row of it and 9KB of prompt, so the answer was "tool policy is large". The cost is
  MARGINAL, meaning what the prompt would be shorter by without the rule rather than the length of the
  rule's text, because `render` ends in a `format` pass that normalizes whitespace across statement
  boundaries and text lengths would therefore produce a breakdown whose parts exceed the whole. The
  parts reconcile exactly instead: section bytes equal the banner plus the sum of the statement bytes
  plus the one separator newline, measured and pinned rather than argued.
- `veyyon prompt --statement <id>` prints one rule's rendered text, which is the counterpart to
  `--section` at the granularity a rule has and the next thing anyone wants after seeing a row in the
  cost table they do not recognise. Rendered rather than the template behind it, so an interpolated rule
  such as the personality block shows what the model receives. A rule that is not in this prompt reports
  the condition that would include it and why it exists, and still exits 0, because a rule being off is
  a configuration and not a failure; an unknown id exits non-zero and quotes the ids of the section it
  named, since an empty stdout reads as an empty rule rather than as a typo. The printed text weighs
  exactly what `--statements` charges the rule, asserted, so the two surfaces cannot disagree about the
  same rule.
- The bench can run a per-rule prompt experiment. `VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS` had no arm
  vehicle when it landed, so the mechanism built for the harness could not be used by it: an operator
  would have had to set the variable outside the runner, where the single-IV guard cannot see it and two
  different ablation arms fingerprint identically. An arm now carries `arms/<arm>.statements.yml`,
  validated before the run (unknown statement id, a value that is neither text nor `null`, malformed
  YAML), staged as `statements/<arm>.json`, folded into the arm fingerprint, and mounted into the
  container the same scoped way the section override is. `arms/candidate-ablate-delegation-gates.*` is
  the worked example, checked through the builder's own validator so it is known to load.

  The fingerprint folds the new field in only when it says something, so arms without one keep the
  fingerprints already recorded in past results and a longitudinal diff does not report every arm as
  changed; an EMPTY override canonicalizes to `{}` and counts as absent, so an arm cannot pass the
  single-IV guard by carrying an empty file.
- `VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS` replaces or removes ONE rule of the system prompt, which is
  what makes an eval able to attribute a score change to a rule instead of to a section. A JSON object
  of statement id to replacement text, or to `null` to ablate the rule. Same instrument as the
  per-section override, one level finer, and deliberately the same shape: environment variable only,
  no config key and no CLI flag, because a config-reachable prompt override could silently contaminate
  a production run and a contaminated eval reports a number that looks valid. `null` and `""` are
  different operations and both are pinned: `null` removes the row and the separation it carries, `""`
  keeps the row present and drops only its words. Every way an override could do nothing is refused
  loudly rather than ignored, including an unknown statement id, a value that is neither text nor
  `null`, and malformed JSON. An override cannot resurrect a rule whose condition is false, since the
  condition decides presence and the override decides text.
- `system-prompt-builder/gate-registry.ts` lists every setting that changes the system prompt:
  the setting path, the template variables it decides, what the model sees change, and whether a
  mid-session flip reaches it. A settings-fed gate used to be declared in up to six places that
  had to agree, and the one that failed quietly was the rebuild trigger. Frozen gates now say
  why they are frozen, and the two reasons are kept apart, because "fixed at session start on
  purpose" and "fixed because the read sits above the builder" call for different fixes.
- Every package that ships prompts now has a prompt registry, and `veyyon prompt --prompts` lists all of them. Two packages had none: `@veyyon/ai` shipped fourteen prompts (a tool-call format guide per dialect, plus the tool-catalog template) next to the fourteen modules that imported them by relative path, and `@veyyon/metaharness` shipped the edit benchmark's three. That text goes into a model's system prompt, so "which prompts does veyyon send" had an answer that was short by seventeen, and the inspection command listed none of them. Prompts moved to `packages/ai/src/prompts/` and `packages/metaharness/adapters/edit/prompts/`, each with a registry beside them where the import is the registration. `veyyon prompt --prompts` now lists every id from all three product registries grouped by directory, and `veyyon prompt --prompt <id>` looks a prompt up in whichever one holds it, so `dialect/gemma` and `compaction/summarization-system` work like any coding-agent id. The benchmark harness's prompts stay out of the listing: they are asked by a measurement tool, not by the agent.
- The auto-compaction threshold is now a two-level picker in `/settings`: **Auto-Compaction Threshold** opens to three modes (Auto, Percent, Tokens) with a green check and the current amount on the active one, and each mode drills into its own presets plus a Custom entry. The flat list it replaces mixed all 19 auto/percent/token options in one list, so the three semantics were invisible until you read every description, and a hand-edited value like `170000` showed as nothing selected. Custom values are validated and normalized on entry (`92` stores as `92%`, `170_000` as `170000`), and a stored value the parser cannot read is shown as a warning with Auto in effect instead of presenting Auto as your choice. The stored value is unchanged (`auto`, `85%`, `200000`), so existing configs, the legacy `thresholdTokens`/`thresholdPercent` fold-in, and the clamp warnings all keep working.
- Added an **Experimental** settings tab: every experimental feature now lives in one place — Argot shorthand (five settings, moved from the Context tab's Experimental group), Tool Calling Mode, and Auto-Learn (moved from the Memory tab). The tab's name says "experimental" for everything on it, so labels no longer need an "(experimental)" suffix and the features stop pretending to be regular settings on three different tabs.
- `update`: confirm 'Checksum verified' on a successful self-update.
- `release`: derive commit-history notes + gate the generator on CI.

### Fixed
- The Agent Control Center is centred in the terminal, like every other modal in the TUI, instead of sitting flush against the top of the screen. The card was laid out against its own height rather than the viewport, so the shell had no room to centre it in and the panel hung from the top edge over an otherwise empty screen. It also hugs its content now: a one-agent roster draws a short card rather than framing rows of bordered nothing, keeping a four-row floor so the first spawns do not resize the panel while you read it.
- Clicking the row-local `[x]` in the Agent Control Center roster terminates that agent again. The hit test placed the card's body one column right of where it is drawn, because it added the modal's horizontal padding while the frame insets every body line by exactly one column regardless of that padding. The target sat one column past the `[x]` the pointer was over, so the click fell through to opening the agent on any card whose padding was not the compact variant. The roster now reports the width it actually drew at instead of the hit test re-deriving it.
- The Agent Control Center now confirms subagent termination instead of aborting immediately on `x`. You can also hover a terminable row and click its `[x]`; both paths open the same **Dismiss** or **Yes, terminate** card, and the transcript remains on disk.
- Subagents whose model and effort are left at **Inherit** now receive the parent session's configured effort through a dedicated runtime channel. Previously the inherited model selector omitted effort by design, so child initialization fell back to the saved global default and could run at `auto` even when the parent session had selected another level. Per-agent, blanket, frontmatter, and explicit model-suffix overrides still win.
- The Linux, macOS, and Windows installers now record ownership receipts for binaries and completion files. Reinstall and uninstall preserve unrelated files at those paths, while exact legacy Veyyon launchers and generated completions migrate without manual cleanup. Source installs also verify the checkout's `origin` before updating or deleting it, so an unrelated pristine repository is moved aside rather than reset or removed.
- Source self-update now requires a clean tracked checkout and records the current Git revision before fast-forwarding. If dependency installation, generated-artifact regeneration, native provisioning, version verification, or the runtime probe fails after the merge, Veyyon restores the previous revision and its runnable artifacts before reporting the failed update.
- The release train now waits until the public `releases/latest` redirect resolves to the exact release tag, verifies the installed version against that tag, and runs the production installer round trip on Linux x64, Linux arm64, macOS x64, macOS arm64, and Windows x64 before reporting success.
- Tool calls now refuse an expired or removed secret placeholder before execution and name only the retired placeholder in the error. Turning protection off also retires every name advertised by the running process while preserving stable redaction output. Retired names cross secret-runtime refreshes, a replacement stored under the same name clears the refusal, and ordinary text such as `#TODO#` remains untouched.
- The Windows installer now accepts a healthy release binary that writes a native-variant warning
  to stderr while its search self-test succeeds. Windows PowerShell 5.1 promoted that warning to a
  terminating `NativeCommandError`, so a bytecode-free Windows build passed `--version` and
  `--smoke-test` but was rejected before installation. Exit status and the expected search match now
  decide the preflight while stderr remains available when the command actually fails.
- Provider payload confidentiality failures now identify a safe structural cause such as a cycle,
  non-JSON value, size bound, accessor, or protected-key collision. The request still fails before
  network I/O, and neither the payload, key names, secret values, placeholders, nor transform
  exception text reaches the operator message.
- Concurrent explicit binary updates now use unique same-directory staging and rollback files, then
  serialize the installed-path mutation. One failed update can no longer truncate or delete another
  update's live download, and stale cleanup cannot sweep an active rollback copy.
- Task spawn-policy and self-recursion refusals now return explicit error results. A requested
  background task also fails loud when no async job manager exists instead of silently running
  synchronously and changing the parent turn's blocking behavior.
- `install.sh --uninstall` now preserves a user-managed executable at the legacy
  `~/.bun/bin/veyyon` path. It removes only the exact Bun-global Veyyon package symlink that older
  installs created, while canonical binaries, aliases, completions, and installer-owned PATH entries
  retain their existing cleanup behavior.
- Session listing now reports a failure to enumerate recovery backups instead of silently continuing
  with primary files only. A backup remains intact and visible in the unreadable-session report until
  the directory or storage backend can be read again.
- Session-backed Python, Ruby, and Julia eval now replace an interpreter that exits unexpectedly
  mid-cell and replay the cell once. Unexpected process exits were classified as user cancellation,
  which bypassed the existing dead-kernel recovery path. Timeouts and explicit cancellation still
  stop without replaying the cell.
- A cold Julia eval now gets 60 seconds to compile each kernel startup phase instead of 15 seconds.
  Clean hosted runners exceeded 30 seconds before the first cell could run, which surfaced as a cell
  timeout even though the user's code had not started. Warm kernels still return immediately.
- Tool status headers no longer gain a blank leading cell when the active symbol preset intentionally
  leaves that tool's glyph empty. Empty symbols now produce no ANSI wrapper, so IRC inbox headers and
  other iconless tool rows begin at the same column as their title.
- With `tools.discoveryMode=all`, `generate_image` starts in the searchable tool inventory instead of
  sending its schema on every provider request. Explicit tool whitelists still keep it active, and
  selecting it through tool discovery persists activation for subsequent turns.

- Subagents no longer embed their launch-specific id and a live peer roster in the system prompt.
  Agents discover the current roster through `irc list` only when coordination needs it. Sibling
  launches now share the same cacheable system-prompt prefix instead of invalidating it whenever an
  agent id, activity, or peer status changes.

- A credential passed with `=` no longer reaches editor history or the on-disk draft. The predicate
  that decides whether a submitted slash command may be recalled and resumed tested for `--token`
  followed by whitespace or end of line, so `--token=sk-live-...` never matched: one keystroke
  decided whether a live bearer token was written to durable storage and offered back on arrow-up.
  Measured before the fix, `/mcp add srv --url https://example.com --token=sk-live-SECRET123` reached
  `<artifacts>/draft.txt` verbatim. The classifier now recognises twenty-four credential option names
  in the space, `=`, quoted and bare-trailing spellings, the short `-t` and `-H`, and credential
  material sitting in no option at all: URL userinfo, and a query parameter whose name looks like a
  secret using the same pattern the logger already applies to MCP URLs. It scans the arguments of
  every command rather than an allowlist of command-and-verb pairs, so a credential passed to a
  command nobody thought of is still caught. `--url` is judged on its content rather than its name,
  which keeps an ordinary `/mcp add srv --url http://x` recallable.
- `/mcp add` with no arguments answered with a single 174-character line, the widest usage string in
  the product, which at 80 columns broke `[-- <command...>]` across lines and left a dangling `[--`
  that reads as a broken flag. It also restated the usage as a second literal, free to drift from the
  one the command already owned.
- Tool approval prompts now use a structured permission card that separates the one-call scope,
  approval reason, and requested action. Approve and deny choices include explicit descriptions,
  radio focus, and complete navigation help instead of presenting one flat accent-colored text block.
- `config list` is laid out for the terminal it prints on. It emitted one unwrapped
  `key = value (type)` line per setting, so at 80 columns fifteen lines ran past the edge and
  `bashInterceptor.patterns` was a single 2355-character line; the terminal re-broke each of them
  wherever it liked with no indent, which put the tail of a value at column 0 where it read as
  another setting. The listing now goes through the same width-aware `renderHelpTable` /
  `renderHelpParagraph` primitives as `--help`, so values wrap into a column and continuation lines
  stay indented under their key. Long values WRAP rather than truncate: `config list` is the command
  an operator runs to read what a setting is actually set to, so an ellipsis would hide the part they
  came to check, and trimming and rejoining the continuation lines reproduces the stored value byte
  for byte. A value that opens with a token too long to share its key's line (a 2.3kB JSON blob) gets
  its own indented block instead of being jammed into the value column and overflowing anyway. What
  still exceeds the width is only what has nowhere to break, an unbroken enum spelling or a regex
  with no spaces in it, each on a line of its own.
- A value-taking flag with no value is refused instead of silently dropped. `--model`,
  `--approval-mode`, `--thinking`, `--system-prompt` and every other string-valued flag fell through
  the parse loop when they sat in the last argv position, so `veyyon -p "..." --approval-mode` exited
  0, answered normally, and ran on the DEFAULT approval mode. Nothing was printed. There is no
  misspelling to notice in that command, so the only evidence the operator had that a safety-relevant
  flag took effect was that they had typed it, and the same hole could quietly run a session on the
  wrong model. The refusal names the flag and both accepted spellings. The one case still skipped
  rather than refused is the profile bootstrap's internal boundary marker, where refusing would
  discard the message the user is waiting on to report a flag they did not really leave empty.
- An unrecognized flag suggests the flag you meant. `veyyon --modle=x` answered "unknown flag:
  --modle" and stopped there, leaving the reader to diff their typo against a list of fifty-seven
  flags, while a misspelled SUBCOMMAND one keystroke away already answered "Did you mean `veyyon
  config`?". Suggestions come from the parser's own flag tables, so a name it offers is always a name
  it accepts; nothing close enough produces no guess rather than a wrong one.
- An interactive launch with no terminal exits 2 rather than 1. `cli/exit-codes.ts` names this case
  verbatim in its description of the usage code, so the documented contract and the code disagreed,
  and the visible symptom was one mistake split down the middle: `veyyon confg` exited 2 while
  `veyyon confg get foo` reached the no-TTY guard and exited 1. A wrapping script branching on the
  code to decide whether retrying could help got opposite answers for the same typo.
- Seven settings rows no longer sit on the settings screen offering a choice that changes nothing.
  `Speech Vocalization Mode`, `Enhanced Speech Rewriting` and `Speech Vocalization Voice` render while
  `Speech Vocalization` is off; `Speech Model` and `Speech-to-Text Submit Trigger` while
  `Speech-to-Text` is off; `Auto-Background After` and `Stall After` while `Bash Auto-Background` and
  `Bash Stall Detection` are off. All four master toggles ship off, and every read of the dependent
  values is behind its master, so with stock settings you could open `/settings`, pick "Final message
  only" or "Stall After: 15 seconds", watch the row take the value, and get no change in behaviour at
  all. That is the same failure as a dead flag and worse than an absent feature, because the screen
  confirms the choice. The two bash values did not even reach the model: the bash tool description
  renders them only inside the `{{#if autoBackgroundEnabled}}` and `{{#if stallDetectionEnabled}}`
  guards.
  This adds no new mechanism. `ui.condition` and the selector's visibility check already existed and
  are what hides 26 of the memory tab's 27 rows behind the chosen memory backend and three Advisor
  rows behind `advisor.enabled`; these seven had simply missed it. Four predicates were added beside
  the existing nine, no default moved, and the rows are unchanged when the feature is on. Row counts
  with stock settings: Interaction 43 to 41, Shell 18 to 16, Providers 36 to 33. `Secret Lifetime` and
  `Record Secret Use` are deliberately left visible while `Hide Secrets` is off, because `/secret add`
  reads both on the pre-enable run that turns protection on.
- A vault that cannot be read no longer stops a session from starting, which had made the command
  that repairs one unreachable on every surface except the full-screen interface. `/secret discard`
  moves a broken vault file aside, but the vault was read while the session was being assembled, so
  a `-p`, scripted, or ACP run over a project with a corrupt `vault.json` exited 1 before any command
  could be dispatched: `veyyon -p "/secret list"` and `veyyon -p "/secret discard --scope project"`
  both failed with the same message, and that message recommended the command the other run had just
  refused to execute. The only repair was deleting the file by hand, which is exactly the thing the
  encrypted store exists to stop you doing casually. Sessions now start without the vault, and
  `/secret list` reports the failure with the repair instead of throwing.
  This is not a wider `catch`. `load()` still refuses every failure it refused before, because
  skipping a scope that failed a provenance or integrity check would silently turn a tampered vault
  into "that scope has no secrets" and drop its entries out of the obfuscator. The failure is
  absorbed one level up, where the answer is unambiguous, and every scope holding a file is marked
  unreadable rather than empty, so its placeholders are refused rather than sent as literal text and
  the operator is told which file to move aside. The mid-session reload that runs before a live
  `#NAME#` is expanded still fails closed: the loader takes an explicit mode, and only startup asks
  to degrade.
- A project-scope vault can no longer be committed by accident. `/secret add --scope project` writes
  an encrypted credential store to `<project>/.veyyon/vault.json`, which is inside the repository you
  are working in, and nothing kept it out of your commits: a real untracked `vault.json` was found in
  this repo, one `git add -A` from being published. Veyyon now writes `.veyyon/.gitignore` on the way
  to creating a project vault, covering `vault.json` and the `vault.json.unreadable-*` name that
  `/secret discard` renames a broken vault to. Committing one would not expose the credentials, since
  the ciphertext is unusable without the machine key, but it would put a credential store in your
  history that no clone can open, which then breaks `/secret` for whoever cloned it. Only the vault is
  ignored, never the directory: `.veyyon/` also holds skills and project settings a repo is supposed
  to track, and ignoring all of it would read as git losing files. An existing `.veyyon/.gitignore`
  that does not already cover the vault is appended to rather than rewritten, because a vault stored
  before this shipped is exactly the case a create-only guard would miss while saying nothing; your
  own lines are left untouched, and a file that already names the vault is not modified at all.
- `/secret` no longer repeats a word you typed back at you when it refuses a command, because on a
  `/secret` line that word is often the credential. Every verb except `add` echoed it: the realistic
  slip is muscle memory for `add` with a different verb, which is exactly the moment a secret is on the
  line, so `/secret extend TOK sk-live-...`, `/secret rm TOK sk-live-...`, a value appended to a bare
  `/secret list`, and a credential landing where a lifetime or a scope goes all wrote it into an error
  that reaches the scrollback and the saved transcript. The command whose entire purpose is keeping
  credentials off the screen was putting one there permanently, and in the saved session it survived
  the restart. The refusals now name the position that was wrong (`the word after the first`) and say
  why the word is not shown, which carries the same correction without repeating anything. `/secret log
  50` still echoes `50`, since a run of digits cannot be a credential worth protecting and the
  `--limit` hint is useless without it. Fixed at the source in `parseTtl`, so a lifetime typed anywhere
  stops being echoed rather than only on the one path that had noticed. That also let `add` drop a
  per-verb rewrite it only carried to blunt the same echo, which had cost it the distinction between
  "not a lifetime", "expires immediately", and "too large": `add` and `extend` now explain the same bad
  lifetime identically.
- `set_cwd` now explains that `.` in later tool paths and directory headers names the current absolute
  working directory, while `..` names its parent. This prevents the agent from treating a successful
  re-root as an unexpected move and running a second command to rediscover the same directory.
- Subagents whose effort is **Inherit** now receive the parent session's effective effort before
  their session starts. Previously the inherited value became undefined at the executor boundary,
  which let the provider default every child to `auto` even when the parent was running at `medium`.
  Explicit subagent efforts, including an explicit `auto`, still win.
- `/secret add` now makes secret protection survive the process it was turned on in. Storing your
  first credential switches `secrets.enabled` on and says it was "saved for the next one", but the
  write was only queued behind a 100ms debounce and nothing on that path flushed it, so any
  short-lived surface exited before it landed: a `-p` run, an ACP request, any non-interactive
  client. The next launch then came up with protection OFF and the credential already in the vault,
  which is the one state the feature exists to prevent, and the confirmation had promised otherwise.
  Found by driving the real CLI rather than the test suite: `/secret add` reported the save, and the
  very next process reported `secrets.enabled` as `false`. A flush that fails now says so in the
  confirmation instead of overstating what was written.
- `/secret add --from-env` now tells you when the variable is set but empty, instead of claiming it
  "is not set in this process". Unset and set-to-nothing shared one message, so exporting `TOKEN=`
  produced a line that was false for the situation you were in and sent you to re-check an export
  that was already correct. A variable holding only whitespace is refused too, rather than stored as
  a credential that would expand to blank text inside a command. A value that merely carries
  surrounding whitespace is still stored byte for byte, since a real token is allowed to and
  trimming one would corrupt it where nothing could trace the failure back.
- The Linux, macOS, and Windows installers now ask the staged executable for its version before they replace an existing command or change your alias, shell profile, or completions. A checksum-valid asset that reported the wrong release version previously replaced the working binary and failed only in the final doctor check. The mismatch now stops at the staged file and leaves the installed bytes untouched. Interrupted-install cleanup also removes only installer-owned staging names, so a similarly named user file is never mistaken for debris.
- Binary self-update now preserves the old executable under a recovery link or copy and replaces the live path with one atomic rename. A hard kill between the old two renames previously left `veyyon` absent from `PATH`; it now leaves either the complete old binary or the checksum-verified new one. Automatic update state and lock errors return a visible failure instead of rejecting behind the TUI, completion refresh failures appear in the update notification instead of writing raw text through the live frame, single-quoted source wrappers stay source installs, and the rollback picker continues past a full GitHub page even when drafts or prereleases are filtered out. Windows arm64 now reports that no release asset exists instead of requesting a filename the release train never publishes.
- A session holding any stored secret no longer has its tool calls refused because the vault's
  revision moved. The freshness guard asked whether the SESSION held a secret rather than whether
  the CALL carried a placeholder, so a `bash` running `echo "$HOME"` was rejected out of a session
  that happened to hold one credential, and the reload that would have fixed it was started and
  thrown away on the line above the refusal. A stale revision now reloads the vault and the call
  expands against the current values. A refusal survives only where it is real: the text carries a
  placeholder the runtime would substitute, a reload was actually attempted, and it could not
  produce a runtime that resolves it. That refusal now names the reload failure and says to retry
  and check `/secret list`, instead of blaming another session for a reload of its own that failed.
- Enabling secrets on a machine where the vault key cannot be created no longer kills veyyon at
  launch with a bare stack. Key provisioning throws on a key root that cannot be hardened, a
  symlinked or read-only `~/.veyyon`, or anything occupying the key path, and that throw was
  awaited uncaught during session construction, so veyyon died before drawing a frame and nothing
  on screen said why. It still refuses to start, because starting without a key would silently
  switch redaction off after you deliberately turned protection on, but the failure now names the
  key path, what to check, and the one command that starts veyyon without protection if that is
  what you want.
- A vault file that cannot be read no longer lets a placeholder run as literal text, and no longer
  takes the terminal down on launch. A vault that clears every provenance and integrity check but
  whose decrypted contents will not parse is now skipped so you can still reach `/secret` to repair
  it, while a vault that fails any of those checks still refuses to start rather than quietly
  reporting that the scope holds no secrets. Previously the revision fingerprint read file stats and
  never parsed, so nothing downstream noticed a skipped scope: `#TOKEN#` was passed through verbatim
  and the command ran with those seven characters where a credential belonged. While any scope is
  unreadable, a placeholder-shaped token that does not resolve is now refused, naming the unreadable
  file and the repair. Tokens the surviving scopes do resolve still expand, and with every scope
  readable an unknown `#WORD#` is still just text.
- `/secret discard --scope <scope>` moves a broken vault file aside, which is the repair the
  unreadable-vault notice tells you to run. The notice and the operation it names had been
  describing a repair the product could not perform: the method behind it existed and nothing in
  the tree called it, so the only real route was deleting the file by hand. The scope is required
  and has no default, because unlike every other use of `--scope` this one names a file to move
  rather than a place to store something, and defaulting it would move a working vault out from
  under the session. The file is renamed, never deleted, and the new path is reported, because a
  vault that will not parse may still hold recoverable entries sealed with a key you still have.
- A secret matched by a `secrets.yml` pattern no longer stops rendering readable for the rest of the
  session after the vault changes, you move directories, or protection is toggled. Each of those
  refreshes carries previously seen values forward so redaction can never regress, and it carried
  them as redact-only entries; because plain values are substituted before patterns are matched,
  the carried-forward entry replaced the value before its own pattern could match, and the pattern
  is what makes a placeholder reversible. The value stayed hidden, so nothing leaked, but it
  rendered as an opaque `#0...#` token from then on and no later refresh could recover it.
- Secret expansion no longer breaks by itself while veyyon is running. The vault's revision
  fingerprint also stat'd the directories the vault files sit in, which are `~/.veyyon`, the
  profile agent directory, and `<cwd>/.veyyon`, and a directory's timestamps move whenever
  anything at all is created or removed inside it. veyyon's own SQLite journals, session files,
  caches, and even the vault's own lock file therefore made the vault look like another process
  had rewritten it, seconds after a session started and with nothing stored. The fingerprint now
  reads the vault files themselves, and a write this process makes no longer counts as somebody
  else's, so storing a credential with `/secret add` and spending it in the same session works
  instead of reporting that the vault changed underneath you. A genuine write from another
  session or process is still detected.
- A vault that changes under a running session no longer takes the session down with it, and a stored
  credential is no longer painted onto your screen. Rendering the transcript, an assistant message, or
  a tool call ran the same expansion the spend path uses, so a vault written by a second window or a
  rotation script turned the next redraw into a thrown error out of a code path that only ever draws,
  which left the session unable to accept commands. Display paths now expand what they can and render
  the placeholder literally when they cannot, with a notice saying why, and the refresh they schedule
  is awaited on the render paths that can wait. The same seam also stopped restoring values that exist
  precisely so they are never shown: a `secrets.yml` pattern match is still restored on screen, while
  a vault credential and an environment-derived value stay as placeholders in prose, tool arguments,
  intents, and both rendered transcripts, so they no longer reach your terminal or its scrollback.

### Changed

- Subagent nesting now defaults to parent-only spawning. Your main session can still spawn direct
  subagents, but those children do not receive the `task` tool unless you raise
  `subagent.maxNestedSpawnDepth`. You can override the blanket limit for one agent through
  `subagent.agents.<name>.maxNestedSpawnDepth` or the Agents settings editor; `-1` remains unlimited.
  Existing `maxRecursionDepth` values migrate to the equivalent nested-depth policy.
- `tui.scrollIsolation` now defaults to OFF. While it is on, veyyon holds the mouse in order to read
  wheel events, which takes drag-to-select away from your terminal: selecting text becomes shift+drag,
  or `/copy` to pick text and code out of the conversation without the mouse at all. That trade may be
  worth making deliberately, but it was being made for everyone by default, and breaking the most
  ordinary thing a terminal does is an opt-in rather than a default. With it off, the wheel, native
  scrollback, drag-select and copy all belong to your terminal again, and the prompt still sits at the
  bottom of the live view. Turn it back on in `/settings` under Appearance, Display, or with
  `veyyon config set tui.scrollIsolation true`; nothing about its behaviour changed when it is on.
- `/secret list` renders as an aligned table with a header, wide-character-safe column widths, and a
  status column that appears only when something is close to expiring. The near-expiry threshold now
  has one owner shared with the warning sentences, so the marker in the list and the warning below it
  cannot disagree.
- The swallowed-drag hint, the `tui.scrollIsolation` description and the gated tip no longer promise
  that the mouse comes back on its own. A hold that released after a few seconds of quiet was tried
  and removed: it unpinned the composer at unpredictable moments and made whether a plain drag
  selected anything depend on how recently you had typed. The wording outlived the behaviour, which
  is worse than saying nothing, because it sent you off to wait for a handback that never arrives.
  All three now state plainly that veyyon holds the mouse while the setting is on and name the three
  answers that actually work: shift+drag, `/copy`, and turning the setting off.
- The bounded JSON walk moved out of the secret obfuscator into `src/json-transform.ts`.
  `mapJsonStrings` rewrites every string in a JSON value, keys included, and three callers want
  three different rewrites: the obfuscator's placeholders, the argot token dictionary, and whatever
  transform the session applies at the outbound provider seam. Only the first is about secrets, but
  it lived in `secrets/obfuscator.ts`, which reaches 65 modules including an 18-module JSON Schema
  validator (the obfuscator redacts tool schemas). So `provider-boundary.ts` imported one function
  and got all of it, and since every module that can make an outbound request reaches that seam, so
  did they: reading a local file loaded a schema validator. The walk now reaches two modules,
  `provider-boundary.ts` reaches three where it reached 66, and `tools/read.ts` is 24 modules
  lighter. Import it from `@veyyon/coding-agent/json-transform`; the obfuscator re-exports the same
  function, so nothing that already worked stops working.
- `veyyon -p` starts without loading the slash-command handlers. Text and ACP mode dispatch every
  message through `executeAcpBuiltinSlashCommand`, and that function imported the builtin registry
  statically: 740 modules of handlers, and behind them the settings store, the MCP client and the
  session store. Almost every message is a prompt rather than a command, so a plain
  `veyyon -p "hello"` paid for the entire command surface to discover the text had no slash in it.
  The registry loads inside the function now, after the parse has already said the text is a command.
  A command still runs exactly as it did; what changed is when the handlers arrive. Print mode reaches
  227 modules where it reached 960.
- The MCP HTTP transport uses the shared `isRecord` instead of spelling the same three-clause check
  out inline, and `commit/{shared-llm,changelog/generate,analysis/summary}.ts` and
  `secrets/obfuscator.ts` import `completeSimple`, `validateToolCall` and `toolWireSchema` from the
  modules that declare them rather than from the `@veyyon/ai` entry point. That entry point
  re-exports the whole package, so taking one function from it costs 363 modules;
  `commit/shared-llm.ts` reaches 184 where it reached 325.
- Context accounting and the turn-budget directive moved out of the terminal UI. Both lived under
  `modes/` because the surfaces that display them do, and the session engine imported them from
  there, which is the wrong direction: the layering gate had to carry a standing exception for each.
  `parseTurnBudget` is at `session/turn-budget.ts` and the token accounting is at
  `session/context-usage.ts`. The `/context` grid stayed where it was, in
  `modes/utils/context-usage.ts`, and imports only the shapes from the accounting module.

  The category rows dropped their colour and glyph in the move. The panel owns that table now, keyed
  on the category id, so the numbers carry no palette and another surface can report the same figures
  without inheriting the grid's colours. Callers importing `computeContextBreakdown`,
  `computeNonMessageTokens`, `computeNonMessageBreakdown`, `computeStoredMessagesTokens`,
  `estimateSkillsTokens` or `estimateToolSchemaTokens` from
  `@veyyon/coding-agent/modes/utils/context-usage` should import them from
  `@veyyon/coding-agent/session/context-usage`; `renderContextUsage` stays where it was.
- `tools/` may import the terminal UI only to draw, and only through named leaves. Unlike the session
  engine a tool renders its own output block, so it cannot be forbidden the UI outright, and that
  partial permission is how the boundary rots: thirty-two files under `tools/` import from `modes/`,
  each one obviously fine on its own. A gate now lists the ten modules they may reach and what each
  is for, so an eleventh is a decision someone writes down rather than an import that slips in.
- The Agent Control Center sizes itself to the roster. It used to take the whole terminal whatever was
  in it, so a run with four agents drew four rows and then about twenty rows of empty bordered card
  over the transcript you opened it to look past. It keeps room for eight rows so it does not resize
  on every spawn, grows with the roster, and still takes the viewport and no more when the roster is
  larger than the screen. The Comms stream keeps the full height, because a feed that resized its own
  frame as messages arrived would be worse than the space it saves. With no agents running it also
  stops offering the three keys that act on a selected row, since there is no row to select.
- Every place that tells you which key expands a folded block now reads the key you have. Nine
  surfaces wrote `ctrl+o` out as a literal, so rebinding `app.tools.expand` left them naming a key
  that no longer expands anything: the Agent Control Center's Comms chip and fold line, the
  rule-injection notice, the shared execution footer, the bash block, and both `ssh` output hints.
  The line count they carry is unchanged, and is still shown when the action is bound to nothing.
- The hook editor's footer reads its chords too, and it now names both submit chords. It said
  `enter or ctrl+q submit`, while `app.message.followUp` ships as `ctrl+q` and `ctrl+enter` and the
  handler has always accepted either, so a chord that really submits was missing from the row that
  lists them.
- `config/settings.ts` stopped dragging the whole of `@veyyon/ai`. It is the most imported module in
  the package (528 test files, and every runtime consumer of `Settings`) and it reached 380 modules, 228
  of them that package: the streaming engine, every provider transport, the model registry, the error
  taxonomy. Three imports carried it, each naming a barrel or a re-export instead of the module that
  owns the value: the in-flight caps setter came from `@veyyon/ai/stream` rather than from the caps
  themselves, `THINKING_EFFORTS` came from the `@veyyon/ai` barrel though `@veyyon/catalog/effort` owns
  it and imports nothing, and the sqlite credential store came through the barrel (345 modules) rather
  than from `@veyyon/ai/auth-storage` (212), which defines it. Now 250, with `config/settings-schema.ts`
  down from 371 to 106 and `thinking.ts` from 346 to 6. Nothing about behaviour changes; what changes is
  that reading a setting no longer instantiates the streaming stack. Neither existing architecture gate
  could see any of this, because both walk without resolving workspace packages and read this file as 36
  modules, so the cut is held by a new gate that resolves them.

  Then 125, once `packages/ai` split the sqlite credential store out of the module that also owns the
  OAuth machinery. `session/agent-storage.ts` wanted the store and nothing else, so it now names
  `@veyyon/ai/auth-storage-sqlite` (83 modules) and `@veyyon/ai/auth-credential-rows` (75), and takes
  the credential types from `@veyyon/ai/auth-storage` as types, which are erased. It fell from 213 to 84,
  and that carried `session/session-manager.ts` from 482 to 369 and `session/session-context.ts` from 472
  to 359. `session/auth-storage.ts` stayed at 215 and that is not slack: it forwards `AuthStorage`
  itself, and that class is the OAuth machinery.
- Reading a local file no longer loads the MCP client, the skill loader or the memory consolidator.
  `tools/read.ts` reached 972 modules through five hops, and each hop was a process-global slot or a pure
  function living inside the heavy module that fills it. `internal-urls/mcp-protocol.ts` used `MCPManager`
  as a type everywhere except one `MCPManager.instance()`, so reading a static slot cost the MCP client
  and its transports; `internal-urls/skill-protocol.ts` reads the active-skill snapshot from inside the
  skill loader; `internal-urls/memory-protocol.ts` wanted `getMemoryRoot`, a two-line path join, from the
  module that asks a model to summarise a session; and `tui/status-line.ts` wanted one status glyph from
  the tool renderer.

  Four modules now own those four things and import nothing: `mcp/manager-instance.ts`,
  `extensibility/active-skills.ts`, `memories/paths.ts` and `tools/tool-ui-status.ts`. Each is re-exported
  from where it used to live, so `MCPManager.instance()`, `getActiveSkills()`, `getMemoryRoot` and
  `formatStatusIcon` all keep working from their old import paths. An empty slot still means what it
  meant, and still says so: the `mcp://` handler reports "No MCP manager available. MCP servers may not be
  configured." with the available resources, and the `skill://` handler names the active skills. Measured
  after: `read` 736, `internal-urls` 419 (was 911), `tui/hyperlink` 182 (was 609), `tui/status-line` 2
  (was 168), and the three protocol handlers 76, 79 and 89 where they were 871, 369 and 571.
- The session layer stopped carrying the prompt registry and the tool layer. `session/messages.ts`
  reached 356 modules, and 261 of them came through two imports that had nothing to do with message
  shapes. `PROMPTS` came from `prompts/registry.ts`, which imports all 143 prompt files by design, for
  one interjection template; and `formatOutputNotice` came from `tools/output-meta.ts`, which owns the
  fluent builder, the tool wrapper and the spill configuration on top of the notice text, and therefore
  reaches settings, the streaming output sink and the artifact store.

  `wrapSteeringForModel` now lives in `session/steering-envelope.ts`, the module that renders the prompt,
  and the notice wording, the metadata types and the three strippers live in `tools/output-notice.ts`.
  `tools/output-meta.ts` re-exports all of them, so no caller changed there; `wrapSteeringForModel` moved
  import path for its three callers. `session/messages.ts` is 100 modules,
  `session/session-context.ts` 107 (was 602) and `session/session-manager.ts` 155 (was 612), the last of
  which 206 test files import.

  The strippers moved WITH the wording on purpose. `stripOutputNotice` removes a notice by rebuilding it
  and matching the tail of the text, so the writer and the remover are one contract: wording that
  changed in one and not the other would leave the notice visible twice, once in the message body and
  once as the styled warning.
- Asking the theme engine for a colour no longer loads an ASCII diagram renderer.
  `modes/theme/theme.ts` is the second most imported module in the package (291 test files, and every
  component that paints) and it reached 307 modules. Thirty-six of them were mermaid: `getMarkdownTheme`
  lived there, and it binds a diagram renderer to the palette, so every consumer of a colour paid for
  the renderer whether or not anything on screen was a diagram. Nothing here was a barrel import, which
  is why the earlier sweep did not find it: the function was simply in the wrong module.

  `getMarkdownTheme` and `setMarkdownMermaidRendering` now live in `modes/theme/markdown-theme.ts`, and
  the memoised native highlighter both sides need lives in `modes/theme/highlight.ts` (17 modules,
  taking `logger` and `errorMessage` from the modules that own them rather than the `@veyyon/utils`
  barrel). `theme.ts` is 272 and still re-exports `highlightCode`, so that caller set did not change;
  it deliberately does not re-export `getMarkdownTheme`, because forwarding it would put the same 36
  modules straight back. `markdownMermaidRendering`'s test-reset hook moved with it, so the module that
  owns the state owns its restore, and a suite that never loads the markdown adapter has no such state
  to restore.
- The same import mistake was found in twenty-six more places and the rule is now written down rather
  than counted. A value defined in a cheap module gets imported through the `@veyyon/ai` barrel because
  the barrel re-exports it and that is the first completion an editor offers; the names are identical
  either way, so nothing ever fails. `assistantText`, `assistantTextBlocks` and `instrumentationRank`
  are each defined in a module that reaches exactly one, against the barrel's 346, so
  `modes/utils/copy-targets.ts`, `hindsight/transcript.ts` and `cli/session-stats.ts` each fell from
  about 347 modules to 76 on one line; `task/agents.ts` went 520 to 253 and
  `modes/components/settings-selector.ts` 783 to 655. Twelve of the fixes did not change their own
  file's number, because those files also import `completeSimple` or `streamSimple` and genuinely want
  the streaming engine, and they were made anyway: a file whose graph is large for a good reason is not
  a licence to name the wrong owner, and the day the expensive import moves out the wrong one is still
  there. The gate holds it as a table of value, owner and the owner's reach, so a new entry costs one
  line instead of a new ceiling. Type imports are out of scope on purpose, since they are erased.
- `argot.models` and `argot.disableAboveTokens` are now `argot.encode.models` and
  `argot.encode.disableAboveTokens`. Those two are the only Argot settings that decide whether a model
  is taught to WRITE shorthand; `enabled`, `autoload`, `tokenBudget` and `subagents` decide whether the
  feature runs, when a dictionary is built, how many tokens it may spend, and what a subagent starts
  with. Flat, all six read as peers, and nothing in the names said that emptying the allowlist stops
  the teaching while expansion carries on regardless, which is the distinction you need to predict what
  turning it off does. Existing configs need no edit: both keys migrate under `encode` the first time
  the file is read, in either the nested or the dotted spelling, and the retired key is dropped the
  next time the file is saved. A config carrying both spellings keeps the `encode` value and discards
  the old one without reading it, so the result never depends on which key is visited first.
- The two gate test suites stopped describing the prompt through a document no session reads.
  `prompt-gate-registry.test.ts` partitioned every gate variable it could find by regular expression
  over `system-prompt.md`; it now reads the statement rows and the statement text, which is what
  reaches the model. That also closed a silent hole in the old check: the expression matched `{{#if}}`,
  `{{#unless}}`, `{{#each}}`, `{{#ifAny}}` and `{{#has}}`, so `{{#when MAX_CONCURRENCY ">" 0}}` was a
  gate it could not see and `subagent.maxConcurrency` was partitioned over a set that omitted the one
  variable it gates. A row's condition names its variable structurally, so that hole cannot exist on
  this side, and the cross-check is now exact identifier membership rather than a substring match that
  would accept `{{#if renderMermaidSomethingElse}}` as evidence for a row claiming `renderMermaid`.
- `prompt-gate-inputs.test.ts` asserts which text each gate moves, instead of that 76KB of prompt
  differs. `expect(flipped).not.toBe(baseline)` proved the flip reached the assembler, which was the
  bug it was written for, and nothing more: it passes just as well if the flip changes the wrong text,
  in the wrong section, or one byte of whitespace, and it could not be read, so nobody could tell from
  the suite what `subagent.maxRecursionDepth` is supposed to do. Each gate now names the statement it
  decides, with the signature DERIVED from that statement's own text rather than pasted into the test,
  so the claim cannot rot into a quotation of prose that has since been reworded. Verified against
  four mutations the old comparison passed, including one where `tui.renderMermaid` gates a different
  statement entirely.
- The system prompt is now assembled from named statements in full. All six sections are converted,
  68 rows in total (conventions 1, ROLE 2, RUNTIME 12, TOOL POLICY 34, EXECUTION WORKFLOW 13,
  DELIVERY CONTRACT 6), and `system-prompt.md` no longer feeds any session. A single gated line such as
  an `ast_grep` preference, a delegation rule or one contract block can now be named, asserted on,
  priced in tokens and ablated in an eval without editing the prose around it. Two conditions were added for the shapes the
  larger sections need: `whenAll`/`whenAny` hold conditions rather than variable names so they nest,
  which is what lets a row say "the task tool is active and this is not the Codex wording", and `not`
  covers a block-level `{{else}}` arm. Zero word-level differences across the gate matrix.
- The granularity rule that decides how fine a statement is now admits units the prompt itself
  delimits. `DELIVERY CONTRACT` is five unconditional XML blocks and `EXECUTION WORKFLOW` six numbered
  steps under headings; merging each set into one row would have been faithful to the old rule and
  wrong, because those boundaries come from the document rather than the registry and an eval that
  ablates one step needs it to have a name. The check allows adjacent unconditional rows only when the
  second opens a heading or an XML block, so an arbitrary prose split is still reported.
- The system prompt's `RUNTIME` section is now assembled from twelve named statements instead of a
  block of Handlebars conditionals, and the statements are what a session actually sends. Each one
  has an id, a stated purpose and a condition drawn from a closed vocabulary, so a single gated line
  such as the `memory://root` URL or the MCP discovery notice can be named, asserted on and switched
  off without editing prose around it. Not one word of the prompt changed. The spacing changed in
  three gate combinations, deliberately: `format` deletes a run of two or more blank lines and keeps
  a single one, and RUNTIME's template put unconditional blank lines between conditional blocks, so
  with two of those blocks absent `# Skills & Rules` was landing directly on `# Internal URLs` with
  no gap. A statement owns the separation that follows it, so the spacing no longer depends on which
  unrelated blocks are missing. The three differences are enumerated with their measured deltas and
  the list is asserted exhaustive in both directions.
- The `-1` that older configs stored to mean "unset" is named in one place. `config/settings.ts`
  declared its own constant for it beside the one in `config/optional-number.ts`, so the module
  that deletes the old sentinel and the module that translates it each had their own spelling of
  the same number. No behaviour change; the point is that there is nothing left to keep in sync.
- The session-entry types are declared once, in `@veyyon/agent-core`, instead of twice. This package and the agent core each wrote out the same fifteen entry interfaces and their own `SessionEntry` union over them; twelve of the fifteen were identical and three had drifted, so compaction in the other package saw a `SessionInitEntry` without the `spawns` and `readSummarize` this one actually writes and a `ThinkingLevelChangeEntry` without `configured`. The shared shapes now live in one file and are re-exported here under the same names, so every existing import keeps working, and the two entry kinds only this package persists reach the shared union through the declaration-merging hook that already existed for that purpose.
- The secret obfuscator's JSON type is `JsonWithOptionalFields`, not `JsonValue`. It is a deliberately laxer shape than the repository's `JsonValue` (`@veyyon/utils`), whose objects never hold `undefined`, and it needs to be: `mapJsonStrings` walks tool-call arguments, and a TypeScript object with optional properties is not assignable to the strict shape, so the walker would refuse the values it exists to rewrite. Two exported types with one name and different contents is a bug waiting for an editor's auto-import, so the name now says what the difference is. `JsonRecord` is unchanged in shape.
- `veyyon prompt --prompts` lists every prompt from all three product registries, grouped by the directory each lives in, and `--prompt <id>` resolves an id from any of them. It listed and looked up only this package's own, so the compaction prompts that rewrite a session's entire history and every dialect format guide were absent from a list that looked complete. An unknown id is now refused with the nearest registered id quoted back and the directory named, rather than a rule that no longer identifies one tree.
- The "trim each, drop the blanks" loop is `nonEmptyTrimmed` from `@veyyon/utils`. `gh.ts` wrote it twice, 145 lines apart, for a PR identifier list and for search-query fragments, and `autoresearch/helpers.ts` had a third copy with deduplication folded in. Nothing was wrong with any of them, which is why it was worth naming: the next copy is the one that forgets the trim or decides a whitespace-only entry counts, and then two parts of the product disagree about whether `"  "` is a value. `dedupeStrings` now adds only uniqueness on top.
- Host probing moved out of the prompt builder into `utils/host-environment.ts`. `system-prompt.ts` is about assembling a prompt, and roughly 280 of its lines were not: spawning `lspci` and `wmic`, racing them against a deadline, draining a pipe an exited child left behind, caching the answer on disk, and reading `/proc/cpuinfo`. Burying a subsystem with its own failure modes inside a 1200-line file about something else is what let two of those failures be handled at different volumes without anyone noticing. The prompt builder now asks for what it actually wants — the CPU, the GPU and the finished rows — and passes its preparation budget in, so the probe's margin (it must outlive its own deadline long enough to write the null cache) lives with the probe instead of being derived from a constant in another file. `system-prompt.ts` is 1201 lines to 912.
- `firstNonEmpty` is in `@veyyon/utils` rather than private to the prompt builder, which needed it in both halves of that split. It picks the first value that is set and not blank after trimming, which is the case `??` and `||` each get half of: `??` keeps an empty string, `||` drops one but also drops `0`, and neither trims. A `TERM=` exported blank now falls through to `COLORTERM` for the same reason it always should have.
- The one parser that cuts a bannered prompt lives in `banner-grammar.ts`, beside the grammar it parses. It was in `prompt-sections.ts`, whose header called it "section machinery for the default system-prompt template" while it served every prompt in the product, and that mislabelling is what let it close over the system prompt's banner table in the first place: handed the subagent prompt, same grammar, it recognised only the banners the two happen to share and folded the rest away without a word. The banner table is now a required argument, so there is no default to fall back to and no prompt the parser knows. `prompt-sections.ts` keeps what is genuinely about the system prompt: its section names, its table, and the reordering a harness profile asks for.
- The three memoized derivations in `prompt-sections.ts` use the shared `once` rather than a module-level `let` and a `??=` written out three times. Three copies of a caching pattern are three chances to get it wrong in a way only one of them shows: `??=` re-runs forever if its derivation ever yields an empty string or zero, which these do not today and nothing was checking. The regression test that keeps the reads deferred was also flagging the deferred spelling as if it were an eager one, so the honest fix failed the check that exists to encourage it; it now looks for a read nothing on the line defers, and proves on synthetic input that it still catches an eager read.
- The prompt banner grammar is its own module, and the file that held it is named for what it contains. `prompt-blocks.ts` owned two unrelated things: how a banner is written and recognised in EVERY prompt, and the system prompt's own list of sections. The universal half is now `system-prompt-builder/banner-grammar.ts`, a leaf that knows no prompt, so `prompts/registry.ts` no longer reaches into the system prompt's module to ask what a banner looks like. The remaining half is `section-registry.ts`, since a "block" in that subsystem already means an entry of the `string[]` `buildSystemPrompt` returns, and the file contained none. `PROMPT_SECTIONS` became `SYSTEM_PROMPT_SECTIONS` for the same reason: it lists the system prompt's sections, not every prompt's, and the `PROMPT_SECTIONS/` override directory shares the old spelling.
- Collapsed seventeen helpers that existed as byte-identical copies into one definition each: the project resolution that decides which launch daemon a directory uses (two copies, so the client and the presence file could have disagreed about a symlinked project), the "YAML if `.yaml`, otherwise JSON" decision the LSP and DAP config readers each made privately, the provider-name rendering three user-visible surfaces each had their own version of, and the patch check that refuses two hashline sections resolving to one file, which now lives in the package that defines the section type. Three more followed: the DAP files' private error renderer, which the shared `errorMessage` already did better (an error with an empty message now shows its class name instead of nothing), the commit an experiment records, and the current-branch-or-`HEAD` spelling two bundled commands each rolled themselves. Then four whose copies could disagree across a boundary: the diagnostic text sanitizer two rendering surfaces stated separately (a diagnostic containing a tab would have rendered differently depending on where you saw it), the browser tab id the supervisor and its worker each derived (a tab addressed under two ids takes commands on neither), the collab wire envelope the host and the browser guest each coded, which now lives in `@veyyon/wire` beside the header length it reads, and the WebCrypto byte coercion four packages needed, now `asStrictBytes` in `@veyyon/utils`. The `token` subcommand followed, which the auth gateway and the auth broker offer identically and each implemented separately, down to the JSON shape it prints. The envelope is the one that fails most quietly: the payload still decrypts, because the room key is untouched, so a host and a guest that disagreed about the byte order would deliver a frame to the wrong peer without an error anywhere. Four more after that: the tree indentation three renderers drew (the JSON tree's copy had drifted to the OPPOSITE argument order, so the same nesting could draw different rules in two panes of one screen), the thenable guard the IPC and MCP stdio send paths each carried (the surviving copy's own comment justified the other as "battle-tested there", though only one of the two was tested at all, and those tests moved to `@veyyon/utils` with the function), the `token` subcommand described above, and the bootstrap `veyyon bench` and `veyyon dry-balance` share, where the part that matters is the failure path: if settings or the extension providers throw, the credential store opened a line earlier is closed before the error propagates, or a SQLite handle leaks on every failed invocation. The last two: the log replay both worker supervisors performed (a worker has no logger of its own, so it ships the level with the message and the supervisor replays it, and a copy that mapped a level to the wrong method would move a class of worker diagnostics out of the log an operator is reading), and the runtime installer's pipe reader, which moved to `@veyyon/utils` as `readPipeText`.
- Fixed two ways an eval kernel could be started twice for the same work. The key a retained kernel is stored under, `(session, cwd, interpreter)`, had three copies, one per managed runtime, and the Julia copy had drifted: it resolved the interpreter path without following symlinks, so reaching the same Julia through a link (`/usr/local/bin/julia` and the versioned binary behind it) started a second kernel that shared no state with the first, and it joined the key's parts with `::`, a sequence that can occur inside a session id or a path. All three now use one builder that canonicalises the path and separates the parts with a byte that cannot appear in either.
- Tool-output folding now recognises six more shapes an agent meets constantly: `python -m unittest -v` per-test lines, cmake/make progress (`[ 42%] Building C object ...`), make's directory recursion, gradle tasks that did no work, docker layer ids, and maven artifact fetches. Measured on runs captured on a real machine rather than on fixtures: a 41-test unittest run goes from 2,473 to 170 characters (93.1% smaller) and a 41-file cmake build from 2,556 to 60 (97.7%), both keeping every diagnostic and the summary verbatim. Only the shapes that state no work was done are folded, so a gradle task that ran, a docker `Step 4/12` line, and every `[ERROR]`/`[WARNING]` maven line stay.
- A `read` with a bounded line range now says on its last line what it padded: `read file:1-3` answers with six lines and `[Showing lines 1-6: you requested lines 1-3, plus 3 lines of trailing context]`. The padding is deliberate, it saves the follow-up read that a one-line-off anchor needs, and it was documented only in `docs/tools/read.md`, where a reader looking at the result never saw it: the same read was reported as over-delivery twice, because the surprise happens where the result is, not where the docs are. The counts come from the range that was actually shown, so padding cut short by the end of the file reports the smaller number, an unpadded read carries no notice, and `:raw` stays byte-verbatim.
- `veyyon gc` now lets you set how recently a file may have been written and still be left alone: `gc.writeGraceMinutes` in your config, or `--write-grace-minutes` for one run. The window was a fixed five minutes while the retention knob beside it was already configurable, so you could tune how long sessions are kept but not how much slack GC leaves for live writes. One minute is the minimum, and a smaller value is raised to it with a message rather than honoured, because a shorter window would let GC delete a blob a running session wrote a moment ago. Breaking a stale GC lock keeps its own five-minute window, so a shorter grace no longer also makes one GC run steal another's lock.
- Every prompt veyyon sends a model is now owned by one registry per package, and the import is the registration. Prompts were reached by ad-hoc relative path from wherever they were used: 160 `import … with { type: "text" }` specifiers across 85 files, 27 of them in one module. A registry beside them listed 23 of the 143 and recorded each one's location a SECOND time as a path string the compiler cannot check, so a prompt's home was written down twice in spellings nothing kept in agreement, and 120 prompts were written down nowhere. `src/prompts/registry.ts` now holds the text import, id and purpose of every prompt in one row each, nothing else may import a prompt file, and `veyyon prompt --prompts` lists all 163 with what each is for instead of 23. Prompts that lived beside their consumer (`src/commit/prompts`, `src/commit/agentic/prompts`, `src/autoresearch`, `packages/agent/src/compaction/prompts`) moved into their package's one prompts tree.
- Prompt files are grouped by when they fire instead of piled in a `system/` directory. Moving 163 prompts into one tree was not the same as organizing them: `system/` held 61 of them, 40% of the tree, with personalities, plan mode, rule violations, IRC, session titles, loop redirects, agent creation, memory and the main system prompt all as siblings, and six more sat loose at the root. Directories now say when a prompt reaches the model: `session/` for what defines a session, `turn-control/` for what interrupts or resumes a turn, `side-channel/` for turns that reuse the context but are not the task, plus `subagent/`, `plan-mode/`, `rules/`, `autolearn/`, `titles/`, `thinking/`, `requests/` and `bench/`. The largest directory outside `tools/` is now 17 of 163. A prompt's id is its path, so the ids `veyyon prompt --prompts` lists moved with the files. The `PROMPT_SECTIONS/` names are unaffected: those are the banner sections inside the system prompt, not prompt files.
- One splitter now cuts every bannered prompt, and both callers agree about a broken one. The product had two implementations of the same `NAME\n====` grammar: the template slicer walked byte offsets and refused a missing or out-of-order banner, while the reorder and inspection path walked lines and silently folded an unrecognised banner into the section above it. Unifying the section definitions had been mistaken for the whole fix, so a renamed banner refused the build in one path and quietly merged two sections in the other, shipping a prompt with a region missing and reporting nothing. Strictness is now a caller's choice on one parser: the template slicer requires its sections and names the id, the banner and the document when one is absent, while a custom prompt with no banners is still read as one region rather than an error.
- The context gauge is now the last thing on the footline. On the default status line it sat between the model and the session name, so the one number that changes every turn was wedged between two that never do, and the default and minimal presets disagreed about it. Standing state reads first, the gauge last. A gauge you place explicitly on the right side of the line stays where you put it.
- Tool cards now line up with everything else in the transcript. A card drew its frame at column 0 while the prompt glyph, assistant text and command blocks all sat two columns in, so every tool call broke the single left edge the eye follows down the screen. The card starts on that edge now, and keeps the same gap from the right.
- `/compact soft` and `/compact remote` now say that those names are retired. Both were removed with the provider-native compaction path they used to steer, and typing one fell through to the plain focus-text path: veyyon compacted with your configured type, folded the word into the focus text, and reported success, so it looked like the type you asked for had run. It still compacts and still passes your text through exactly as typed, and now it tells you which name you used and to use `/compact summary` instead.
- `veyyon update` now refuses to replace a binary that is a symlink, instead of silently destroying the link. If `~/.local/bin/vey` points at a checkout build, the update renamed a downloaded binary over that path: the checkout survived, nothing pointed at it any more, and the update reported success, so you kept editing a build that no longer ran. The refusal names the link, where it points, and both ways out (update that install directly, or `rm` the link first). A hardlinked binary still updates.
- An update that fails inside a directory you cannot write to now reports why it failed. The cleanup of the downloaded file failed too, and that error replaced the real one, so you were told veyyon could not delete `vey.new` when it could not write into the directory at all. The download is left behind instead, and reclaimed by the next update.
- A dotted key at the top level of a config file now works. `subagent.model: openai/gpt-5` looks exactly like the nested form the docs show, and people write it, but it was parsed, merged, and then never read: values are looked up by walking nested keys, so the setting sat in the tree under a literal `"subagent.model"` key that nothing looked at, and it silently did nothing — no warning, and `veyyon config list` showed the default. Every setting was affected. Flat keys naming a setting this build knows are expanded when the file is read, so either spelling works; a setting written both ways keeps the nested value and drops the flat one with a warning naming both; a key this build does not know is still preserved exactly as written.
- `veyyon config reset <key>` removes the key instead of writing the default back into `config.yml`. Writing it made the reset value look explicitly configured, pinning a default that was meant to follow the app.
- An optional numeric setting is now unset by having NO key, instead of storing `-1` to mean "no value". The sentinel made `-1` unreachable as a real value, and `presencePenalty: -1` is a penalty providers accept. Choosing `Default` in `/settings` removes the key, and a config holding the old `-1` on one of these keys has it dropped on load, so your effective settings do not change while `-1` becomes settable. The seven affected settings are the six sampling knobs and `compaction.modelContextWindow`.
- Subagents now run the model you are working with. On a stock install they each ran a DIFFERENT model — scout and sonic on a small one, reviewer on a thinking one, designer on a third — and no subagent model setting could change it: the bundled agents carried role aliases (`@smol`, `@slow`, `@designer`, `@task`) in their frontmatter, and an unset role expanded to a built-in `priority.json` chain rather than reporting that the role names no model, so those aliases won before any choice of yours was consulted. Role expansion no longer has a chain (every role, advisor included, inherits the live main model when unset), no bundled agent pins a model, and the four layers that can name a subagent's model — that agent's row, the blanket `subagent.model`, the definition's own `model:`, then inherit — resolve in one place with the deciding layer reported. `priority.json` still picks a fast or strong model on first run, where nothing has been chosen yet.
- A configured subagent model that matches no available model now refuses the spawn and names the setting to fix. It used to fall silently through to the next layer, which is indistinguishable from your setting having no effect. `/agents` shows the pattern, the model it resolves to, and which layer decided, so an override that was outranked is visible rather than merely disappointing.
- Only the general-purpose worker and agents you wrote yourself are offered to the model now. The five bundled specialists (`scout`, `reviewer`, `designer`, `librarian`, `sonic`) ship unoffered: each agent type costs its description in every request of the session, and most sessions want a worker and nothing else. Enable the ones you want in the Subagents tab or with `/agents`, where `space` cycles offered / not offered / blocked. An unoffered agent still runs when something names it outright, so `/review` keeps spawning `reviewer`; `blocked` refuses even then.
- Subagent effort is now picked from a list instead of typed, and a value that names no level is reported instead of ignored. "Subagent Effort" was a free-text field, so `hihg` was accepted, resolved to nothing, and read as "inherited" — a setting that looked configured and did nothing. Both effort surfaces (the blanket setting and the per-agent row) offer the same rows — `off`, `minimal` through `max`, `auto`, and `Inherit` — from one vocabulary, and an unrecognized value from a hand-written config is named alongside the levels that would have worked. It is still never rounded to a neighbouring effort.
- Task delegation moved under the same area and gained a level: `subagent.delegation` is `off`, `allowed` (the default), `preferred`, or `required`, replacing `task.eager`. `off` removes the `task` tool outright instead of describing a tool the prompt then forbids, and every delegation instruction is derived from what you have enabled — with only the worker offered, nothing tells the model to pick an agent type or to send research to a `scout` it cannot spawn.
- The context gauge now reports how much room is LEFT, and says so. It measures against whichever limit comes first — the auto-compaction trigger when auto-compaction is on, the model's window otherwise — and the quiet footline shows that as a draining 8-cell bar with a labelled percentage (`▰▰▰▰▰▰▱▱ 76% left`), so the bar and the number cannot disagree. The bar used to grow as room ran out, which is a fuel gauge running backwards, and a bare `38%` beside it was read as consumption by half its readers. Text presets show tokens on both sides of the slash (`47K/170K`) instead of `47.3%/200,000`, which put a percent and a token count either side of a slash and was true under no reading. The percentage is a whole number: a tenth of a percent moved every turn and decided nothing.
- Clicking the context gauge in the composer's footline opens the `/context` breakdown. The footline has room for one number, and the question behind it needs the per-category split; a hover cannot serve it because the main screen tracks mouse buttons without motion reporting, so nothing is known about the pointer until a press.
- `/context` reports the room left alongside what is used, formats its token counts (`272K` rather than `272000`), and, when the per-category breakdown cannot be computed, says that and why instead of printing three plain lines that look like a healthy narrow report.
- Argot has one name. The package was published as `argot`, its settings were `argot.*`, and its directory and veyyon's wiring modules were `lexpack`, so every reader had to learn the mapping. The directory is `packages/argot` and the modules are `argot-wire.ts` / `argot-cache.ts` / `tools/argot.ts`. Nothing you configure changed: the setting keys were already `argot.*`. Three things the mismatch had been hiding turned up with it: the handbook's Argot chapter was an eight-byte stub, because `SUMMARY.md` linked `why/argot.md` while the real chapter sat at `why/lexpack.md`; a stale duplicate of the Argot blog post was still in the repo; and the dictionary-generation script for the DeepSWE bench imported a package name that does not exist, so it could not have run.
- The per-turn receipt (`display.showTokenUsage`) now reports how long the turn took. The total duration was read only to divide the output tokens by it, so the row published a rate and never the time behind it: you could read `59.3/s` and still not know whether the turn took four seconds or forty, which is exactly the number you want when comparing two models on the same prompt. The one time value it did show was time-to-first-token wearing the clock icon with nothing to say so, so a reader took it for the turn's length. The clock now means the turn's length, formatted the way the status line formats elapsed time, and TTFT is labelled `ttft`.
- A shell command that failed is now marked as failed, not just tinted. The bash block deliberately shows no title, since the frame would only repeat the `$` line, and that suppressed the failure marker too: `state: "error"` reaches the border colour and nothing else, so with colour stripped — a monochrome terminal, a colour-blind reader, a transcript pasted into an issue — a failed command rendered byte-identically to a clean one. A failed run now carries its own `✗ failed` header. This also covers failures that carry no exit code: a timeout, an abort, or a command that could not be spawned propagates as a thrown error whose result has no exit code to key the `Exit: N` chip on, so that whole class of failure previously showed no marker at all.
- A rendering hook or message renderer that throws now says so in the transcript instead of being replaced without a word. Tools, extensions, and hooks can all supply their own renderer, and a throw was survivable but invisible: you saw the tool's name where its card should be, raw output where its diff should be, an empty box for a multi-file edit, or the built-in card in place of an extension's, with nothing but a log line behind it (and for custom messages, not even that). The substituted render now carries one line naming which renderer failed, why, and what you are looking at instead, marked with a glyph so it survives a monochrome terminal. Returning `undefined` still declines quietly: that is how a renderer opts out for one call.
- The model slot holding the model you are working with now has one name. It answered to `default` in storage, `interactive` as `setModel`'s role argument, and both spellings in scattered inline comparisons, and one line stored `default` while logging `interactive` for the same write, so a session-log entry could not be matched to the setting it changed. Callers pass either spelling and `resolveModelSlot` translates once.
- The priority service tier now reads as a serving tier rather than a fourth effort level. Its icon sat immediately before the thinking-level glyph in the same color, so `⚡ ◉ high` looked like one more rung on the effort scale. It now trails the effort as its own chip, in its own color, and names itself, which also makes the tier visible in symbol themes whose fast icon is empty (it used to render nothing there). `/fast` keeps its name and now names what it changes ("Priority tier (fast mode) enabled") instead of describing the same state in a second vocabulary.
- A setting replaced by another is now marked retired in the schema, so it stops advertising itself as a choice: `veyyon config list` leaves it out, and `config get`/`set` still work but name the key that governs the behavior now. `compaction.thresholdTokens`, `compaction.thresholdPercent`, and `defaultThinkingLevel` are the first three.
- Optional numeric settings share one definition of "unset". The `-1` sentinel was written out by hand in thirteen schema entries, with two different submenu encodings and a list of paths maintained inside the settings selector; the selector now derives that set from the schema, and every `Default` row comes from one helper.
- The auto-compaction trigger now has one setting, `compaction.threshold`, whose unit is part of its value: `auto` (the model's window minus the reserve), a percent that moves with the model (`85%`), or an absolute token amount that is the same on every model (`170000`). It replaces two rows both labelled "Compaction Threshold" (`compaction.thresholdTokens` and `compaction.thresholdPercent`) that wrote one axis with an invisible precedence, so picking the wrong one silently did nothing. Your global config is rewritten on load — the amount becomes `threshold: 170000`, the percent becomes `threshold: 85%`, and both retired keys are dropped — so the ambiguity leaves the file without moving your trigger; project configs and `--config` overlays, which are never rewritten, are folded in at read time with the same precedence. The resolved threshold is now reported with its origin — `170k (85% of 200k)` — whenever it is capped for the current model, still coming from a retired key, or unparseable.
- Handoff now ends with the same `<files>` block a summary does, so a session started from a handoff gets the same map of what was read and modified.
- `/compact` subcommands are now the two compaction strategies, `summary` and `handoff`. The former `soft` and `remote` modes existed only to steer provider-native remote compaction, which was removed; a stale `/compact soft ...` or `/compact remote ...` is read as focus text rather than erroring.
- Settings search now ranks by field instead of one concatenated blob: the setting named for your query comes first, prose matches come last, and a setting can declare the words users actually type for it (`reasoning` finds Default Effort, `copy`/`clipboard` finds scroll isolation). Searching no longer matches a setting by its current value or its enum values.
- Thinking effort now has one persisted home: `defaultEffort`, a per-profile list of model to effort rows edited at `/settings` → Model → Default Effort. A row keyed by a model selector applies to that model, and a `*` row applies to every model without one. It replaces the profile-wide `defaultThinkingLevel` enum, which is still read so an existing config keeps working: with no `*` row, that value becomes it. Effort resolves in one documented order (session choice, then an explicit `:level` on the role's selector, then the model's row, then the `*` row, then the model's default) owned by `config/effort-resolver.ts` rather than written inline at each call site.
- `/thinking` and its `/effort` alias now change the current session only and print where the saved default lives. They used to rewrite the profile-wide default while the cycle keybinding did not, so the same change stuck or evaporated depending on how you made it, and there was no way to try an effort without keeping it.
- Effort pickers now follow the active model's catalog-defined variant list. They show an explicit Default row, Veyyon's Auto control, Off only when the model permits it, and only native effort names after that. A low/high model no longer presents unsupported medium or xhigh choices that would be silently clamped.
- The `compaction.model` and `subagent.model` chain editor now edits the highlighted primary or fallback position directly. Add fallback appends a position, and Delete removes only the highlighted position. Reopening model pickers reuses the catalog projection and sort while refreshing authentication badges.
- `changelog`: backfill the undocumented veyyon changes across all packages.
- `identity`: lock every @veyyon manifest to author santhreal.
- `natives`: document the version-sentinel freshness gate and tri-state AVX2 lock-step.
- `release`: lock the fork-notice-safe changelog roll.
- `release`: unify the changelog roll onto the gate's bullet predicate.
- `release`: verify the published linux-x64 binary launches.
- `release`: verify the darwin binary's .sha256 sidecar too.
- `hashline`: sample the seed-fuzz corpus on the gate, soak the full 3M nightly.
- `hashline`: reclaim the range-edit perf bullet into [Unreleased].
- `ai`: satisfy useLiteralKeys in the prototype-key metadata test.
- `lint`: remove dead vars and a comma operator flagged by biome.
- `natives`: warn (not silently skip) on a stale workspace native.
- Align stale tests with strict contracts (unblock release gates).
- Repoint sibling-package collapse-and-trim onto the utils owner.
- `utils`: give collapseWhitespace a dependency-free subpath.
- Repoint the three named errorMessage copies onto the utils owner.
- `veyyon-shell`: unify head_tail_dedup onto one primitive owner.
- `tui`: paint terminal ground (OSC 11) + track missing source; add handbook book-freshness gate.
- Docs+debrand: canonical internal-doc coherence, verification stamps, dead-code cleanup.
- Fix auth-broker-gateway ASCII diagram alignment after veyyon rename.
- `website`: auto-sync changelog from CHANGELOG + published GitHub releases; auto-deploy site on release.
- Website changelog: show only veyyon releases + Unreleased block; credit pre-fork oh-my-pi history as a note, not release cards.
- Gate npm publish + Homebrew tap on their secrets/vars; debrand brew formula (veyyon.rb, veyyon binary + vey alias, santhreal/veyyon repo).
- Debrand user-visible surfaces: terminal title π→vey, App/report/prompt/gallery omp→veyyon.
- `wip`: in-progress modes/plugins/mcp/tui/docs work from parallel session (committed to unblock the 1.0.0 release cut).
- Biome format wrap in auto-compaction-queue test.
- `natives`: changelog references the real exported symbol __ompInstallTokioRuntime.
- `deployment`: repo secrets/variables table + rollback-and-hotfix runbook.
- Rustfmt diff.rs, crash_handler.rs, bun.rs.
- `swarm-extension`: debrand npm metadata (description + repo/bugs URLs).
- `utils`: hoist levenshteinDistance to @veyyon/pi-utils (one canonical home).
- `mnemopi`: use canonical levenshteinDistance from @veyyon/pi-utils.
- `cli`: near-miss did-you-mean routing coverage.
- `changelog`: record the Kimi usage and recent-sessions ordering fixes.
- `changelog`: note the set_cwd argot_load tip fix.
- Purge upstream (can1357/oh-my-pi) traces from runtime source.
- Lock loud surfacing of managed AGENTS.md seed failures.
- `coding-agent`: correct the auto-chdir fallback chain in the maybeAutoChdir comment.
- `tui`: warm the native addon before process.platform mocks.
- `utils`: repoint strip-ansi's stale browser-consumer refs to @veyyon/tool-render.
- `doc-freshness`: surface tracked-but-deleted docs loudly; re-stamp releasing.md to canonical HEAD.

### Fixed

- `/secret rm` now tells the model the credential is gone. Only `add` ever produced an agent notice,
  and a revoked placeholder is no longer substituted, so a model still carrying "use `#GITHUB_TOKEN#`"
  wrote that literal text into the next command: the operator saw an authentication failure from the
  remote service with nothing anywhere connecting it to the secret they had just removed. `/secret
  extend` likewise says the placeholder is still good. The extend notice quotes no duration, because a
  lifetime pinned into conversation history goes stale and then misleads, and the operator already has
  the exact time left on screen.
- A revocation notice reaches the model even when secret protection is off. Notice delivery sat below
  the `!secretsEnabled` early return, so every notice was discarded in exactly the state where a stale
  placeholder does the most damage: with no obfuscator nothing is substituted, so every `#NAME#` still
  in the model's history reaches the shell verbatim. Notices that OFFER a usable placeholder are still
  withheld there, since they would advertise an expansion the runtime cannot perform.
- `SecretObfuscator.namedSecretNames()` returns its names sorted. It previously returned them in vault
  load order, which is stable enough for reconciling the live runtime and quietly wrong for the system
  prompt, where a section whose bytes reshuffle between rebuilds invalidates the provider's prompt
  cache for no behavioral reason. Every pre-existing assertion on this method was single-element,
  empty, or a length check, so none of them could see the difference.
- `/settings` now keeps the selected row visible in short terminals and shows a
  non-actionable resize message when the terminal cannot fit a usable pane. Mouse
  close, outside-click, and category switches now cancel uncommitted theme or text
  previews before leaving their scope. Clicking or scrolling the settings pane
  returns keyboard focus from the category sidebar and each category restores its
  last selected row. Rows shadowed by project config, a `--config` file, or a
  runtime override now name that source and remain read-only instead of accepting
  a hidden profile write. Default Model shows the saved profile choice separately
  from an active session override. Array-encoded model chains show their primary
  model and fallback count instead of `inherit`, and expanded Advanced rows retain
  their original section heading while you scroll.
- Session effort overrides remain authoritative across role-model switches until
  cleared. Clearing one now reveals the active role selector's explicit effort.

- Pressing Esc to interrupt a turn can no longer take the process down with
  `[Unhandled Rejection] AbortError: The operation was aborted.` The interrupt path aborted the
  session as `void session.abort(...)`, and `void` discards the value without attaching a rejection
  handler, so an abort that rejected escaped to the process from a keystroke handler. The reported
  stack blamed the keystroke rather than the teardown step that actually failed, because nothing had
  ever caught the error to record it. Detached aborts now go through one owner, `abortDetached`,
  which handles the rejection and logs it with the call site that issued it; the same defect is
  fixed at the four places that had it (both interrupt paths in the input controller, the SDK agent
  control, the ACP session control, and the extension host control).
- `/settings` → Model → Default Model now stores only the model selector. Saved effort has one UI owner, Default Effort. The old second step wrote a hidden `:effort` suffix to `modelRoles.default`, which outranked the adjacent Default Effort row and made later edits there appear ineffective. Role models and subsystem chains keep their explicit effort steps.
- `set_cwd` now reports a re-root as one readable move, `Moved cwd: <from> → <to>`, and tells the
  caller that relative paths moved with it. The old line put the origin in a trailing parenthetical,
  `Session cwd is now <to> (previously <from>)`, so the half that says whether anything happened was
  the easiest half to miss, and when either endpoint reached the message unresolved it collapsed to
  `Session cwd is now . (previously .)`: a successful re-root naming neither directory. An agent
  reading that cannot tell a move from a no-op, so it either re-issues the call or keeps resolving
  relative paths against the directory it just left. Both branches now name the directory at each
  end and point at the one call that lists the new root.
- `TERM=dumb` now suppresses bold, italic, underline, strikethrough, and inverse SGR sequences as
  well as foreground and background colors. `NO_COLOR` still preserves non-color emphasis.
- The Windows installer stages downloaded releases and local builds with an `.exe` suffix. Windows
  PowerShell 5.1 can run both verified preflight searches inside an output pipeline instead of
  rejecting `.download` or `.local` staging files as documents. Replacement now retries a transient
  Windows image lock while the staged preflight's last worker or an antivirus scan releases the
  executable, so an immediate reinstall does not fail after verification. Reinstall and uninstall
  also reclaim interrupted local staging files, including the legacy suffixless form.
- A block that folds exactly one line now says "1 more line". Every collapsed tool block, the read
  tool's continuation notice, the edit preview, the LSP hover, the MCP and eval renderers, `ssh`
  output and the Agent Control Center's comms fold wrote the count inline, so all of them said
  "1 more lines" on the commonest fold there is.
- Image paste now uses the same chords in the composer as everywhere else. The editor kept its own
  copy of the shipped defaults and had pinned `app.clipboard.pasteImage` to `ctrl+v`, so on Windows
  the `alt+v` fallback and on macOS the `super+v` fallback did not fire there, while the docs,
  `/hotkeys` and the settings UI all listed them. There is one table now, in
  `config/keybinding-defs.ts`, and the editor reads it.
- The Agent Control Center's Comms view names the expand key you actually have. Its key handler
  already read `app.tools.expand`, but the footer chip and the fold line both said `ctrl+o` in so
  many letters, so rebinding the action left the card telling you to press a key that no longer
  unfolds anything. When no expand key reaches the card the chip is dropped rather than shown, and
  the fold still reports how many lines it hid.
- `/hotkeys` now prints the live chord for every row, including the composer and editor ones. The
  reference page sends you there for "the live list after your remaps", and half the table was
  hardcoded: `Enter`, `Tab`, `Ctrl+U`, `Ctrl+K`, `Ctrl+W`, `Ctrl+A`, `Ctrl+E` and the word motions
  were literal strings, so rebinding `tui.editor.deleteToLineStart` in your `keybindings.yml` left
  the panel that exists to tell you what you had done still showing `Ctrl+U`. The rows that stay
  prose are the ones with no binding behind them: the arrow keys as a family, `alt+enter`, the
  push-to-talk `Space` hold, and the prompt sigils `/`, `!`, `$` and `#`.
- Eight keybinding ids that nothing read are gone. Every id in the table is printed by `/hotkeys`
  with a default key beside it and written into the generated `keybindings.yml` as something you may
  remap, so an id nothing reads is a documented shortcut that does nothing when pressed.
  `app.session.rename`, `app.session.togglePath`, `app.session.toggleSort` and
  `app.session.deleteNoninvasive` named actions the session selector does not have,
  `app.tree.foldOrUp` and `app.tree.unfoldOrDown` named a tree view that is not implemented,
  `app.session.delete` named an action the selector has but reaches by matching the literal `delete`
  and `backspace` keys rather than the binding, and `tui.input.copy` named a copy the editor does not
  implement. One of them was a lie rather than a silence: `app.session.toggleSort` claimed `ctrl+s`,
  which is `app.session.observe` and opens the Agent Control Center, so `/hotkeys` told you `ctrl+s`
  sorted your session list. An entry naming a removed id in your own `keybindings.yml` is kept and
  ignored, as it already was.
- Two functions no longer `await import("@veyyon/utils")` in a file that already imports it
  statically. The module was instantiated either way, so the await bought nothing and cost a promise
  per call.
- The list of setting TYPE tags has one owner. `settings-schema.ts` exports `SETTING_TYPES` and
  `isSettingType`, both derived from a `Record<SettingType, true>` so that adding a definition kind
  without listing it, or listing one that does not exist, is a compile error. The schema corpus test
  had kept its own copy of the list, which had drifted both ways: it named an `object` kind the
  schema never had, and it was missing `modelChain`, so `compaction.model` and `subagent.model` read
  as untyped.
- Class privacy is `#` everywhere it can be. `private` and `protected` are compile-time annotations that vanish at build time, so a `private` field is reachable from any code holding the object; AGENTS.md asks for the runtime-enforced `#` and exempts only constructor parameter properties, which have no `#` spelling. Six members are now `#`, and the four `ChatBlock` lifecycle hooks plus the one controller that overrides them are bare methods, because a `#` member cannot be overridden by a subclass and a hook exists to be overridden. `MnemopiSessionState` gained a `scoped` constructor option in the process: the failure suite had been building an instance with `Object.create(prototype)` and an `Object.assign`, which skips the constructor and therefore has no private fields at all, so the class now offers the bank bundle as a real seam and the test drives the real class through it.
- Veyyon no longer discovers `SYSTEM.md`, `.gemini/system.md`, or `APPEND_SYSTEM.md`. A whole-prompt file bypassed the assembled prompt and its settings gates, while the append file duplicated `AGENTS.md` at fewer scopes. Existing files remain untouched and produce an operator-visible launch notice with their exact path and the supported replacement. The per-invocation `--system-prompt` and `--append-system-prompt` flags remain, and `PROMPT_SECTIONS/` remains the persistent section-level mechanism.
- New profiles copy only `AGENTS.md` in the instruction row. `RULES.md` never travels during profile switching. The assembled project footer now gives the agent its active profile name, agent directory, skills directory, and the exact global and profile `AGENTS.md` paths.
- A model chain is valid written either way. `compaction.model` and `subagent.model` hold an ordered chain, and every reader has always accepted both a comma-separated string and a YAML list. The schema declared them `string`, so a config written as a list was reported as a value that "does not match its declared type" and shown as invalid while the runtime read it correctly, and the list form is what the handbook shows. Both are declared `modelChain` now, which admits either spelling and still reports a number, an object, or a list holding something that is not a pattern (naming which entry). The settings UI picks the model editor from that type instead of from a hardcoded pair of paths, so a third chain setting cannot silently become a text box.
- `inlineToolDescriptors: auto` follows the active model after a model switch. A session that started on Gemini previously kept Gemini's inline catalog after moving to a native OpenAI model because schema pruning was frozen at construction. Prompt placement, provider-schema pruning, side requests, and session dumps now resolve one active-model policy. The full built-in catalog integration saves at least 500 estimated provider tokens after the switch; the measured fixture saved 937.
- The default built-in system prompt is 742 estimated tokens smaller. Completion, evidence, cleanup, and delegation invariants each have one owner instead of being restated across sections. The default delegation path fell from 862 to 433 tokens, and native tool providers no longer receive a prompt inventory that repeats names already present in their schemas. Inline and non-native tool modes still receive full descriptors.
- The default system prompt has no monolithic prose template. `system-prompt.md` is now a checked
  scaffold containing only `{{templateSections}}`; statement modules own instruction text, and the
  section registry owns section order and banners. Assembly joins those sections directly, so prompt
  text containing JavaScript replacement tokens such as `$`` remains literal. `PROMPT_SECTIONS/` and
  eval section overrides accept body text only and cannot restyle a registry-owned banner.
- Prompt overrides now fail closed. An eval statement override is rejected when its gate is inactive
  or a whole-section replacement would discard it. Body-only overrides cannot inject any registered
  section banner, blank append files change no bytes, and `veyyon prompt --statements` prices the
  effective replacement text instead of the shipped text. An explicitly blank custom prompt remains
  a replacement and no longer emits an empty provider block.
- Changing a session's working directory now reloads the destination prompt inputs instead of
  rebuilding from startup captures. The cwd, `AGENTS.md`, workspace tree, repository context,
  project extension skills, rule inventory, and TTSR matchers move together. Non-TUI `/move` uses
  the same re-scope owner, so ACP, RPC, and headless sessions also refresh secrets and prompt state.
- `skill://` paths now use one canonical, session-owned resolver in every tool. Bash can no longer
  follow a child symlink outside the declared skill root, autocomplete and managed-skill collision
  checks no longer read another top-level session's skill inventory, and distinct authored skills
  with one name produce an operator-visible collision warning.
- Profile creation now distinguishes an absent optional seed item from unreadable or malformed
  source data. An `AGENTS.md` directory, a file named `skills`, or a genuine filesystem failure
  aborts creation with the source path instead of silently producing an incomplete profile.
- Layered context files no longer resend a less-prominent file when its entire normalized paragraph sequence appears contiguously in a later authoritative file. The comparison keeps paraphrases, noncontiguous blocks, and distinct parent/child instructions. The regression fixture removes 86 provider bytes (22 estimated tokens) per request; a comparison of the active 22KB and 40KB rule files took 0.36 ms during prompt preparation.
- `plugin doctor` and the LSP project detector probe the filesystem without blocking. Both ran a run of sequential `fs.existsSync` calls inside an `async` function: the detector checks up to six marker files in a row before doing any work, and doctor checks a package, a tools entry, a hooks entry and every extension entry for each installed plugin, so its probe count grows with the number of plugins. On a cold or network filesystem that is a stall the TUI cannot paint through. Both use `pathExists` from `@veyyon/utils` now, which also fixes a reporting bug in doctor: `existsSync` answers `false` for a path that exists and cannot be read, so an unreadable plugin entry, exactly the broken install doctor is for, was reported as "not found" and sent the operator looking for a file that was there.
- The two profile dispatchers are named for the surface each one drives: `runProfileCliCommand` in `cli/profile-cli.ts` and `runProfileSlashCommand` in `slash-commands/profile-command.ts`. Both were `runProfileCommand`. Their signatures differ enough that importing the wrong one cannot compile, which is why it lasted; the cost was on the reader, since a call site said nothing about which surface it drove and two test files each had a `runProfileCommand` in scope meaning a different function. `test/architecture/command-surfaces-do-not-share-names.test.ts` now fails when `cli/`, `commands/` and `slash-commands/` declare the same exported name, and `DEVELOPMENT.md` says what each tree owns. No behaviour change: `veyyon profile` and `/profile` do exactly what they did.
- `/agents` is the one agent surface. There were four. `/agents` opened a configuration list of every agent type the project offers, which is the Subagents settings table rendered a second time. `/cockpit` (alias `/hub`, the `app.agents.hub` and `app.session.observe` keys, and the double-tap-left gesture) opened a separate "Agent Hub" overlay with its own roster, its own ordering, its own status glyphs and its own drill-in. A third roster, the "subagent inbox", sat behind a `display.subagentInbox` flag with a fourth drill-in. Three of them rendered the same registry three different ways, so "which agents are running" had three answers that could disagree, and the operator had to know which screen they were on to read the one that was right. Every entry point now opens the same card, which has two views: **Live**, the roster of agents that exist right now, and **Comms**, the agent-to-agent message stream. `/cockpit` and `/hub` are aliases of `/agents` rather than a command of their own, so there is one description and one help entry.
- Opening an agent hands the main view to that agent's live session, so you can talk to it. Enter on a roster row retargets the transcript, the composer and the status line at the agent, and Esc there returns you to your own session; a parked agent revives on the way in. Every drill-in before this was a read-only pane inside the card, which could show you a subagent asking a question and gave you no way to answer it. Two agents still open the read-only transcript, because there is no session to hand over: an advisor, which is observability-only and is not an addressable peer, and a collab guest's agents, which live on the host.
- A roster row says what TYPE of agent it is, next to its call sign. A call sign is memorable but arbitrary, so `Kestrel` told you nothing about whether the thing burning tokens over there was a reviewer or a scout. The type was already recorded at spawn and was rendered only when the agent had NO activity to report, which is exactly when nobody is looking at the row. Rows sit in spawn order rather than by recency: call signs are assigned from that order, so a recency sort renamed agents as they worked, and the old hub had to freeze its order on open to stay usable.
- The **Comms** view streams agent-to-agent traffic as it happens, read from the message bus rather than from session files. A subagent's transcript records what THAT agent received, so a view built from transcripts shows each half of a conversation in a different file and never shows a message that failed to arrive at all. `IrcBus` now keeps a 500-message log of every delivery with its outcome, because mailboxes are drained on delivery and a peeked mailbox is empty by the time anyone looks. Failed deliveries are marked with the reason. Long messages are folded to their first few lines with a count of what was hidden, and `ctrl+o` unfolds them, the same key that expands a truncated tool result in the transcript.
- The card's age column advances again. It is repainted on a five-second ticker, and the pane it repaints had captured `Date.now()` when it was built, so the ticker paid for a repaint on a fixed cadence and the label it existed to update never moved. The scan for agents persisted by earlier runs now reports how many it registered and only repaints when that is more than zero, instead of rebuilding the roster one microtask after every open to draw the same rows again.
- Fixed a modal getting SMALLER as the terminal got bigger. `computeModalDims` took its vertical margin off both ends unconditionally, and the compact path zeroed that margin at 24 rows and under, so the two rules met in the middle of ordinary window sizes: a 24-row terminal gave a full-screen card and a 25-row terminal gave an 11-row card whose body had no room for a single list row. The Agent Control Center on a 25-row terminal, which is an ordinary split pane, showed an EMPTY box, and you needed a 38-row window to see what a 24-row one showed. Card height now has a floor that rises with the padding the card carries, the compact path sheds padding but not the margin, and the height a list gets is a non-decreasing function of terminal rows from 8 to 120.
- Page up and page down move the Agent Control Center. The card handled up, down, j and k and nothing else, so a fan-out of sixty agents or a stream of five hundred messages could only be crossed one row at a time. They come from the shared `tui.select.pageUp` / `pageDown` bindings, so it is the same key and the same distance as every other selector.
- The Live roster reads as a table. The call sign and type were padded to a column and the rest were not, so `running` on one row and `idle` on the next pushed the model and the activity three columns apart down the list. The age column was worse: `formatAge` treats an age of zero as UNKNOWN and returns nothing for it, so the busiest agent in the roster showed no age at all while one idle for forty seconds read `just now`, and every row that lost the column slid left. Status and age are now measured and padded like the names, and an agent that acted this second reads `just now`.
- One long agent type no longer costs every other row its content. Columns are padded to the widest value in the roster, so a single subagent spawned as `a-very-long-agent-type-name` padded the type column to 27 cells on every row; on a 56-column card that left nothing for the status, the model or the activity, and the roster stopped answering the question it exists for. No column may now take more than a quarter of the row. The model badge degrades with the space instead of being cut by the row: whole where it fits, `claude-son…` where it does not, and dropped rather than stubbed once too little of it would survive.
- A failed kill or hand-over says what happened. Both paths put the exception's own words on the notice line, so stopping an agent whose session could not abort announced `ref.session.abort is not a function. (In 'ref.session.abort({ reason: USER_INTERRUPT_LABEL })', ...)`: no agent, no action, nothing to do next. It now reads `Could not stop Kestrel: <reason>`, with the underlying reason kept at the end as evidence.
- The selected roster row is highlighted across the whole row. The fill was wrapped around the row's TEXT, so the band stopped wherever that agent's line happened to end and changed shape as you moved the cursor: a ragged right edge reads as a rendering fault, not as a selection. It now runs to the pane's edge and stops exactly where the scrollbar gutter starts, which is a width only the scroll view knows, so `ScrollView` answers it (`contentWidth`) rather than the row guessing. Guessing the full width would have been worse than wrong: the view truncates to make room for the bar, and the cut drops the escape that CLOSES the fill, painting the scrollbar and everything past it.
- The same ragged band is fixed everywhere else it appeared: the session tree, history search, the extension list (rows and hover), the OAuth picker, the model browser, the model hub and the plan review overlay. One helper pads the row and then tints it, so there is one place to read the rule and one place to change it. Underneath was a width the two owners disagreed about: the list helper reserved ONE column for the scrollbar while `ScrollView` reserves TWO, a gutter plus the glyph, so every row was built a column too wide and cut on the way out. The helper is gone; a list now receives the width from the view that will render it and cannot restate the reserve.
- The setup wizard's theme step picks a THEME, and its two modifiers compose with it. "Colorblind colors" and "ANSI-safe" sat in the list as if they were alternatives to a theme, and selecting either one FINISHED the step: you got `colorBlindMode: true` with your theme left at whatever it already was, or `symbolPreset: ascii` with `theme.dark` forced to `dark-terminal`. Neither is a theme choice, so a colourblind-safe LIGHT theme, or ASCII glyphs on Titanium, could not be asked for at all, and picking a theme afterwards silently reverted the modifier, because the theme rows restored the original state on commit. They are toggles now: selecting one flips it, repaints the preview with the new combination and stays in the step, and every commit writes both of them alongside the theme. The rows are rebuilt after the preview applies as well as before it, because the mark is drawn with the very glyph set the ASCII toggle controls, and building them once left the two checkboxes in unicode while the whole rest of the screen had switched to plain text.
- Twelve overlays got the modal height fix they were supposed to have. Each carried its own `height < 24` instead of asking the shell, and a threshold that depends on the card's own margin and padding is only ever right for one sizing, so when the shared rule was corrected the model hub, the settings picker, the session picker, the extension dashboard, the OAuth picker, history search, the copy and move overlays, the usage reset and message pickers and the plain select list all kept the cliff.
- The slash-command reference documents `/models`, `/status` and `/force:`. All three are aliases,
  and `/status` is the surprising one: it opens the Extension Control Center rather than anything
  about session status.
- The `Live` tab in the Agent Control Center counts the rows it shows. It counted only the running
  agents while the pane listed every one, so a roster with parked agents read `Live (17)` above
  twenty rows, and a roster with nothing running read `Live (0)` above a full pane.
- Agents spawned in the same millisecond are listed and named in spawn order. Ties were broken on
  the agent id compared as text, which put `10-Sub` between `1-Sub` and `2-Sub`, so a fan-out of
  twenty appeared as 1, 10, 11, 12, 2, 3 and the call signs were assigned in that order.
- Six glyphs in the `unicode` symbol preset rendered as empty boxes on a machine without a Nerd
  Font. `⟳` (running) is absent from DejaVu Sans Mono, so every busy row in the Agent Control
  Center drew a box where the status mark belongs, and `⤵`/`⤴` (the token in/out icons in
  the status line) exist in none of the monospace fonts checked. Running is `◐` now, in/out are
  `↓`/`↑`, and the worktree, gh and disabled marks changed for the same reason. The `nerd`
  and `ascii` presets are untouched.
- The unread-message badge on an agent row takes its glyph from the symbol preset instead of
  hard-coding one, so it follows the `ascii` and `nerd` presets like every other icon.
- A second, dead answer to "which model does this session start on" is gone. `config/model-resolver.ts` exported `findInitialModel` and `restoreModelFromSession`, a full precedence chain with its own `console.log`/`console.error` output and a `process.exit(1)` inside a library module. Nothing in the workspace called either one, not even a test: `main.ts` had grown its own resolution and the two had drifted, and `docs/models.md` documented the dead order as the live one. Both functions and their registry type aliases are deleted, and the doc now describes what `buildSessionOptions` actually does, including the deferred resolution for a bare model id an extension may register and the loud substitution when a remembered default is unavailable.
- An empty icon no longer leaves its space behind. A symbol preset may leave an icon blank and the unicode preset leaves thirty-one of them blank, so a label written as `` `${theme.icon.job} ${count}` `` rendered ` 5`: a leading space and a number with nothing saying what it counts. The status line showed it worst, several metrics side by side with unlabelled numbers between them. The join is one leaf function now, `modes/theme/icon-label.ts`, which emits the separator only when there is an icon to separate; it had existed as a private helper inside the status line's segment builders while twenty-nine hand-written copies across thirteen files did not use it, which is why the gap appeared in some parts of a line and not others. Every icon-then-label site goes through it, and a repo-wide ratchet keyed on the SHAPE rather than on a file list fails if the template is written by hand again.
- Secret protection now closes every provider-bound path, including compaction, commit analysis, benchmarks, evaluation, Hindsight, Mnemopi, memory extraction, title and thinking classifiers, task labels, TTS, image tools, resumed assistant text, and dynamic prompts and schemas. Each physical attempt rebuilds from raw text with the live profile, project, environment, and vault runtime after credential refresh. Authenticated replay fields fail closed when they contain a live value, JSON keys are protected with collision checks, provider-bound images are canonically re-encoded without metadata, and credential-bearing URLs bypass cloud readers. Unnamed values and generated one-way aliases use machine-keyed HMAC derivation; replacement output is atomic; ambiguous regex alternations are refused; and ill-formed Unicode cannot enter placeholder generation. Working-directory rescoping rolls back transactionally. Vault files reject scope aliases, hard links, legacy unbound envelopes, oversized descriptors, and stale-lock reaper races. Audit generations reject hard links and oversized reads, recover non-newline tails safely, protect JSON keys, and escape terminal control bytes. Inline `/secret add` preserves exact trailing bytes and rejects option-like text after credential data begins.
- Vault storage now pins open physical scope and key directories for every transaction. Kernel no-replace and exchange publication preserves a racing destination, key creation uses one crash-atomic winner, and interrupted key stages recover idempotently under concurrent readers. Vault authentication includes the canonical path and physical scope-directory identity. Runtime revisions include inode, time, link, permission, and ownership changes. Existing key and vault permissions fail closed on POSIX and Windows, and write preflight rejects encoded plaintext over 6,291,402 bytes before encryption.
- SDK hosts can set `globalConfigRoot` in `createAgentSession()` to isolate the cross-profile vault and machine key from the host user's Veyyon data. The omitted default remains `getGlobalConfigRootDir()`. Secret runtime setup now captures one root for creation and refresh, and records the vault revision after key initialization so the first provider attempt does not misread key creation as an external vault change.
- Session loading now refuses a non-empty transcript with a corrupt header without rewriting it. Recoverably malformed later records produce one content-free operator notice with their path, line, byte offset, and shape problem. Working-directory and session-file moves are transactional through file, memory, Redis, and SQL-backed storage, include artifacts, roll back after a failed final header write, and participate in global listing and orphan-backup recovery without requiring a local mirror.
- Concurrent SDK sessions now own independent secret-notice registrations, so disposing one cannot detach another's warnings. Vault add and authenticated-load boundaries reject ill-formed UTF-16 without replacing ciphertext. Runtime expiry notices distinguish immediate in-memory revocation from the encrypted entry that a later successful vault refresh prunes.
- Default Effort treats any explicitly stored `defaultEffort` object, including `{}` or model-only rows, as authoritative over the retired global value. Scoped model cycling re-reads current per-model defaults unless a selector carries an explicit suffix; alias suffixes replace stored suffixes; role displays resolve the concrete model row; and CLI selector effort no longer leaks into later models as a session override.
- ACP and text dispatch reject argument tails for commands that do not accept them while `/model` retains its argument. Extension and custom commands accept every canonical whitespace separator. Compaction dividers and modal selector footers show live remapped keys and omit unbound actions, and extension headers no longer retain a gap for an empty preset icon.
- Bold, italic, underline, strikethrough, and inverse attributes no longer disappear when color detection is disabled or unavailable. The theme emits its attribute-specific SGR pairs directly, so markdown emphasis, reasoning text, selected tabs, and wrapped inverse diffs remain readable without relying on color support.
- Compaction retry messages marked `queueOnly` remain in the user queue rather than starting an idle turn. Image-bearing skill retries preserve their user attribution and queue label after canonical image normalization.
- Secret runtime refresh now follows the session manager's authoritative working directory. A request that retained an older scope cannot supersede an in-flight move back to that scope, while unchanged vault revisions reuse the exact existing lease. SDK disposal now shares one transaction across concurrent callers, forwards the first caller's shutdown options, and detaches listeners and registries even when audit flushing fails.
- A misspelled key in a model's `compat.reasoningEffortMap` is now reported when the config loads instead of being accepted and ignored. The map remaps a thinking level to whatever string a given OpenAI-compatible server calls it, so every key names a level; a key that names none, `hihg` for `high`, validated, was carried into the config, and then never matched, so the remap silently did not happen and the level went to the provider verbatim. That is the exact failure the map exists to prevent, and nothing about it was visible: the config loaded, the request succeeded, and the effort was wrong. The schema rejects undeclared keys and names the offending one.
- The models-config schema no longer keeps its own copy of the effort ladder. `EFFORT_ORDER` is `THINKING_EFFORTS` from `@veyyon/catalog/effort`, and the literal union `EffortSchema` still spells out (ArkType infers a literal union only from a literal definition, and generating it would infer as `string`, leaving every `defaultLevel`, `minLevel` and `maxLevel` unchecked) is verified against the owner when the schema is built. Adding a level to the ladder and forgetting this file used to produce no build error and no runtime error either: the new level was rejected as unknown, so the failure arrived as a validation message against the user's own config file.
- The Unix installer says `curl is required and is not installed` instead of blaming GitHub. Every fetch it makes is curl, so on a machine without it the first request failed exactly the way an unreachable host does and the install died with "could not reach https://github.com/santhreal/veyyon/releases/latest (network error, or GitHub is down)" while the network was fine. The user then goes looking at DNS, a proxy and a firewall for a missing package. Minimal container images and stripped CI runners are where this happens, and they are also where people reach for `wget -qO- ... | sh`, which is how you get here with wget present and curl not. The check runs before any install path and names the package manager command; an uninstall does not need curl and is not gated on it.
- One malformed line in a session file costs its own turn, not the whole transcript. An assistant record written without its `usage` field threw while the transcript was being BUILT, so the viewer died in its constructor: no rows at all, and nothing on screen saying why. The loader was lenient about lines it could not DECODE and blind to lines that decoded to the wrong SHAPE. Both read paths, the ordinary one and the streaming one that takes over at 8MiB, now check a record against what the readers actually dereference before handing it over, and report what they dropped and why. A rejected record is never repaired: a turn that claims `0` tokens it did not use is a wrong number in the transcript and in every total taken from it, and nothing on screen would ever say it was invented.
- The Comms stream names agents the way the Live roster does. It printed the raw ids the message bus records, so a room view whose whole point is that you follow a conversation by who is speaking showed `0-Sub → 1-Sub`: a pair of spawn-scoped tokens you had to look up on the other view, which is exactly what call signs exist to replace. Both ends now print the call sign, and an agent that has since been released prints its id, because two different departed agents reading as one placeholder is worse than an id.
- The scroll wheel moves the card. A wheel report over it was decoded, matched against no chrome, and consumed anyway, so the scroll neither reached the card nor fell through to anything else: a roster longer than the card could only be moved by keyboard, and the wheel read as broken rather than unsupported. It now moves whatever the arrow keys move, the roster cursor on Live and the stream on Comms.
- You can click a roster row to open that agent, and click a name in the view strip to switch views. The card was keyboard-only inside its own borders: every mouse gesture that did anything belonged to the shell around it (the close glyph, a footer chip, a click outside to dismiss), so a row drawn with a cursor on it that did nothing when clicked read as a broken control rather than a keyboard-only one. A row click OPENS rather than only selecting, because the row's one action is "open this agent" and asking for a second gesture to do what the first already said is the friction; Esc in the agent's session returns you to your own, so nothing about it is one-way. A click on the blank space under the last agent, on the chrome, or in the Comms stream does nothing.
- The card stays readable on a terminal that renders no colour. The selected roster row and the active view tab were each marked by a background tint and nothing else, and a tint is not applied at all under `NO_COLOR`, on a dumb terminal, or in a piped capture, so on those you could not tell which agent `enter` would open or which view you were looking at. The selected row now carries the same nav cursor glyph every other picker in Veyyon draws, in a slot inactive rows reserve. The active tab uses brackets while inactive tabs reserve the same width. It also takes the shared overlay tab theme for bold and tint when the terminal permits them.
- `IrcBus.send` records every leg it attempts, including one that throws. It logged on the paths that RETURN a receipt, which is every failure the bus knows how to describe, but the registry read that opens a delivery, the waiter hand-off and the mailbox enqueue all sit outside a try. A collab guest's registry is a mirror of the host's and can fail on a read, and a throw there left a message that was really sent absent from the Comms view, which reads as a message nobody sent. The throw is recorded as the failure it is and then rethrown unchanged, since the log is a display feed and must not change what the caller sees.
- `display.subagentInbox` is removed, along with the layout behind it. The Subagents settings tab already owned the per-agent table the `/agents` configuration list duplicated, so nothing is lost with it: `/settings` is where you decide whether an agent is offered and what model it runs on, and `/agents` is the live picture.
- Asking which slash commands an ACP or RPC client can drive no longer loads what they do. Three places needed the same answer, and all three got it by reading `command.handle !== undefined` off the assembled registry: the command list advertised to a client, the reserved names that stop an extension shadowing a builtin, and the available-commands list. `handle` is a function, so reading it meant loading all 67 handler bodies. A command now DECLARES `textMode` beside its name, and the handler table is typed against that flag: a command with `textMode` must supply a text handler and one without it may not, so the flag cannot drift from the fact it stands for. `slash-commands/available-commands.ts` went from 959 modules to 192, and the new `slash-commands/text-mode-builtins.ts` answers all three questions in 4. Dispatch stays in `slash-commands/acp-builtins.ts` and still loads the handlers, because it runs one.
- Knowing that a slash command exists no longer means loading what it does. The builtin registry held 67 objects, each carrying a command's name, aliases and description next to the handler body that implements it, and a handler body reaches the model resolver, the collab host, the OAuth providers and the session store. The names now live in `slash-commands/builtin-declarations.ts`, which reaches 3 modules, and the registry attaches handlers to them through a table keyed by the declared names, so a handler for a command that does not exist and a command with no handler are both compile errors rather than something a test has to notice. The extension loader, which imports the reserved names and nothing else, went from 945 modules to 178, `modes/runtime-init.ts` from 947 to 219, and `veyyon -p` from 949 to 221.
- An `apply_patch` streaming preview shows its file path instead of the wire handle. The fields a renderer reads mid-stream are listed per tool name, but the renderer they feed is bound to more than one name: `apply_patch` is the same object as `edit`, and it had no list, so it fell through to a regex that slices the path out of the raw JSON buffer. That buffer is deliberately left unexpanded, since a handle can expand to text holding a quote or a newline and splicing it in would corrupt the JSON the next frame parses. The two names now share one list, so the heading reads the real path for the whole call rather than after the first full parse, which for a long patch is most of it.
- Four more modules name the module that declares the function they wanted rather than the `@veyyon/ai` entry point, which re-exports the whole package and reaches 363 modules. `config/api-key-resolver.ts` wanted `isUsageLimitOutcome`, a predicate over a status code that lives in a module with no imports at all, and went from 364 modules to 42; `commit/shared-llm.ts` from 368 to 112; `mcp/manager.ts` from 613 to 498; `web/search/providers/perplexity.ts` from 372 to 327. The two spellings differ by one keyword, since `import type` is erased and free, which is why this kind of edge accumulates without anything failing.
- A streaming tool-call preview shows the text a handle stands for. Argot replaces long repeated strings on the wire with `§handle` fragments and expands them just before a tool runs, so for the whole time a call streamed the preview drew `§db` where the file body belonged. The codec now reaches both the live reveal and the rebuilt one, and expansion happens on decoded VALUES rather than on the partial JSON they came from: a handle can expand to text containing a quote, a newline or a backslash, and splicing that into the buffer would corrupt the JSON the next frame has to parse. A custom tool's stream is raw text rather than JSON, so both its fields expand. With argot off, which is the default, every path is byte-identical.
- The session backup name is written and read through one owner. `session-storage.ts` moves a transcript aside when it cannot rename over it, and `session-listing.ts` had hand-rolled the inverse parse to recover sessions stranded by a crash between the two renames, one file away from the template it was inverting. The gc glob and the two listing filters that exclude backups now spell the suffix once as well.
- Declaring the web-search tool no longer loads the credential store. `web/search/index.ts` is the module eighteen providers sit behind, and it imported `discoverAuthStorage` statically from a module that reaches the auth broker client, the remote store, the snapshot cache and the SQLite credential store: 347 modules for a function that only runs when a search executes. It is loaded on demand inside the three call sites now, which were already `async`, and the file went from 517 modules to 252.
- The usage CLI, the models CLI, the `token` command and the plugin doctor no longer import the whole application to find out where credentials live. `discoverAuthStorage` is declared in `session/auth-broker-config.ts` and re-exported from `sdk.ts`, and for those four it was the only name they wanted from the barrel; all four are now clean of it.
- Two more values are read from the module that declares them rather than through a barrel. `modes/session-observer-registry.ts` subscribes to two task event channels by name and had taken those two strings from the `../task` barrel, 1,406 modules to know what a channel is called; it names `task/types.ts` now and reaches 24. The slash-command browse order moved to `slash-commands/category-order.ts`, because reaching it through the builtin registry meant importing every command implementation, and the autocomplete that arranges menu headers wanted nothing else from there.
- The session transcript extension and the advisor transcript name come from `@veyyon/utils/session-file`. The session manager, session listing, the gc CLI, HTML export, the Agent Hub, the debug bundle, the `history://` registry helper, the task executor and the read tool had each spelled `.jsonl` themselves, in four incompatible forms: a string, a length constant, `path.basename(file, ".jsonl")` which also strips the directory, and `slice(0, -6)`. The gc CLI's globs and its compressed-session suffix now derive from the extension, so changing it moves the archive form too.
- Reading a setting no longer means importing the module that writes it. `config/settings-instance.ts` owns the process-global slot, the `settings` proxy over it and the test-reset registry, at one module and with no runtime imports; `config/settings.ts` fills that slot and re-exports the names callers already use. Thirty-one modules imported the 95-module store and used nothing but a value: the vault URL handler asked whether the vault is enabled and paid 32 marginal modules for the question, `modes/theme/markdown-theme.ts` imported it to register a test-teardown hook, and `tools/output-meta.ts` reached it for `getDefault`, which the schema owns and the store only re-exports. The settings store is now off the graphs of `tools/read.ts`, `tools/fetch.ts` and `web/search/index.ts`, and off every internal-URL handler.
- `Settings.init()` records the promise that fills the singleton slot rather than the bare load it derives from. The bare load settles first, so a second caller that joined it could resume from `await Settings.init()` before the slot was filled, see `isSettingsInitialized()` return false in a process that was initialising correctly, and fall back to a default with nothing thrown.
- `web/search/providers/perplexity-auth.ts` re-exports its published `OPENROUTER_BASE_URL` from `@veyyon/catalog/provider-endpoints` instead of declaring the host itself.
- Four values that one module produces and another matches now have one owner each: the legacy shim's `__isToolDefinition` marker, the default plan file URL, the MCP protocol revision, and Anthropic's `web_search` tool name. Each was declared on both sides of the boundary, and a drift in any of them is silent. The plan URL was the worst: nine spellings, four of them inline in `session/agent-session.ts`, which is the module that decides it. Plan protection compares an edit target against that URL, so a drift meant plan mode reporting that it was protecting the plan file while an edit to that exact path went through.
- The Gemini web-search provider reads the developer API base from `@veyyon/catalog/provider-endpoints`. Its copy was the third spelling of a URL whose `/v1beta` segment every consumer has to agree on.
- `tools/eval.ts` no longer carries the module that draws eval results. It runs language kernels, and it had two edges to `tools/eval-render.ts`, which brings `Markdown` and `Text` from `@veyyon/tui`, the theme engine, the markdown theme and the settings store with it: one imported `upsertStatusEvent`, a ten-line array helper now living in `src/eval/status-events.ts` beside the event type, and the other re-exported the renderer for consumers that did not need the indirection. `modes/components/tool-execution.ts` had been importing the whole tool to read a preview-line count and now reads it from the renderer. The tool went from 801 modules to 638.
- The Perplexity search provider reads its client identity from `@veyyon/catalog/wire/perplexity`, including the `version` field of the ask request body, which is the same value the `X-App-ApiVersion` header carries and was the copy furthest from the header it has to agree with.
- `browser-headers.ts` states the Chrome version it claims once, and exports `CHROME_DESKTOP_USER_AGENT` and `CHROME_WINDOWS_USER_AGENT` derived from it. The `Sec-Ch-Ua` client hint and the User-Agent had each spelled the version as a literal, and a fingerprint whose two version claims disagree is what a bot check compares. `web/scrapers/types.ts` used Chrome 131 as the last rung of its bot-block escalation ladder while this module claimed 149, so the attempt that has to get through announced the stalest browser of the three; it now reads the shared Windows User-Agent.
- The Codex web-search provider reads the account id out of a token through `@veyyon/catalog/wire/codex`. It had declared its own copy of the claim namespace while already importing three other constants from that exact file in the same import statement.
- Reads `BEL`, `SGR_BG_RESET`, `SGR_INTENSITY_RESET` and `OSC66` from `@veyyon/tui/ansi` instead of redeclaring them. `\x07` had three local names, `BEL` in `tui/hyperlink.ts`, `OSC_TERMINATOR_BEL` in `utils/enhanced-paste.ts` and `SIXEL_END_BELL` in `utils/sixel.ts`, so the sixel scanner and the paste decoder each decided independently what closes an OSC sequence. `modes/theme/shimmer.ts` called `\x1b[22m` `BOLD_CLOSE` and `modes/components/diff.ts` called it `DIM_OFF`, and it is both: cancelling dim inside a bold run also cancels the bold.
- A long-running eval cell no longer grows its retained output without limit: `capExecutionOutputLines` in `modes/components/execution-shared.ts` bounds it at five screenfuls, the same bound the bash block already had.
- An execution block now says how many output lines it dropped while streaming, in its own note, instead of folding them into the "… N more lines (ctrl+o to expand)" hint. The bash block used to drop the oldest lines and then compute that hint from the already-trimmed buffer, so a five-thousand-line run reported eighty hidden lines and expanding revealed a hundred. The two are different facts: hidden lines are still held and expanding reveals them, dropped lines are gone.
- The bash and eval execution blocks share one output-line clamp, `clampExecutionDisplayLine` in `modes/components/execution-shared.ts`, and it measures terminal columns. Both components declared `MAX_DISPLAY_LINE_CHARS = 4000` and both had a private `#clampDisplayLine`, but bash measured `visibleWidth` and eval measured `line.length`, so one named limit meant two different things. Eval's half charged a syntax-highlighted line for the ANSI escape bytes a user cannot see and truncated it while it still displayed far short of the limit, let a wide-character line through at twice the budget because it counted a two-column character as one, and cut at a code-unit offset that can land inside an escape sequence or a surrogate pair. The column measurement is the correct one and is now the only one. The twenty-row preview height both components declared is shared as `EXECUTION_PREVIEW_LINES`.
- The three option labels the ask runtime adds to a question (`Other (type your own)`, `Chat about this`, `Next →`) are declared once in `tools/ask-option-labels.ts`, together with the reserved-label predicate. They were declared in three modules under two sets of names, and each is compared by string equality to decide behaviour, so a drift between the module that renders a label and the module that compares it does not fail loudly: the branch never runs and the label is handed back to the model as though the user had typed it. A user who picks the free-text option to answer in their own words gets no prompt, and the model is told their answer was the words "Other (type your own)".
- The agent surfaces take their three shared interaction timings from `modes/components/agent-view-timings.ts`. The Agent Hub and the Subagent Inbox had each declared `AGE_TICK_MS`, `DATA_CHANGE_RENDER_COALESCE_MS` and `LEFT_TAP_WINDOW_MS` with the same values, and the inbox's comment on the gesture window said "matching the hub", which names the coupling without doing anything about it. Both views were then replaced by the Agent Control Center and the coupling outlived them: the card owns the age tick and the coalesce window, the input controller owns the double-tap window for the gesture that opens the card, and its own 500ms literal is gone. Drift there is felt rather than abstract: a relative-time column refreshing at two rates, or a gesture needing one rhythm to open a view and another to leave it, which reads as the gesture not working. The owner is a leaf with no imports, deliberately NOT `agent-status-display.ts`, whose doc makes it the owner of the AgentStatus visual language and which imports the theme engine to do that.
- The collab relay client takes the fatal close codes and the reconnect send bound from `@veyyon/wire/relay`. Both were declared here and again in `@veyyon/collab-web`'s browser client, character for character; an unlisted code is transient by definition, so a fatal code that only one client knew about would have made the other reconnect forever against a condition that will never clear.
- Every eval kernel takes its shutdown grace, its interrupt escalation window and its two naming conventions from `eval/kernel-base.ts`, which already owned the startup floor for exactly this reason. `SHUTDOWN_GRACE_MS = 1_000` was declared in all three language kernels and a FOURTH time in the Julia executor's session reset, so a language given a longer shutdown in its kernel would still have been killed at one second when its session was reset; `INTERRUPT_ESCALATION_MS = 5_000` was declared three times, though it describes a user's patience behind Ctrl-C rather than anything about an interpreter. The two conventions matter more than the duplication: `VEYYON_<LANGUAGE>_IPC_TRACE` is a name a user types and each kernel formatted its own, so nothing stated the convention and a fourth language had no reason to follow it, and the same went for `<tmpdir>/veyyon-<language>-runner`. Both are now helpers (`kernelIpcTraceEnvVar`, `kernelRunnerCacheDir`), the path one joining with `path.join` as the three call sites did rather than with a slash. `VEYYON_RUBY_IPC_TRACE` and `VEYYON_JULIA_IPC_TRACE` existed and were undocumented; both are in the environment-variable reference now, with the convention stated.
- The Antigravity endpoint switch in `session/agent-session.ts` reads its two hosts from `@veyyon/catalog/provider-endpoints` instead of spelling them inline, and `tools/image-gen.ts`, `web/search/providers/gemini.ts`, `session/agent-storage.ts`, `session/history-storage.ts`, `mcp/oauth-flow.ts` and `modes/components/custom-editor.ts` each stopped declaring a value another package owns: the Google Cloud Code and Antigravity hosts, the SQL `now`-in-seconds expression that stamps the history and model-performance tables, the default OAuth callback path, and the bracketed-paste markers. Behaviour is unchanged; each value now has exactly one place a change to it can be made.
- Twelve modules stopped importing the `@veyyon/utils` barrel whole for one or two names, which takes the barrel off `tools/read.ts`'s graph entirely. The barrel is 81 small leaf modules, and an edge to it only leaves a closure when the LAST path does, so this had to be all twelve at once: `internal-urls/vault-protocol.ts` wanted `$which`, `lsp/utils.ts` wanted `truncate`, `tools/render-utils.ts` five formatters, `web/scrapers/types.ts` one. Each now names its owner (`@veyyon/utils/which`, `/format`, `/byte-truncate`, `/path-tree`, and so on), with the name-to-owner map read off the barrel's own re-export list. Measured: `session/session-context.ts` 130 -> 82, `session/messages.ts` 122 -> 74, `tools/render-utils.ts` 177 -> 139, `internal-urls/index.ts` 231 -> 205, `tools/read.ts` 468 -> 449, and 822,349 module instantiations across the test suite.
- Rendering a code cell no longer loads the theme engine. `modes/theme/theme-binding.ts` exists so a module can read the ACTIVE theme without importing the loader that sets it, and its doc warns that a value import of `modes/theme/theme` puts the engine back in front of every reader. That is what had happened one function away: `modes/theme/markdown-theme.ts` took `getSymbolTheme` from the engine for one field, and `tui/code-cell.ts` took `highlightCode` from it, which the engine merely forwards from `modes/theme/highlight` (24 modules against 282). A box-drawing character set and a syntax highlighter were carrying theme JSON loading, the hundred embedded theme modules and mermaid rendering into every rendered cell, and through `tools/read.ts` into every file read. `getSymbolTheme` now lives in `modes/theme/symbol-theme.ts`, a two-module leaf beside the binding, re-exported from the engine so the eight callers that already reach it are unchanged; nine modules that render code name the owner of what they use. Measured: `modes/theme/markdown-theme.ts` 319 -> 175, `tui/code-cell.ts` 327 -> 220, `tools/read.ts` 648 -> 542, `modes/components/diff.ts` 288 -> 181. Three of the nine did not move on the first pass, because the engine also arrived through a different import, and those paths were four hops of forwarding: `tools/bash.ts` and `tools/write.ts` took three names from the local `tui` barrel, which `export *`s `tui/file-list.ts`, and that module took `getLanguageFromPath` from the engine rather than from the one-module table it lives in; `modes/components/eval-execution.ts` took its symbols through `modes/components/execution-shared.ts`. With those repointed too: `tui/file-list.ts` 289 -> 180, the local `tui` barrel 352 -> 246, `tools/bash.ts` 504 -> 353, `tools/write.ts` 536 -> 386, `modes/components/eval-execution.ts` 299 -> 193, and 832,035 module instantiations across the test suite instead of 859,485.
- The prompt registry now holds one row module per prompt directory, and `prompts/registry.ts` aggregates them. It held all 163 `import ... with { type: "text" }` specifiers itself, so importing it to read ONE prompt reached all 163: a tool renders its own description from a row, and `tools/read.ts` paid 167 modules for that one string. 95 files in this package had the same edge. Each of the twenty-one directories now owns its rows in `<directory>/rows.ts` and consumers take the directory they belong to (`toolsPrompts["tools/read"]`), which is 51 modules for `tools/` and 3 for `steering/`. `PROMPTS`, `PromptId`, `PROMPT_IDS`, `promptText`, `requirePrompt` and `codingAgentPrompts` are unchanged, so no consumer had to change; the three modules that genuinely span directories still take the aggregate. Measured: `tools/read.ts` 761 -> 647, `session/steering-envelope.ts` 216 -> 86, and 859,485 module instantiations across the test suite instead of 893,359. The coverage gate now checks the same invariant one level deeper: every `.md` is imported by exactly one row module, every row module is aggregated by `registry.ts`, and nothing else in the repository may import a `.md`.
- Two re-export shims stopped naming the `@veyyon/utils` barrel. `utils/fetch-timeout.ts` forwards five timeout helpers and `web/search/utils.ts` forwards `collapseWhitespace`, and both took them from the barrel, so a shim whose whole content is a re-export list put 82 modules on its callers' graphs. They now name `@veyyon/utils/scoped-timeout`, `/abortable` and `/collapse-whitespace`. Every web-search provider is 53 modules cheaper (`web/parallel.ts` 217 -> 164) and both shims are 2 modules.
- `--ref 1.0.37` installs the same release as `--ref v1.0.37` on both installers, instead of refusing a version that exists. Releases are tagged with a leading `v` and the bare version is what people type, so the old refusal stated a true fact ("release tag not found: 1.0.37") and left the user to guess which of the two spellings this project uses. The tag you named is looked up first and the `v` form second, and the installer prints `resolved 1.0.37 to the published tag v1.0.37` before it downloads anything, so the version being installed is the version on screen rather than something inferred quietly. Only a string that reads as a version gets the second lookup: a branch or a commit is not a version, `vmain` is a tag nobody has, and a wider search would risk installing a version the user never named. 8 assertions per installer, including that a branch, a commit and a missing `v`-tag each cost exactly one lookup.
- The Windows installer stops opening with "Restart your terminal" when the terminal does not need restarting. The documented install is `irm https://veyyon.dev/install.ps1 | iex`, which executes in the caller's own session: the installer sets `$env:Path` there, so `veyyon` works in that window immediately. Leading the closing steps with a restart was both untrue and the first thing the user read. Run as `pwsh -File install.ps1` the installer is a child process whose `$env:Path` dies with it, and the restart is real, so that form still leads with it. `$PSCommandPath` tells the two apart: a script invoked from a file knows its own path, and code handed to `Invoke-Expression` as a string has none. Either way the block still says that terminals open elsewhere pick up the new PATH entry when they restart, because that is true in both cases and is a note rather than a step.
- `VEYYON_INSTALL_DIR` with a trailing slash installs to the same place as one without, instead of leaving a PATH entry the installer cannot recognize as its own. `install_dir()` returns the path unchanged, and everything downstream compares it as a string: the membership test asks whether `":$dir:"` appears in `$PATH`, and the uninstall matches the rc line back byte-for-byte. So `VEYYON_INSTALL_DIR=$HOME/.local/bin/` wrote an entry that the next run did not recognize, added a second one, and then left both behind on uninstall. Trailing slashes are stripped now, `/` excepted since there the slash is the directory, and a `HOME` spelled with one no longer builds `/home/you//.local/bin`. This is the POSIX half of the same rule `Get-NormalizedPathEntry` applies on Windows; `environments.toml` gained a case that installs into the trailing-slash spelling for real and runs the whole contract against it.
- The Windows installer recognizes a PATH entry it wrote even when Windows hands it back quoted or padded, so a reinstall no longer appends a second copy of the install directory and an uninstall no longer strands one. A real `%PATH%` is not a clean list: entries arrive wrapped in double quotes, which is legal and is what installers write around a path containing a space, and padded with spaces, which `PATH=%PATH%; C:\tools` leaves behind. The presence check compared raw strings with only a trailing backslash trimmed, so `"C:\Users\you\.veyyon\bin"` did not match `C:\Users\you\.veyyon\bin` and every re-run added the directory again. `Get-NormalizedPathEntry` is now the single owner of what makes two entries the same directory, and the add, the presence check and the removal all go through it, so they cannot disagree in the direction where one adds an entry the other cannot find.
- The startup update check no longer calls the GitHub API, so several agents behind one address can no longer lock each other out of updating. `api.github.com` allows 60 requests an hour per IP without a token, and that budget belongs to the address rather than to the process: an office, a CI fleet or a container host running several sessions spent it on launches alone, and every machine behind that address then reported that it could not check for updates, on a machine where nothing was wrong. The version now comes from where `https://github.com/santhreal/veyyon/releases/latest` redirects to, which is not on that budget, matching what the installer already does. It is a HEAD request with `redirect: "manual"`, so the release page's own body is never downloaded either. The rollback picker still reads the API, deliberately: a list of every published version has no redirect equivalent, and it runs when someone opens the picker rather than on every launch.
- The installer no longer calls the GitHub API, so installing repeatedly from one address cannot fail on a rate limit. `api.github.com` allows 60 requests an hour per IP without a token, and that budget is shared by everyone behind the same address; the release lookup spent one of them on every install, so a CI fleet, an office NAT or a container host doing a few dozen installs in an hour started getting `403` on a machine where nothing was wrong. An adversarial matrix of 39 installs from one container hit exactly that, six times, on an installer that was working perfectly. The newest tag now comes from where `github.com/santhreal/veyyon/releases/latest` redirects to, and a `--ref` is checked against its tag page, both on the same host the binary is downloaded from and neither counted against the API. `GITHUB_TOKEN` and `GH_TOKEN` are no longer read, because there is no longer a limit to raise.
- Neither installer downloads the release page it does not read. The tag is in the URL the `/releases/latest` redirect lands on, and a `--ref` check only asks whether a page is there, so both requests fetch headers only. A GitHub release page is a few hundred kilobytes, transferred and discarded on every install.
- The Windows installer works on Windows PowerShell 5.1, which is what `irm https://veyyon.dev/install.ps1 | iex` actually runs under on a stock Windows box. Three of its defaults broke an install that was otherwise fine. Its `SecurityProtocol` still includes SSL 3.0 and TLS 1.0, and GitHub has required TLS 1.2 since 2018, so every request failed with "The request was aborted: Could not create SSL/TLS secure channel", an error that names nothing about the real cause; TLS 1.2 is now added to whatever the machine already allows, never assigned over it. Without `-UseBasicParsing` it hands each response to Internet Explorer's parsing engine, which is absent on Server Core and refuses to run wherever IE's first-launch configuration was never completed, so the download failed with a message about a browser the install never mentioned. And its progress bar repaints per read on a synchronous download, which on a 300 MB binary dominates the transfer; it is suppressed for the download and restored afterwards. The release lookup no longer depends on how the two PowerShells each treat an unfollowed redirect either: it asks `HttpWebRequest` with redirects off, which answers the same way on both.
- The doc-path gate stopped calling build outputs rot. A doc that says where the build puts something names a path no clean checkout contains, and the gate reported five of those as docs pointing at nothing: the benchmark's `runs/` and `repo-cache/`, napi-rs's `.build/`, and both references to `tool-views.generated.js`. It asks `.gitignore` now, because the repository already answers "is this generated?" in exactly one place and a second list kept beside it would drift the first time a build output moved. Ordinary rot still fails, and the ratchet baseline is untouched: that list is a promise to remove a dead path, and these paths are alive. Three docs that pointed at brand notes which are local to one machine and never distributed now name the shipped conformance test instead.
- The Windows installer opens with the sun. `install.sh` grew the mark and `install.ps1` did not, so the same product introduced itself two different ways depending on the platform. It is the same seven cells from the same owner: four bands of the ember ramp in `sun.ts`, drawn as lower blocks of rising height so the silhouette is a dome rather than a rectangle, and a parity test fails when the two stop agreeing about the color. Windows Terminal gets the colored form; the legacy console host renders those glyphs as mojibake whatever color they are, so it gets the plain ASCII one, and a pipe gets nothing at all. It is not printed over an uninstall.
- Uninstalling says that the shell it ran in has not caught up yet. A profile is read when a shell starts, so the shell running the uninstall keeps the `PATH` entry the uninstall has just deleted from the file, and bash and zsh also cache where they last found a command they have run. Typing `veyyon` straight afterwards answered "No such file or directory" for a path the user can plainly see is gone, which reads as a half-finished uninstall rather than as a shell that has not caught up. The verdict is followed by the reload command, and only when a `PATH` line was actually removed. Windows says the same thing for the same reason: a `PATH` entry lives in the registry and reaches a process when that process starts, so every terminal already open still holds the entry the uninstall removed.
- The installer's closing steps put the shell reload ahead of the command that needs it. A shell profile is read when a shell starts, and the shell running the installer has already started, so an install that had just added `~/.local/bin` to that profile then opened with "1. Launch in any repository: veyyon" — the first thing a new user types after a successful install, answered by `command not found`, which reads as a broken install rather than as a shell that has not caught up. The reload is a numbered step now, first, naming both `exec $SHELL -l` and the profile to source instead, and the rest renumber behind it. An install onto a directory that was already on `PATH` adds no such step, because there the command really does work immediately. The Windows installer prints the same block: it had three copies of a one-line closing message, one per install mode, each naming `vey` unconditionally even on a machine where the installer had just declined to create it because the user owns that command, and none of them mentioning `setup` or `--help` at all.
- The `PATH` line the installer writes quotes the install directory, so a home directory whose name contains `$`, a backtick or a backslash no longer expands when your shell profile is sourced. `export PATH="$dir:$PATH"` put the directory inside a double-quoted string, where the shell expands what it finds: an install under `/home/a$PATH/bin` wrote a line that on the next login expanded `$PATH` inside the directory NAME, put a nonsense entry on `PATH`, and left the user reading `veyyon: command not found` in a shell whose profile plainly named the right directory. The directory is single-quoted now, with any literal quote in it escaped, and `$PATH` itself stays outside the quotes where it still has to expand. Uninstall matches the older double-quoted spelling as well as the current one, because every install already in the wild wrote the old form and matching only the new one would strand that line in the profile forever.
- Every version this install moves to is recorded, not only the ones it moved back to. `recordVersionMove` was called from exactly one place, `rollbackToVersion`, so the history file held rollbacks and nothing else: an update from 1.0.30 to 1.0.37 left no trace, and the rollback picker reads that history to mark rows "previously run", which made the version a user is trying to get back to the one guaranteed not to be marked. The recording moved into `installRelease`, the single owner of the install-method dispatch and therefore the one function every move goes through, so `veyyon update`, the background automatic update and `veyyon rollback` all record through it. A forced reinstall of the version already running is not a move and is not recorded, since a history of `1.0.37 -> 1.0.37` rows describes nothing and would push the real moves out of view.
- `veyyon update` and `veyyon rollback` shipped as two halves of one mechanism and neither command named the other. A failed update now points at `veyyon rollback`, and only where it applies: a source install cannot be rolled back, so the line is suppressed there rather than sending someone to a command that refuses. `update --help` gained a "Going back:" section. And a successful update prints the changelog for the version it installed, which `rollback` already did, through the same single `changelogUrlForVersion` owner so the two commands cannot point at differently-shaped links.
- `veyyon rollback --list` no longer pads its lines out with trailing spaces. The columns are padded so they line up, which left whitespace at the end of the header and of every row with no marker: invisible on screen and real in a file, and that output gets pasted into bug reports and piped into diffs, where a line ending in three spaces does not match the same line typed by hand.
- The install opens with the sun. It is the logo everywhere else — the setup splash, the website, the login page — and the first thing anyone ever saw of veyyon was a line of lowercase progress text. One line now, printed before anything happens: a small ember dome rising over its own horizon, then the name letterspaced in silver, which is the order the setup splash reveals them in. `modes/components/sun.ts` stays the single owner of the brand ember; the shell quotes its bands and `scripts/installer-brand-parity.test.ts` fails if the two drift, because two shipped suns that disagree about the brand color are worse than one plain line. Nothing is printed into a pipe or a log, a terminal without color or without a UTF-8 locale gets an ASCII mark instead of mojibake, and an uninstall gets no mark at all: a logo over a removal reads as a sales pitch at exactly the wrong moment. The shape was arrived at by rendering it: shading it with the owner's `░ ▒ ▓` ramp the way the TUI does washed out to a grey swatch, because a terminal draws stipple as a dot pattern that averages to grey over seven cells, and solid blocks fixed the color but left something that read as a progress bar. Lower blocks of rising height are what make it a sun.
- The installer says what it is doing in color, wraps what it says, and shows the download moving. It rendered in the same monochrome as any package manager, so "Installation complete." looked exactly like the twelve progress lines above it and the one warning worth reading looked like every `ok` around it. The status glyph now carries the color and the message does not; progress narration is dimmed so the lines recording what the installer DID are what the eye lands on; and the binary download shows curl's progress bar rather than sitting silent for a minute on a slow link, which read as a hang. Long messages wrap on word boundaries with a hanging indent, and a message that indents itself keeps that indent, so a warning longer than the terminal is no longer broken mid-word with its tail starting at column 0. All of it is off unless stdout is a terminal, `NO_COLOR` is unset and `TERM` is not `dumb`, so piped output and CI logs keep the exact bytes they had. Two bugs found while building it: the width lookup asked `[ -t 1 ]` about its own stdout from inside a command substitution, where the answer is always "no terminal", so wrapping was disabled on every terminal there is; and `tput cols` answered a literal `0` in a container, which a "did it print anything" check accepted as a width. The terminal question has one owner now, and a width must be digits and at least 24 before it is believed.
- `get.veyyon.dev` redeploys when the installer changes, and the endpoint is now verified by content rather than by shape. It is a separate Cloudflare Pages project fed by a separate tree, and `site.yml` — which triggers on `scripts/install.sh` — deployed only the marketing site, so an installer change updated the documentation about the installer and left the installer itself on whatever the last release had published. The release job's verification could not see that: it grepped the served body for `#!/bin/sh`, which is true of every install.sh ever written, so it reported OK while the endpoint served a script hundreds of lines behind main. Everything added in between was unreachable to users, including the alias-clobber protection that stops the installer overwriting a `vey` of their own, the uninstall that takes its own PATH line back out of a shell rc, and the check that skips a redundant PATH edit when the directory is already on it. `site.yml` deploys both trees now, and both workflows end with `scripts/verify-deployed-installers.ts`, which compares sha256 digests of all three documented endpoints against the files in `scripts/`, retries for propagation, and reports a stale deploy differently from a broken root rewrite. Found by installing from `get.veyyon.dev` in a clean container and comparing what arrived against what the repository ships.
- The installer's closing advice no longer promises a diagnostic it does not run. Step 3 read "Run system diagnostics: `vey plugin doctor`", and there is no `doctor` command: `plugin doctor` reports on plugins alone, and on a fresh install prints three plugin slots all "not created yet", so a user following the installer's own third step was told they were checking their system and shown a report about a subsystem they had never touched. The install's own doctor already ran eight lines above. Step 3 is now "See every command: `vey --help`". The website said the same thing twice ("`veyyon plugin doctor` checks install health" on the features page, "Health: `veyyon plugin doctor`" under Platforms on the install page) and now names plugin health, the installer's doctor, and `veyyon setup status` as three different checks. Found by installing from `get.veyyon.dev` in a clean container and reading what the installer said at the end.
- `apply_patch` refuses a file-op marker that names no path. `*** Delete File:   ` trimmed to the empty string and was accepted, and an empty path is not an empty value: every op resolves against the working directory, so the delete targeted the cwd itself and the create wrote to a directory. All three markers now fall through to the same "is not a valid hunk header" error the parser already raises for an unrecognised line, which is what a marker with no path is. A streaming preview still tolerates it, because a partial buffer legitimately holds `*** Add File:` before the path has arrived and that parse never touches a file.
- Resolving an internal URL no longer loads the streaming engine. `session/session-context.ts` took `legacyArchiveSourceText` from `@veyyon/agent-core/compaction`, and that subpath barrel re-exports the compaction engine, which imports the `@veyyon/ai` barrel to summarize a conversation. The function's owner, `compaction/legacy-snapcompact-archive.ts`, is a self-contained reader for a retired archive format and imports nothing at all. One specifier: `session/session-context.ts` 407 -> 131 modules, `session/session-manager.ts` 455 -> 179, and because the URL router reaches the session loader through the history handler, `internal-urls/index.ts` 497 -> 232 and `tools/read.ts` 918 -> 761.
- Reading `Settings` no longer loads the compaction engine or the streaming engine. Four imports named a barrel where they wanted one value: `config/compaction-strategy.ts` took `resolveThresholdTokens` from `@veyyon/agent-core/compaction`, whose subpath barrel re-exports the summarizer; `config/settings-domains/context.ts` took the string `AUTO_COMPACTION_THRESHOLD` from the bare `@veyyon/agent-core` barrel, 406 modules for a sentinel; `thinking.ts` and `config/model-resolver.ts` took `ThinkingLevel` from the same barrel. All four now name their owners. `config/settings.ts` 442 -> 136 modules, `config/settings-schema.ts` 433 -> 58, `thinking.ts` 407 -> 7, and because settings is imported nearly everywhere, `modes/theme/theme.ts` 588 -> 282, `tui/hyperlink.ts` 497 -> 192, `tools/fetch.ts` 554 -> 369 and `tui/code-cell.ts` 633 -> 327 for free. The gate in `test/architecture/leveraged-imports-stay-cut.test.ts` asserted that settings reached neither `@veyyon/ai/index.ts` nor `@veyyon/ai/stream.ts` and passed anyway, because its resolution table did not know this workspace's own package names; it now derives the table from the workspace and every ceiling in it has been re-measured.
- Resolving `issue://123` or `pr://7/diff` no longer loads the `github` tool or the prompt corpus. `tools/gh.ts` held two things: the cache-aware issue, PR and PR-diff fetchers, and the `GithubTool` class with its 38 ops, run-watch poller, worktree-based PR checkout and four search renderers. The class renders its own description from the prompt registry, which is correct for a tool, so `internal-urls/issue-pr-protocol.ts` reached 355 modules to call six functions. From there it spread the way these always do: the router builds every handler, `tools/read.ts` consults the router because reading `pr://7` is a real feature, and 54 test files import `read`. The fetchers now live in `tools/gh-fetch.ts` (81 modules) and the primitives both halves share in `tools/gh-format.ts` (4), with every name re-exported from `tools/gh.ts`, so no caller changed. The handler reaches 84 and `internal-urls/index.ts` 205, down from 418. The shared cache row is unaffected and still shared: open `pr://7`, then ask the tool for PR 7, and the second read is free because both call the same fetcher against the same SQLite row.
- `prompts/registry.ts` takes `definePromptRegistry` from the module that defines it rather than from the `@veyyon/utils` barrel: 3 modules instead of 74. 94 files in this package import the registry, and its own code cost was almost entirely that one import.
- The prompt inventory reports the real renderer of a prompt again. It finds one by matching a registry table indexed by an id, and the pattern accepted only SCREAMING_CASE table names, so splitting the registry into camelCase per-directory row tables made all 95 consumers invisible at once and the inventory claimed the system prompt was rendered by its own row module and two tests. The accepted camelCase names are derived from the registry's own directories rather than matched as any `\w*Prompts`, so an ordinary local named `userPrompts` is still not a registry.
- `tools.artifactSpillThreshold` now reaches every tool it claims to. "How many bytes of tool output
  stay in the conversation" had two answers with the same meaning and the same value: this setting
  governed the centralised spill that runs after a tool returns, while every streaming tool priced
  itself against a compiled 50KB constant that nothing could reach. They agreed only because both
  happened to be 50KB, so lowering the threshold to 2KB moved the centralised path and left bash,
  eval, ssh and the interactive shell at 50KB. `eval` alone is about 80% of tool-result bytes, so
  most of the setting did nothing while reading as though it had been applied, which is worse than a
  knob that does nothing at all. `inlineOutputPricing` reads it for both paths now, so it also
  composes properly with `tools.inlineOutputFloor`, which is a SHARE of this budget: a quarter of
  50KB and a quarter of 2KB are different budgets, and only one of the two factors had been settable.
  Nothing is lost by lowering it — output past the threshold is written as a session artifact and the
  result keeps a head/tail window plus the `artifact://<id>` footer that reads the full text back, so
  it costs a re-read rather than output. The 50KB exists once, as
  `DEFAULT_ARTIFACT_SPILL_THRESHOLD_KB` beside the floor default; `DEFAULT_MAX_BYTES` is that value
  in bytes, under the name every caller and tool doc already uses. A threshold that is not a positive
  finite number is refused with a log line and the compiled default, never silently corrected.
- The bench's worked prompt-section arm did not load. `arms/candidate-delivery-terse.sections.yml` is
  the file an operator is told to copy, and its `DELIVERY CONTRACT` banner carried a two-character
  underline where the builder requires at least four, so the runner rejected it and every experiment
  derived from it would have failed once a container was already running. `docs-coherence.test.ts` had
  the check that catches this and the bench suite was simply red.
- A misspelled `--arms` entry died with a raw ENOENT stack from the config read, which reads as a broken
  runner rather than as a typo and buries the only useful fact: what the arms are called. It now names
  the available arms and exits. The check is a pure function so it is unit-testable, since `run.ts` ends
  in a top-level `await main()` and importing it to test anything would run a bench.
- "Which files in `arms/` are arms" was answered in three places and one was wrong.
  `docs-coherence.test.ts` counted every `*.yml`, so `candidate-delivery-terse.sections.yml` became a
  phantom arm named `candidate-delivery-terse.sections` and every coherence check quantified over an arm
  nobody can run. There is now one owner, `isArmConfigFile`/`armNamesIn`, and `run.ts` refuses an
  `--arms` entry that names an attachment rather than parsing a section-override map as a config overlay
  and benching nonsense.
- An append-mode section override silently reverted the rest of its section to the copy in
  `system-prompt.md`. Appending produces a whole-section override (base text plus the addition), and a
  whole-section override beats the statements by design, so whichever base the append started from
  became the section. It started from `DEFAULT_TEMPLATE_SECTIONS`, the copy sliced out of the template
  file, which meant a `.veyyon/prompt-sections/role.md` in append mode replaced ROLE with the
  template's version of it and kept only the operator's line as intended. Invisible today because that
  copy and the statements are byte-identical and asserted so, and it would have begun deleting
  statement edits the moment the two diverged, which is the first thing that happens when someone edits
  a rule. An append now appends to the ASSEMBLED section, so the base is what the session actually
  sends; an explicit replacement in the same override set still wins, and the template copy remains the
  base only for a section that is not assembled from statements. The regression test supplies a base
  that differs on purpose, because with identical copies no assertion can tell which one was read.
- Two spacing defects in the shipped prompt, both from conditionals that leave an empty line behind. A
  one-line inline conditional such as `- {{#has tools "ast_grep"}}...{{/has}}` is not a standalone
  block-helper line, so Handlebars cannot remove it and its newline together; when the condition is
  false the line collapses to an empty line. Next to an existing blank that makes a run of two, which
  `format` deletes entirely, so a heading landed directly on the bullet above it. Alone inside a list
  it survived as a stray blank splitting the list. Statements have no empty line to leave behind, so
  the class is gone rather than reproduced, and every resulting delta is recorded per matrix point and
  asserted exhaustive in both directions.
- `TOOL POLICY` sent `delegated.- A subagent's value` as one token to every non-Codex session with
  delegation required. A `{{#has}}` nested inside an `{{#if}}` across a line boundary jammed the close
  tags together with the bullet that followed. The statement rows put the bullet on its own line. The
  byte gate would have reported the repair as drift, so the template side of the comparison applies it
  explicitly and asserts it in both directions, and the affected matrix points are listed so a new one
  appearing fails the gate.
- `statement-registry.test.ts` now exists. The registry's header had cited it as the enforcement for
  its own contracts for weeks, so the granularity rule, the closed condition vocabulary and the
  disjointness of gate variables from session facts were documented and unchecked. The disjointness
  check caught a real duplicate on its first run: `hasSubagentSpecialists` was declared a session fact
  while the `subagent.agents` gate row already claimed it.
- Three of the thirteen rows in the prompt gate registry named template variables that do not exist,
  and the registry's own test protected the error. The rows are contracted to name the template
  variables a setting decides. `subagent.maxConcurrency` named `taskMaxConcurrency`, which is the
  builder option's name; the template is handed `MAX_CONCURRENCY`, so the row described a variable no
  conditional could read. `includeModelInPrompt` and `includeWorkspaceTree` each named themselves, as
  though the template contained a conditional on them, when both actually decide whether a runtime
  section is assembled at all. `tools.intentTracing` named only half of what it decides, leaving the
  `intentField` parameter name claimed by nothing. The consequence was not cosmetic: a statement's
  condition is validated against these rows, so a wrong row rejects a correct condition. Rows now
  name template variables only, a new field carries the runtime-section route for the two settings
  that gate a section, and a test cross-checks every row against the template. The old test required
  each gate to name a variable, which is precisely why two settings that gate sections stayed
  mislabelled.
- The statement registry now reaches the model. `conventions` and `role` had been converted to
  statements and gated for byte identity, but nothing outside the tests imported the registry, so
  every session was still served the Handlebars copy and the tests looked identical either way.
  `buildSystemPrompt` splices the converted sections in through the section-override seam, ahead of
  your own overrides so a `.veyyon/prompt-sections/` replacement still wins. Wiring it revealed a
  one-byte bug: the assembler followed the convention where a section separator sits between
  sections, while the template slicer keeps it inside, so the whole prompt came out two bytes short
  and the missing bytes were the blank lines before `ROLE` and `RUNTIME`.
- An MCP server's error that names no request now reaches you instead of turning into a timeout.
  JSON-RPC lets a server answer with `"id": null` when it found the problem before it could read
  which request the problem belonged to, which is what a parse error is. Both streaming transports
  dispatched on the id being non-null, so such a reply matched no branch and was dropped in
  silence, and every call in flight waited out its own timeout and reported that the server had
  not answered. The server had answered. Now every call on that connection fails with the server's
  own code and message, for example `MCP error -32700: Parse error`, and the transport logs the
  server, the code, the message and how many calls it killed. Veyyon's own memory server emits
  exactly that shape, so this was losing parse errors between two parts of veyyon.
- Disposing a session no longer lets one stuck subsystem leak the rest. Releasing owner-scoped
  resources was four calls in a row followed by the browser-tab release, so the first one to throw
  skipped everything after it: a Python kernel that would not close leaked the Ruby and Julia
  kernels, the JavaScript eval subprocess and every browser tab the session had opened, and you
  saw one error with no mention of the leaks. Each subsystem now registers its own cleanup, all of
  them run whatever the others do, and the failures are reported together.
- A `vault://`, `memory://` or `local://` URL rejected for an absolute path or a `..` no longer
  tells you about `skill://` URLs. The check was shared but its messages were not.
- The two memory tools that write now honour a cancellation, and the two that only read already
  did. `retain` and `memory_edit` took no abort signal at all, so a call issued just before you
  pressed Escape wrote to the store afterwards and nothing could have stopped it. Both now refuse
  before writing anything. `retain` with the Mnemopi backend writes one memory per item, so it
  also stops between items and the abort names what was already stored, what was not, and that
  the stored ones were not rolled back. Neither races the signal, because rejecting the caller
  while the writes continue is worse than not honouring the cancellation at all.
- Changing a setting the system prompt depends on now takes effect. `modes/controllers/selector-controller.ts`
  carried a hand-written `case` per setting deciding which flips rebuild the prompt, and it had
  two of the nine: `subagent.batch`, `subagent.delegation`, `subagent.maxConcurrency`,
  `subagent.maxRecursionDepth`, `subagent.agents`, `includeModelInPrompt` and `tools.format` all
  change prompt text and had none, so flipping one saved the value and left the model reading a
  prompt that described the previous configuration until an unrelated rebuild happened to fire.
  Nothing was logged. The trigger is now derived from
  `system-prompt-builder/gate-registry.ts`, so registering a gate is what makes it take effect
  and there is no second list to forget.
- Flipping a prompt setting a running session cannot pick up now says so. Three gates are read
  once at startup (`inlineToolDescriptors` deliberately, `includeWorkspaceTree` and
  `tools.intentTracing` as a consequence of where `sdk.ts` reads them), and the settings screen
  showed the new value either way, so there was no way to tell an applied change from one that
  did nothing.
- Cancelling a `github` op that writes no longer walks away from it. Every op ran inside a
  helper that races the work against the abort signal, so the moment you pressed Escape the tool
  rejected and the git commands kept going: a `pr_checkout` carried on creating worktrees and
  branches with nobody waiting for them, and a `pr_push` was left mid-push. The three writing ops
  (`pr_create`, `pr_checkout`, `pr_push`) are now awaited, and they already pass the signal into
  every git call, so a cancellation still takes effect promptly. Reads and `run_watch` keep the
  old behaviour, which is correct for them: nothing was changed, so returning at once is the point.
- A cancelled `pr_checkout` now tells you which worktrees exist. It reported the bare sentence
  "Operation aborted" and dropped the list, even though the checkouts that finished had created
  real directories and local branches, so the next checkout of the same PR found a branch nobody
  had mentioned and refused without `force`. The abort now names each worktree and its branch,
  names the PRs it did not reach, and says the worktrees were left in place.
- A collab guest no longer receives the host's private session-header fields. The `welcome` frame's
  header was the host's own, sent verbatim, and the host's header carries three fields the wire
  contract does not declare: `titleSource`, `parentSession`, and `providerPromptCacheKey`. Extra
  fields satisfy a narrower type, so nothing complained. The guest writes the header it receives as
  the first line of its own replica session file, so the provider prompt-cache identity and the id of
  the session this one was forked from were being persisted on every guest's machine, read-only
  viewers included. The frame now names the wire type and the host projects onto it field by field,
  so a field added to the host's header cannot start shipping on its own.
- The generated prompt inventory was scoped to three of the five prompt directories and missed two registries' templates, and its call-site scan named two of the five registry tables. Both were hand-maintained lists inside a tool whose whole purpose is that the set of prompts should not be hand-maintained: it reported `@veyyon/ai`'s fourteen format guides and `@veyyon/hashline`'s tool description as rendered only by their own registry module, and left them out of the orphan check altogether. The directory list now comes off the registry descriptors, so it grows when a package adopts a registry rather than when somebody remembers, and the scan matches any `SOMETHING_PROMPTS` table. `prompt-inventory.test.ts` pins every table name in use against that pattern, in both directions, because the obvious generalisation of it silently stops matching the bare `PROMPTS` and drops 189 call sites at once.
- The `/settings` description of the `plan` approval mode said write and exec tools "require confirmation", but the mode has always denied exec outright and only asks about writes while a plan-mode session is active. The description now says what the mode does: read tools are auto-approved, write asks only inside an active plan-mode session, and exec is blocked.
- The check that keeps every prompt registered was narrower than its own name. It scanned two `src` trees and, inside them, only flagged an import landing in a directory it already knew was a prompts directory, so the predicate deciding "is this a prompt" was "is it already registered": seventeen unregistered prompts in `@veyyon/ai` and `@veyyon/metaharness` were invisible to it, and `scripts/bench-title-models.ts` imported a registered prompt's file by relative path without being seen, because `scripts/` is not `src/`. The rule is now the general one, over every `.ts` under `packages/`: a `.md`-as-text import is a registration and may only appear in a registry module, with two named exception lists (the registries themselves, and `@veyyon/hashline`'s tool description, which its own package exports) that are each asserted to still describe a real import. A relative path reaching into another package's tree is refused even for a file that is otherwise allowed.
- Re-rooting the session no longer tells the model to call a tool it does not have. Two places advise it -- the `<working-directory>` block of the system prompt and the hint appended to a tool result once you have touched three files outside the working directory -- and neither checked whether `set_cwd` was in the toolset. It usually was not: `set_cwd` is a discoverable tool, so under `tools.discoveryMode: all` it is deliberately kept out of the initial tool list and found through `search_tool_bm25`. The advice was right, the model followed it, and the call named a tool absent from the request, so nothing happened -- and re-rooting appeared to work only in sessions where something else had already activated the tool. The hint now activates `set_cwd` before it recommends it, and when it cannot, it says the tool is missing and names the way to get it instead of recommending a call that cannot land. The prompt block gained the same conditional sentence, keyed on the live tool list.
- The re-root hint no longer picks which directory to name by how long its path string is. When several directories cross the threshold in one call (a multi-path grep, a glob, a patch spanning projects) the hint used to go to the longest path, which within one project is accidentally the deepest and between two projects is arbitrary: `/srv/averyverylongprojectname` beat `/srv/a/b/c/d` while being four levels shallower. It now names the deepest directory by path segments, breaks a tie by which one you have worked in more, and resolves a full tie the same way every time rather than by the order files happened to be read. The shared parent of two unrelated projects can no longer win despite holding the sum of both.
- `set_cwd` no longer reports that no rule files are in effect when you ask for the directory you are already in. A real move computed the rule-file counts from the loader; a no-op asserted its own empty answer with `rulesUnchanged: 0`, which is untrue -- your user-level `AGENTS.md` applies from every directory, so a session that never moved still has rules governing it. Both cases now read the same describer, so the counts in the details and the sentence beside them cannot disagree, and a no-op whose rule files cannot be read says which instructions are in effect is unknown rather than claiming a change that did not happen.
- `veyyon -p "prompt"` no longer hangs forever when stdin is a pipe nobody writes to. Reading piped stdin waits for EOF, and a supervisor or CI runner that spawns the CLI with an inherited pipe it never writes to never sends one, so the run stopped before it started with the prompt sitting unused on the command line. When the prompt is already on the command line, the wait for the FIRST byte is now bounded (10 seconds, `VEYYON_PIPED_STDIN_WAIT_MS` to change it, `0` to wait indefinitely) and giving up is reported on stderr. Once any byte arrives the wait is unbounded again, so a slow or large piped document is still read in full: truncating it would let the model answer about content you believe it read.
- A directory that cannot be read no longer reads as "nothing configured". Agent discovery and the managed-skills sweep listed optional directories with `.catch(() => [])`, so a `.veyyon/agents` that exists but cannot be listed produced the same empty result as one that was never created: the agents disappeared from `/agents` with nothing in the log. Both now go through the shared `readdirIfPresent`, which stays quiet when the directory is simply absent and logs the path and what it was looking for when it is there and unreadable.
- Two local auth services starting at the same moment can no longer end up with two different bearer tokens. The token file is created with an exclusive create so the loser of the race re-reads the winner's token, but an exclusive create makes the file exist before its contents are written, and an empty file read as "no token yet" -- so a caller that read inside that window minted a second token, and a client holding the first was then rejected by the service that issued it. The loser now waits for the creator to finish writing. If the file is still empty after the wait, which means a creator died between creating it and writing to it, the caller takes ownership and logs that it did, since the file it replaces may already have been handed out.
- An isolated task no longer mistakes a directory it cannot inspect for ordinary content. `discoverNestedRepos` decides which directories are their own git repositories, and an isolated task treats each one as a boundary it does not snapshot. The check swallowed every error, so a `.git` the process could not stat -- an unreadable parent, a restricted mount, an I/O error -- read the same as "no repository here", and the walk descended into a repository it had failed to recognise and captured its files as the parent's. A directory that could not be listed hid every nested repository beneath it with nothing logged. A missing `.git` is still a plain no; anything else is now logged with the path and treated as a boundary, so the walk stops instead of reaching into a tree it cannot see.
- Startup no longer loads the interactive TUI on runs that never render one. `main.ts` loaded interactive mode with a dynamic import specifically so `-p`, `--rpc` and ACP runs would not pay for the `modes/components` subtree, and two static edges pulled the same subtree in anyway: the four extensibility loaders each held `import * as PiCodingAgent from "../../index"` to hand extension authors the package as `api.pi`, and the package barrel re-exports every mode; `main.ts` also imported two small functions from the welcome component. So `veyyon -p "hi"` with no extensions installed loaded the settings overlay, the plugin-settings panel and the interactive mode it would never construct. The `pi` namespace now loads on demand from one owner, the launch tip moved to a module that pulls no component with it, and a session with no custom tools no longer builds a custom-tool API at all. Interactive mode's inclusive load went from 402ms to 75ms and the instrumented boot wall from about 2.0s to about 1.1s. `test/startup-module-graph.test.ts` resolves the static graph and fails if any of those modules re-enters it.
- A piped prompt that cannot be READ no longer vanishes silently. `veyyon -p` with input on stdin
  returned no prompt on a read failure and continued as if nothing had been piped, which ends as exit 0
  with no output and no explanation -- the same disappearing-prompt symptom the code already guarded
  against for a different cause. A failed read now prints what went wrong on stderr before continuing.
- A GPU probe that cannot RUN is reported. `nvidia-smi`/`lspci`/`wmic` failures were swallowed to "no
  GPU information", and the prompt's environment section then simply omits the GPU -- which on a machine
  that has one is a configuration bug, not a fact. A missing probe binary stays quiet at debug level
  (slim containers and trimmed Windows installs genuinely lack them); anything else warns with the
  command and the error, so a workstation does not quietly describe itself as GPU-less.
- A theme whose file cannot be read no longer produces an export in default colours with no explanation.
  `getThemeExportColors` returned "this theme sets no explicit colours" for both a theme that sets none
  and a theme that could not be loaded; the second case now logs the theme name and the error.
- A tool block's spinner stops itself and warns if the active theme cannot supply spinner frames, rather
  than throwing from inside its 80ms timer. A throw there has no caller to catch it, so it surfaced as an
  unhandled error attributed to whatever happened to be running and then repeated twelve times a second
  for the rest of the process. One unrestored global theme in a test suite cost 12 failures in three
  suites that render nothing.
- The Essential Tools Override setting description now names the real default list. It showed six tools (`read, bash, edit, write, glob, eval`) while the actual always-loaded default has seven, `launch` included, so an operator writing an override list from the description would have silently dropped process launching.
- `bench/session-tree-nav.bench.ts` runs again. `buildSessionContext` moved to `session/session-context.ts` and the `SessionEntry` union to `session-entries.ts`, and the script still imported both from `session-manager`, so it died on a SyntaxError and published nothing while saying nothing about it. It reports 0.0460ms per navigation before the dedupe fix against 0.0071ms after, an 84.6% reduction, and it uses the shared bench harness instead of its own timing loop now that the harness runs the warmup this script always knew it needed.
- `veyyon bench/throughput <TAB>` completes model ids again, and completes a comma-separated list of them. The completion generator keys its positional tables by `<command>.<arg>`, and the benchmark's was listed under `bench` while the command registers as `bench/throughput`, so the key matched nothing and the positional fell through to "no candidates". The argument is also declared repeatable and was pinned to a single value, which stopped offering candidates after the first selector. A key that matches no command cannot fail on its own, so every key in those tables is now checked against the real command list and the arguments each command declares.
- A provider whose model discovery produced no catalog now says why, for every provider rather than only the ones that failed by throwing. The registry keeps per-provider discovery state and reported a reason only when discovery THREW, so a returned `null` was silent: an endpoint that refused the connection, one that answered 401, and one that answered with an unrecognized payload all left the same result, a picker missing models you pay for with nothing anywhere explaining it. The reason arrives with a stage, which is what decides where to look: `request` at the network, `status` at credentials, `body` or `payload` at whether the endpoint still speaks the protocol. It goes through the same reporter as a thrown failure, so it is deduplicated per provider instead of repeating on every refresh, and an endpoint that answers with an empty list still produces nothing.
- A harness profile now refuses a `promptSectionOrder` or `tools` list containing an entry that is not a name, instead of dropping that entry and applying the rest. A misspelled section name already rejected the whole list, with a comment explaining that a silently dropped entry would apply an order the operator did not write; a non-string entry three lines above hit a `continue` and did exactly that. `tools` matters more, since it DENIES tools: `tools: [read, 42, bash]` gave the model two tools instead of three with nothing naming the one that vanished. A `harness-profiles.yml` that cannot be read or parsed is also reported now, with the path and the reason: the loader had an `ENOENT` branch and a fallthrough that both returned no profiles, so a YAML syntax error dropped every per-model profile and started the agent on the defaults in silence.
- A `/proc/cpuinfo` that exists and cannot be read is now reported at the same volume as the GPU cache beside it. Both omit a line from the prompt's environment section, and both are the same fact — the file is there and the read failed — but one warned while the other used `logger.debug`, a level nobody runs with. A missing file stays silent, since it is Linux-only and absent in some containers.
- `veyyon prompt --prompt <id>` builds its stand-in section row against the real section type. A prompt with no declared sections is described by one synthesized row, and that row was missing `name` with nothing to say so, because the function happens not to print it; it would have started rendering `undefined` the moment it did.
- A `git status` autoresearch cannot read is no longer reported as a clean worktree. `tryGitStatus` answered any failure with `""`, which parses to "no dirty paths", and three things acted on that: a `discard` reported "nothing to revert" while the experiment's changes sat in the tree, `log_experiment` recorded an empty modified-path list so the scope-deviation check passed vacuously against `off_limits`, and `run_experiment` recorded an empty PRE-RUN dirty set, which claims the tree was clean and would attribute the user's own uncommitted files to the experiment. The probes now propagate and each caller reports through the error channel it already had. A cwd outside a repository is still answered with `""`, decided by resolving the repository rather than by a failed command, because autoresearch may run there and then has no tracked changes.
- `init_experiment` treats an unreadable `git status` as dirty rather than clean. False took the branch that skips committing harness changes, which is the branch whose own warning says "discard may not preserve uncommitted harness files".
- A debug adapter config that exists and cannot be read or parsed is reported. Six filenames are probed per directory, so absence is silent, but a `dap.json` with a trailing comma used to be indistinguishable from no `dap.json`: the configured adapters simply were not there and the debugger fell back to its defaults without a word. Same for an unparseable lspmux `config.toml`, where a typo silently reverted every language server to the direct, unmultiplexed path.
- Detecting a repository inside the working directory says when it could not look. An unreadable cwd produced the same empty listing as one with no repository in it, so the prompt and the status line both showed nothing with no sign the check never ran. The "exactly one direct child" rule also has one owner now instead of a copy in each of the asynchronous and synchronous paths.
- Cancelling a fan-out of agents part way through now reads as cancelled instead of failed. Stopping a five-agent call after three finished produced the same result the parent sees when two agents crash: `isError` was set, the text said nothing about the stop, and the three transcripts you did get sat under a claim that something had gone wrong, so the model would re-run work you had just cancelled. The result now opens with what became of the batch (`2 of 5 agents completed, 3 cancelled.`), names the spawns that never started, still returns everything the finished agents produced, and reserves the error flag for agents that actually failed. A genuine failure still reads as one, alongside any cancellations.
- A subagent calling `set_cwd` no longer moves the working directory of your session and every other subagent. Subagents run inside the same process you do, and re-rooting one used to `chdir` that whole process, reload settings for its project, and reset the shared capability and plugin caches. Tool paths hid it, because they resolve against each session's own directory, so the symptom was a command or a bare relative path running in a project nobody had opened, with nothing on screen to explain it. A subagent now re-roots itself alone: its paths and its system prompt move, and yours do not. Your own session still moves the process as before.
- Clicking a tool result's image thumbnail in the web view now reports a blocked or unavailable popup instead of doing nothing. The click decoded the image and opened it inside one `try`, so a popup blocker was swallowed by the same `catch` that exists for undecodable image data, and the button looked live while nothing happened. The `try` now covers decoding only, which is the one failure the broken thumbnail beside it already explains.
- Every version from 1.0.0 to 1.0.36 has a changelog entry. The file described one release out of thirty-seven, so a user could install eight published versions it said nothing about. The sections are reconstructed from git history and dated by the commit that cut each version, and the site build now fails on any published release with no entry rather than printing a warning and exiting 0.
- A mistyped `--system-prompt` path is now an error instead of becoming the system prompt. The option takes either a path or the prompt text, and any read failure returned the input unchanged with `ENOENT` explicitly excluded from the warning, so `--system-prompt ./promtps/main.md` handed the model a system prompt whose entire content was that string: every rule, tool policy and workflow gone, the session behaving nothing like it should, and nothing on screen connecting it to a misspelled directory. `--append-system-prompt` and `TITLE_SYSTEM.md` resolved the same way. A value that fails to read is now refused when it has no spaces and either contains a path separator or ends in a prompt-file extension, naming the option, the path and the error. Prose is untouched: a one-line prompt containing a slash or ending in a dotted word is still used as written.
- `looksLikeFilePath` is one function in `@veyyon/utils` rather than a private copy in the Anthropic provider. It decides whether an option that accepts "a path or the value itself" was written as a path, and the provider's copy was the only place asking; prompt resolution had no shape check at all, so the same class of typo was an error for a certificate and silent for a system prompt. The extension list is passed by the caller, since `.md` names a prompt file and means nothing in a certificate option.
- A `PROMPT_SECTIONS/` directory that exists and cannot be read is now refused instead of read as having no overrides. Any error from listing it returned the same empty list a missing directory does, so a directory that became root-owned after a `sudo` edit, a broken symlink, or a path that is a file dropped every section override the user wrote and the agent ran the shipped prompt with nothing logged. Absence is now `ENOENT`/`ENOTDIR` alone, through the shared `isMissingPath`, and anything else names the directory, the underlying error, and what would have happened. A file the listing just reported and the reader cannot open is refused the same way: it used to be skipped silently, which left a file on disk that had quietly stopped doing anything. Both judgements moved to the loader itself, so a reader injected by a test or an embedder is held to the same contract.
- The error refusing a `PROMPT_SECTIONS/<section>.md` replacement now says how long the underline has to be. It named the banner, so a file refused for its underline read as though the section name were wrong, and the width it did mention was prose written by hand at the throw site rather than the constant the check applies — a change to the accepted width would have left it telling you to write the length that no longer works.
- A plugin directory that cannot be read is reported instead of loading as a plugin with nothing in it. `resolveDirectoryEntries` answered a failed `readdirSync` with `[]`, which is also what a directory holding no loadable files gives, so an unreadable one registered no tools, hooks or commands and said nothing. The empty list is still returned, because one unreadable directory must not stop the rest of the plugin from loading.
- A plugin `package.json` that exists and cannot be parsed is reported. It used to reach the same `null` an absent one does, so dependency resolution gave up and the import failed with "cannot resolve <specifier>", which sends the reader hunting a missing dependency rather than the malformed manifest in front of them.
- `doctor --fix` says why reinstalling plugins failed. The exit code and `bun install`'s output were drained and discarded, so a network failure, a lockfile conflict and a missing `bun` on PATH all showed up as the same red check.
- `/review` no longer presents a git failure as an empty repository. Listing branches or commits answered any failure with an empty list, so the command reported "No git branches found"; worse, an unreadable repository made the status probe return `""` and the review ran on an EMPTY diff and reported no findings, which is a false clean bill of health rather than an admission that git could not be read. Each failure now names its reason through the same notice the command already used for a failed diff.
- Search providers say when stored credentials cannot be read. `findCredential` answered any failure from the credential store with `null`, which is also "no credential configured", so a search key the user configured silently dropped out of the provider chain and the search quietly ran on whatever was left. Reported once per provider set, since the failure belongs to the store rather than to the query.
- The result-anchor rule for HTML search providers has one owner, `resolveExternalResultUrl`. Ecosia, Mojeek and Startpage each had a copy, and the three had already drifted in the part that matters: one rejected the engine's host and its `www.` spelling, one rejected every subdomain, one did both for a single domain. Ecosia's copy would have returned `images.ecosia.org` as an outbound result. Subdomain matching is now the rule everywhere.
- The GitHub, GitLab, Hugging Face, Sourcegraph and Vimeo URL classifiers no longer wrap their whole body in a catch that returns `null`. The parse verdict already belongs to `tryParseUrl`, so that catch could only swallow a bug inside the classifier, and it surfaced as "this is not a URL I handle": the structured reader was skipped and the page came back as anonymous HTML with the issue, PR and Actions handling silently gone.
- A prompt part is now identified as a section only when it actually carries a banner. `applyPromptSectionOrderToParts` read the part's first line and looked it up, with no check for the `====` underline beneath it, while the splitter cutting the same document required one. So any part whose first line happens to read like a banner name was ranked as that section: it could be ordered ahead of the real one, and a `promptSectionOrder` naming a section no part carries was reported as known instead of warned about. Both sides ask `leadingBannerName` now, which is also what `startsWithBanner` is written in terms of.
- Failing to save a tool's full output as an artifact is reported. `saveOutputArtifact` is the one owner of the `artifact://<id>` spill, and it answered a failed write with the same silent `undefined` a session with no artifact store gives, so the caller printed its bounded head/tail window with no footer and no trace that the full bytes had existed. The window is all there is: the raw text is kept nowhere else. `undefined` is still returned, since the visible result is correct without the artifact, and the session's own `bash-original` save now reports through the same `reportLostOutputArtifact` owner instead of swallowing the failure privately.
- `AgentSession`'s plan-file listing is the shared `listLocalPlanFileUrls` rather than a third copy of the same readdir-filter-stat-sort walk. All three copies ended in `catch { return [] }`, so an unreadable session-local root looked like a session with no plans in each of them, and the fix had to be made in each of them.
- Settings search now treats a multi-word query as an AND of its words: every word must match the label, path, group, description, or declared keywords, and word order carries no weight. The one-needle scorer it replaces looked for the words as a literal pair, space included, so `auto compaction` matched nothing — the label reads "Auto-Compaction Threshold" and contains neither the space nor the pair — which is exactly the query you type after reading the label. Stray punctuation between words is ignored, so `auto - compaction` is still the two-word query.
- Added a **Subagents** settings area: a tab of its own (Delegation, Agents, Models, Limits, Isolation) that owns every question about a spawned agent. Everything about subagents used to be spread across fifteen `task.*` keys, a `subagent.model` field on the Model tab, a `task` model role in the role table, and two agent-keyed maps with no UI at all (`task.disabledAgents`, `task.agentModelOverrides`), so "is this agent on" and "what model does it run" each had two owners that could disagree. The Agents group lists every agent the project has, with the model each resolves to and the setting that decided, and opens one agent at a time to set whether it is offered, its model and its effort — the two agent-keyed maps it replaces could only be edited by hand, and nothing showed what a spawned agent would actually run. `/agents` edits the same rows through the same resolver. Your config is folded onto the new keys on load, including `modelRoles.task` becoming `subagent.model`, and the old keys are dropped from the file. Handbook: [Subagents](docs/handbook/src/features/subagents.md).
- Added `docs/settings-reference.md`: every setting that appears in `/settings`, with its key, type, default, and what it does, grouped exactly as the tabs are. 201 of the 313 settings a user can see and change had no documentation anywhere, and nothing failed when a new one shipped undocumented. The page is generated from the schema by `scripts/gen-settings-reference.ts`, and CI fails when the committed file and the generator disagree, so it cannot fall behind the code. `docs/settings.md` keeps the hand-written narrative and links to it.
- Ruby and Julia eval cells can now run on a kernel of their own: `ruby.kernelMode` and `julia.kernelMode`, with the same `session` and `per-call` values as `python.kernelMode` and the same `session` default. `per-call` starts a kernel for the cell and shuts it down when the cell finishes, including when it fails, so nothing the cell defined survives it. Python has had that choice since the setting existed while both other runtimes always kept one kernel per session, so a run that needed a clean slate could only get one in Python. A fresh Julia kernel recompiles, so `per-call` costs more there than anywhere else.
- `veyyon prompt --sections` now lists the sections that are NOT in the prompt, each marked optional or REQUIRED, and exits 1 when a required one is missing. The breakdown could only show what rendered, so a prompt missing a section for a good reason (a feature is off) and one missing it because assembly broke produced the same output and the same zero exit. The subagent prompt has always had that distinction; the system prompt, which is larger and where 86 of 272 template lines are conditional, did not. `--json` carries the same information in a `missing` array, present even when empty.
- Added a build-time guard on the system prompt's cached prefix. Block 0 is the byte-stable text a provider serves from its prefix cache, and nothing failed when an edit changed it, so a wording change shipped a one-time full re-read of every user's conversation with no sign of it in the diff. `system-prompt-cached-prefix-stability.test.ts` records the digest, so moving those bytes is now a deliberate line in a review, and separately fails if a runtime section lands inside the prefix, if arming a feature perturbs it, or if two builds of the same inputs differ.
- Plan approval now reports a session-local plan directory it cannot read, instead of behaving as though you had written no plans. The interactive path and the ACP path each had their own copy of that listing and both answered any failure with an empty list; there is now one owner, `listLocalPlanFileUrls`, and an unreadable root is named while the empty list is still returned so approval keeps working.
- A theme that fails to load is now reported with its name and the underlying error. `getThemeByName` returned nothing for both a name that does not exist and a custom theme file with a syntax error, so a broken theme sent you looking for a typo.
- Code that cannot be highlighted is now reported once per language rather than silently rendered plain, which is also what an unsupported language looks like.
- A harness `promptSectionOrder` that asks a runtime section to come before a template section is now reported instead of quietly half-applied. Runtime sections always follow the cached prefix, so the request cannot be honoured; the warning names the section and the reason. Only a name matching no section at all was reported before, so an order naming two real sections produced a prompt in a different order from the one asked for with nothing logged, and an eval arm testing whether teaching the shorthand notation first changes behaviour would have run the control and recorded it as the treatment.
- Prompt sections are now described by one type instead of two. `system-prompt-builder/section-registry.ts` (then named `prompt-blocks.ts`) and `prompts/registry.ts` each exported an interface named `PromptSection`, so importing "the" one gave you whichever your editor offered, and each had grown a field the other lacked. They share one declaration now, which is how the system prompt gained `optional`.
- Every banner in every prompt is now underlined the same way. Three widths shipped at once: the system prompt's template sections used 14 `=`, its runtime sections used 35, and the subagent prompt used 35, so one prompt showed the model two different banner styles. The width had no owner, being split between a two-character stub in the registry and a `"=".repeat(33)` in the assembler. Registry rows declare only the banner NAME now and one function renders it, so a section cannot ship a width of its own. The system prompt's cached prefix is byte-identical; the subagent prompt's banners changed once.
- A `PROMPT_SECTIONS/<section>.md` replacement whose underline is too short is now refused instead of accepted and then ignored. The validator required only that the text start with the registry's banner field, which ended in two `=`, while the splitter needs four to cut on a banner. A replacement underlined with two or three `=` therefore passed validation and landed in the prompt as ordinary text: the section stopped appearing in `veyyon prompt --sections`, `promptSectionOrder` could no longer move it, and a later override addressed the wrong span. Both sides ask one function now. Underlines of four or more are accepted, so a hand-written file that does not match the shipped fourteen still works.
- Adding a prompt section that arrives as a builder option no longer demands an entry in the map of sections the builder computes itself. The type keying that map named the option-backed sections by hand (`Exclude<RuntimeSectionId, "shorthand" | "shorthand-handles">`), so a new option-backed section failed the build asking for text that has no source, and the two ways to silence it — a bogus entry, or widening the map — both bring back the failure the map exists to prevent. The type is derived from each section's own declared input now, so it tracks the registry.
- A prompt section pointing at an option that does not exist is now a compile error naming the key. The check meant to prove it cast its own input (`section.input.key as StringOptionKeys`), and a cast asserts rather than checks, so the check passed for every key: a mistyped option read `undefined`, the section rendered nothing, and nothing failed. The assembler's two text lookups were cast as well and are not now, so a section reclassified as computed without a matching entry is also caught at the index. Contributor guide: [System Prompt Customization §10](docs/system-prompt-customization.md).
- An MCP authorization-server metadata document whose `issuer` is not a URL is now refused instead of trusted. The check that keeps a grant from being routed to an unverified `/authorize` endpoint compared the issuer against the URL the document was found at, and accepted the document whenever either value failed to parse, so a junk `issuer` skipped the check that a well-formed mismatching one had to pass. An unverifiable issuer is now treated as a mismatch: discovery moves on to the next well-known path, exactly as it already did for a mismatch.
- Protected-resource metadata that cannot be read is now reported. It carries the scopes the grant should ask for, and a failed fetch produced the same "no scopes advertised" answer as a document that lists none, so the authorization request went out without them and came back as an opaque `invalid_scope` or `server_error` with nothing pointing at the cause.
- `veyyon grievances` no longer tells you to enable auto-QA when the database is there and cannot be opened. The two cases produced the same message, so advice that could not help hid the fact that your reported tool issues were being dropped. The message now names the path, `push --json` reports `reason: "unreadable_db"` rather than `"no_db"`, and the explanation goes to stderr in `--json` mode so piped stdout stays parseable.
- An unreadable artifact directory no longer presents as an `artifact://` reference that does not exist. Following the recovery link under a truncated tool output said the artifact was missing when the directory holding it could not be listed; the failure is now reported with the directory and the artifact id.
- A read that could not be summarized now says so. Failing to build the outline returned the same value as a file with nothing worth folding, so you got the whole file with no indication that an outline was attempted and lost. Cancelling a read stays quiet, because that is not a summarize failure.
- A session file that exists and cannot be read no longer presents as a session that is not there. `peekSessionInit`, the lock-free peek a cold subagent revives from, caught every failure and returned `null`, which is also its answer for a path that was never written, so an unreadable transcript was reported to you as a missing one. It still returns `null`, because that is the caller's contract, and it now warns first with the path unless the file is simply absent.
- An unreadable artifact directory is now reported instead of reading as a session with no artifacts. Artifacts are what an `artifact://` URL resolves against, so an empty listing made every truncated tool output in the session unreachable with no error to explain it. The listing still returns empty, since a session has to keep running when its artifacts are unreachable, and the warning names the directory.
- A tool call whose arguments cannot be serialized now renders its argument names in the `history://` transcript. A circular reference or a `BigInt` makes `JSON.stringify` throw, and the summary fell back to an empty string, so `→ write()` was printed for a `write` that had a path and a body. It now reads `→ write({unserializable: path, content})`.
- An unreadable sessions directory no longer looks like having no sessions. The cross-project scan
  behind the session picker and `--resume`, and the per-directory listing under it, answered any
  failure with an empty list, so a permissions problem presented as a user with no history: the picker
  came up empty, `--resume` had nothing to offer, and nothing was logged to disagree with. An absent
  directory is still an empty list in silence, because that is a project you have not opened yet. One
  that is there and cannot be read is now reported with the path, and the empty list is still returned
  so a picker that cannot list comes up empty rather than crashing.
- A click by selector that failed because the page re-rendered no longer reports it as an invisible
  element. Clicking examines every match and keeps the ones it can see; an element also leaves that
  list when the probe THROWS, which is what happens when the node is detached between the query and
  the check. That case was swallowed, and the timeout then said `no-visible-candidate`, which sent you
  to inspect CSS and stacking contexts for an element that was on screen the whole time. The timeout
  now distinguishes the two, counts the failed probes, and names the first error: `every candidate
  probe failed (3 of 3): Execution context was destroyed ...`, or, when both happened,
  `no-visible-candidate, and 2 of 5 probes failed: ...`.
- Seven packages' test suites are executed again. `scripts/ci-test-ts.ts` replaced the old `bun run --workspaces test`
  fan-out with three hand-kept lists of package paths, and argot, stats, deepswe-bench, metaharness, collab-web,
  tool-render and swarm-extension were never added to any of them, so 82 files and 1274 tests ran in neither CI nor a
  local full run. They all pass, in about seven seconds. `scripts/workspace-test-coverage.test.ts` now checks the
  lists against the tree in both directions, so a package cannot ship tests that nothing runs and a list entry cannot
  outlive the package it names.
- Formatting and import order are checked in CI. The lint job ran `biome lint`, which covers lint rules only, beside
  a step labelled "Biome check" that ran the TypeScript type checker and no Biome at all, so the formatter and the
  import-organization pass were gated by nothing: 39 files were unformatted and 25 had unorganized imports while both
  jobs reported green. `bun run check:tools` is now its own step and the mislabelled one says what it does.
- Benchmarks are linted. `packages/*/bench/**` was outside Biome's file list, so six unused-binding findings sat there
  unreported. The deliberately frozen key-parser baseline at `packages/tui/bench/_jskey.ts` stays excluded by path,
  because its unused declarations are the snapshot it exists to preserve.
- `tsc -p tsconfig.json` at the repository root no longer tries to compile the benchmark repositories downloaded into
  `packages/deepswe-bench/repo-cache/`. The root config is a solution file that owns no sources of its own, but it
  omitted `files: []`, so `include` defaulted to everything and the check failed on third-party syntax.
- Compaction has exactly two strategies. The settings enum has said `summary | handoff` for a while, but the
  type behind it still admitted `context-full`, `shake`, and `off`, so the code disagreed with the setting.
  The first two were engine actions rather than things you choose; `off` was a second way to spell
  `compaction.enabled: false`, which let two fields disagree about whether compaction runs. Turning
  compaction off is now `compaction.enabled` and nothing else. A config file that still says
  `strategy: off` keeps working: it loads as `handoff` with `enabled: false`, so compaction stays off.
- Extensions no longer see a compaction action that cannot happen. The `auto_compaction_start` and
  `auto_compaction_end` events typed their `action` as `context-full | handoff | shake`, and nothing has
  ever emitted `shake`, so an extension with an exhaustive switch was handling a case that could not
  occur. All three copies of that union now reference the one type that owns it.
- Constants that named one thing while meaning another. `STARTUP_TIMEOUT_MS` in the MCP manager is not a
  timeout: nothing is aborted when it elapses, cached tools are served while the connections keep
  running, so a name reading "an MCP server gets 250 ms to start or it is dropped" described behaviour
  the code never had; it is now `STARTUP_TOOL_WAIT_MS`. Four more pairs shared a name across unrelated
  subsystems and now say what they bound: a log rotation threshold against how much of a log tail a bug
  report may read, a debug session's in-memory output ring against the subagent return budget that has
  to match `VEYYON_TASK_MAX_OUTPUT_BYTES`, and a loopback broker connect budget against the network
  relay one. No behaviour changed; the numbers were always right, only the names were shared.
- The three eval sandboxes each spelled out their own environment allow-prefix list under one shared
  name with three different values, so widening the base that all of them need meant three edits and
  nothing failed if you made two. The base now has one owner and each runtime extends it with its own
  language prefixes. The Python and Ruby kernels likewise each typed the same startup timeout, with
  Julia typing a longer one; the shared value now lives in one place and Julia expresses its need as
  base plus margin, so raising the floor raises Julia's too.
- `veyyon auth-broker` could hand out a token it then rejected. Two brokers starting at the same time each minted a bearer token and the second overwrote the first, so a client told to use the first token was refused by the service that issued it. The broker also created the token file with the default mode and narrowed it afterwards, leaving it briefly readable by any local user, and on Windows, where that narrowing does nothing, permanently. The auth gateway had already solved both (an exclusive create at mode 0600, and treating a lost race as "read the winner's token"), and the two services now share one implementation with the gateway's behaviour.
- Fixed the rule that nudges you to `set_cwd` into another project delivering nothing most of the time. Three separate defects hit the same path. Its body was folded into the tool result unrendered, so the model was shown template markup that named neither directory and advised a tool that is off by default. The rule was marked as delivered the moment it was queued, and a turn that aborted or errored dropped the queue without taking that mark back, which retired the rule for the rest of the session. And rules fire once per session by default, which is right for a rule stating a convention and wrong for one whose advice applies again to the next directory, so a rule can now set `repeatMode` and `repeatGap` in its own frontmatter; this one repeats after eight messages. Your global `ttsr.repeatMode` and `ttsr.repeatGap` are unchanged.
- Fixed the bundled rule that nudges you to load a project's Argot shorthand never running. It shipped in every install as a file nothing loaded, and it could not have worked if it had been: it carried no trigger, and its body was gated on the argot feature being on rather than on the dictionary being missing, so with argot on it would have told the model to load a dictionary it had already loaded, on every edit. It now triggers on an edit in a project whose shorthand is not loaded, and only then. Two related fixes came out of it: a rule whose body renders to nothing is no longer delivered as an empty reminder, and every bundled rule file is now checked to be registered, so the next one cannot sit unloaded.
- Fixed a rule whose `condition` is blank matching everything instead of nothing. An empty pattern compiles to a regex that matches every character, so a half-written rule fired on every tool call and every line of prose for the whole session. A blank pattern is now skipped and reported, and a rule left with no trigger at all is refused with a message naming the file, instead of being loaded, listed by `/rules`, and silently never watched.
- Fixed a rule whose `scope` names a tool that does not exist loading as if it worked. A bare scope token is read as a tool name, so a typo like `raed` registered a rule that could never match, and that is indistinguishable from a rule whose condition simply never came up. Veyyon now reports it once the tool list is known, naming the rule, its file, and the closest tool it does know. The rule is not disabled, because a rule scoped to a tool an extension registers later is legitimate.
- Fixed inherit-able model settings (`subagent.model`, `compaction.model`, role models, the default model) being effectively one-way: once a model was assigned, the only path back to unset was the forward-Delete key, which many keyboards do not have, and Backspace fell through as a silent no-op. These pickers now lead with a visible `(inherit main model)` row (the default model's reads `(auto-select on launch)`) that clears the assignment like any other selectable row, Backspace clears alongside Delete when the search is empty, the footer names both paths, and an assigned slot opens with its model preselected so a quick Enter re-picks it instead of clearing.
- Fixed model switches bypassing `defaultEffort`. A session-only effort still wins, then an explicit selector suffix, then the new model's saved row, the any-model row, and the model default. Choosing Default clears the session override and immediately restores that chain.
- Fixed a mouse drag over the transcript doing nothing without a word of explanation. Scroll isolation holds the mouse so the wheel scrolls the transcript with the prompt pinned, which means selecting is shift+drag, and that tradeoff was stated only in a settings description. The first swallowed drag now names shift+drag, `/copy`, and `tui.scrollIsolation=false`, and a gated tip says the same before you hit it.
- Fixed the composer being replaced by a scroll readout while reading history: the contextual chip row under the prompt was overwritten with "N rows up / click to go to the bottom" whenever the transcript was frozen, so scrolling up during a run silently removed the `esc interrupt` chip. Scroll position is now drawn on the right edge of the transcript by the renderer, and the composer zone renders the same bytes whether the view is frozen or following.
- Fixed Task subagents calling MCP tools through a rebuilt raw request, which bypassed the source tool's harness-intent stripping, local-URL resolution and reconnect retry, and marked MCP-backed tools non-strict so the server owns validation.
- Fixed a configured `modelRoles.default` on a discovery provider being replaced at startup by an unrelated authenticated provider's default, when a cold catalog cache meant the role could not yet resolve.
- Fixed `session_stop` extension hooks running when a prompt was aborted or the session was disposed, so an abort could still trigger stop-hook work and its continuation state.
- Fixed a provider error being pinned behind the plan review overlay, which left the error invisible and the input unusable until the plan was answered.
- Fixed the `tools.maxTimeout` ceiling being ignored whenever a tool call omitted `timeout`, so a configured global cap did not bound a tool running on its default budget.
- Fixed isolated branch merge-back rejecting committed agent edits when the parent had unrelated uncommitted changes in the same file; dirty-baseline blobs are now seeded into the parent object database and replayed with a 3-way synthetic-tree apply ([#40](https://github.com/santhreal/veyyon/issues/40)).
- Fixed Esc aborting an ongoing agent turn instead of overlapping TTS playback, leaving speech uninterruptible.
- Fixed the remapped TypeBox compatibility shim omitting `Type.Unsafe`, which crashed extensions such as `vey-mcp-adapter` when they registered tools from raw MCP input schemas.
- `mnemopi`: validate the source name in renameBank to close a traversal.
- `settings-test`: drop wrong SettingPath cast that broke the release typecheck.
- `coding-agent`: make file moves crash-atomic; hoist mode-preserving atomic write.
- `install`: compare whole PATH entries on Windows, add gated ps1 function tests.
- `edit`: preserve a UTF-8 BOM through an old_text/new_text edit.
- `lsp`: don't silently swallow format-on-write failures.
- `website`: serve get.veyyon.dev root from a dedicated install-only tree.
- `release`: reclaim hashline perf bullet into [Unreleased]; keep new [Unreleased] below fork notice.
- `natives`: declare the four new loader-state exports in the .d.ts.
- `compaction`: count retained custom/branch tokens in keepRecent budget.
- `compaction`: cut past the crossing entry when keeping everything dead-ends.
- `tool-render`: deep-import formatCount so the collab-web browser bundle stops pulling Bun-only utils.
- `plugins`: plugin doctor reports ok for the fresh-install state.
- `session`: clearer no-model/no-key guidance pointing at /login and veyyon setup.
- `release`: skip changelog diff when no baseline ref exists (first release).
- `cli`: fail fast on non-TTY interactive/empty stdin; consume piped prompts.
- A secret vault changed by another session or process no longer kills the running session. Every
  display and render path (the streamed assistant message, the tool-intent working line, the
  transcript the TUI repaints, the state rebuild after a compaction or a branch move) now shows the
  placeholder unexpanded and raises an operator notice while it re-reads the vault, instead of
  throwing a codec error that unwound the whole session and left the TUI refusing every command.
  Text with no placeholder in it is never checked for freshness at all, so a command like
  `echo "$HOME"` can no longer be refused over a vault it does not touch.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
- `plugin-cli`: stop doubling the 'Error:' prefix in plugin command errors.
- `errors`: remove remaining doubled 'Error:' prefixes; generalize the source-lock.
- `install`: warn instead of silently skipping a failed shell completion.
- `edit`: trim apply_patch marker paths so the write matches the approved path.
- `hashline`: guard NodeFilesystem.move against deleting the file it just wrote.
- `hashline`: guard the production move adapter against deleting the file it just wrote.
- `hashline`: guard InMemoryFilesystem.move against dropping a same-key move.

### Removed

- Removed five directory barrels that nothing imported: `src/exa/index.ts`, `src/mcp/transports/index.ts`, `src/mnemopi/index.ts`, `src/modes/acp/index.ts` and `src/repair/index.ts`. Every consumer already reached the module directly, so each barrel was a second, silently incomplete list of its directory's exports. The subpath exports `@veyyon/coding-agent/exa`, `@veyyon/coding-agent/mcp/transports` and `@veyyon/coding-agent/modes/acp` are gone with them; import the module you want instead (`@veyyon/coding-agent/exa/tools`, `@veyyon/coding-agent/mcp/transports/stdio`, `@veyyon/coding-agent/modes/acp/acp-agent`), which is what every in-tree caller and every example already did. `@veyyon/coding-agent/mnemopi/index` and `@veyyon/coding-agent/repair/index` resolved through the wildcard subpath rather than a declared entry, and are likewise replaced by the direct module (`.../mnemopi/backend`, `.../repair/schema-repair`). A new barrel that nothing imports now fails `scripts/barrel-files-are-imported.test.ts`.
- Removed the `remoteCompaction` option from `models.yml`. It opted a provider or model into provider-native compaction, which was removed, so setting it configured nothing and gave you a session whose compaction was not what your config said. A config that still carries it is now refused at load with the provider, the model, and the replacement named: set `compactionModel` on the model, or the `compaction.model` setting. Deleting the key from your config is the whole migration.

## [1.0.37] - 2026-07-24

### Fixed

- `veyyon update` now updates source installs for real: it fast-forwards the checkout, reinstalls dependencies, and regenerates build artifacts, instead of refusing with advice to run `git pull` yourself.
- A source checkout missing its generated tool-views bundle (any freshly pulled or cloned checkout) no longer dies at launch with a raw module-resolution error: the launcher regenerates the bundle before starting, and fails with the exact fix command if it cannot.
- The setup wizard now paints its own pure-black ground across the full frame (splash, scene transitions, and outro), so the launch sequence looks the same on every terminal background instead of inheriting the terminal's color.
- The Windows binary is now built as a modern (AVX2) Bun target instead of baseline. Baseline Windows standalone builds crash in the Bun runtime at startup before any Veyyon code runs (oven-sh/bun#32684), which made every published `veyyon-windows-x64.exe` exit with a segmentation fault on launch. The modern target requires a CPU with AVX2 (Intel Haswell 2013 / AMD Excavator 2015 or newer).

## [1.0.36] - 2026-07-24

## [1.0.35] - 2026-07-24

### Changed

- `slash-commands`: drop unnecessary 'as SettingPath' casts.
- `atomic-write`: allowlist hashline's deliberate node:fs-only temp+rename.

## [1.0.34] - 2026-07-24

### Fixed

- `update`: rich release-binary download-failure message.
- `update`: verify self-update binary checksum, fail closed (parity with installers).
- `update`: honest --check --force message when already up to date.

## [1.0.33] - 2026-07-24

### Changed

- `ai`: give heavy idempotence property tests explicit timeouts.
- `test`: give packages/ai a 20s per-test timeout floor.

### Fixed

- `settings`: quarantine wrong-shape settings files instead of dropping them silently.
- `keybindings`: quarantine wrong-shape keybindings files instead of corrupting the map.

## [1.0.32] - 2026-07-24

### Changed

- Verify the published Windows binary runs (install channel had no release verification).
- Verify get.veyyon.dev serves the install script post-deploy (curl|sh regression guard).
- Assert the published binary reports the release version (all platforms).

### Fixed

- `mnemopi`: migrate the legacy triples database crash-atomically.
- `hashline`: crash-atomic NodeFilesystem writes.

## [1.0.31] - 2026-07-24

### Changed

- `ai`: cover in-flight slot release when a provider request fails.

### Fixed

- `coding-agent`: make apply_patch default filesystem crash-atomic.
- `mnemopi`: write content-addressed blobs crash-atomically.

## [1.0.30] - 2026-07-24

### Fixed

- `coding-agent`: commit edits and writes crash-atomically.

## [1.0.29] - 2026-07-24

### Changed

- `utils`: one owner for the read-tool selector grammar.
- `install`: extract + cover the Windows checksum verification path.
- `ai`: lock global idempotence of validateToolArguments on valid input.

### Fixed

- `install`: remove a partial binary download on failure (Windows).

## [1.0.28] - 2026-07-24

### Changed

- `install`: fix ps1 backup-branch discovery (scalar-index bug) and make it robust.

### Fixed

- `install`: preserve local src edits on Windows update/uninstall (parity with install.sh).
- `ai`: stop over-coercing string|number tool args to numbers.
- `cli`: guard fatal-error cause walk against circular cause chains.

## [1.0.27] - 2026-07-24

### Changed

- `catalog`: lock anthropic models.dev outage fallback; document the swallow.

### Fixed

- `install`: write PATH to the login-shell rc on macOS, not ~/.bashrc.

## [1.0.26] - 2026-07-24

### Changed

- Rebuild handbook book to match sources.
- `utils`: differential property suite for the JSON repair/parse path.

### Fixed

- `utils`: stop normalizeBaseUrl leaking a trailing space behind a stripped slash.

## [1.0.25] - 2026-07-24

### Added

- `tui`: accelerate repeated wheel ticks in scroll isolation.

### Changed

- `coding-agent`: never block session startup on argot dictionary generation.
- `ai`: hoist duplicated OpenAI SSE event-name resolver into one owner.
- `tui`: update the EIO write-failure test to the fatal/transient contract.

### Fixed

- `tui`: don't brick rendering on a single transient write failure.

## [1.0.24] - 2026-07-24

### Added

- `coding-agent`: present only alabaster while the light-theme slab class is unfixed.

### Changed

- `coding-agent`: lock the argot mid-session prompt-refresh contract.

### Fixed

- `coding-agent`: teach argot handles after a mid-session load.

## [1.0.23] - 2026-07-24

### Changed

- Enforce the changelog gate on direct-to-main pushes.
- Describe the changelog gate as running on direct-to-main pushes.

### Fixed

- `edit`: stop applyCodexPatch from silently hiding partial application.

## [1.0.22] - 2026-07-23

### Added

- `coding-agent`: unify the run clock, merge model effort, clickable scroll-to-bottom.

### Changed

- Set veyyon package author to santhreal.
- `natives`: cover the runtime load gate that threw for stale addons.
- `coding-agent`: make the agents-guidance isolation helper async and profile-aware.
- `types`: sync loader-state.d.ts with the tri-state + load-gate API.
- `natives`: cover the runtime AVX2 classifier + lock parity with the build one.

### Fixed

- `ci`: make single-owner guards self-contained and clear unused-import lint errors.
- `natives`: don't silently downgrade to baseline when AVX2 detection fails.
- `build`: don't silently build baseline-only when host AVX2 probe fails.
- `website`: serve install.sh at the get.veyyon.dev root.

## [1.0.21] - 2026-07-23

### Changed

- `changelog`: note the release-publish fix for the next release.

### Fixed

- `release`: ci-release-notes.ts must not import a workspace package.

## [1.0.20] - 2026-07-23

### Changed

- `release`: assert the tarball smoke PACKS every closure dep, not just overrides it.

### Fixed

- `release`: never rewrite the native sentinel inside test files.

## [1.0.19] - 2026-07-23

### Changed

- `natives`: cover the ship-path stale-native guard on real .node bytes.

### Fixed

- `smoke`: force core native-addon load in --smoke-test.
- `ai`: create the config dir before writing the Kimi device-id file.
- `coding-agent`: make the recent-sessions recency order deterministic.

## [1.0.18] - 2026-07-23

### Fixed

- `ci`: keep hashline scale suites under the 5s per-test limit on slow CI.

## [1.0.17] - 2026-07-23

### Changed

- `hashline`: reject bodyless SWAP with EMPTY_REPLACE in expand/contract scale suites.
- `hashline`: O(n) large-range applyEdits; bound the O(n^2) scale suites.
- `ci`: run release-sentinel.test.ts in the workspace scripts bucket.
- `hashline`: meta-guard that scale suites never reintroduce a large 1..n sweep.

### Fixed

- `ci-test-ts`: honor the native bucket's --smol request.
- `release`: scope the native sentinel bump to the previous version only.
- `natives`: restore native sentinel test fixtures corrupted by the 1.0.16 bump.

## [1.0.16] - 2026-07-23

### Fixed

- `natives`: refuse to embed a native addon built for the wrong version.
- `install-smoke`: pack argot + build prepack bundle so release gate passes.

## [1.0.15] - 2026-07-23

### Added

- `coding-agent`: ease the footline badge slot open and closed.
- `tui`: release the mouse when the frame fits the viewport.

### Changed

- Document scroll isolation in the settings reference and renderer internals.
- `install`: --uninstall never deletes a checkout holding local work.

### Fixed

- `install`: never reset over local checkout edits; back-fill profile AGENTS.md.
- `task`: resolve a relative subagent cwd against the parent, not reject it.
- `install`: make preserve/move-aside backup names collision-proof.
- `ci`: green the Checks and Docs gates.
- `coding-agent`: align the composer band at the rail under the location group.
- `docs`: delink references to local-only design.md.
- `set-cwd`: gate the argot_load advice on argot.enabled, not the argot session.

## [1.0.14] - 2026-07-23

### Changed

- Preserve in-progress startup-cwd and home-anchor-layout edits.

### Fixed

- `ai/dialect`: route model-controlled arg keys through prototype-safe setToolArg.
- `utils,ai`: share one prototype-safe dynamic-key primitive; fix loop-guard hash collision.
- `utils/json-parse`: store __proto__ keys safely in the relaxed/streaming parser.
- `coding-agent`: make the composer anchor stateless, no latch-off on transient spikes.
- `onboarding`: run the setup wizard on first install only, never on update.

### Removed

- `polish`: drop the 'sun' from user-facing copy (it's design, never named).

## [1.0.13] - 2026-07-23

### Added

- Add ship-skills index and prove-feature bar.
- Ship real demo captures and wire them through README and the site.
- Add root changelog sync and tighten release CI gates.
- Land pending coding-agent TUI, session, and test work.
- Land remaining package and natives pending work.
- Land remaining coding-agent SDK and JTD prompt tweaks.
- Land leftover JTD and deepswe-bench run tweaks.
- `stats`: attach turn context to request details instead of a lone reply.
- `dist`: GitHub-only update path and changelog-gated auto-release.
- `tui`: scroll isolation, wheel scrolls the transcript, footer stays pinned.

### Changed

- Replace README mark with the entrance ASCII sun.
- Pin demo recordings to Gemini 3.6 Flash high on the work profile.
- Update website pages and sun field assets.
- Sync handbook and docs tree with pending content work.
- Fold snapcompact into agent as legacy archive compaction.
- Expand hashline adversarial and apply-suite coverage.
- Point AGENTS proof ritual at ship skills; drop keyhog baseline from git.
- Harden JTD-to-TypeScript conversion and image-tool gating tests.
- Tidy deepswe-bench runner and pier agent glue.
- Prove search cwd gating, reset keybindings between tests, and drop natives embed from source.
- Harden settings-test-state keybindings isolation for full-suite pollution.
- Re-sync root CHANGELOG with coding-agent source.
- Migrate discovery and render-utils tests onto settings-test-state isolation.
- `stats`: clarify negation lead patterns are message-leading, not line-leading.
- `utils`: cover frontmatter key normalization, fences, fallback, and error levels.
- `utils`: add behavioral coverage for isUuid and isDateOnly validators.
- `stats`: fix misleading folder-encoding example in extractFolderFromPath.
- `markit`: one owner for markdown-table layout, fix ragged-row data loss.
- Unify HTML entity decoding into one single-pass owner.
- Compile glob excludes once and dedup overlapping matches.
- Count JSON-schema string length in code points, not UTF-16 units.
- `ai`: cache JSON-schema pattern compilation instead of recompiling per value.
- `utils,ai`: one owner for rate-limit reset epoch/delta classification.
- `hashline`: correct inverted before/after direction in AnchorNeighbors.
- Expand coding-agent regression corpus and operator path contracts.
- Expand path-utils corpus pack and thicken regression contracts.
- Expand normalize-roots corpus and thicken settings/CLI contracts.
- Expand corpus for gh-url, timeouts, compact args, and line ranges.
- Expand corpus for search/find parse, RPC builders, and conflict review.
- Expand corpus for title slots, drive aliases, and media formatters.
- Expand corpus for output notices, Codex redeem gates, and git/changelog parsers.
- Revert accidental eval/deepswe files from the corpus expansion commit.
- Expand corpus for gallery states, JSON payload, search dates, and languages.
- System prompt: composition seam + gate-parity across the prompt family.
- Install + docs: setup-cli, doctor, install.sh, handbook pages, demo assets.
- Rebuild handbook site and update guide/reference pages.
- `coding-agent`: checkpoint work-in-progress tests and src.
- `hashline`: checkpoint work-in-progress tests, src, benches, scripts.
- `packages`: checkpoint wip across ai, tui, utils, catalog, natives, mnemopi, agent, metaharness, bench, collab-web.
- `root`: checkpoint scripts, skills, README/AGENTS, config, lockfile, assets.
- `prompt-sections`: make reorder duplicate-safe, add property/adversarial tests.
- `prompt`: cover the 18 previously-untested render helpers.
- `prompt`: lock closing-brace disambiguation contract (JSON works, triple-stash unsupported).
- `system-prompt`: unit-test the prompt-source dedup logic.
- Rename dedup unit suite to prompt-source-dedupe-matcher.
- `render-utils`: pin capPreviewLines tail-window math and formatMoreItems.
- `render-utils`: cover truncateDiffByHunk budget-fill and context-ratio branches.
- `coding-agent`: assert the first message hugs the composer, no reserved void.
- `bash-skill-urls`: direct unit coverage for resolveSkillUrlToPath.
- Snapshot in-progress working tree to preserve uncommitted changes.
- `tui`: derive the pinned footer rows from the compose segment ledger.
- `coding-agent`: add scrollToLiveTail to the InputController ui stubs.
- `utils`: one owner for the source-lock package walk.
- `onboarding`: clarify check is the typecheck+test gate, biome is advisory.
- `mnemopi/mmr`: drop provably-dead MMR top-up branch, pin length invariant.
- `test`: O(n) fuzz content generator; explicit timeout for DATALOSS-2 fuzzer.

### Fixed

- Close non-Argot P1/P2 hygiene: changelog, search cwd proof, natives tarball, suite isolation.
- Stop process-global mock.module pollution of utils and natives.
- `coding-agent`: escape external text in markdown tables; fold whitespace in fuzzy normalizer.
- `scrapers,markit,metaharness`: escape external text in markdown tables; unify pptx run join.
- `scrapers`: route markdown links through one paren-safe builder.
- `scrapers`: route external-data links through markdownLink to stop paren truncation.
- `scrapers`: escape external table cells in terraform and dockerhub.
- `scrapers`: route sec-edgar links through markdownLink to stop paren truncation.
- `utils`: roll formatNumber tier-top rounding overflow up to the next unit.
- `utils`: promote formatBytes boundary values that round up to a full unit.
- `web`: keep HN comment links whole through markdownLink.
- `markit`: keep numeric EPUB metadata instead of dropping it.
- `utils`: detect dotted-version integer components strictly, not via parseInt.
- `web`: decode &amp; last so doubly-encoded entities stop at one level.
- Fix markit dropping a numeric-zero cell/run and unify XML text extraction.
- Fix time and ipv6 JSON-schema format validation.
- `mnemopi`: substitute conversation text into extraction prompt verbatim.
- `markit`: render large tables without the argument-spread ceiling.
- `mnemopi`: route SHMR/scratchpad env tunables through envInt/envFloat.
- `catalog`: parse OpenRouter pricing through toPositiveNumber, not bare parseFloat.
- `coding-agent`: accept any-length time fractional seconds per RFC 3339.
- `coding-agent`: require RFC 3339 shape for the date-time format.
- `coding-agent`: range-bound the time format components.
- `schema`: one float-safe multipleOf owner for both schema validators.
- `coding-agent`: count typebox string length in code points, not UTF-16 units.
- `coding-agent`: compile typebox string pattern once and fail invalid ones cleanly.
- `catalog`: canonicalize hand-authored thinking effort ladders at build.
- `mnemopi`: match named times as whole words, not substrings.
- `metaharness`: keep edit-benchmark fail disjoint from error.
- `mnemopi`: drop decorative voice weights that never reached RRF scoring.
- `system-prompt`: fix Linux GPU name extraction and Matrox BMC skip.
- `tui`: stop the live-region blank-hole regression in transcript layout.
- `tui`: re-anchor editor at viewport bottom when a tall transient block collapses.
- `tui`: re-anchor the editor when a collapsed frame fits the viewport.
- `settings`: type DEFAULT_MODEL_SETTING_ID as SettingPath at its definition.
- `test`: make the regression corpus runner typecheck under strict matchers.
- `tui`: give the composer shortcut band a fixed one-row height.
- `tui`: anchor the editor after collapse even when the transcript overflows.
- `jtd`: honor nullable and metadata.description in JTD to JSON Schema conversion.
- `lang`: detect Makefile by basename in getLanguageFromPath.
- `dist`: vendor argot as packages/argot so a clean clone builds.
- `catalog`: apply compat overrides by own-key, not prototype membership.
- `ai`: validate JSON Schema object keywords by own property, not `in`.
- `ai`: own-property omit + membership in Responses chain equality.
- `ai`: stop silently dropping Codex client metadata named after prototype keys.
- `ai`: use own-property membership for prototype-named header/effort keys.
- Own-property membership for bareword and advisor-noise lookup sets.
- Exclude standalone argot package from ONE-PLACE source locks; dedup jtd guard.
- `coding-agent`: align the agent transcript viewer chrome on the shared left rail.
- `agent,catalog,hashline`: typed normalizeTools overload, drop removed cost.total, tighten test casts.
- `catalog,collab-web`: silence prototype-member and codec expect type errors.
- `ai/cursor`: stop mislabeling date-bearing grep matches as context lines.
- `release,ai`: make natives sentinel rewrite exhaustive; type http2 stream param.
- `release,install-test`: use Bun.Glob for sentinel discovery; pin XDG completion dirs.
- `release`: rebase-retry the bump push so a busy main can't kill the release.
- `test`: update GPU-probe cache expectation to the prefix-stripped name.

### Removed

- Drop the black fill from the README sun mark.
- `prompt`: remove dead topLevelTags bookkeeping from format() hot path.

## [1.0.12] - 2026-07-20

### Added

- `skills`: load skills only from the active profile.
- `profile`: interactive picker and full verb set for /profile.
- `utils`: give clamp01 one owner and fix its NaN divergence.
- Add batched() array helper and fold five hand-rolled batch loops onto it.
- `tui`: add conservation fuzz for the bracketed-paste state machine.
- `utils`: give the profiles path segment one owner (PROFILES_DIR_NAME).
- `settings`: per-model thinking effort on compaction.model + subagent.model.
- Add /thinking (and /effort alias) command and interactive effort picker.
- Add effort step to the settings model roles picker via a shared renderEffortStep.
- Render model-slot effort as readable ' · high' across settings rows and role list.
- `approval`: add full-bypass rung for the /yolo command.
- `approval`: /yolo command for a full session permission bypass.
- Add --dangerously-skip-permissions launch flag for full permission bypass.
- Add settings UI option round-trip guard (HSL-2).
- Add exhaustive fail-closed approval precedence matrix (HSL-4).
- Add settings sentinel-default + model-selector round-trip guards (HSL-1, HSL-3).
- `utils`: add atomicWriteFileWith and route the last hand-rolled atomic writers through the owner.
- `profile`: create profiles atomically via a staging dir + rename.
- `instructions`: load exactly three instruction layers by default.
- `instructions`: seed a new profile's AGENTS.md on creation.
- `session`: per-profile workdir, agent setCwd, task cwd input.
- `session`: canonicalize outbound tool call ids per provider compat.
- `session`: relativize wire paths under session roots (TW-10).

### Changed

- Repoint two assistantText copies onto the @veyyon/ai owner.
- Repoint mnemopi local-llm envInt + estimateTokens to their owners.
- Shrink errorMessage + estimateTokens source-lock allowlists.
- Repoint two AssistantMessage inline text extractions to assistantText.
- Rebrand the two GitLab Duo GraphQL operation names omp_ -> veyyon_.
- `ai`: extract shared formatOpenAiError for the two byte-identical OpenAI-compatible error envelopes.
- `ai`: dedup 6 inline trailing-slash strips onto trimTrailingSlashes.
- Dedup 9 more inline trailing-slash strips onto trimTrailingSlashes.
- `ai`: lock getProviderDetails endpoint normalization (strip-all trailing slashes).
- `ai`: pin formatOpenAiError wire envelope, status, and content-type.
- Dedup inline errorMessage ternaries onto the @veyyon/utils owner.
- `ai`: dedup inline errorMessage ternaries in the ai server/provider modules.
- `utils`: cover async and glob modules.
- `agent`: repoint compaction-v2-streaming onto errorMessage owner.
- `hashline`: cover tokenizer public surface.
- `hashline`: one owner for hasAnchorScopedEdit; drop dead getter.
- `hashline`: cover Executor.reset, snapshot recordSeenLines + base findByHash.
- `hashline`: cover empty-file INS.HEAD/INS.TAIL apply branch.
- `agent`: cover CompactionCancelledError sentinel contract.
- `catalog`: cover gemini/antigravity wire headers; drop redundant ternaries.
- `catalog`: cover credential-gated special model-manager builders.
- `catalog`: cover google-family model-manager builders.
- `catalog`: cover the lazy bundled reference index.
- `hashline`: one owner for edit anchor-line collection.
- `utils`: cover the module-load timing buffer.
- `ai`: cover createProviderErrorMessage.
- `ai`: cover the kimi-code usage provider parse chain.
- `ai`: cover the gemini-cli usage provider.
- `ai`: cover the ollama/ollama-cloud usage providers.
- `ai`: cover the minimax-code usage provider stub.
- `ai`: cover the github-copilot usage provider.
- Rust Book register pass and em-dash removal across all prose.
- Fix phantom CLI flags in handbook and rebuild book.
- Correct exit-code table (usage errors are 2, add 130).
- Remove em dashes from user-facing --help text.
- Rebuild handbook for the skills and profile changes.
- Replace inline error-message ternaries with errorMessage().
- Repoint inline trailing-slash strips onto trimTrailingSlashes.
- Unify strip-one base-URL normalizers onto trimTrailingSlashes.
- Repoint assistantText copies onto the @veyyon/ai owner.
- Repoint web-provider asRecord copies onto the @veyyon/utils owner.
- Repoint stringField copies onto the getStringProperty family.
- Rename coarse formatDuration to formatDurationCoarse.
- Repoint ai ollama normalizeBaseUrl onto the catalog owner.
- Document VEYYON_SKIP_SETUP, VEYYON_NO_WEBP, VEYYON_HARMONY_DEBUG.
- `utils`: real-value coverage for module-timer instrumentation helpers.
- `utils`: fold five normalizeBaseUrl copies into one owner.
- `utils`: real-value coverage for tab-spacing editorconfig resolution.
- `utils`: real-value coverage for $which PATH resolution and cache policies.
- `utils`: real-value coverage for the ptree subprocess primitive.
- `utils`: cover dirs pure surface, profile-name validation, path containment, hashPath, worktree base resolution.
- `metaharness`: rename local formatDuration to formatTraceDuration.
- `hashline`: cover normalize.ts, line-ending detection, LF round-trip, BOM stripping.
- `hashline`: cover containsRecognizableHashlineOperations op-recognition boundary.
- `escapeRegExp`: remove last test-helper copy and extend the lock to guard tests.
- Fold test-local isRecord/stripAnsi copies onto owners and lock test dirs.
- `utils`: extend url/tokens source locks to guard test dirs.
- `coding-agent`: fold six local isRecord copies onto @veyyon/utils.
- Fold remaining four isRecord copies onto the single owner.
- `settings`: surface legacy-migration failures instead of swallowing them.
- Walker+discovery: surface an unreadable scan root instead of scanning it as empty.
- `read`: document the trailing-newline phantom line as intentional.
- `grep`: rename resolve_search_path to resolve_grep_operand.
- `tool-render`: one browser shortenPath owner, kill same-name divergence.
- `utils`: extract splitTextLines, dedup two identical copies.
- `coding-agent`: route assistant-text extraction through the ai owner.
- `utils`: extract contentText, dedup two tolerant user-text extractors.
- `utils`: one UUID matcher (isUuid), dedup three identical copies.
- `utils`: one date-only matcher (isDateOnly), dedup four copies.
- `utils`: one owner for the scheme:// regex family.
- `utils`: one owner for the bare scheme: URI-prefix check.
- `catalog`: single owner for the zeroed Usage/cost literal.
- `ai`: one owner for the Copilot fetch-JSON helper, plus usage coverage.
- `utils`: one owner for millisecond duration constants.
- Usage/mnemopi/stats: route inline duration literals through the time owner.
- `utils`: one owner for the relay reconnect backoff schedule.
- `utils`: one owner for string/number coercion, kill asString same-name divergence.
- Align every sleep onto Bun.sleep / untilAborted, one primitive.
- Fold every isRecord clone onto the @veyyon/utils owner.
- Replace inline isRecord predicates with the utils owner.
- Rename the dialect asRecord to recordOrEmpty.
- `one-place`: fold negated inline isRecord onto the shared owner.
- `one-place`: fold mnemopi env helpers onto the util/env owner.
- `coding-agent`: one owner for message content flattening.
- Utils,ai,coding-agent,stats,metaharness,swarm: one owner for safe JSON parse.
- `utils`: one owner for JWT payload decoding.
- One clamp owner across packages.
- `utils`: one owner for the alphanumeric character class.
- `utils`: add clampLow owner for the floor-first clamp idiom.
- `utils`: fold floor-first clamp idiom onto clampLow across all non-modes packages.
- `tui`: one owner for the inline-markdown token grammar.
- `mnemopi`: one owner for the unicode word-token character set.
- `ai`: cover cursor usage provider edge branches.
- `coding-agent`: fold three inline truncate copies onto the utils owner.
- `mnemopi`: one detectLanguage owner, wired to the comprehensive detector.
- `ai/usage`: one owner for the used-fraction status ladder.
- `mnemopi`: one owner for temporal scoring, delete the dead forks.
- `mnemopi`: fold beam envNumber into the util/env owner.
- `ai/usage`: fold claude/zai/opencode-go into the status owner.
- `ai`: unify toNumber to the catalog owner.
- `session`: fold the last content flattener onto contentText.
- `mnemopi`: cover the plugin system's error and lifecycle paths.
- `mnemopi`: cover ExtractionDiagnostics directly.
- `mnemopi`: one owner for the log-truncation idiom.
- `mnemopi`: close entities and binary-vector branch gaps.
- Unify tableExists into @veyyon/utils/sqlite (ONE-PLACE).
- Fold two isObject clones onto the canonical isRecord (ONE-PLACE).
- Unify the SQL placeholder builder into one sqlPlaceholders (ONE-PLACE).
- Repoint five inline sqlite_master existence checks to tableExists (ONE-PLACE).
- `utils`: unify SQL LIKE-wildcard escaping onto one escapeLike owner.
- `tui`: cover decodeReencodedPasteControls with byte-exact tests.
- `ai`: cover normalizeCodexBaseUrl branches (issue #3679 guard).
- `ai`: cover calculateAnthropicRetryDelayMs backoff bounds.
- `ai`: cover buildBetaHeader anthropic-beta assembly.
- `ai`: cover dialect coercion helpers (overlap, kimi name, jsonTypeOf).
- `ai`: cover mintToolCallId format and same-ms uniqueness.
- `coding-agent`: unify scraper partial-ISO date assembly into one owner.
- `coding-agent`: pin formatMediaDuration hour boundary and padding.
- `coding-agent`: cover formatDurationCoarse and renderAsciiBar edges.
- `coding-agent`: show download state + cached size in tiny-models list.
- `coding-agent`: scope the glob timeout in read path resolution.
- `coding-agent`: scope the marketplace catalog fetch timeout.
- `coding-agent`: scope subagent-teardown cleanup timeouts.
- Make npm-plugin agent discovery test profile-hermetic.
- `coding-agent`: scope the codex reset-credit redeem timeout.
- Make three plugin/config tests profile-hermetic.
- `cli`: load per-profile .env by importing errorMessage via subpath, not the barrel.
- Guard the whole pre-setProfile import graph against eager .env loads.
- `mnemopi`: one owner for the stored-embedding wire format.
- `mnemopi`: surface throwing memory-stream listeners instead of swallowing them.
- `mnemopi`: fold recall.ts parseEmbedding into the shared embedding codec.
- `mnemopi`: hoist query norm out of recall's per-candidate cosine loop.
- `mnemopi`: one owner for the set-jaccard similarity formula.
- `mnemopi`: route weibull/patterns timestamps through the canonical UTC parser.
- `mnemopi`: store cost-log timestamps as UTC via the canonical toUtcIso.
- `mnemopi`: cover the config env resolvers to 100%.
- `mnemopi`: cover the DR backup/restore/rotate/health API.
- `mnemopi`: cover extraction parse helpers and local heuristic fallback.
- `mnemopi`: cover beam detectLanguage, lexical partials, metadata coercion.
- `mnemopi`: cover SHMR belief parsing, cluster formatting, and reflect.
- `mnemopi`: cover local-llm prompt build, cleanOutput, and chunk budget edges.
- `mnemopi`: cover embedding input truncation window and provider availability.
- `mnemopi`: cover MCP initialize, tools/call dispatch, errors, and CLI flags.
- `mnemopi`: cover CLI sleep, diagnose, and --help handlers.
- `mnemopi`: give the summarization header one owner.
- `mnemopi`: cover MEMORIA category storage, veracity aggregation, ability routing.
- `mnemopi`: fully cover veracity consolidation helpers and conflict lifecycle.
- `mnemopi`: cover temporal-parser relative-day, delta units, and this-month/year.
- `mnemopi`: lock typed-memory priority, decay, and length-boost tables.
- `mnemopi`: cover local-llm transport error paths and runtime-scoped options.
- `mnemopi`: cover fastembed download failure, orchestrator embedding conversion, empty extension specifiers.
- `mnemopi`: cover embedding API transport, availability branches, and local-model cache/error paths.
- `mnemopi`: cover extraction transport failure, no-output diagnostics, and salvage-miss line parsing.
- `mnemopi`: cover recall date-window, author, and channel scope filters plus single-token lexical boost.
- `mnemopi`: cover BeamMemory hub delegators (global/scoped stats, fact-extract, MEMORIA, degrade, health, sleep-all, consolidation-log).
- `mnemopi`: cover getEpisodicStats author/type/channel scoping + health healthy/stale/error arms.
- `mnemopi`: cover recall source/veracity/memoryType filters + lock topic-eq-source behavior.
- `mnemopi`: cover local-llm guard branches (sleep-prompt render, empty chunk/summarize, no-baseURL, llmAvailable arms).
- `mnemopi`: cover EpisodicGraph getFact + getEdges list/endpoint-filter paths.
- `mnemopi`: cover module-level write/read aliases, consolidate, and the db-backed annotations facade.
- `mnemopi`: cover MemoryStream off/offAny, iterator return-with-pending, and DeltaSync checkpointRoot derivation.
- `mnemopi`: cover mcp-tools surface labels by kind and validate update path.
- `mnemopi`: cover store trust-tier derivation, temporal annotations, and episodic invalidation.
- `mnemopi`: cover episodic veracity aggregation fallthrough and graph-enrichment failure.
- `mnemopi`: cover parseNlDate year branches and diagnose inspect-failure path.
- `mnemopi`: cover shmr provider-failure embedding fallback and update-belief application.
- `mnemopi`: cover minimumRecallRelevance tiers and e6 migration missing-db guard.
- `mnemopi`: cover schema ALTER-migration path and build-side non-finite vector drops.
- `mnemopi`: cover empty-vector, unknown-synonym, no-recall, graph close, and module query aliases.
- `mnemopi`: cover proactive-link failure, batch extract scheduling, and annotation unique-index skip.
- `mnemopi`: pin adversarial LLM-output parsing (category caps, field priority, fence, punctuation).
- `agent`: pin compaction message transform for every core+compaction role.
- `agent`: cover branch entry collection, conversion, file-op accrual, and early returns.
- `agent`: cover shake block regions for user/developer/custom entries and the compaction boundary.
- `agent`: cover openai compaction endpoint resolution, native-history encoding, and codex auth headers.
- `agent`: cover telemetry content capture, gateway detection, warning hooks, invoke_agent aggregates, and value shaping.
- `agent`: cover v2 streaming compaction endpoints, retained-history truncation, SSE collector, and retry loop.
- `agent`: cover Agent accessor/mutator/queue surface, listener resilience, and busy guard.
- `agent`: cover compaction token-estimate role branches, cut-point detection, and threshold resolution.
- `agent`: cover proxy stream non-ok responses, thinking blocks, event-order guards, and mid-stream abort.
- `agent`: cover compaction utils legacy serializer, edit/elided file-ops, upsert, and truncation.
- `agent`: cover pause-gate paused/pausedAt getters and run-collector runEnded latch.
- Extract effortStepItems for testable effort-picker row ordering.
- Extract and test subagent thinking-effort precedence (explicit suffix wins).
- Extract effort-picker module so settings and advisor share one effort UI source.
- Docs: document per-model effort step, /thinking (/effort), and thinking keybindings.
- Make the compaction threshold an absolute token amount, model-independent.
- Goal status-line: always-on token readout, streaming icon motion, near-budget warning.
- `goals`: track completed-turn count on goal state.
- Goal mode: down-arrow opens the goal detail menu; richer detail card.
- Goal status indicator, down-arrow affordance, turn count.
- `shake`: elide redundant identical tool-results (re-reads / re-runs).
- `write`: lock result body to a byte-count summary with proving tests.
- `shake`: extract offload tail + add lossless dedupeRedundantToolResults primitive.
- `compaction`: run lossless dedup as a Tier-0 pass on every strategy.
- `config`: write config.yml atomically so an interrupted save can't corrupt profiles.
- `config`: write the global defaultProfile pointer atomically too.
- `config`: route hand-rolled atomic writers through the canonical helper.
- `markit`: route the mupdf cache-asset write through atomicWriteFileSync.
- `mnemopi`: use errorMessage() in memory-stream listener isolation.
- `utils`: source-lock hand-rolled temp+rename to the atomic-write owner.
- `profile`: clear the launch-default pointer when its profile is removed.
- `settings`: pin the first-run invariant on the unlocked legacy-migration write.
- Lock writeGlobalDefaultProfile; move file-lock into @veyyon/utils.
- Harden profile create: atomic display-name clear + race backstop tests.
- Rename active profile through the live settings singleton.
- Warn on profile rename to an unreachable display name.
- Make legacy default-profile migration resumable.
- `mcp`: serialize mcp.json read-modify-write under a cross-process lock.
- `ssh`: serialize ssh.json read-modify-write under a cross-process lock.
- `keybindings`: write keybindings.yml atomically to prevent torn-file corruption.
- `config`: migrate JSON to YAML atomically to prevent stuck corrupt files.
- `status-line`: stub isApprovalBypassed in session mocks.
- `images`: use a local WebP fixture for the Kitty tool-image test.
- Drop reference to deleted plugin installer.ts.
- `system-prompt`: isolate HOME so the GPU probe cache can't leak.
- Clear biome lint blocking the release check gate.
- `utils`: make type-guards source locks fast enough to not time out.
- `contributing`: require before/after screenshots for UI changes.
- Make npm publish opt-in via NPM_PUBLISH repo var.
- `grep`: spill oversized results to a recoverable artifact instead of silent loss.
- `ui`: show every launched subagent's model across all agent surfaces.
- Prepare 1.0.12: shared profile credentials, Global settings tab, per-profile cwd, argot wire.

### Fixed

- Normalize doubled trailing slashes in base-URL resolvers via trimTrailingSlashes.
- `auth`: sign-in success page text sits below the sun, not over it.
- `stats`: deep-import errorMessage in the browser-graph SyncButton.
- `utils`: close the unhandled-rejection window in ChildProcess.wait.
- `tool-render`: route truncate through the code-point-safe owner (no more surrogate-splitting).
- `capability/fs`: surface unreadable context files instead of silently dropping them.
- `claude-plugins`: surface malformed plugin/marketplace manifests instead of swallowing them.
- `config/settings`: surface project settings discovery warnings (Law 10).
- `discovery`: surface malformed --plugin-dir manifest instead of silent basename fallback (Law 10).
- `grep`: fail closed on an unreadable directory operand (Law 10).
- `cli`: reject positionals beyond the declared args (Law 10).
- `read`: exit non-zero when the read CLI cannot deliver content.
- `cli`: unknown command exits 1 on the help path, with one message.
- `metaharness`: use byte-aware token estimate, drop chars/4 heuristic.
- `tui`: stop bracketed paste from swallowing pre-marker bytes.
- Close modal overlays exactly once, even on synchronous or racing done().
- `settings`: cycle a value with click-then-choose, not Left/Right.
- `io`: harden user-config writes and keep the utils barrel off early-load paths.
- `bash`: spill oversized abort/timeout output to an artifact.
- `bash`: reuse sink artifact for oversized timeout/abort output.

### Removed

- `coding-agent`: delete dead plugin installer duplicate.

## [1.0.11] - 2026-07-18

### Changed

- `utils`: promote collapseWhitespace to the repo-wide owner.

### Fixed

- `ci`: generate tool-views before release binary bundle.

## [1.0.10] - 2026-07-18

### Changed

- `utils`: unify the last three escapeRegExp copies onto the owner.
- `subprocess`: unify the ref-counted worker-handle wrapper.
- `web-search`: unify the whitespace-collapse idiom onto one owner.

### Fixed

- `update`: prune rebranded scoped cache entries by manifest name.

## [1.0.9] - 2026-07-18

### Changed

- `coding-agent`: lock the process.exitCode restore pattern.

### Fixed

- `release`: gate the CI watcher on the release workflow, not every run.
- `test`: stop deleting VEYYON_PROFILE before the profile-cli assertions.

## [1.0.8] - 2026-07-18

### Changed

- `internal-urls`: hoist getContentType to a single owner.

### Fixed

- `security`: make cargo-deny and cargo-audit gates pass with documented exceptions.
- `test`: restore process.exitCode to 0, not captured-undefined, after mutation.

## [1.0.7] - 2026-07-18

### Fixed

- `security`: override tar>=7.5.20 and adm-zip>=0.6.0 to clear high audit advisories.
- `grep`: use a backreference, not a stray paren, in the literal-fallback test.

## [1.0.6] - 2026-07-18

### Fixed

- Loud grep literal-fallback (Law 10) and fix latent release-only CI failures.

## [1.0.5] - 2026-07-18

### Changed

- `veyyon-shell`: unify blank-line collapse onto one primitive.
- `veyyon-shell`: remove unwired unknown-command counter, fix flaky tests.

### Fixed

- `ci`: generate tool-views codegen in shared bun-install so source-run jobs work.

## [1.0.4] - 2026-07-18

### Changed

- `coding-agent`: drop the superseded export/html/tool-render duplicate + orphaned generator.

### Fixed

- `release`: drop unpublished @veyyon/tool-render dep + pack @veyyon/stats in install smoke.

## [1.0.3] - 2026-07-17

### Changed

- Add dependabot for the bun/npm, cargo, and github-actions graphs.

### Fixed

- `stats`: deep-import format helpers + lock browser bundles off the Bun-mixed utils barrel.

## [1.0.2] - 2026-07-17

## [1.0.1] - 2026-07-17

### Changed

- Run releases on GitHub-hosted runners; drop self-hosted omp-kata.
- Complete pi -> veyyon rename across crates, native build, CI, and docs.

### Fixed

- `branding`: user-visible .omp/OMP leaks -> CONFIG_DIR_NAME/.veyyon (menus, ssh list, ttsr help, mcp schema, autolearn prompt).
- `ci`: restore collab:web:build root script (unblocks release check gate).

## [1.0.0] - 2026-07-17

### Added

- `cli`: did-you-mean near-miss subcommand suggestion (blocks bare typo -> paid prompt).

### Changed

- Forked oh-my-pi 16.5.2 and imported it under the veyyon name.
- `website`: latest design refresh + PWA/SEO assets.

### Fixed

- Resolve lint/format errors in parallel-session WIP so the tree gates green.
- Debrand user-visible omp leaks (login hint told users to run `omp`).
- `swarm-extension`: peerDependency @veyyon/pi-coding-agent ^16 -> catalog:.
