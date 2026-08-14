# TTSR Injection Lifecycle

This document covers the current Time Traveling Stream Rules (TTSR) runtime path from rule discovery to stream interruption, retry injection, extension notifications, and session-state handling.

## Implementation files

- [`../src/sdk.ts`](../../packages/coding-agent/src/sdk.ts)
- [`../src/export/ttsr.ts`](../../packages/coding-agent/src/export/ttsr.ts)
- [`../src/session/agent-session.ts`](../../packages/coding-agent/src/session/agent-session.ts)
- [`../src/session/session-manager.ts`](../../packages/coding-agent/src/session/session-manager.ts)
- [`../src/prompts/rules/ttsr-interrupt.md`](../../packages/coding-agent/src/prompts/rules/ttsr-interrupt.md)
- [`../src/capability/index.ts`](../../packages/coding-agent/src/capability/index.ts)
- [`../src/extensibility/extensions/types.ts`](../../packages/coding-agent/src/extensibility/extensions/types.ts)
- [`../src/extensibility/hooks/types.ts`](../../packages/coding-agent/src/extensibility/hooks/types.ts)
- [`../src/extensibility/custom-tools/types.ts`](../../packages/coding-agent/src/extensibility/custom-tools/types.ts)
- [`../src/modes/controllers/event-controller.ts`](../../packages/coding-agent/src/modes/controllers/event-controller.ts)

## 1. Discovery feed and rule registration

At session creation, `createAgentSession()` loads discovered rules, constructs a `TtsrManager`, and buckets rules through `bucketRules(...)`:

```ts
const ttsrSettings = settings.getGroup("ttsr");
// A live getter, not a snapshot: a `pathScope` rule compares against the CURRENT
// working directory, and `set_cwd` moves it mid-session.
const ttsrManager = new TtsrManager(ttsrSettings, { getCwd: () => sessionManager.getCwd() });
const rulesResult = await discoverRules(cwd, agentDir);
const { rulebookRules, alwaysApplyRules } = bucketRules(rulesResult.items, ttsrManager, {
  builtinRules: ttsrSettings.builtinRules,
  disabledRules: ttsrSettings.disabledRules,
  experimentalRules: ttsrSettings.experimentalRules,
});
```

`bucketRules(...)` drops names listed in `ttsr.disabledRules`, drops embedded `builtin-defaults` rules when `ttsr.builtinRules === false`, drops an experimental rule that is not named in `ttsr.experimentalRules`, registers accepted TTSR rules, and then routes the remaining rules to always-apply/rulebook buckets.

### Pre-registration dedupe behavior

`loadCapability("rules")` deduplicates by `rule.name` with first-wins semantics (higher provider priority first). Shadowed duplicates are removed before TTSR registration.

### `TtsrManager.addRule()` behavior

Registration is skipped when:

- TTSR is disabled (`ttsr.enabled === false`)
- both `rule.condition` (regex) and `rule.astCondition` (ast-grep patterns) are absent, or every regex condition fails to compile and there are no AST conditions
- a rule with the same `rule.name` was already registered in this manager
- the rule scope excludes all monitored streams

Invalid regex conditions and unreachable scopes are logged as warnings and ignored; session startup continues. If a TTSR rule defines `globs`, those globs are compiled as a global file-path gate for matching.

### AST conditions (`astCondition`)

