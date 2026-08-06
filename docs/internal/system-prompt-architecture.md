# System prompt architecture

`buildSystemPrompt` returns an ordered list of strings, not one document:

```ts
// packages/coding-agent/src/system-prompt.ts:1192
return {
	systemPrompt: reorderSections && !hasCustomPrompt
		? applyPromptSectionOrderToParts(systemPrompt, sectionOrder)
		: systemPrompt,
	// …
};
```

Each entry is a **block**. Block 0 is the assembled static template. Every entry after it is
one runtime section. The split is a provider caching contract, and the comment that says so
sits on the loop that builds the array (`system-prompt.ts:1176-1181`):

> Each runtime section is emitted as its own array entry, carrying the banner the registry
> owns. Separate entries are a CACHING contract, not a structural tier: `rendered` is the
> byte-stable prefix a provider can cache, and a volatile section (the handle table changes
> whenever a dictionary loads) must not sit inside it.

This page is about that boundary: what goes in which tier, why, what the ordering rules are,
and how to decide where a new section belongs. For how an operator *changes* the prompt
(`--system-prompt`, `PROMPT_SECTIONS/`, gates, statements), read
[System prompt customization](../system-prompt-customization.md), which owns that surface.

## The two tiers

| | Block 0 | Blocks 1..n |
| --- | --- | --- |
| Registry | `TEMPLATE_SECTIONS` | `RUNTIME_SECTIONS` |
| `source` label | `template` | `runtime` |
| Text comes from | statement modules under `src/system-prompt-builder/statements/` | the builder itself, or a `buildSystemPrompt` option |
| Lifetime | byte-stable for as long as the configuration is | changes within a session |
| Emission | one string, assembled by `assembleDefaultTemplate` | one string per section, banner added by `withSectionBanner` |

Both registries live in one file, `packages/coding-agent/src/system-prompt-builder/section-registry.ts`,
and its header states the same boundary in the terms the rows use:

> The `template` source label means the static provider-cache prefix assembled into the outer
> template slot. It does not mean prose is read from `prompts/session/system-prompt.md`.

That distinction matters when you read the code. `prompts/session/system-prompt.md` is a
zero-prose scaffold holding `{{templateSections}}`; a `template` section's words are in a
statement module, never in that file.

### Block 0: the six static sections

`TEMPLATE_SECTIONS` declares six rows, in the order the model reads them:

| id | Banner | Purpose |
| --- | --- | --- |
| `conventions` | none | the `<system-conventions>` preamble, everything before the first banner |
| `role` | `ROLE` | who the agent is |
| `runtime` | `RUNTIME` | workstation, tool inventory, memory |
| `tool-policy` | `TOOL POLICY` | tool rules, delegation, LSP/AST |
| `execution-workflow` | `EXECUTION WORKFLOW` | how work is carried out |
| `delivery-contract` | `DELIVERY CONTRACT` | output contract, personality |

`conventions` carries `name: null` because it is defined as whatever precedes the first
banner, so it has no banner of its own. None of the six is optional: if one does not render,
assembly broke, and `veyyon prompt --sections` exits 1 rather than reporting a small prompt.

### Blocks 1..n: the runtime sections

`RUNTIME_SECTIONS` declares four rows, in emission order:

| id | Banner | Source | Optional |
| --- | --- | --- | --- |
| `project` | `PROJECT` | computed | no |
| `shorthand` | `SHORTHAND` | option `argotPreamble` | yes |
| `shorthand-handles` | `SHORTHAND HANDLES` | option `argotHandles` | yes |
| `available-secrets` | `AVAILABLE SECRETS` | option `secretInventory` | yes |

Every runtime section carries a banner (`RuntimeSection.name` is `string`, not `string | null`),
so the same splitter and the same override vocabulary address a runtime section and a static
one identically.

## Computed against option-backed

A runtime row's `input` field says where its text comes from, and the two cases are not
interchangeable:

