# Changelog

## [Unreleased]

### Added

- The auto-compaction threshold is now a two-level picker in `/settings`: **Auto-Compaction Threshold** opens to three modes (Auto, Percent, Tokens) with a green check and the current amount on the active one, and each mode drills into its own presets plus a Custom entry. The flat list it replaces mixed all 19 auto/percent/token options in one list, so the three semantics were invisible until you read every description, and a hand-edited value like `170000` showed as nothing selected. Custom values are validated and normalized on entry (`92` stores as `92%`, `170_000` as `170000`), and a stored value the parser cannot read is shown as a warning with Auto in effect instead of presenting Auto as your choice. The stored value is unchanged (`auto`, `85%`, `200000`), so existing configs, the legacy `thresholdTokens`/`thresholdPercent` fold-in, and the clamp warnings all keep working.
- Added an **Experimental** settings tab: every experimental feature now lives in one place — Argot shorthand (five settings, moved from the Context tab's Experimental group), Tool Calling Mode, Auto-Learn (moved from the Memory tab), and the Subagent Inbox layout (moved from Appearance's Advanced fold). The tab's name says "experimental" for everything on it, so labels no longer need an "(experimental)" suffix and the features stop pretending to be regular settings on three different tabs.
- `fetchOpenAICompatibleModels` takes an `onFailure` callback and calls it with an `OpenAICompatibleDiscoveryFailure` before returning `null`. Discovery answered a refused connection, a 401, an HTML error page and an unrecognized payload with the same bare `null`, and the caller that keeps per-provider discovery state only reported a reason when discovery THREW, so a model you pay for disappeared from the picker with nothing anywhere explaining it. The reason travels back as a value rather than a log line, because no source file in this package logs and its callers already own the state they report from; `stage` separates the three fixes an operator would reach for, since `request` points at the network, `status` at credentials, and `payload` at whether the endpoint is OpenAI-compatible at all. An empty catalog is still `[]` and still silent.
- `DEVIN_SESSION_TOKEN_PREFIX` and `normalizeDevinSessionToken` are exported, and `@veyyon/ai`'s Devin provider takes them from here instead of spelling both again. Two packages send that header, so one format had four statements across a package boundary; a disagreement would let model discovery authenticate while every completion 401s, which reads like a broken account rather than a mismatched header.
- `matchesKimiK27CodeFamily` and `hasBillableCost` each have one home. The Kimi K2.7 Code family test lived in both compat layers, id pattern and match, with the second copy documented as mirroring the first: one model-identity rule stated four times, and a drift between them would force thinking on only for whichever transport handled the request. `hasBillableCost` lived in the model generator and again in `@veyyon/stats`, where it decides whether to trust a bundled price, so two functions that only happened to agree were deciding money a user reads. Note what it does not answer: an all-zero cost cannot tell a free model from an unpriced one, which is what `costKnown` is for.
- Added `isEffort`, the guard for a thinking level, beside the `THINKING_EFFORTS` list that owns the values. Callers were spelling the six levels out again in comparison chains, which meant adding a level to the ladder left them rejecting it while the type system accepted it.
- Added `TUI#onSelectionAttempt`, called when a left press and a release land in different cells outside the pinned footer while the engine holds the mouse. Capturing the mouse is what lets the wheel scroll the transcript, and it also takes plain drag-select away from the terminal, so hosts can now explain a drag that selected nothing instead of leaving it silent.
- Added the scroll position to the right edge of a frozen transcript region: a dim one-column groove with a bright thumb, composited through the same cell-accurate path overlays use. It sits in the region that scrolled, so a host's pinned footer renders byte-identically whether the view is frozen or following.
- Added `rankSettingItems`/`filterSettingItems`: field-weighted ranking for settings search. Label, declared synonyms, config path, group and description are scored separately with the best field winning, so a setting NAMED for your query outranks every setting whose description merely mentions it. A setting's current value and its enum values are no longer searchable (typing `high` used to match everything set to high, and results shifted as values changed), a punctuation-only query returns nothing instead of matching everything, and heading rows are excluded. `SettingItem` gained `group` and `keywords` for this.
- Every place that reads a subprocess pipe as text now goes through `readPipeText`. Thirty-four further sites across five packages spelled `new Response(proc.stdout).text()` inline, four of them casting the pipe (`proc.stderr as ReadableStream`) to satisfy the compiler. Reading text out of a pipe is one operation, and the helper's null handling means a caller no longer has to decide per-site whether a stream that was not piped is an error: it reads as no output, which is what every one of these sites wants, since they are assembling a diagnostic about someone else's failure. No behaviour change at any of the thirty-four: each either pipes the stream it reads or already guarded it by hand. `ptree`'s blob, JSON, ArrayBuffer and bytes readers are different operations and stay as they are.
- `bench-harness`: `makeBench`, `benchStats` and `benchFail`, the loop and the two readings every bench script here needs. Four scripts across two packages had written their own copy of each, and a benchmark's own arithmetic is the last place a difference should be free to hide. `benchFail` exits non-zero, because a bench that prints a failure and succeeds is a bench nothing can gate on.
- Added `readPipeText`, which drains a spawned process's pipe to a string and reads an absent pipe (`Bun.spawn` gives `null` for a stream that was not captured) as empty output. Both runtime installers had a private copy of that guard, and each is the code that explains a failed install to an operator: dropping the null case turns the install error into a TypeError about reading a stream.
- `startupMarker` moved into `@veyyon/utils/startup-marker`, a module whose only dependency is `node:fs`, and `logger.startupMarker` re-exports it. It existed twice, in the logger and in the CLI framework, with the second copy documented as deliberate: `veyyon --version` must not pull the winston-backed logger into its import graph. That constraint is real, and a module with one node builtin as its dependency satisfies it without a second definition. The marker's behaviour is unchanged, and now tested: one synchronous `fs.writeSync(2)` line per phase, silent unless `VEYYON_DEBUG_STARTUP` is set.
- Added `isThenable`, the guard that decides whether a value needs a rejection handler attached. It existed twice in `@veyyon/coding-agent` (the IPC `send()` sites and the MCP stdio transport), where one copy's comment justified the other as "battle-tested there"; a missed thenable becomes an unhandled rejection that takes the process down far from the call that made it. Its tests moved here with it.
- Added `createThemeStore`, the light/dark theme store a browser page reads through: it restores the preference a person chose (`system`, `light`, `dark`), resolves it against the browser's, writes it onto `<html>` for CSS and for the native form controls, and notifies its readers. The collab client and the stats dashboard each had a byte-identical copy of it, ~90 lines with no tests in either. Browser access goes through a `ThemeEnvironment`, so the resolution can be asserted without a DOM, and the package stays free of the `dom` lib. It is React-free; each page binds it with `useSyncExternalStore`. Also available as `@veyyon/utils/theme-store`.
- Added `asStrictBytes`, which narrows a `Uint8Array` to one over its own whole `ArrayBuffer`, copying only when it is not one already. `crypto.subtle` reads the entire backing buffer of the array it is handed, so a view into part of a larger buffer (an IV taken with `subarray`, say) has to be copied before it is signed or decrypted, or the neighbouring bytes go in with it. Four packages needed this and each had a private copy, one of which could have been "tidied" into a bare cast without any test noticing. The no-copy path is the common one and is kept: sealing runs per collab frame and signing per request. Also available as `@veyyon/utils/bytes` for browser bundles, which must not import the barrel.
- Added `parseJsonOrYamlByExtension`, which parses a config file's text as YAML when the path ends in `.yaml` or `.yml` and as JSON otherwise. The LSP and DAP config readers each had a private, byte-identical copy of that decision. It throws on malformed input rather than returning nothing, so the caller can name the file and the line.
- Added `visitJsonlBytes`, `parseJsonlBytes` and `decodeJsonlLine`: a byte-level JSONL walk for a file that is still being appended to. It returns the byte offset up to which whole lines were consumed, so a reader stores that offset and reads only the new bytes next time and never holds a large file as a string. A trailing partial line is the ordinary case rather than an error, and a complete line that cannot be decoded is reported with its offset and length instead of vanishing. This is the third reader in the package and each answers a different question: this one for a growing file, `parseJsonlIncremental` for a stream arriving in chunks, `parseJsonlLenient` for a complete buffer.
- `sealFrame`, `openFrame`, `SEAL_IV_BYTES`, `generateRoomKey`, `generateWriteToken` and `importRoomKey`: the AES-256-GCM frame seal (`[12B IV][ciphertext+tag]`), which the host and the browser guest had each implemented in full. The layout is a wire format like everything else here, and its drift failure is the worst kind available: a GCM tag mismatch cannot distinguish a wrong key from a wrong layout, so changing the IV length on one side presents as every frame failing to authenticate with nothing naming the cause. Both sides now bind only their own frame type. Nothing added here reaches for Node, so the browser guest still imports this package directly.
- `importRoomKey` reports a wrong key length as a rejection instead of a synchronous throw. It returned a promise but threw that one error synchronously, and the browser client hands the promise to its socket without awaiting it, so a mangled link threw out of the socket's construction rather than reaching the connection's error path.
- `packEnvelope`, `unpackEnvelope`, and `rewriteEnvelopePeer`: the codec for the plaintext collab envelope (`[4B uint32 BE peerId][sealed payload]`), now beside the `ENVELOPE_HEADER_LENGTH` they read. The TUI host and the browser guest each carried a byte-identical copy, so one wire format had two statements of its byte order and header width. That drift is silent by construction: the payload still decrypts, because the room key is untouched, so the only symptom is a frame arriving at the wrong peer, or broadcast to a room that should not have seen it. Nothing in the package needs Node, so the browser guest imports it directly. No wire-format change.
- `WELCOME_TIMEOUT_MS`, `SNAPSHOT_PROGRESS_TIMEOUT_MS`, and `TRANSCRIPT_TIMEOUT_MS`: the budgets a collab guest allows the host for each of its three round trips. These describe the protocol, so they now live beside the envelope and link constants instead of being declared separately by each guest. Both guests import them; see the Fixed note below for why that matters.
- `FallbackContent` is now part of `AssistantContent`. An Anthropic server-side-fallback marker (`{ type: "fallback", from, to }`) was already reaching guests on assistant turns whose request opted into provider fallbacks; the union simply did not admit it, so a client with an exhaustive `switch` had no reason to handle a block it was told could not exist. Renderers should ignore it: it marks a model hand-off and carries no content. No wire-format change.