A rule may carry `astCondition`: a list of [ast-grep](https://ast-grep.github.io/) patterns (OR'd, same as regex `condition`), matched structurally instead of textually. A repeated metavariable inside one pattern requires both occurrences to be equal (`if ($X) clearTimeout($X)` matches but `if ($X) clearTimeout($Y)` does not).

AST conditions only evaluate on **edit/write tool-argument streams**, they need a language, which is inferred from the file extension on the tool's path argument, and they match against the tool's reconstructed source snapshot (`matcherDigest`), not the raw wire delta. Matching is performed in memory by the native `astMatch` engine (no temp files) with Smart strictness. Streams without a usable file path (prose, thinking, path-less tool calls) skip AST conditions entirely. A rule may mix `condition` and `astCondition`; the regex paths keep working on every scope while AST paths apply only to those tool streams.

### Setting gating

`TtsrSettings.enabled` gates the manager: when `ttsr.enabled === false`, `addRule()` refuses registration and `checkDelta()`/`checkSnapshot()`/`checkAstSnapshot()`/`hasRules()`/`hasAstRules()` all return empty/false, so no matching runs.

## 2. Streaming monitor lifecycle

TTSR detection runs inside `AgentSession.#handleAgentEvent`.

### Turn start

On `turn_start`, the stream buffer is reset:

- `ttsrManager.resetBuffer()`

### During stream (`message_update`)

When assistant updates arrive and rules exist:

- monitor `text_delta`, `thinking_delta`, and `toolcall_delta`
- for tools exposing `matcherDigest` (edit/write), replace the scoped buffer with the reconstructed source snapshot and call `checkSnapshot(snapshot, matchContext)`; otherwise append the delta into a source/tool scoped manager buffer and call `checkDelta(delta, matchContext)` (synchronous regex matching either way)
- for edit/write tool streams, when `hasAstRules()` is true, `await checkAstSnapshot(snapshot, matchContext)` (asynchronous AST matching)

`checkDelta()`/`checkSnapshot()` iterate registered rules and return all matching rules that pass scope, global path-glob, regex condition, and repeat policy checks. `checkAstSnapshot()` applies the same scope/path/repeat gates, then runs each candidate rule's `astCondition` patterns against the snapshot via the native `astMatch` engine. It is throttled per stream key: an identical consecutive snapshot (common when only non-source arguments change between deltas) is skipped without re-running the matcher. Both paths feed their matches through the same trigger-decision handler.

## 3. Trigger decision and immediate abort path

When one or more rules match and at least one matched rule allows interruption:

1. Matched rules are deduplicated into `#pendingTtsrInjections`.
2. `#ttsrAbortPending = true` and a TTSR resume gate is created.
3. `agent.abort()` is called immediately.
4. `ttsr_triggered` event is emitted asynchronously (fire-and-forget).
5. retry work is scheduled via the post-prompt task scheduler with a 50ms delay.

Abort is not blocked on extension callbacks.

## 4. Retry scheduling, context mode, and reminder injection

After the 50ms timeout:

1. `#ttsrAbortPending = false`
2. read `ttsrManager.getSettings().contextMode`
3. if `contextMode === "discard"`, drop the targeted partial assistant output with `agent.replaceMessages(...slice(0, targetAssistantIndex))`
4. build injection content from pending rules using `ttsr-interrupt.md` template
5. append and persist a hidden `custom_message`/runtime custom message with `customType: "ttsr-injection"` and `details.rules`
6. mark those rule names injected, persist a `ttsr_injection` entry, and call `agent.continue()` to retry generation

Template payload is:

```xml
<system-interrupt reason="rule_violation" rule="{{name}}" path="{{path}}">
...
{{content}}
</system-interrupt>
```

Pending injections are cleared after content generation.

### `contextMode` behavior on partial output

- `discard`: partial/aborted assistant message is removed before retry.
- `keep`: partial assistant output remains in conversation state; reminder is appended after it.

### Non-interrupting matches

Non-interrupting matches split by `matchContext.source`:

- **`source === "tool"` (tool-source match).** The rule is bucketed into `#perToolTtsrInjections`, keyed by the matched tool call's `id`. There is **no** deferred follow-up turn and the stream is not aborted. When the tool actually produces a result, the `afterToolCall` hook prepends a rendered `ttsr-tool-reminder.md` block to `ctx.result.content` (a single `text` block inserted ahead of the tool's own content), and persists a `ttsr_injection` entry with the consumed rule names. The template payload is:

  ```xml
  <system-reminder reason="rule_violation" rule="{{name}}" path="{{path}}">
  ...
  {{content}}
  </system-reminder>
  ```

- **`source === "text"` / `"thinking"` (prose-source match).** Behavior is unchanged: the rule is queued in `#pendingTtsrInjections` and, after a successful non-error, non-aborted assistant message, `AgentSession` injects the hidden `ttsr-injection` custom message as a follow-up and schedules continuation.

Within a single matching batch, each rule is attached to exactly one sibling tool call, if multiple sibling tool calls would satisfy the same rule, deduplication picks one and the others are left untouched. Multiple distinct rules can still fold onto the same tool call.

#### Implications for tool authors and transcript readers