```ts
export type RuntimeSectionInput =
	| { readonly kind: "computed" }
	| { readonly kind: "option"; readonly key: string };
```

**Computed** means `buildSystemPrompt` produces the text itself. There is exactly one today,
`project`, and its text is the rendered `prompts/session/project-prompt.md`. The builder holds
a map keyed by the computed ids the registry derives:

```ts
// system-prompt.ts:1162
const computedText: Record<ComputedRuntimeSectionId, string | undefined> = {
	project: projectPrompt,
};
```

`ComputedRuntimeSectionId` is derived from the registry
(`Extract<RuntimeSectionEntry, { input: { kind: "computed" } }>["id"]`), so declaring a computed
row and forgetting to supply its text is a compile error at that object literal.

**Option-backed** means the caller hands the rendered text to `buildSystemPrompt`. That is how
every settings-gated section works: the caller reads the setting, renders the text, and passes
it, or passes nothing and the section does not appear. The registry declares the option key,
and the builder reads it *through* the registry rather than through a hand-written map:

```ts
// system-prompt.ts:1173
const runtimeText = (section: RuntimeSectionEntry): string | undefined =>
	isOptionBackedSection(section) ? options[section.input.key] : computedText[section.id];
```

Neither branch casts, and the registry header explains what the casts used to cost: an option
key that named no field read `undefined`, a section reclassified as computed missed the map and
read `undefined` too, and either way the section rendered nothing while the build stayed green.

`RUNTIME_SECTIONS` therefore ends in `as const satisfies readonly RuntimeSection[]` and not a
`: readonly RuntimeSection[]` annotation. The annotation widens `input.key` to `string`, which
turns "is this a real option field" back into a question nothing answers.
`system-prompt-section-derivation.test.ts` fails if the annotation comes back.

## Ordering rules

Four rules decide where text ends up, and they compose in this order.

**1. Registry position is section order.** `RUNTIME_SECTIONS` is walked in array order
(`system-prompt.ts:1183`), so a row's position in the array is its position in the prompt.
There is no separate order list to keep in step.

**2. A section cannot reach the model unregistered.** The loop only emits rows from
`RUNTIME_SECTIONS`, and `withSectionBanner` adds the banner from the row. A statement file or
an override file that contains banner-shaped text is rejected rather than becoming a second
section.

**3. Volatile last *inside* a section.** Section granularity is not the whole story: a section
whose own tail changes often should put that tail at the end. `project-prompt.md` records the
one case where this was got wrong, at lines 55-64:

> Volatile-last, and it must stay that way. `<workstation>` carries `Model:` and `Terminal:`,
> which change whenever the session switches model or runs under a different terminal. This
> block used to sit FIRST, ahead of `<context>`, so a single model switch changed byte one of
> the blob and invalidated the provider's prefix cache for everything behind it, including the
> user's AGENTS.md — 5,396 tokens re-prefilled to report a different model name.

The measured cost recorded there is 3-5s of re-prefill on the Kimi path, with a tail past 25s.

**4. `promptSectionOrder` permutes, but never across the block-0 boundary.** A harness model
profile may carry `promptSectionOrder` (`src/harness/model-profile.ts:26`), and
`applyPromptSectionOrderToParts` applies it to template and runtime sections from one list. It
refuses one thing: a runtime section can never move ahead of block 0.

```ts
// system-prompt-builder/prompt-sections.ts:206
const lastTemplateAt = order.findLastIndex(name => templateNames.has(name));
const crossing = order.filter((name, index) => runtimeNames.has(name) && index < lastTemplateAt);
```

The refusal is loud. A crossing request logs
`harness promptSectionOrder asks a runtime section to precede a static section; it will stay
after the cached prefix`, and an unknown name logs against the set of names that are actually
in the assembled prompt. Both used to pass in silence, which meant an eval arm that ordered
`["shorthand", "role", …]` ran the control and recorded it as the treatment.

