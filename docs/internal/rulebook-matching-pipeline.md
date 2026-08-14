# Rulebook Matching Pipeline

This document describes how coding-agent discovers rules from supported config formats, normalizes them into a single `Rule` shape, resolves precedence conflicts, and splits the result into:

- **Rulebook rules** (available to the model via system prompt + `rule://` URLs)
- **TTSR rules** (Time Traveling Stream Rules)

It reflects the current implementation, including partial semantics and metadata that is parsed but not enforced.

## Implementation files

- [`packages/coding-agent/src/capability/rule.ts`](../../packages/coding-agent/src/capability/rule.ts)
- [`packages/coding-agent/src/capability/rule-buckets.ts`](../../packages/coding-agent/src/capability/rule-buckets.ts)
- [`packages/coding-agent/src/capability/index.ts`](../../packages/coding-agent/src/capability/index.ts)
- [`packages/coding-agent/src/discovery/index.ts`](../../packages/coding-agent/src/discovery/index.ts)
- [`packages/coding-agent/src/discovery/helpers.ts`](../../packages/coding-agent/src/discovery/helpers.ts)
- [`packages/coding-agent/src/discovery/builtin.ts`](../../packages/coding-agent/src/discovery/builtin.ts)
- [`packages/coding-agent/src/discovery/veyyon-plugins.ts`](../../packages/coding-agent/src/discovery/veyyon-plugins.ts)
- [`packages/coding-agent/src/discovery/builtin-defaults.ts`](../../packages/coding-agent/src/discovery/builtin-defaults.ts)
- [`packages/coding-agent/src/discovery/agents.ts`](../../packages/coding-agent/src/discovery/agents.ts)
- [`packages/coding-agent/src/discovery/cursor.ts`](../../packages/coding-agent/src/discovery/cursor.ts)
- [`packages/coding-agent/src/discovery/windsurf.ts`](../../packages/coding-agent/src/discovery/windsurf.ts)
- [`packages/coding-agent/src/discovery/github.ts`](../../packages/coding-agent/src/discovery/github.ts)
- [`packages/coding-agent/src/sdk.ts`](../../packages/coding-agent/src/sdk.ts)
- [`packages/coding-agent/src/system-prompt.ts`](../../packages/coding-agent/src/system-prompt.ts)
- [`packages/coding-agent/src/internal-urls/rule-protocol.ts`](../../packages/coding-agent/src/internal-urls/rule-protocol.ts)
- [`packages/utils/src/frontmatter.ts`](../../packages/utils/src/frontmatter.ts)

## 1. Canonical rule shape

All providers normalize source files into `Rule`:

```ts
interface Rule {
  name: string;
  path: string;
  content: string;
  globs?: string[];
  alwaysApply?: boolean;
  description?: string;
  condition?: string[];
  astCondition?: string[];
  scope?: string[];
  interruptMode?: "never" | "prose-only" | "tool-only" | "always";
  repeatMode?: "once" | "after-gap" | "per-compact";
  repeatGap?: number;
  repeatCompactions?: number;
  warmupMatches?: number;
  pathScope?: "outside-cwd" | "inside-cwd";
  section?: string;
  experimental?: boolean;
  _source: SourceMeta;
}
```

Capability identity is `rule.name` (`ruleCapability.key = rule => rule.name`).

Consequence: precedence and deduplication are **name-based only**. Two different files with the same `name` are considered the same logical rule.

## 2. Discovery sources and normalization

`src/discovery/index.ts` auto-registers providers. For `rules`, current providers are:

- `native` (priority `100`)
- `veyyon-plugins` (priority `90`): `rules/*.{md,mdc}` inside configured extension package roots, normalized via the shared `buildRuleFromMarkdown` path
- `agents` (priority `70`)
- `cursor` (priority `50`)
- `windsurf` (priority `50`)
- `github` (priority `30`)
- `builtin-defaults` (priority `1`)

The registry contains every provider above. Ambient discovery filters foreign providers (`agents`, `cursor`, `github`, and `windsurf`) unless `discovery.importForeignConfig` is enabled. An explicit provider allowlist selects named providers directly and bypasses that ambient foreign-config gate.