### Changed

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
- The narrowing that answers "does this session entry carry a tool result" lives with the entry union it narrows, as `getToolResultMessage` in `compaction/entries.ts`. Both compaction passes, pruning and shake, had a byte-identical private copy, and a pass that recognised one message shape while its sibling recognised another would prune output the other still counted.
- The two compaction strategies now state distinct contracts instead of asking for the same document. `summary` is told it continues in the SAME session, so the recent turns survive alongside it and must not be restated; `handoff` is told it starts a NEW session where nothing survives, so it must carry cold-restart state (working directory, branch, uncommitted files, toolchain, the exact next command). Both prompts now ask for verification evidence explicitly (commands run verbatim, pass/fail counts, durations, run IDs, exact error text), and the summary prompt states the precedence between brevity and evidence rather than leaving "be concise" one sentence away from "keep the command results".
- The handoff prompt gained a `Blocked` section, which only the summary prompt had. Handoff is the strategy whose reader starts cold with nothing but the document, so it is the one that most needs to carry blockers; without the section they had nowhere to go. In practice it now records constraints that cannot be re-derived from the repository at all, such as an action requiring explicit approval or a repository-owner UI step.
- Compaction prompts now separate the overarching goal from the current task, in one shape shared by `compaction-summary`, `compaction-update-summary`, and `handoff-document`. A single Goal field meant the model wrote whichever goal was most concrete, which is always the immediate task, so the standing objective went unrecorded from the first compaction onward. `compaction-update-summary` runs on every later compaction and permits dropping anything no longer relevant; the overarching goal is now carved out of that permission.
- Compaction prompts ask for the HEAD commit and whether anything was committed during the session, not just the branch. A branch name does not say where the work started or whether any of it is saved anywhere but the working tree. Repository state stays conditional on the work actually being version controlled, so a session outside a repository is not pushed into inventing one.
- Both compaction strategies now fail loudly when the model returns an empty document instead of accepting it. A provider can return `stopReason: "stop"` with output tokens spent entirely on reasoning and no text content; `handoff` then returned just the deterministic `<files>` block, which reads as a real document while carrying no goal, no decisions, and no next step, and `summary` would have stored an empty summary in place of the history it replaces.
- Mechanical compaction-request pruning has one owner, `pruneMessagesForCompaction`. It previously existed as two inline copies inside `serializeConversation`, one per rendering branch, so it applied to the `summary` strategy and to nothing else. Both strategies now route through it. Dropping a useless result also drops its paired `toolCall`, so no call is sent without a result; non-text content blocks (images) survive pruning; a byte-identical repeat is collapsed only when the back-reference is shorter than the text it replaces; and stale reads are recognized with `readToolSupersedeKey`, which moved to `compaction/utils.ts` so the durable pruner and the request pruner share one definition of that rule.
- Tool-result truncation is opt-out through `truncateToolResults`. `summary` keeps it; `handoff` turns it off, because handoff seeds a new session where a truncated result is evidence deleted rather than shortened. Across two real sessions the lossless passes accounted for 0.0% and 1.6% of message bytes while truncation accounted for 60.4% and 35.3%, so the size win and the data loss are the same pass.
- `generateHandoff` accepts `fileOps` and appends the same deterministic `<files>` block the `summary` strategy has always emitted. The block is machine-generated and byte-identical across models, so withholding it made handoff strictly worse for free.
- An OAuth refresh no longer trusts a credential row purely because it sits under the right id. The peer-rotation check re-reads the row by a bare numeric id to see whether another process already rotated the token, and nothing in that lookup said which provider the row belongs to: `readAuthCredentialById` is an optional method on the credential-store interface, so the row comes from whichever store is plugged in, and the explicit-id insert paths used by migration and import write ids chosen elsewhere. A row for a different provider is a live, unexpired OAuth credential whose refresh token differs from the one held, which is exactly the shape the check is looking for, so it would have been returned as your own rotated token and sent to the wrong provider. Such a row is now refused and the refusal is logged with both provider names and the credential id, and with no part of either credential. The shipped SQLite store uses `AUTOINCREMENT` and does not recycle ids on its own, so this is a check at the store-interface boundary rather than a fix for a race in that store.
- Three more pass-through wrappers are gone: `hermes`, `qwen3` and `pi-native` each declared a `renderToolResults` whose whole body forwarded to `renderToolResponseResults`, which is what the generic `xml` dialect already referenced directly. A wrapper that adds nothing is a place a reader has to visit to learn that nothing happens there.
- Anthropic's `<invoke>` tool-call syntax has one owner in `dialect/rendering.ts`. Three dialects speak it (`anthropic`, the generic `xml`, and `minimax`, which wraps the same invokes in a tag of its own) and each had a byte-identical private copy of the invoke renderer, the invoke list, the single-call renderer and the transcript wrapper, with two of them also repeating the `<function_results>` block: one wire format written out three times. A change to the escaping or to the rule that emits a declared string argument verbatim would have left the other two dialects emitting a shape the model was never prompted for, and the symptom is not an error but a model that calls tools badly. Six dialects' pass-through `renderThinking` wrappers and the three per-model turn delimiters, which `rendering.ts` already exported, went the same way. No output change: the shared renderers produce the same bytes, which the new suite asserts literally for all three dialects.
- The reasoning-effort and service-tier guards come from the lists that own those values: `isEffort` beside `THINKING_EFFORTS` in `@veyyon/catalog`, and `isServiceTier` beside `SERVICE_TIERS` in this package, with `ServiceTier` now derived from the list instead of declared next to it. Both OpenAI-compatible servers hand-wrote the six effort levels and the five tiers as comparison chains, so adding a level to the ladder left every one of them silently rejecting it: a request naming the new effort was answered as if it had named none. Their `formatError` wrappers, which only forwarded to `formatOpenAiError`, became re-exports.
- The snapshot generation's entity-tag format has one owner, `auth-broker/generation-tag.ts`, which both writes and reads it. The broker's client and server each had a private copy of the parser next to their own inline copy of the quoting, so one header format had four independent statements of itself, and both ends both write and read it. The failure mode is quiet either way: a tag the server cannot parse reads as no condition and returns a full snapshot the client already has, and a tag the client cannot parse leaves its generation unchanged so it asks again forever. See the Fixed note above for the defect the copies were hiding.
- SigV4 signing and the auth-broker snapshot cache take their WebCrypto byte coercion from `asStrictBytes` in `@veyyon/utils` rather than each defining it. It decides whether a `Uint8Array` has to be copied before `crypto.subtle` reads it, and `crypto.subtle` reads the whole backing buffer, so getting it wrong signs or decrypts bytes the caller did not name. Four packages had a private copy of the same three-line condition. No behaviour change.
- Frame sealing comes from `@veyyon/wire`. This client carried a full copy of the AES-256-GCM layout, described in its own header as a browser-safe mirror of the host's, which is the shape of duplication that goes wrong quietly: the host seals what this opens, and a disagreement about the IV length or the order of the parts fails authentication without saying why. Only the frame type binding stays here.
- The theme store moved into `@veyyon/utils` as `createThemeStore`, shared with the stats dashboard, which carried a byte-identical copy of the same ~90 lines and neither copy had a test. Only the storage key and the React binding stay here. The two had drifted in their storage guard, and the dashboard had the broken half; this client's try/catch is the behaviour that was kept.
- The wire envelope codec and the WebCrypto byte coercion now come from the shared packages that own them, `@veyyon/wire` and `@veyyon/utils/bytes`, instead of being restated here. The envelope matters most: the host writes the envelopes this client reads, and both sides had their own copy of the byte order and the header width. A disagreement there does not fail, because the sealed payload is untouched by it, so a frame would simply be delivered to the wrong peer. No behaviour change.
- The theme store moved into `@veyyon/utils` as `createThemeStore`, shared with the collab client, which carried a byte-identical copy of the same ~90 lines. Only the storage key and the React binding stay here. See the Fixed note above for the divergence the two copies had.
- `hasBillableCost` now comes from `@veyyon/catalog`, which carried an identical copy in its model generator. The generator uses it to decide whether an OpenAI entry may donate its pricing to the matching Codex entry, and the dashboard uses it to decide whether to trust a bundled price at all, so the two answers had to agree about the same numbers while being written twice.
- The session-transcript walk moved into `@veyyon/utils` as `visitJsonlBytes`, so the dashboard and every other reader share one byte-level JSONL walker. The copy here was a fourth JSONL reader, and it had drifted: it dropped an unparseable line with no report at all, while both string-based readers in utils had one, and every total on the dashboard is a sum over the lines that parsed. A line holding only a carriage return is no longer counted as a lost record, because there is nothing in it to lose. Throughput is unchanged on the path the parser takes: 331 MB/s against the old loop's 311 over a 63 MB corpus (`scripts/bench-jsonl-bytes.ts`).
- `AbortError` from `@veyyon/utils` is now the signal-shaped cancellation class, and the class raised when a child process is killed is `ProcessAbortError`. Three unrelated classes answered to the name `AbortError`, two of them in this package, and the barrel exported the process one, so importing `AbortError` and constructing it from an `AbortSignal` failed with "Expected 2 arguments, but got 1" while an `instanceof AbortError` check compiled, passed, and asked about a class the author did not mean. Both classes still report `name === "AbortError"`, so `isAbortError` and every log and message shape are unchanged; only the import name moves. If you constructed the process-abort class through the barrel, import `ProcessAbortError` instead.
- `VEYYON_CONFIG_DIR` set to an absolute path is now refused at startup instead of being reinterpreted. It names the config directory under your home rather than replacing it, so `VEYYON_CONFIG_DIR=/srv/veyyon` was joined onto your home and created `~/srv/veyyon`: you got a brand new tree inside your home, the old one stayed where it was, and nothing said so. The error names the directory that would have been created and points at the `XDG_*_HOME` variables, which do take absolute paths. A value written for the other platform (`C:\veyyon`, a UNC path) is caught the same way, and a whitespace-only value is refused rather than creating a directory whose name is invisible in a listing. An empty value still means "use the default".
- Log output follows the config root when it moves. The rotating file transport resolved its directory once, on the first log line of the process, so anything that changed the config root afterwards kept writing to the old location: the log file where the docs say it should be had no entries, and if the old directory had been removed the lines went to an unlinked file and were gone. If the new location cannot be written to, veyyon keeps using the one that works and says so through a process warning rather than losing logging entirely.
- A log write that fails no longer takes the process down. A winston transport reports failures as an `error` event, and an event with no listener is an uncaught exception, so a log destination that went wrong after startup — its directory removed, the disk full, a volume unmounted — crashed whatever veyyon was doing at the time. The failure is reported once as a process warning and the run continues; a log line is the least important thing happening at that moment.
- `errorMessage` falls back to an error's constructor name when its message is empty. Callers splice the result into a sentence (`renderer threw: <msg>`), and `new TypeError()` produced text that trailed off after the colon and named nothing. A whitespace-only message is still returned as-is: it is a real message, and substituting the class name would hide that the throw site produced junk.