- The tool's own `toolResult` content is preserved verbatim; the reminder is **prepended** as an additional leading text block. Renderers that assume `content[0]` is the tool's primary output must scan past any block whose text begins with `<system-reminder reason="rule_violation"` (or filter on the wrapper tag) to find the real payload.
- The reminder is in-band on the tool result, not a separate `custom_message`/`ttsr-injection` entry. Transcript readers looking for non-interrupting TTSR activity on tool-source rules MUST inspect tool results (and the persisted `ttsr_injection` entry list), not just synthetic injection entries.
- A single tool result may carry reminders for several rules concatenated with a blank line between rendered templates.
- The reminder body is template-rendered before delivery, by the same `#renderRuleBody` owner the interrupting path uses. Both paths resolve `argot`, `argotUnloaded`, `cwd`, and `matchedPath`. `argot` is the feature flag; `argotUnloaded` is `argot.enabled && !argot.loaded`, which is the question a nudge to LOAD shorthand actually depends on (the template language has no `unless`, so an inverted condition is passed in already inverted). The tool path used to fold the RAW body in, so a rule with a `{{#if ... }}` gate reached the model as markup; `cwd-reroot` only ever takes this path, so that was the only body it ever delivered.
- If the assistant message ends with `stopReason === "aborted"` or `"error"` before the matched tools run, the pending per-tool buckets are dropped by `#dropUndeliveredPerToolInjections`, which also calls `TtsrManager.releaseInjectedByNames` to give back the claim taken at bucket time. Those rules are **not** persisted as injected and remain eligible to re-trigger (subject to repeat policy). Clearing the bucket without releasing the claim leaves a rule marked as injected with nothing ever shown to the model, and under `repeatMode: "once"` that retires it for the session.

### Matches that render to nothing

`#handleTtsrMatches` filters every match through `#deliverableTtsrMatches` before anything else happens. A rule whose body renders to the empty string is dropped there: before the claim is taken, before a bucket exists, and before `ttsr_triggered` is emitted.

A body wrapped entirely in a `{{#if}}` gate renders to nothing whenever the gate is closed. `argot-load-nudge` is that shape, and delivering the empty result would spend tokens, interrupt the stream on the interrupting path, mark the rule as injected so it could not fire once the gate opened, and tell the model a rule was violated without naming a behaviour to change.

The drop is reported at debug when the body carries a `{{#if}}` (the gate working, on every match, for as long as it stays closed) and at warn when it does not (a body that can never say anything, which is a packaging bug in the rule).

## 5. Repeat policy and gap logic

`TtsrManager` tracks `#messageCount` and per-rule `lastInjectedAt`. `repeatMode` and `repeatGap` come from the `ttsr.*` settings (defaults `"once"` / `10`), and a rule may override either in its own frontmatter. Per-rule wins, in both directions.

The global default is right for a rule stating a convention: saying it twice adds nothing. It is wrong for a NAVIGATIONAL rule, whose advice applies again to a different directory. Under the global default, `cwd-reroot` fired for the first foreign project a session touched and stayed silent for every later one, which reads as the rule not working. So `cwd-reroot` carries `repeatMode: after-gap` with `repeatGap: 8`.

### `repeatMode: "once"`

A rule can trigger only once after it has an injection record.

### `repeatMode: "after-gap"`

A rule can re-trigger only when:

- `messageCount - lastInjectedAt >= repeatGap`

`messageCount` increments on `turn_end`, so gap is measured in completed turns, not stream chunks.

### `repeatMode: "per-compact"`

A rule re-arms when the transcript is replaced, and `repeatCompactions` says how many replacements it waits out first (default 1). `resetForCompaction()` counts the event and drops the injection record only once `transcriptResets - resetAt >= repeatCompactions`.

Five session paths reach that reset — compaction, a history rewrite, a rewind, a shake, a restore — and they share one counter, because each takes the injected reminder out of the model's view, which is the only property that decides whether the rule has been heard.

A rule whose subject is a standing STATE rather than an event needs a period above 1. `commit-drift` counts files that are still uncommitted and `test-scope` sees a command that is still a whole-suite command, so both match again the instant they are re-armed; both carry `repeatCompactions: 3`.

### `warmupMatches`

A rule may also stay silent until the behavior it is about has happened several times. `warmupMatches` is how many DISTINCT streams the rule matches in before it fires; the ledger lives in `TtsrManager.#warmupStreams`, keyed by rule name and holding stream keys (`toolcall:<id>`), so the many deltas of one tool call advance it once.

It is set aside into `#warmupAtClaim` when the rule is marked injected and restored by `releaseInjectedByNames`, because a claim that was never delivered must not cost the rule the evidence that earned it. Delivery therefore starts the warm-up over: the rule was heard, so the next reminder is earned by the pattern happening again rather than by the transcript rolling.

`cwd-reroot` carries `warmupMatches: 3` with `repeatMode: per-compact`, which is the quietest combination available: three separate calls reaching outside the working directory before it says anything, and then nothing until the transcript is replaced.