Unlisted runtime sections keep registry order: the sort is stable and their rank is
`Number.POSITIVE_INFINITY`.

## How a block reaches a provider

The array is the interface. `context.systemPrompt` is `readonly string[]`, and every provider
maps it a different way. Verified per provider:

| Provider path | What each block becomes |
| --- | --- |
| `anthropic.ts` | one `system[]` text block, all in one request field |
| `amazon-bedrock.ts` | one `SystemContent` text block, plus `cachePoint` blocks |
| `openai-completions.ts` | one `system`/`developer` message per block, or all blocks joined by `\n\n` when `compat.supportsMultipleSystemMessages` is false |
| `openai-responses.ts` / `openai-shared.ts` | one `system`/`developer` input message per block |
| `openai-codex-responses.ts` | block 0 becomes `instructions`; blocks 1..n become developer messages |
| `google-shared.ts`, `google-gemini-cli.ts` | one `systemInstruction.parts[]` entry per block |
| `ollama.ts` | one `developer` message per block |
| `cursor.ts`, `gitlab-duo-workflow.ts` | all blocks joined into one string |

So "separate blocks" does not mean "separate messages" everywhere. It means separate
serialized parts, and on the two paths that place cache markers (Anthropic and Bedrock) it
means separately markable parts. What every path shares is that block 0 is a prefix: it is
serialized first, and nothing later can perturb its bytes.

`normalizeSystemPrompts` (`packages/ai/src/utils.ts:10`) is the shared front door. It coerces
to well-formed UTF-16 and drops blank entries, so an option-backed section that resolved to an
empty string costs nothing on the wire.

For which markers land on which block, read [Prompt caching](prompt-caching.md).

## Adding a section: where does it go

Work down this list and stop at the first match.