### Removed

- Removed the `remoteCompaction` option from `models.yml`. It opted a provider or model into provider-native compaction, which was removed, so setting it configured nothing and gave you a session whose compaction was not what your config said. A config that still carries it is now refused at load with the provider, the model, and the replacement named: set `compactionModel` on the model, or the `compaction.model` setting. Deleting the key from your config is the whole migration.
- Removed provider-native remote compaction (OpenAI `/responses/compact` and the Responses V2 streaming variant). It stored the durable history as an opaque provider blob that no other provider could replay, wrote a fixed placeholder string in place of the compaction summary, and re-sent the full context uncached on every call. Compaction now has exactly two strategies, `summary` and `handoff`, and no provider gets a private path. Sessions compacted by the old path still load: such an entry is treated as having no usable summary, so the original messages behind it are re-expanded and summarized locally.
- Removed the `compaction.remoteEnabled`, `compaction.remoteStreamingV2Enabled`, and `compaction.v2RetainedMessageBudget` settings, which existed only to gate that path. `compaction.remoteEndpoint` stays: it is a summarizer transport for the `summary` strategy and returns summary text.
- Removed `remoteCompaction` from model and provider metadata, along with the Codex discovery constant that set it. It configured provider-native compaction, which no longer exists, so nothing has read it for some time while it was still declared on every model and shipped in `models.json`.