## 6. Event emission and extension/hook surfaces

### Session event

`AgentSessionEvent` includes:

```ts
{ type: "ttsr_triggered"; rules: Rule[] }
```

### Extension runner

`#emitSessionEvent()` routes the event to:

- extension listeners (`ExtensionRunner.emit({ type: "ttsr_triggered", rules })`)
- local session subscribers

### Hook and custom-tool typing

- extension API exposes `on("ttsr_triggered", ...)`
- hook API exposes `on("ttsr_triggered", ...)`
- custom tools receive `onSession({ reason: "ttsr_triggered", rules })`

### Interactive-mode rendering difference

Interactive mode uses `session.isTtsrAbortPending` to suppress showing the aborted assistant stop reason as a visible failure during TTSR interruption, and renders a `TtsrNotificationComponent` when the event arrives.

## 7. Persistence and resume state (current implementation)

`SessionManager` persists injected-rule state:

- entry type: `ttsr_injection`
- append API: `appendTtsrInjection(ruleNames)`
- query API: `getInjectedTtsrRules()`
- context reconstruction includes `SessionContext.injectedTtsrRules`

`TtsrManager` supports restoration via `restoreInjected(ruleNames)`.

### Current wiring status

In the current runtime path:

- interrupted injections append a hidden `custom_message` with `customType: "ttsr-injection"` and append a `ttsr_injection` entry via `appendTtsrInjection(...)`
- deferred non-interrupting prose-source injections are marked/persisted when their queued custom message reaches `message_end`
- non-interrupting tool-source injections are marked at match time and persisted via `appendTtsrInjection(...)` from the `afterToolCall` hook when the matched tool's result is produced
- `createAgentSession()` restores `existingSession.injectedTtsrRules` into `ttsrManager`

Net effect: injected-rule suppression is persisted/restored across session reload/resume for the current branch path.

## 8. Race boundaries and ordering guarantees

### Abort vs retry callback

- abort is synchronous from TTSR handler perspective (`agent.abort()` called immediately)
- retry is deferred by timer (`50ms`)
- extension notification is asynchronous and intentionally not awaited before abort/retry scheduling

### Multiple matches in same stream window

`checkDelta()` returns all currently matching eligible rules for that scoped buffer. Pending injections are deduplicated by rule name before injection.

### Between abort and continue

During the timer window, state can change (user interruption, mode actions, additional events). The retry call is best-effort: `agent.continue()` is awaited in a try/catch; on failure the error is swallowed and the TTSR resume gate is resolved.

## 9. Edge cases summary

- Invalid `condition` regex: skipped with warning; other conditions/rules continue.
- Duplicate rule names at capability layer: lower-priority duplicates are shadowed before registration.
- Duplicate names at manager layer: second registration is ignored.
- `ttsr.disabledRules`: listed names are dropped before TTSR registration and are not surfaced through always-apply/rulebook buckets.
- `ttsr.builtinRules: false`: embedded `builtin-defaults` rules are dropped before TTSR registration; user/project rules still load.
- `globs` on a TTSR rule require the stream match context to include at least one matching file path.
- `contextMode: "keep"`: partial violating output can remain in context before reminder retry.
- `interruptMode: "never"`: prose-source matches queue a deferred hidden injection after a successful assistant message; tool-source matches fold an in-band `<system-reminder>` into the matched tool call's `toolResult` content via the `afterToolCall` hook (no mid-stream abort, no separate follow-up turn).
- Tool-source non-interrupting buckets are cleared when the parent assistant message ends with `stopReason === "aborted"` or `"error"`, so rules whose target tool never produced a result remain eligible to re-trigger.
- Repeat-after-gap depends on turn count increments at `turn_end`; mid-turn chunks do not advance gap counters.
- `repeatMode: per-compact` re-arms on a transcript replacement, and `repeatCompactions` (default 1) is how many of them the rule waits out first. Five paths reach `resetForCompaction()` and share its counter: compaction, history rewrite, rewind, shake, restore.
- `warmupMatches` (default 1) keeps a rule silent until it has matched in that many distinct streams; a released claim restores the count, a delivered one starts it over.
- An experimental rule (one shipping in `builtin-rules/experimental/`) is dropped before registration unless named in `ttsr.experimentalRules`, and naming it in `ttsr.disabledRules` as well keeps it off.

*Verified against `e80e0a0b` on 2026-08-13.*