1. **Is it an instruction that is true for the whole configuration?** Then it is not a
   section at all. It is a **statement** inside one of the six static sections. Add a row to
   `statement-registry.ts` with its condition and put the text in a statement module. This is
   the common case, and [System prompt customization](../system-prompt-customization.md#13-statements-the-prompt-is-a-list-not-a-document)
   is the procedure.
2. **Does its text change during a session?** Then it is a runtime section. It must be its own
   block, or it invalidates block 0 every time it changes.
3. **Does the builder already have the inputs?** Then it is `computed`: add the row with
   `input: { kind: "computed" }`, and the compiler will demand its entry in `computedText`.
4. **Does a setting decide it, or does the caller render it?** Then it is
   `input: { kind: "option", key: "…" }`. The key must name a real `BuildSystemPromptOptions`
   field, and a production caller must populate it: `sdk.ts` is that caller for every shipped
   option-backed section, and the wiring test exists because a section whose option was
   declared and threaded but never populated compiled, shipped, and rendered nothing forever.
5. **Can the feature be off?** Then `optional: true`, so an absent section reads as a
   configuration rather than as a broken assembly.

Two judgement calls the registry has already made, so you can calibrate against them:

- `project` is deliberately **one** section, not several. It carries the environment framing,
  the cwd, the context files, the workspace tree and the active-repo-context clause. Splitting
  the last one out meant two things to remember on a working-directory change; exactly one got
  remembered, which is how the prompt kept describing the previous project after a `/cd`.
- `shorthand` and `shorthand-handles` are deliberately **two** sections, though they are one
  feature. Teaching the notation with no handle table is the inert case, and an eval has to be
  able to run it as its own arm to tell "the model ignored available handles" from "there were
  no handles".

The pattern: split when the two halves are separately *meaningful*, merge when they share an
input, a lifetime and an invalidation.

## Inspecting a real prompt

`veyyon prompt` assembles against your real configuration and writes nothing.

```sh
veyyon prompt                    # the assembled prompt, block markers included
veyyon prompt --sections         # cost per section, largest first
veyyon prompt --section project  # one section's text
veyyon prompt --statements       # cost per rule, plus every rule this config leaves out
veyyon prompt --statement tool-policy/lsp
veyyon prompt --json             # the same breakdown, machine readable
veyyon prompt --no-tools         # assemble with no tools, to find tool-gated text
veyyon prompt --prompts          # every registered prompt, not just this one
veyyon prompt --cwd ./other-project
```

The bare dump separates blocks with `# ---- system prompt block N ----`
(`cli/prompt-cli.ts:253`) rather than concatenating them, because the boundary is the caching
contract and hiding it would misrepresent what is sent.

`--sections` reports a `block` column, which is exactly the array index this page is about:

```
section             source    block    bytes   tokens  share
project             runtime       1    23191     5798   62.2%
tool-policy         template      0     4406     1102   11.8%
```

A `template` row is always block 0. A `runtime` row is never block 0. If you ever see
otherwise, the boundary has been broken.

Exit codes carry one fact: a **required** section that did not render exits 1
(`cli/prompt-cli.ts:135`), and everything else exits 0, so `--sections` works as a script
check. `--json` reports the same in a `missing` array that is present even when empty.

The handbook's [Execution-order prompts](../handbook/src/models/prompts.md#seeing-every-prompt)
page is the operator-facing version of this section.

## The two escape hatches, and why they are env vars

`VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS` replaces whole sections and
`VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS` replaces or ablates individual statements. Both are
benchmark instruments: they have no config key, no CLI flag, and no
`BuildSystemPromptOptions` field, because a config-reachable prompt override could silently
contaminate a production run and a contaminated eval reports a number that looks valid. Both
fail closed when absent and `logger.warn` loudly when active
(`system-prompt.ts:620-683`). A malformed payload throws rather than reverting to the
production prompt.

Neither combines with `--system-prompt`: a custom prompt has no banner sections to override,
so asking for both is an error rather than a silent choice between them
(`system-prompt.ts:1105-1115`). Statement overrides also refuse to combine with a whole-section
replacement for the same section, because the replacement would discard the statement arm.

## Known limitations

- **`applyPromptSectionOrderToParts` reorders parts, not the fact that block 0 is one part.**
  There is no way to split the static prefix into two cacheable blocks, so a configuration
  where one static section changes far more often than the other five cannot be expressed. In
  practice the static sections change only when settings change, so this has not bitten.
- **Section-level volatility is declared by hand.** Nothing checks that a `template` section
  is actually byte-stable. Putting session-varying text into a statement module compiles,
  ships, and quietly invalidates block 0 on every turn. The only signal is a cache verdict
  after the fact, and only on Anthropic (see [Prompt caching](prompt-caching.md)).
- **One computed section.** `ComputedRuntimeSectionId` is a union of exactly one id today, so
  the machinery that keeps computed rows honest has one instance proving it.

## Where the code is

| Concern | File |
| --- | --- |
| Assembly, block array, eval overrides | `packages/coding-agent/src/system-prompt.ts` |
| Both section registries | `src/system-prompt-builder/section-registry.ts` |
| Banner grammar | `src/system-prompt-builder/banner-grammar.ts` |
| Splitting and reordering | `src/system-prompt-builder/prompt-sections.ts` |
| Statement registry and statement text | `src/system-prompt-builder/statement-registry.ts`, `src/system-prompt-builder/statements/` |
| Gate resolution shared by session and inspection | `src/system-prompt-builder/gate-inputs.ts` |
| Inspection model | `src/system-prompt-builder/prompt-inspect.ts` |
| `veyyon prompt` | `src/cli/prompt-cli.ts`, `src/commands/prompt.ts` |
| The project footer template | `src/prompts/session/project-prompt.md` |
| The zero-prose outer scaffold | `src/prompts/session/system-prompt.md` |
| Per-model section order | `src/harness/model-profile.ts` |

*Verified against `27538ffb` on 2026-08-05.*