### Fixed

- A `git status` autoresearch cannot read is no longer reported as a clean worktree. `tryGitStatus` answered any failure with `""`, which parses to "no dirty paths", and three things acted on that: a `discard` reported "nothing to revert" while the experiment's changes sat in the tree, `log_experiment` recorded an empty modified-path list so the scope-deviation check passed vacuously against `off_limits`, and `run_experiment` recorded an empty PRE-RUN dirty set, which claims the tree was clean and would attribute the user's own uncommitted files to the experiment. The probes now propagate and each caller reports through the error channel it already had. A cwd outside a repository is still answered with `""`, decided by resolving the repository rather than by a failed command, because autoresearch may run there and then has no tracked changes.
- `init_experiment` treats an unreadable `git status` as dirty rather than clean. False took the branch that skips committing harness changes, which is the branch whose own warning says "discard may not preserve uncommitted harness files".
- A debug adapter config that exists and cannot be read or parsed is reported. Six filenames are probed per directory, so absence is silent, but a `dap.json` with a trailing comma used to be indistinguishable from no `dap.json`: the configured adapters simply were not there and the debugger fell back to its defaults without a word. Same for an unparseable lspmux `config.toml`, where a typo silently reverted every language server to the direct, unmultiplexed path.
- Detecting a repository inside the working directory says when it could not look. An unreadable cwd produced the same empty listing as one with no repository in it, so the prompt and the status line both showed nothing with no sign the check never ran. The "exactly one direct child" rule also has one owner now instead of a copy in each of the asynchronous and synchronous paths.
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
- An unreadable sessions directory no longer looks like having no sessions. The cross-project scan behind the session picker and `--resume`, and the per-directory listing under it, answered any failure with an empty list, so a permissions problem presented as a user with no history: the picker came up empty, `--resume` had nothing to offer, and nothing was logged to disagree with. An absent directory is still an empty list in silence, because that is a project you have not opened yet. One that is there and cannot be read is now reported with the path, and the empty list is still returned so a picker that cannot list comes up empty rather than crashing.
- A click by selector that failed because the page re-rendered no longer reports it as an invisible element. Clicking examines every match and keeps the ones it can see; an element also leaves that list when the probe THROWS, which is what happens when the node is detached between the query and the check. That case was swallowed, and the timeout then said `no-visible-candidate`, which sent you to inspect CSS and stacking contexts for an element that was on screen the whole time. The timeout now distinguishes the two, counts the failed probes, and names the first error: `every candidate probe failed (3 of 3): Execution context was destroyed ...`, or, when both happened, `no-visible-candidate, and 2 of 5 probes failed: ...`.
- Seven packages' test suites are executed again. `scripts/ci-test-ts.ts` replaced the old `bun run --workspaces test` fan-out with three hand-kept lists of package paths, and argot, stats, deepswe-bench, metaharness, collab-web, tool-render and swarm-extension were never added to any of them, so 82 files and 1274 tests ran in neither CI nor a local full run. They all pass, in about seven seconds. `scripts/workspace-test-coverage.test.ts` now checks the lists against the tree in both directions, so a package cannot ship tests that nothing runs and a list entry cannot outlive the package it names.
- Formatting and import order are checked in CI. The lint job ran `biome lint`, which covers lint rules only, beside a step labelled "Biome check" that ran the TypeScript type checker and no Biome at all, so the formatter and the import-organization pass were gated by nothing: 39 files were unformatted and 25 had unorganized imports while both jobs reported green. `bun run check:tools` is now its own step and the mislabelled one says what it does.
- Benchmarks are linted. `packages/*/bench/**` was outside Biome's file list, so six unused-binding findings sat there unreported. The deliberately frozen key-parser baseline at `packages/tui/bench/_jskey.ts` stays excluded by path, because its unused declarations are the snapshot it exists to preserve.
- `tsc -p tsconfig.json` at the repository root no longer tries to compile the benchmark repositories downloaded into `packages/deepswe-bench/repo-cache/`. The root config is a solution file that owns no sources of its own, but it omitted `files: []`, so `include` defaulted to everything and the check failed on third-party syntax.
- Compaction has exactly two strategies. The settings enum has said `summary | handoff` for a while, but the type behind it still admitted `context-full`, `shake`, and `off`, so the code disagreed with the setting. The first two were engine actions rather than things you choose; `off` was a second way to spell `compaction.enabled: false`, which let two fields disagree about whether compaction runs. Turning compaction off is now `compaction.enabled` and nothing else. A config file that still says `strategy: off` keeps working: it loads as `handoff` with `enabled: false`, so compaction stays off.
- Extensions no longer see a compaction action that cannot happen. The `auto_compaction_start` and `auto_compaction_end` events typed their `action` as `context-full | handoff | shake`, and nothing has ever emitted `shake`, so an extension with an exhaustive switch was handling a case that could not occur. All three copies of that union now reference the one type that owns it.
- Constants that named one thing while meaning another. `STARTUP_TIMEOUT_MS` in the MCP manager is not a timeout: nothing is aborted when it elapses, cached tools are served while the connections keep running, so a name reading "an MCP server gets 250 ms to start or it is dropped" described behaviour the code never had; it is now `STARTUP_TOOL_WAIT_MS`. Four more pairs shared a name across unrelated subsystems and now say what they bound: a log rotation threshold against how much of a log tail a bug report may read, a debug session's in-memory output ring against the subagent return budget that has to match `VEYYON_TASK_MAX_OUTPUT_BYTES`, and a loopback broker connect budget against the network relay one. No behaviour changed; the numbers were always right, only the names were shared.
- The three eval sandboxes each spelled out their own environment allow-prefix list under one shared name with three different values, so widening the base that all of them need meant three edits and nothing failed if you made two. The base now has one owner and each runtime extends it with its own language prefixes. The Python and Ruby kernels likewise each typed the same startup timeout, with Julia typing a longer one; the shared value now lives in one place and Julia expresses its need as base plus margin, so raising the floor raises Julia's too.
- `veyyon auth-broker` could hand out a token it then rejected. Two brokers starting at the same time each minted a bearer token and the second overwrote the first, so a client told to use the first token was refused by the service that issued it. The broker also created the token file with the default mode and narrowed it afterwards, leaving it briefly readable by any local user, and on Windows, where that narrowing does nothing, permanently. The auth gateway had already solved both (an exclusive create at mode 0600, and treating a lost race as "read the winner's token"), and the two services now share one implementation with the gateway's behaviour.
- Fixed the rule that nudges you to `set_cwd` into another project delivering nothing most of the time. Three separate defects hit the same path. Its body was folded into the tool result unrendered, so the model was shown template markup that named neither directory and advised a tool that is off by default. The rule was marked as delivered the moment it was queued, and a turn that aborted or errored dropped the queue without taking that mark back, which retired the rule for the rest of the session. And rules fire once per session by default, which is right for a rule stating a convention and wrong for one whose advice applies again to the next directory, so a rule can now set `repeatMode` and `repeatGap` in its own frontmatter; this one repeats after eight messages. Your global `ttsr.repeatMode` and `ttsr.repeatGap` are unchanged.
- Fixed the bundled rule that nudges you to load a project's Argot shorthand never running. It shipped in every install as a file nothing loaded, and it could not have worked if it had been: it carried no trigger, and its body was gated on the argot feature being on rather than on the dictionary being missing, so with argot on it would have told the model to load a dictionary it had already loaded, on every edit. It now triggers on an edit in a project whose shorthand is not loaded, and only then. Two related fixes came out of it: a rule whose body renders to nothing is no longer delivered as an empty reminder, and every bundled rule file is now checked to be registered, so the next one cannot sit unloaded.
- Fixed a rule whose `condition` is blank matching everything instead of nothing. An empty pattern compiles to a regex that matches every character, so a half-written rule fired on every tool call and every line of prose for the whole session. A blank pattern is now skipped and reported, and a rule left with no trigger at all is refused with a message naming the file, instead of being loaded, listed by `/rules`, and silently never watched.
- Fixed a rule whose `scope` names a tool that does not exist loading as if it worked. A bare scope token is read as a tool name, so a typo like `raed` registered a rule that could never match, and that is indistinguishable from a rule whose condition simply never came up. Veyyon now reports it once the tool list is known, naming the rule, its file, and the closest tool it does know. The rule is not disabled, because a rule scoped to a tool an extension registers later is legitimate.
- Fixed inherit-able model settings (`subagent.model`, `compaction.model`, role models, the default model) being effectively one-way: once a model was assigned, the only path back to unset was the forward-Delete key, which many keyboards do not have, and Backspace fell through as a silent no-op. These pickers now lead with a visible `(inherit main model)` row (the default model's reads `(auto-select on launch)`) that clears the assignment like any other selectable row, Backspace clears alongside Delete when the search is empty, the footer names both paths, and an assigned slot opens with its model preselected so a quick Enter re-picks it instead of clearing.
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
- Fixed compaction doing nothing when the newest turn alone exceeded the keep-recent budget. One very large tool result at the end of a session was enough: the cut-point search found no boundary at or after the entry that blew the budget and fell back to keeping the whole session, so compaction reported nothing to do while the context meter sat at the ceiling. It now cuts to the newest valid boundary, which never separates a tool call from its result.
- Fixed images in a user message counting as zero tokens. Every other message role already counted them, so a session of pasted screenshots under-reported its own size to the compaction trigger, the pruning budgets, and the context meter.
- A GCE metadata server that refuses a token is reported. `fetchMetadataToken` answered a refused status and "not running on GCE at all" with the same `undefined`, and the error the caller raises offers "run on a GCE or Cloud Run instance with a service account" as one of three fixes, which is exactly the wrong advice for an instance whose metadata server answered 403. The status and URL are now warned where they are still known; not being on GCE stays silent, since that is every laptop.
- Tool-call arguments that cannot be used are no longer dropped in silence. The DeepSeek, Harmony and Kimi dialects and the GitLab Duo provider each had their own copy of the same parse, and each answered a failure with an empty object, which is also what a call that takes no arguments produces. So a stream cut mid-arguments, or a model emitting a bare string or an array, ran the tool with nothing and nothing said so. There is one owner now, and it names the source, the tool, and an excerpt of what arrived; the empty object is still returned, because refusing the call belongs to the tool's own argument validation.
- Usage history that cannot be read is now reported instead of appearing as usage you never had. Both the history and the cost queries answered any database failure with an empty list, so an unreadable database presented as a clean slate and the cost totals read as zero.
- An empty entity tag on a broker snapshot request read as generation 0 instead of as no generation. `Number("")` is 0, so `If-None-Match: ""`, or a header an intermediary blanked, matched a store that was still at its first generation: with `?wait=` set, the broker then long-polled for up to 30 seconds waiting for a change instead of immediately serving the snapshot the client did not have, on every poll. The same hole was in the client's reading of the response `ETag`, where a blanked tag reset its generation to 0 and made it re-download the snapshot it already held. An empty or whitespace-only tag is now no generation, which falls back to sending the snapshot in full. Found while collapsing the two copies of the parser below.
- **Auth Gateway Models**: Fixed `/v1/models` endpoint returning ambiguous bare model IDs when multiple providers register the same model name. Model IDs are now correctly advertised with their `provider/` prefix (e.g., `anthropic/shared-model`) and duplicate entries from the resolver map are deduplicated.
- Fixed GPT-5.6 Codex SKUs (`gpt-5.6-{sol,terra,luna}`) losing ~75K of usable context when the Codex discovery endpoint actively reports `context_window: 272000`: discovery now floors these SKUs at the 372K hard capacity instead of only substituting it when the field is absent, so the runtime dynamic value no longer overwrites the bundled pin.
- A patch to a file reached through a chain of symlinks now lands on the real file. The write followed one hop, so with `entry.ts` linking to `middle.ts` linking to the real file, it replaced `middle.ts` with a regular file: the link was destroyed and the file you keep never received the edit. Both halves were silent, because reading back through `entry.ts` returned the new bytes. The whole chain is followed now and every link survives.
- `NodeFilesystem` refuses to write over a path that is not a regular file. The write ends in a rename, and a rename pointed at a named pipe destroys it and leaves a regular file behind, breaking whatever process was reading the other end; sockets and device nodes went the same way. The refusal names the path and what it actually is. A directory now reports that instead of a bare `EISDIR`.
- A write is flushed to disk before it is published. The rename already prevented a truncated file, but the contents were not fsynced, so power loss could leave the file present and empty. The write handle and the directory entry are both flushed now.
- A write that fails names the file you asked to write. The failure came from the temporary sibling the write stages into, so a read-only directory reported `EACCES` on `.mod.ts.4711.1.tmp` — a path that never existed as far as you are concerned and changes every attempt. The reason and the error code are kept, the real target is named, and the original travels as `cause`.
- Writing to a path whose parent directory does not exist creates the directory instead of failing. A patch that creates `src/new/mod.ts` is an ordinary create. Parents are never created for a symlink, where a missing target directory means the link is dangling.
- Fixed the in-process `rm` builtin treating an empty path operand as the shell working directory, so `rm -rf ""` recursively deleted the current directory instead of rejecting the operand. An empty operand reached `veyyon_uutils_ctx::resolve`, which joins `""` onto the cwd and yields the cwd itself; the builtin now rejects empty operands before resolution, matching GNU `rm` (ENOENT, silent under `-f`) and leaving the cwd untouched (Closes #51).
- A sessions directory that cannot be read no longer looks like a user who has never run a session. Both session listers answered every failure with an empty list, so a permissions problem on the sessions directory, or on one project's folder inside it, produced a dashboard reporting zero of everything: `syncAllSessions` sees an empty file list, returns early, and reports success having read nothing. An ABSENT directory still returns empty in silence, because that is what a fresh install is. A directory that is there and unreadable is now reported through the same log the unparseable-line reporter uses and with the same framing, naming the path and the underlying error, and the sync continues with what it could read so one unreadable project cannot blank the whole dashboard. A session file that cannot even be examined is reported the same way instead of being counted as a completed file by the progress bar.
- The dashboard failed to start when the browser blocks storage. It read the saved theme from `localStorage` behind a `typeof localStorage === "undefined"` check, and blocked storage does not make the property undefined: in Safari private browsing and under a blocked-storage policy, touching it THROWS. The read ran while the module was being evaluated, so the throw took the whole bundle down instead of costing a remembered preference. The theme now comes from the shared store below, which treats storage as best effort: your choice applies for the session even when it cannot be saved.
- Shifted keypad operators are covered by a test for the first time, and the keypad fast path says why it exists. Both `parseKey` and `matchesKey` consult a keypad decoder ahead of the native parser on every keypress. The reason recorded there was bare numpad codepoints coming back as navigation keys, which the native parser no longer does: sweeping all 16 keypad codepoints against every modifier value and event type found the two agreeing everywhere except the shift bit on the five operator keys, 120 inputs where native reports `shift+/` for a key that produces `/`. Shift does not change the character a keypad key produces, so the fast path is right and is now the documented reason the pre-check runs at all. Nothing had tested any of those 120 inputs.
- The keypad pre-check no longer runs a six-group regular expression against every keystroke. It first rejects anything that cannot be a Kitty CSI-u sequence with three character comparisons, which is a necessary condition of the pattern that follows rather than a second answer to the same question, so no input changes hands. Worth about 8% of the cost of parsing a non-Kitty keypress (229ns to 209ns for `a`, 233 to 209 for `ctrl+c`, 250 to 234 for a legacy arrow, three process pairs each); Kitty sequences are unchanged, since those pass straight through.
- The key-parser benchmark runs again. `bench/parse-key.ts` is the measurement that says whether the native key parser earns its place, and it had been throwing on its third statement: `bench/_jskey.ts`, the frozen pre-native parser it measures against, exported only its type aliases, so every function the bench imported was undefined. No test imported either file and the benchmarks gate nothing, so no timing had been produced for some time. Three of its expectations had drifted from the shipped parser in the meantime, one of them a real behaviour change: Kitty base-layout keys now report the letter you see and fall back to the PC-101 position only for non-Latin layouts, where the baseline preferred the position unconditionally. Those three are now declared as superseded baseline behaviour rather than read as failures, the correctness gate checks each parser against the contract instead of only against the other one, and it exits non-zero when a sample disagrees. `test/key-bench-samples.test.ts` keeps all of it honest without timing anything.
- Markdown tables now honour the alignment markers in the delimiter row. A column written `| :---: |` centers and `| ---: |` right-aligns; `| :--- |` and a bare `| --- |` stay left, which is the GFM default. The parser had always supplied the alignment and the renderer had always ignored it, padding every cell on the right, so all four spellings produced identical output. When a centered cell's slack is odd the extra column goes on the right.
- Fixed the pinned composer scrolling off screen when reading history back: scroll isolation held the wheel only while the composed frame overflowed the viewport, and a virtualized transcript (the coding agent's) drops committed rows from its frame on every quiet frame, so the gate closed, the wheel went to the terminal, and the whole window scrolled with the prompt in it. Wheel capture now arms while anything sits above the window, including rows already on the new scroll tape.
- Fixed scroll-back depth being limited to the commit lag (a few rows) rather than the session. The engine records every prepared row it lets scroll off on a bounded scroll tape (`scrollTapeRows`, `setScrollTapeCap`, default 20k rows) and scrolls a snapshot of the tape plus the live frame, so a frozen view reaches the first row of the session and cannot be shifted by a transcript dropping rows underneath it.
- Collab guests no longer disagree about when a host has stopped answering. The TUI guest and the web client each kept their own copy of the three join budgets, and `TRANSCRIPT_TIMEOUT_MS` had drifted to 10 s in the browser against 20 s in the terminal. A host taking 15 s to read a large transcript answered the terminal fine and looked dead to a web viewer, which resolves the fetch to `null` on timeout. Both now read 20 s from this package.
- The module header cited a conformance test that did not exist. Conformance is now asserted per entry variant in `packages/coding-agent/test/collab/web-wire-conformance.test.ts`, which fails the typecheck when a host-side session entry stops being assignable to its wire shape.

## [1.0.37] - 2026-07-24

### Fixed

- `veyyon update` now updates source installs for real: it fast-forwards the checkout, reinstalls dependencies, and regenerates build artifacts, instead of refusing with advice to run `git pull` yourself.
- A source checkout missing its generated tool-views bundle (any freshly pulled or cloned checkout) no longer dies at launch with a raw module-resolution error: the launcher regenerates the bundle before starting, and fails with the exact fix command if it cannot.
- The setup wizard now paints its own pure-black ground across the full frame (splash, scene transitions, and outro), so the launch sequence looks the same on every terminal background instead of inheriting the terminal's color.
- The Windows binary is now built as a modern (AVX2) Bun target instead of baseline. Baseline Windows standalone builds crash in the Bun runtime at startup before any Veyyon code runs (oven-sh/bun#32684), which made every published `veyyon-windows-x64.exe` exit with a segmentation fault on launch. The modern target requires a CPU with AVX2 (Intel Haswell 2013 / AMD Excavator 2015 or newer).
- `REM` no longer deletes a file whose content drifted from the section tag. A whole-file delete is now the strictest op about the content tag (it was the most lenient: empty edits took the position-stable path and deleted through drift with only a soft warning), so a stale or fabricated tag can no longer discard edits the model never saw. The delete is refused with a mismatch error that forces a re-read, matching how an anchored edit on a drifted file behaves.
- `MV DEST` no longer silently overwrites an existing destination file. A move onto a different existing file is refused during prepare (aborting the whole batch before any write), so a wrong or hallucinated destination can no longer destroy the user's work. A rename that only respells one file (case-only on a case-insensitive volume, or through a symlink) is still allowed, matched by device+inode identity rather than by path string.

## [1.0.36] - 2026-07-24

### Fixed

- `plugin-cli`: stop doubling the 'Error:' prefix in plugin command errors.
- `errors`: remove remaining doubled 'Error:' prefixes; generalize the source-lock.

## [1.0.35] - 2026-07-24

### Added

- `update`: confirm 'Checksum verified' on a successful self-update.

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
- `mnemopi`: validate the source name in renameBank to close a traversal.
- `settings-test`: drop wrong SettingPath cast that broke the release typecheck.

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
- `coding-agent`: make file moves crash-atomic; hoist mode-preserving atomic write.

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
- `install`: compare whole PATH entries on Windows, add gated ps1 function tests.

## [1.0.26] - 2026-07-24

### Changed

- Rebuild handbook book to match sources.
- `utils`: differential property suite for the JSON repair/parse path.

### Fixed

- `utils`: stop normalizeBaseUrl leaking a trailing space behind a stripped slash.
- `install`: warn instead of silently skipping a failed shell completion.

## [1.0.25] - 2026-07-24

### Added

- `tui`: accelerate repeated wheel ticks in scroll isolation.

### Changed

- `coding-agent`: never block session startup on argot dictionary generation.
- `ai`: hoist duplicated OpenAI SSE event-name resolver into one owner.
- `tui`: update the EIO write-failure test to the fatal/transient contract.

### Fixed

- `tui`: don't brick rendering on a single transient write failure.
- `edit`: preserve a UTF-8 BOM through an old_text/new_text edit.
- `lsp`: don't silently swallow format-on-write failures.

## [1.0.24] - 2026-07-24

### Added

- `coding-agent`: present only alabaster while the light-theme slab class is unfixed.
- `release`: derive commit-history notes + gate the generator on CI.

### Changed

- `coding-agent`: lock the argot mid-session prompt-refresh contract.
- `changelog`: backfill the undocumented veyyon changes across all packages.

### Fixed

- `coding-agent`: teach argot handles after a mid-session load.

## [1.0.23] - 2026-07-24

### Changed

- Enforce the changelog gate on direct-to-main pushes.
- Describe the changelog gate as running on direct-to-main pushes.

### Fixed

- `edit`: stop applyCodexPatch from silently hiding partial application.
- `edit`: trim apply_patch marker paths so the write matches the approved path.
- `hashline`: guard NodeFilesystem.move against deleting the file it just wrote.
- `hashline`: guard the production move adapter against deleting the file it just wrote.
- `hashline`: guard InMemoryFilesystem.move against dropping a same-key move.

## [1.0.22] - 2026-07-23

### Added

- `coding-agent`: unify the run clock, merge model effort, clickable scroll-to-bottom.

### Changed

- Set veyyon package author to santhreal.
- `natives`: cover the runtime load gate that threw for stale addons.
- `coding-agent`: make the agents-guidance isolation helper async and profile-aware.
- `types`: sync loader-state.d.ts with the tri-state + load-gate API.
- `natives`: cover the runtime AVX2 classifier + lock parity with the build one.
- `identity`: lock every @veyyon manifest to author santhreal.
- `natives`: document the version-sentinel freshness gate and tri-state AVX2 lock-step.

### Fixed

- `ci`: make single-owner guards self-contained and clear unused-import lint errors.
- `natives`: don't silently downgrade to baseline when AVX2 detection fails.
- `build`: don't silently build baseline-only when host AVX2 probe fails.
- `website`: serve install.sh at the get.veyyon.dev root.
- `website`: serve get.veyyon.dev root from a dedicated install-only tree.

## [1.0.21] - 2026-07-23

### Changed

- `changelog`: note the release-publish fix for the next release.

### Fixed

- `release`: ci-release-notes.ts must not import a workspace package.

## [1.0.20] - 2026-07-23

### Changed

- `release`: assert the tarball smoke PACKS every closure dep, not just overrides it.
- `changelog`: record the Kimi usage and recent-sessions ordering fixes.

### Fixed

- `release`: never rewrite the native sentinel inside test files.

## [1.0.19] - 2026-07-23

### Changed

- `natives`: cover the ship-path stale-native guard on real .node bytes.
- `release`: lock the fork-notice-safe changelog roll.
- `release`: unify the changelog roll onto the gate's bullet predicate.
- `release`: verify the published linux-x64 binary launches.
- `release`: verify the darwin binary's .sha256 sidecar too.
- `hashline`: sample the seed-fuzz corpus on the gate, soak the full 3M nightly.
- `hashline`: reclaim the range-edit perf bullet into [Unreleased].
- `ai`: satisfy useLiteralKeys in the prototype-key metadata test.
- `lint`: remove dead vars and a comma operator flagged by biome.

### Fixed

- `smoke`: force core native-addon load in --smoke-test.
- `ai`: create the config dir before writing the Kimi device-id file.
- `coding-agent`: make the recent-sessions recency order deterministic.

## [1.0.18] - 2026-07-23

### Fixed

- `ci`: keep hashline scale suites under the 5s per-test limit on slow CI.
- `release`: reclaim hashline perf bullet into [Unreleased]; keep new [Unreleased] below fork notice.

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

### Changed

- `natives`: warn (not silently skip) on a stale workspace native.
- Align stale tests with strict contracts (unblock release gates).

### Fixed

- `natives`: refuse to embed a native addon built for the wrong version.
- `install-smoke`: pack argot + build prepack bundle so release gate passes.
- `natives`: declare the four new loader-state exports in the .d.ts.

## [1.0.15] - 2026-07-23

### Added

- `coding-agent`: ease the footline badge slot open and closed.
- `tui`: release the mouse when the frame fits the viewport.

### Changed

- Document scroll isolation in the settings reference and renderer internals.
- `install`: --uninstall never deletes a checkout holding local work.
- `changelog`: note the set_cwd argot_load tip fix.
- Purge upstream (can1357/oh-my-pi) traces from runtime source.
- Lock loud surfacing of managed AGENTS.md seed failures.

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
- `coding-agent`: correct the auto-chdir fallback chain in the maybeAutoChdir comment.
- `tui`: warm the native addon before process.platform mocks.

### Removed

- `polish`: drop the 'sun' from user-facing copy (it's design, never named).

### Fixed

- `ai/dialect`: route model-controlled arg keys through prototype-safe setToolArg.
- `utils,ai`: share one prototype-safe dynamic-key primitive; fix loop-guard hash collision.
- `utils/json-parse`: store __proto__ keys safely in the relaxed/streaming parser.
- `coding-agent`: make the composer anchor stateless, no latch-off on transient spikes.
- `onboarding`: run the setup wizard on first install only, never on update.

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

### Removed

- Drop the black fill from the README sun mark.
- `prompt`: remove dead topLevelTags bookkeeping from format() hot path.

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

### Removed

- `coding-agent`: delete dead plugin installer duplicate.

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
- `compaction`: count retained custom/branch tokens in keepRecent budget.
- `compaction`: cut past the crossing entry when keeping everything dead-ends.

## [1.0.11] - 2026-07-18

### Changed

- `utils`: promote collapseWhitespace to the repo-wide owner.
- Repoint sibling-package collapse-and-trim onto the utils owner.
- `utils`: give collapseWhitespace a dependency-free subpath.
- Repoint the three named errorMessage copies onto the utils owner.

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
- `utils`: repoint strip-ansi's stale browser-consumer refs to @veyyon/tool-render.
- `veyyon-shell`: unify head_tail_dedup onto one primitive owner.

### Fixed

- `release`: drop unpublished @veyyon/tool-render dep + pack @veyyon/stats in install smoke.

## [1.0.3] - 2026-07-17

### Changed

- Add dependabot for the bun/npm, cargo, and github-actions graphs.

### Fixed

- `stats`: deep-import format helpers + lock browser bundles off the Bun-mixed utils barrel.

## [1.0.2] - 2026-07-17

### Fixed

- `tool-render`: deep-import formatCount so the collab-web browser bundle stops pulling Bun-only utils.

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
- `doc-freshness`: surface tracked-but-deleted docs loudly; re-stamp releasing.md to canonical HEAD.
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

### Fixed

- Resolve lint/format errors in parallel-session WIP so the tree gates green.
- Debrand user-visible vey leaks (login hint told users to run `vey`).
- `swarm-extension`: peerDependency @veyyon/pi-coding-agent ^16 -> catalog:.
- `plugins`: plugin doctor reports ok for the fresh-install state.
- `session`: clearer no-model/no-key guidance pointing at /login and veyyon setup.
- `release`: skip changelog diff when no baseline ref exists (first release).
- `cli`: fail fast on non-TTY interactive/empty stdin; consume piped prompts.

## Upstream history

Veyyon is a fork of [oh-my-pi](https://github.com/can1357/oh-my-pi) 16.5.2 (MIT, by Can Boluk). Everything before the fork is upstream history, not a veyyon release. See [oh-my-pi's releases](https://github.com/can1357/oh-my-pi/releases) for it.