Every provider reads home directories only. A working tree contributes no rules: the foreign providers used to walk project directories (`.cursor/rules`, `.windsurf/rules`, `.clinerules`, `.agent/rules`, `.github/instructions`, and `.veyyon/rules`), and each of those walks was a way for a cloned repository to install a standing instruction, so they are gone.

### Native provider (`builtin.ts`)

Loads native rules from the active profile only:

- user: `<active agent dir>/rules/*.{md,mdc}`, where the active agent directory comes from `getAgentDir()`
- sticky user rule: `<active agent dir>/RULES.md`

A repository's `.veyyon/rules/` and `.veyyon/RULES.md` used to load at project scope and no longer do.

Normalization:

- `name` = filename without `.md`/`.mdc`
- frontmatter parsed via `parseFrontmatter`
- `content` = body (frontmatter stripped)
- `globs`, `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, `interruptMode`, `pathScope`, `repeatMode`, `repeatGap`, `repeatCompactions`, and `warmupMatches` are parsed by `buildRuleFromMarkdown`
- top-level `RULES.md` is synthesized as rule name `RULES` and forced to `alwaysApply: true`

Important caveat: `condition` values that look like file globs are removed from the regex condition list and converted into `tool:edit(...)` / `tool:write(...)` scope shorthands. Catch-all condition `.*` is added only when no non-glob regex condition remains.

### Agents provider (`agents.ts`)

Loads from the home-level `.agent` and `.agents` directories only:

- user: `~/.agent/rules/*.{md,mdc}` and `~/.agents/rules/*.{md,mdc}`

There is no project scope: the provider used to walk up from `cwd` loading `<ancestor>/.agent/rules/` and `<ancestor>/.agents/rules/`, which made a cloned repository a second directory vocabulary for installing rules.

Normalization uses the shared `buildRuleFromMarkdown` path: filename-derived name, stripped frontmatter body, and parsed `globs`, `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, `interruptMode`, `pathScope`, `repeatMode`, `repeatGap`, `repeatCompactions`, and `warmupMatches`.

### Cursor provider (`cursor.ts`)

Loads from:

- user: `~/.cursor/rules/*.{mdc,md}`

Normalization (`transformMDCRule`):

- `description`: kept only if string
- `alwaysApply`: normalized to a boolean: `true` only when frontmatter has `alwaysApply: true` (anything else becomes `false`)
- `globs`: accepts array (string elements only) or single string
- `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, `interruptMode`, `pathScope`, `repeatMode`, `repeatGap`, `repeatCompactions`, and `warmupMatches` are parsed by shared rule helpers
- `name` from filename without extension

### Windsurf provider (`windsurf.ts`)

Loads from:

- user: `~/.codeium/windsurf/memories/global_rules.md` (fixed rule name `global_rules`)

Normalization:

- `globs`: array-of-string or single string
- `alwaysApply`, `description`, `condition`/legacy `ttsr_trigger`, `astCondition`, `scope`, `interruptMode`, `pathScope`, `repeatMode`, `repeatGap`, `repeatCompactions`, and `warmupMatches` parsed by shared rule helpers
- `name` is fixed to `global_rules`

### GitHub Copilot provider (`github.ts`)

Loads rules recursively from:

- user: `<configured-dir>/.github/instructions/**/*.instructions.md` for each directory in `COPILOT_CUSTOM_INSTRUCTIONS_DIRS`

Only those configured directories are read. The repository the agent is running in contributes no instructions of its own.

Normalization uses `buildRuleFromMarkdown`, strips `.instructions.md` from the rule name, and maps GitHub's comma-separated or array-valued `applyTo` metadata to `globs`. `applyTo` values `*`, `**`, and `**/*` become `alwaysApply: true`; other values become described rulebook rules. A missing `applyTo` emits a warning and loads the rule without glob scoping.

## 3. Frontmatter parsing behavior and ambiguity

All providers use `parseFrontmatter` (`utils/frontmatter.ts`) with these semantics:

1. Frontmatter is parsed only when content starts with `---` and has a closing `\n---`.
2. Body is trimmed after frontmatter extraction.
3. If YAML parse fails, the parser retries once after quoting ambiguous plain scalars; if that still fails:
   - warning is logged,
   - parser falls back to simple `key: value` line parsing (`^([\w-]+):\s*(.*)$`).

Ambiguity consequences:

- Fallback parser does not support arrays, nested objects, or quoting rules.
- Fallback values become strings (for example `alwaysApply: true` becomes string `"true"`), so providers requiring boolean/string types may drop metadata.
- `ttsr_trigger` works in fallback (underscore key); hyphenated keys like `thinking-level` also parse and are normalized to camelCase (`thinkingLevel`): key normalization applies to the YAML path too.
- Files without valid frontmatter still load as rules with empty metadata and full content body.

## 4. Provider precedence and deduplication

`loadCapability("rules")` (`capability/index.ts`) merges provider outputs and then deduplicates by `rule.name`.

### Precedence model

- Providers are ordered by priority descending.
- Equal priority keeps registration order (`cursor` before `windsurf` from `discovery/index.ts`).
- Dedup is first-wins: first encountered rule name is kept; later same-name items are marked `_shadowed` in `all` and excluded from `items`.

This is the registered precedence order. The ambient enabled set can be smaller because the foreign-provider gate described above runs before loading.

Effective rule provider order is currently:

1. `native` (100)
2. `veyyon-plugins` (90)
3. `agents` (70)
4. `cursor` (50)
5. `windsurf` (50)
6. `github` (30)
7. `builtin-defaults` (1)

### Intra-provider ordering caveat

Within a provider, item order comes from `loadFilesFromDir` glob result ordering plus explicit push order. This is deterministic enough for normal use but not explicitly sorted in code.

Notable source-order differences:

- `native` appends user `<active agent dir>/rules`, then user `<active agent dir>/RULES.md`.
- `veyyon-plugins` appends `rules/` results per configured extension package root.
- `agents` appends the home `.agent`/`.agents` rule dirs.
- `cursor` appends user results.
- `windsurf` appends the user `global_rules` file.
- `github` appends instructions from each configured custom root.
- `builtin-defaults` uses the embedded rule source order.

## 5. Split into Rulebook, Always-Apply, and TTSR buckets

After rule discovery in `createAgentSession` (`sdk.ts`), `bucketRules(...)` applies session-level filtering and bucket assignment:

1. Drop rules listed in `ttsr.disabledRules`.
2. Drop rules from the `builtin-defaults` provider when `ttsr.builtinRules === false`.
3. Drop rules carrying `experimental: true` unless the name appears in `ttsr.experimentalRules`. Off wins: a name in both lists is dropped.
4. Register rules with a non-empty `condition` or `astCondition` into `TtsrManager`; if registration succeeds, the rule is TTSR-only.
5. Put remaining `alwaysApply === true` rules into `alwaysApplyRules`.
6. Put remaining rules with `description` into `rulebookRules`.

The first three steps are the operator's levers, and `ruleIsEnabled` (`capability/rule-buckets.ts`) is their one owner, so `ttsr scan` reports the same enablement the session applies. `experimental` and `section` come from the directory a bundled rule ships in, never from frontmatter.

### Bucket behavior

- **TTSR bucket**: any enabled rule with a non-empty parsed `condition` (regex) or `astCondition` (ast-grep patterns) that `TtsrManager.addRule(...)` accepts. Takes priority over other buckets.
- **Always-apply bucket**: `alwaysApply === true`, not TTSR. Full content injected into system prompt. Resolvable via `rule://`.
- **Rulebook bucket**: must have description, must not be TTSR, must not be `alwaysApply`. Listed in system prompt by name+description; content read on demand via `rule://`.
- A rule with both a trigger condition and `alwaysApply` goes to TTSR only if TTSR registration accepts it; otherwise it can fall through to always-apply.
- A rule with both `alwaysApply` and `description` goes to always-apply only (not rulebook).

## 6. How metadata affects runtime surfaces

### `description`

- Required for inclusion in rulebook.
- Rendered in the system prompt rulebook block (`<domain-rules>` in the default template, `<rules>` in the custom-prompt template).
- Missing description keeps the rule out of the rulebook listing; unless it is always-apply or an accepted TTSR rule, it is also not addressable via `rule://`.

### `globs`

- Carried through on `Rule`.
- Rendered inline in the default prompt's rulebook listing (`- <name> (<glob>, ...): <description>`); the custom-prompt template renders them as `<glob>...</glob>` entries.
- Exposed in rules UI state (`extensions` mode list).
- Used by TTSR as a global path gate: if a TTSR rule has globs, the match context must include at least one matching file path.
- Not used to automatically select rulebook rules for `rule://`; rulebook matching remains advisory prompt behavior.

### `alwaysApply`

- Parsed and preserved by providers.
- Used in UI display (`"always"` trigger label in extensions state manager).
- Used as an exclusion condition from `rulebookRules`.
- **Full rule content is auto-injected into the system prompt** (before the rulebook rules section).
- Rule is also addressable via `rule://<name>` for re-reading.

### `condition`, `astCondition`, `scope`, `interruptMode`, `pathScope`, `repeatMode`, `repeatGap`, `repeatCompactions`, and `warmupMatches`

- `condition` is the regex TTSR trigger field; legacy `ttsr_trigger` / `ttsrTrigger` are accepted as fallback inputs during parsing.
- `astCondition` is the ast-grep trigger field: a string or list of structural patterns, kept verbatim (no glob inference). It only matches on edit/write tool streams, where the language is inferred from the file path. A rule may set `condition`, `astCondition`, or both.
- A `scope` token that names no registered tool is reported at warn once the tool registry is complete (`TtsrManager.reportUnknownToolScopes`, called from `sdk.ts`), with the closest registered name. A bare token is read as a TOOL NAME, so `scope: "raed"` parses cleanly and registers a rule that can never match, which looks exactly like a rule whose condition is never met. The rule is NOT refused: a tool can be registered later by an extension, and scoping a rule to an inactive tool is legitimate.
- `scope` narrows TTSR matching scope. A `condition` token that looks like a file glob becomes `tool:edit(<glob>)` and `tool:write(<glob>)` scope entries and is removed from the regex condition list. Catch-all condition `.*` is inserted only when no non-glob regex condition remains; `astCondition` tokens never trigger this shorthand.
- `interruptMode` can override the global TTSR interrupt mode for the rule.
- `repeatMode` and `repeatGap` override the global `ttsr.repeatMode` / `ttsr.repeatGap` for the rule. Use them when the rule's advice is repeatable: the global default retires a rule after one injection per session, which suits a convention and not a nudge that applies again to the next directory. An unrecognised mode, a negative gap, and a fractional gap are ignored rather than coerced, so the global setting governs instead of a policy the author did not write.
- `repeatCompactions` is the period of a `repeatMode: per-compact` rule: how many transcript replacements it waits out before it may fire again, default 1. Raise it for a rule whose subject is a standing state rather than an event, since that rule matches again the instant it is re-armed. A fractional or non-positive value is ignored, same reading as the gap.
- `warmupMatches` is how many distinct streams the rule matches in before it fires at all, default 1 (fire on the first match). The unit is the stream, not the match: one tool call is re-matched on every delta it streams, so a warm-up counted in matches clears inside the first call and the rule fires exactly as early as it would with no warm-up. Use it for advice about a HABIT rather than an event — `cwd-reroot` declares 3, because one read of a file in another project is a glance and the rule's own body says to ignore it in that case. The count is set aside when the reminder is claimed and restored if that claim is released undelivered, and it starts again once the reminder has been heard, so a rule that spoke has to see the pattern again before it speaks again. A fractional or non-positive value is ignored, same reading as the gap.
- `pathScope` requires the path the condition matched to be outside (`outside-cwd`) or inside (`inside-cwd`) the session working directory. A condition is a regex over the model's output and cannot know where the working directory is, so a rule about location fires on any path of the right shape. This is what made `cwd-reroot` advise re-rooting into the project the session was already in. The comparison runs against the LIVE working directory at match time, so it stays right after a `set_cwd`, and it resolves both paths rather than comparing strings, so `/work/project-two` is not read as inside `/work/project`. With no working directory available the rule does not fire: a rule that asked to be filtered must not fire unfiltered. `TtsrManager.lastMatchedPath(name)` returns the path that decided the match, which is how an injected body can name the directory it is advising about.

A rule that uses `pathScope` should stay scoped to navigation tools (`read`, `grep`, `glob`, `ast_grep`). These tools are comparatively safe because their raw argument streams normally contain navigation arguments instead of file bodies, but the stream is not path-only: it can also contain intent, patterns, and other arguments. For `edit`, `write`, `ast_edit`, and `bash`, the stream also carries file content or a heredoc, and content mentions absolute paths constantly: docs, configs, fixtures, path constants. Scoping those tools into a path rule makes it fire on what a file talks about rather than on where the file lives, and no regex over the stream can tell the two apart. When you want to react to where a write actually lands, use the tool's declared `filesystemTargets` instead; `RerootDetector` in `src/tools/reroot-hint.ts` does this.

### Rule bodies and their render context

A rule body is a template. `AgentSession.#renderRuleBody` is the one place it is resolved, for both TTSR delivery paths, and it provides exactly five variables:

- `argot` -- whether the argot feature is enabled, for advice that names an argot tool.
- `argotUnloaded` -- whether argot is enabled AND the project's dictionary is not loaded yet. This is the gate a nudge to CALL `argot_load` must use: the feature being on does not mean the dictionary is missing, and advising a model to load one it already loaded is advice it cannot act on. The template language has no `unless`, so the inverted condition is passed in pre-inverted.
- `cwd` -- the session's live working directory.
- `matchedPath` -- the path that decided a `pathScope` match, absent for every other rule, so a body that uses it must guard the reference.
- `commitDrift` -- the uncommitted count and file list, present only when `git.enabled` is on and there is something to report. It is left undefined rather than zeroed, because `{{#if commitDrift}}` is the gate a body uses and `{ count: 0 }` would be truthy.

A body that renders to the empty string is never delivered; see `docs/internal/ttsr-injection-lifecycle.md`.

## 7. System prompt inclusion path

`buildSystemPromptInternal` receives both `rules` (rulebook) and `alwaysApplyRules`.

Always-apply rules are deduped against the caller-supplied custom base, append value, and loaded context files. `dedupeAlwaysApplyRules` normalizes each source and rule into trimmed, non-empty paragraph blocks, then drops a rule when its blocks appear as an exact contiguous run in a source. The remaining rules render first and inject their raw content into a `<generic-rules>` block in the default template.

Rulebook rules are rendered in a `<domain-rules>` block as `- <name> (<globs>): <description>` lines; the URL list in the prompt documents `rule://<name>` and the workflow section tells the model to read relevant rules first. The custom-prompt template (`custom-system-prompt.md`) instead renders `<rule name="...">` entries with `<glob>` children under an explicit "You MUST read `rule://<name>`" instruction.

This is advisory/contextual: prompt text asks the model to read applicable rules, but code does not enforce glob applicability.

## 8. `rule://` internal URL behavior

`RuleProtocolHandler` resolves against the process-global active-rule snapshot. A top-level session installs the snapshot initially in `sdk.ts` and refreshes it when live cwd/project prompt inputs are re-discovered and TTSR rules are re-bucketed. Subagents do not install independent snapshots:

```ts
setActiveRules([...rulebookRules, ...alwaysApplyRules, ...ttsrManager.getRules()]);
```

Implications:

- `rule://<name>` resolves against **rulebookRules**, **alwaysApplyRules**, and **registered TTSR rules**.
- TTSR rules are bucketed out before rulebook/always, but `ttsrManager.getRules()` re-adds them to the snapshot so a triggered rule (e.g. a builtin) stays addressable for re-reading.
- Rules with no description, no `alwaysApply`, and no accepted TTSR condition are not addressable via `rule://`.
- Resolution is exact name match.
- Unknown names return error listing available rule names.
- Returned content is raw `rule.content` (frontmatter stripped), content type `text/markdown`.

## 9. Known partial / non-enforced semantics

1. Registered rule providers are `native`, `veyyon-plugins`, `agents`, `cursor`, `windsurf`, `github`, and embedded `builtin-defaults`. Ambient discovery filters foreign providers unless `discovery.importForeignConfig` enables them; an explicit provider allowlist can select them directly.
2. `globs` metadata is surfaced to prompt/UI and is used as a global path gate for TTSR matching, but it is not used to automatically select rulebook rules for `rule://`.
3. Rule selection for `rule://` includes rulebook, always-apply, and registered TTSR rules (so a triggered TTSR rule can be re-read), but not rules that registered no condition and carry neither a description nor `alwaysApply`.
4. Discovery warnings (`loadCapability("rules").warnings`) are produced but `createAgentSession` does not currently surface/log them in this path.

*Verified against `e80e0a0b` on 2026-08-13.*
