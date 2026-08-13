# System Prompt Customization

How the coding-agent assembles the system prompt sent to the model, and what you can control.

The system prompt is ASSEMBLED. It is composed from the section registry and from statements gated on your settings; there is no file on disk holding its text for you to edit. `PROMPT_SECTIONS/` is how you change what a section says, per statement and validated. `--system-prompt` remains for a caller that supplies its own prompt for one invocation (the SDK, an eval harness).

This page is the operator-facing surface: the inputs, the override mechanisms, and the gates. For the implementation side of the same subsystem, the block/tier model, the ordering rules, and how to decide where a new section belongs, see [System prompt architecture](internal/system-prompt-architecture.md), and for how the cached prefix is marked on the wire see [Prompt caching](internal/prompt-caching.md).

Veyyon no longer reads a `SYSTEM.md` or `APPEND_SYSTEM.md` file from disk.

`SYSTEM.md` replaced the whole assembled prompt with hand-written text. `APPEND_SYSTEM.md` added text to the end of it, which is what `AGENTS.md` already does, at more scopes and with a directory walk-up that `APPEND_SYSTEM.md` never had. Both were discovered out of any repository you entered, and a new profile copied them along under a checkbox labelled `AGENTS.md`.

To add instructions, write them in `AGENTS.md`. To change what a section of the prompt says, use `PROMPT_SECTIONS/`. If either removed file is still on disk, veyyon names it at launch and points at the replacement rather than ignoring it in silence.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`)
- `packages/coding-agent/src/main.ts` (resolves the two prompt flags; there is no file discovery for either)
- `packages/coding-agent/src/prompts/<directory>/rows.ts` (the prompts one directory owns, each with its id and purpose) and `packages/coding-agent/src/prompts/registry.ts` (which aggregates all of them)
- `packages/utils/src/prompt-registry.ts` (what a registry IS: the row shape, `definePromptRegistry`, and `requirePromptFrom`, the one lookup that refuses an unknown id)
- `packages/coding-agent/src/system-prompt-builder/banner-grammar.ts` (what a banner IS for every prompt: how one is written, how one is recognised, and `splitBanneredDocument`, the one parser that cuts a prompt at its banners)
- `packages/coding-agent/src/system-prompt-builder/section-registry.ts` (the section registry: which sections exist, their banners, and their order)
- `packages/coding-agent/src/system-prompt-builder/prompt-sections.ts` (the system prompt's own section names and the reordering a harness profile asks for)
- `packages/coding-agent/src/prompts/session/system-prompt.md` (zero-prose outer scaffold containing only `{{templateSections}}`)
- `packages/coding-agent/src/prompts/session/custom-system-prompt.md` (the base template a caller-supplied prompt switches to)
- `packages/coding-agent/src/prompts/session/project-prompt.md` (project/environment footer)
- `packages/coding-agent/src/utils/host-environment.ts` (the workstation rows that footer renders: OS, kernel, arch, CPU, GPU, terminal)

## Where prompts live

A package owns its own prompts. Each package that ships any keeps them under its own `src/prompts/` directory with a `registry.ts` beside them, and that registry is the only module allowed to import one:

| Package | Prompts directory | What is in it |
|---|---|---|
| `@veyyon/coding-agent` | `packages/coding-agent/src/prompts/` | the system prompt, the subagent prompt, tool descriptions, and every turn the agent takes on its own behalf |
| `@veyyon/agent-core` | `packages/agent/src/prompts/` | compaction: summarizing a session, branch summaries, handoff documents |
| `@veyyon/ai` | `packages/ai/src/prompts/` | one format guide per tool-call dialect, plus the tool-catalog template that carries them |
| `@veyyon/hashline` | `packages/hashline/src/` | the hashline patch language, which is the edit tool's description |
| `@veyyon/metaharness` | `packages/metaharness/adapters/edit/prompts/` | the edit benchmark's task, system, and retry prompts |

An id is the file's path under its registry's directory without the `.md`, so `turn-control/auto-continue` is `packages/coding-agent/src/prompts/turn-control/auto-continue.md` and `dialect/gemma` is `packages/ai/src/prompts/dialect/gemma.md`. Ids are unique across the registries, so you never have to name the package to ask about a prompt. `@veyyon/hashline` is the one package whose prompt is not under a `prompts/` directory: its single file is published at `@veyyon/hashline/prompt.md` for anyone embedding hashline in their own agent, so moving it would break a public subpath.

To find a prompt, read the registry or run `veyyon prompt --prompts`, which lists every id in the four product registries under its directory, with a line saying what it is for. The benchmark harness's prompts are not listed there: they are asked by a measurement tool rather than by the agent.

The registries are the whole set by construction, not by anyone remembering to add a row. The import is the registration, so a prompt file with no row is unreachable code, and `prompt-registry-coverage.test.ts` fails if the set on disk and the set in a registry disagree in either direction, or if any module outside a registry imports a `.md` as text.

A registry is one `definePromptRegistry(dir, rows)` call, and the descriptor it returns is what other code takes. That matters for the same reason the rest of this section does: the directory is stated once, in that call, and `veyyon prompt`, the coverage suite and the generated inventory read it off the descriptor instead of each writing the path again. They used to write it again, and the inventory's copy had gone stale, listing three directories while claiming one per package. The same test fails if a directory is written down twice.

A descriptor gives you `dir`, `prompts`, `ids`, `text(id)`, `require(id)`, `has(id)` and `fileFor(id)`. Use `prompts["some/id"].text` where the id is a literal, since that is checked at compile time; use `require(id)` where the id comes from a variable, because it throws on an unknown one rather than handing back a prompt with no text.

---

## 1) Inputs

Two user-controllable inputs feed prompt assembly. Each resolves as either a literal string or, if the argument names a readable file, the contents of that file (`resolvePromptInput`).

A value that fails to read is an error when it has no spaces and either contains a path separator or ends in a prompt-file extension (`.md`, `.markdown`, `.txt`, `.text`, `.prompt`). `--system-prompt ./promtps/main.md` names the path and the reason rather than quietly using the string `./promtps/main.md` as your whole system prompt. Prompt text is unaffected: a one-line prompt containing a slash, or ending in a dotted word, is used as written. To pass text that would otherwise read as a path, put it on more than one line, since no path contains a newline.

| Input | Source | Effect |
|---|---|---|
| `--system-prompt <text-or-file>` | CLI flag | Replaces block 0: the default stable instructions. Highest precedence. |
| `--append-system-prompt <text-or-file>` | CLI flag | Adds a prompt block. Without a custom system prompt it goes after all default blocks; with one it goes after the custom block and before the preserved project/environment footer. |

Both are per-invocation flags, for a caller that supplies its own prompt for one run: the SDK, an eval harness, a benchmark adapter. Neither has a file on disk that veyyon discovers on your behalf.

Neither flag is discovered from a file, so there is no precedence list to learn and no path where a repository you enter supplies prompt text. Instruction files still work the way they always have: `AGENTS.md` is discovered from the global location, the active profile, and every directory walked up from the working directory to the repository root, and it is inlined into the prompt. See [`docs/config-usage.md`](./config-usage.md) for the discovery contract.

---

## 2) Replace vs. append

Normal CLI startup resolves the two flag values, then hands them to prompt assembly in `packages/coding-agent/src/main.ts`:

```ts
export function applyResolvedSystemPromptInputs(
  options: CreateAgentSessionOptions,
  resolvedSystemPrompt: string | undefined,
  resolvedAppendPrompt: string | undefined,
): void {
  if (resolvedSystemPrompt) {
    options.customSystemPrompt = resolvedSystemPrompt;
  }
  if (resolvedAppendPrompt) {
    options.appendSystemPrompt = resolvedAppendPrompt;
  }
}
```

`buildSystemPrompt` in `packages/coding-agent/src/system-prompt.ts` then selects the base template:

- No custom prompt: statement modules assemble every stable instruction section. The section registry supplies section identity, order, and banners. The zero-prose `system-prompt.md` scaffold contributes only the `{{templateSections}}` slot.
- Custom prompt present: the base switches to `session/custom-system-prompt.md`, which renders your custom text plus the append prompt, context files, discovered skills, always-apply rules, and rules. The stable statement modules, tool inventory, and default workflow guidance are not rendered.

In both cases the dynamic project/environment footer from `project-prompt.md` still renders after the base template. It includes workstation information, the active profile name, the agent and skills directories, the global and profile `AGENTS.md` paths, the directory-context list, workspace tree, date, and cwd. With a custom prompt the footer omits context files and the append prompt because the custom template already rendered them.

Consequences for normal CLI use:

- Passing `--system-prompt` replaces the stable default instructions and tool inventory. Context files, skills, always-apply rules, and rules are kept (the custom template renders them), and the dynamic project/environment footer remains.
- Passing `--append-system-prompt` without a custom system prompt appends your text after the default instructions.
- Passing both produces: custom system prompt text, append prompt text, then the kept skills/rules/context files and the dynamic project/environment footer.

For everyday use you want neither flag. To add instructions, write `AGENTS.md`. To change what one section says, use `PROMPT_SECTIONS/`.

---

## 3) Templating contract

**Contents of `--system-prompt` and `--append-system-prompt` are treated as plain text.** They are resolved before prompt-block replacement and are not rendered as Handlebars templates.

An explicitly supplied empty or whitespace-only custom prompt is still a replacement. It does not
fall back to the shipped statements. If it renders no base content, Veyyon omits the empty provider
block and keeps the dynamic project footer.

The built-in prompt templates are Handlebars (`packages/utils/src/prompt.ts`), but user-provided strings are not compiled with that renderer. The assembler inserts each resolved flag value into a Handlebars parent template as a string. Handlebars does not recursively render substituted text. Concretely:
```handlebars
{{! parent template, handled by Handlebars }}
{{customPrompt}}
```

If the value passed to `--system-prompt` contains:

```handlebars
Working in {{cwd}} on {{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

the rendered output contains those characters verbatim, `{{cwd}}`, `{{#if hasMemoryRoot}}`, etc. are NOT substituted. They will be shown to the model as literal Handlebars syntax.

This is by design. The internal template variables (`cwd`, `date`, `environment`, `workspaceTree`, `skills`, `rules`, `toolRefs`, `hasMemoryRoot`, `hasObsidian`, `mcpDiscoveryServerSummaries`, ...) are not a supported public surface, they change between releases as the prompt is rewritten, and they would couple user configs to internals. Treat them as private.

There is no supported public templating surface for a caller-supplied prompt. Write plain text (or markdown) only.

---

## 4) Recommended patterns

### "Tweak the default": keep default, add a few rules

Write an `AGENTS.md`. The default instructions and the project footer stay intact, and your text is inlined into the prompt with the other context files. This is the everyday answer, and it needs no flag.

```text
# ~/.veyyon/profiles/default/agent/AGENTS.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

An `AGENTS.md` beside the code applies to that project; the one in your profile applies to every session in that profile; the global one applies everywhere. All of them are discovered for you.

### "Replace the stable default instructions": bring your own base prompt

Pass `--system-prompt`. You replace the stable default instructions in block 0, but startup still preserves the dynamic project/environment footer block (`project-prompt.md`): workstation info, context files, dir-context list, workspace tree, current date, cwd, and related project context.

```console
$ veyyon --system-prompt ./reviewer-prompt.md
```

There is no file veyyon picks up on its own for this. A prompt that replaces the whole assembly is a per-invocation decision by a caller who wants exactly that, not a setting that follows you into every session.

Reach for this only when you want a genuinely different base prompt. If you are keeping most of the default and changing one part, use `PROMPT_SECTIONS/` instead (section 8): it edits a single section and leaves the rest as shipped, so you do not have to maintain a copy of the default tool guidance, exploration rules, or workflow rules.

### "Customize while keeping the tool inventory and default workflow guidance"

Use `AGENTS.md`, not `--system-prompt`. The tool inventory, role guidance, and default exploration and workflow rules come from statement modules in `src/system-prompt-builder/statements/`. A custom system prompt switches to `session/custom-system-prompt.md`, so those default statements are not available to the model.

A custom system prompt still keeps the generated project content: `session/custom-system-prompt.md` renders context files, discovered skills, always-apply rules, and rules alongside your text, and the `project-prompt.md` footer still carries workstation info, the workspace tree, the current date, and cwd.

If you wanted a full replacement only to change one part, use `PROMPT_SECTIONS/` (section 8). It replaces or appends to one registry section and keeps every other statement module.

### "Customize automatic session titles"

The system prompt does not affect the model call that names a new session. Create the title-specific prompt file instead:

```text
# ~/.veyyon/profiles/default/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message carries no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` is discovered project-first, then user, across the config bases. It is a prompt for a side call that names a session, not the agent's own system prompt, which is why it is still a file. When absent, Veyyon uses the bundled `title-system.md` / `tiny-title-system.md` prompts. When present, both the online title path and the local tiny-model path keep the `<title>...</title>` wrapper while using this file as the system turn.

### "Replace everything, including project context": SDK-only

The CLI flag path intentionally preserves `defaultPrompt.slice(1)`. Code using `CreateAgentSessionOptions.systemPrompt` directly can return a full replacement array and omit the project footer, but that is not what `--system-prompt` does.

### "Change one section of the default instructions, keep the rest"

Use `PROMPT_SECTIONS/`, described in section 8. Put your text in `PROMPT_SECTIONS/<section>.append.md` to add to a section, or `PROMPT_SECTIONS/<section>.md` to replace it. Every other section stays exactly as shipped, including the generated skills, rules, and tool guidance, so this is the option to reach for whenever you want to change one thing rather than own the whole prompt.

Run `veyyon prompt --sections` to see the section names for your configuration.

---

## 5) Deduplication

A custom base and an append value are each rendered once. `dedupeAlwaysApplyRules` also omits an always-apply rule when its body already appears verbatim in the custom base, append value, or a loaded context file.

---

## 6) Discovery paths

Veyyon does not discover a whole-prompt replacement or append file. Both whole-prompt inputs are flags. Persistent `PROMPT_SECTIONS/` files remain discoverable because each file targets one validated assembled section instead of bypassing assembly.

The instruction files that ARE discovered are a different mechanism, and they still walk the tree: `AGENTS.md` is read from the global location, from the active profile's agent directory, and from every directory between the working directory and the repository root. See [`docs/config-usage.md`](./config-usage.md).

---

## 7) Quick reference

| Goal | Use |
|---|---|
| Add an instruction on top of the full default prompt | `AGENTS.md` (profile, global, or beside the code) |
| Change one section and keep the rest | `PROMPT_SECTIONS/<section>.append.md` (see section 8) |
| Replace the stable default instructions for one run | `--system-prompt` |
| Append text for one run | `--append-system-prompt` |
| Customize automatic session titles | `TITLE_SYSTEM.md`; the agent's own prompt does not affect title generation |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Caller-supplied prompts are inserted verbatim. |
| See the prompt a configuration actually produces | `veyyon prompt` (see section 9) |
| Change instructions per repository | An `AGENTS.md` in that repository |
| Change instructions everywhere | The global `AGENTS.md`, or the one in your profile's agent directory |

---

## 8) Changing one section: `PROMPT_SECTIONS/`

`--system-prompt` replaces the stable default template. The generated project footer, context files, discovered skills, and rules remain, but the tool inventory, default workflow guidance, and settings-gated default sections do not render. If you only want to add a rule or reword one part, use the narrower mechanism.

`PROMPT_SECTIONS/` changes one section and leaves the others exactly as shipped.

The default template is a sequence of named sections. To see the names for your configuration, run:

```
veyyon prompt --sections
```

Put a file named after a section in a `PROMPT_SECTIONS/` directory under the active profile's agent dir:

```
~/.veyyon/profiles/default/agent/PROMPT_SECTIONS/    # default profile
~/.veyyon/profiles/<name>/agent/PROMPT_SECTIONS/     # named profile
```

The active profile is the only location. A repository's `.veyyon/PROMPT_SECTIONS/` used to be read and could replace a shipped section outright; a working tree no longer contributes prompt sections.

Two filename forms decide what happens:

| File | Effect |
|---|---|
| `<section>.append.md` | Your text is added at the end of that section. The shipped text stays, including anything added to it in a later release. |
| `<section>.md` | Your body text replaces that section. The section registry adds the canonical banner. |

Prefer append. It survives upgrades, because the shipped section is reused rather than copied.

To add a rule to the delivery contract:

```
# ~/.veyyon/profiles/default/agent/PROMPT_SECTIONS/delivery-contract.append.md
Always include the exact command you ran when you report a test result.
```

Everything else in the prompt is untouched. Overriding one section never changes another, and never disables a setting-gated block in a different section.

A few rules worth knowing:

- A file naming a section that does not exist is an error, not a no-op. The message lists the valid names. A typo that silently did nothing would leave you believing a change was live when it was not.
- Section names are the ids `veyyon prompt --sections` prints: `conventions`, `role`, `runtime`, `tool-policy`, `execution-workflow`, `delivery-contract`. The `systemPrompt.sectionOverrides` config key accepts the same ids, and also accepts the camelCase spelling (`toolPolicy`) that the SDK uses for its property names. Both reach the same section, so you can use the id everywhere and never think about the difference.
- Replacement and append files contain section body text only. Do not copy any registered `NAME` and `==============` banner into the file. The section registry adds the target section's canonical banner, and rejects any banner-shaped text that could manufacture a second section. An empty or whitespace-only append file is a no-op.
- `PROMPT_SECTIONS/` cannot be combined with `--system-prompt`. A custom prompt has no sections to override, so asking for both is an error rather than a silent choice between them.
- A directory that is not there means you have no overrides, and that is the ordinary case. A directory that IS there and cannot be read is an error naming the path and the reason, as is a file inside it that cannot be opened. Both would otherwise run the shipped prompt while your files sat on disk looking applied.

---

## 9) Seeing the prompt: `veyyon prompt`

`system-prompt.md` is a zero-prose scaffold containing only `{{templateSections}}`. It is not a useful way to inspect instructions. The text comes from statement modules, and conditions depend on the active tools, settings, workspace, and model.

`veyyon prompt` prints the assembled prompt for your current configuration, without starting a session.

```
veyyon prompt                 # the full assembled prompt
veyyon prompt --sections      # a size breakdown, largest section first
veyyon prompt --section role  # one section's text
veyyon prompt --json          # the same breakdown, machine readable
veyyon prompt --no-tools      # assemble with no tools
veyyon prompt --tools         # what each active tool description and schema costs
```

`--sections` answers "what is taking up my prompt":

```
section             source    block    bytes   tokens  share
project             runtime       1    23191     5798   62.2%
tool-policy         template      0     4406     1102   11.8%
delivery-contract   template      0     4053     1014   10.9%
```

The `source` column describes the provider-cache source class. `template` means a static statement-assembled section in block 0. It does not mean prose comes from `system-prompt.md`. `runtime` means a separately emitted section computed from workspace or session state.

Under the table you get the sections that are NOT in this prompt:

```
not in this prompt:
  shorthand          optional  the shorthand notation block, taught when the encode gate is open
  shorthand-handles  optional  the handle table for loaded projects
```

This is the difference between a prompt that is small and one that is broken. An `optional` section is absent because its feature is off, which is ordinary. A `REQUIRED` section is absent because assembly failed, and the command says so and exits 1:

```
1 REQUIRED section did not render (role). This prompt is incomplete, not minimal.
```

Every other exit is 0, so `veyyon prompt --sections` works as a check in a script. `--json` carries the same information in a `missing` array, present even when empty.

The `block` column is the index of the part in the ordered array `buildSystemPrompt` returns. Block 0 is the static prefix that providers cache; later blocks hold text that changes often. Each provider serializes those parts its own way (Anthropic sends them as separate `system` text blocks, most OpenAI-wire paths as separate system or developer messages, Gemini as separate `systemInstruction` parts), so a block is a separate *part*, not necessarily a separate message. Moving content from a later block into block 0 would break the cache, which is why the breakdown reports the boundary rather than hiding it. See [System prompt architecture](internal/system-prompt-architecture.md) for the per-provider mapping.

`--no-tools` is useful for finding tool-gated text: run it, diff against the normal output, and every line that disappeared was behind a tool being available.

Use `--json` to compare two configurations mechanically, for example to check that a settings change altered only the section you expected.

### The other prompts

The system prompt is not the only prompt a model receives. Delegated tasks run under a subagent prompt, and there are separate prompts for summarizing a session, naming it, writing a commit message, classifying a turn, teaching a model how to write a tool call, and more. List them with:

```
veyyon prompt --prompts
```

Then look at one:

```
veyyon prompt --prompt subagent/system-prompt
```

That reports the prompt's sections and which of them are optional, so you can tell a subagent prompt that rendered three of its five sections because the task had no plan and no worktree from one that lost two sections to a bug.

Most of these prompts are a single region with no internal structure, and they report one `body` section. The subagent prompt has five: `role`, `context`, `plan`, `coop`, and `completion`.

The list is grouped by the directory each prompt lives in, and the lookup spans all four groups, so `veyyon prompt --prompt compaction/summarization-system` and `veyyon prompt --prompt dialect/gemma` work the same way as one from the coding agent's own tree. A mistyped id is refused with the nearest registered id quoted back, rather than printing an empty description that would read as a prompt with nothing in it.

---

## 10) Adding a section (contributors)

The sections above are data, not code. `section-registry.ts` holds two registries, and everything else about a section is derived from its row there.

`TEMPLATE_SECTIONS` describes the static cached-prefix sections assembled from statements. `RUNTIME_SECTIONS` describes separately emitted sections, and each runtime row says where its text comes from:

```ts
{ id: "project", source: "runtime", name: "PROJECT",
  input: { kind: "computed" }, purpose: "..." }

{ id: "shorthand", source: "runtime", name: "SHORTHAND",
  input: { kind: "option", key: "argotPreamble" }, purpose: "..." }
```

`computed` means `buildSystemPrompt` produces the text. `option` means a caller passes it in under the named key, which is the shape a settings-gated preamble takes: the setting is read in `sdk.ts`, and the option carries the rendered text.

Adding one is two edits.

First, add the id to `RUNTIME_SECTION_IDS` and a row to `RUNTIME_SECTIONS`:

```ts
{
    id: "house-style",
    source: "runtime",
    name: "HOUSE STYLE",
    input: { kind: "option", key: "houseStylePreamble" },
    purpose: "the project's writing conventions, when the setting is on",
    optional: true,
}
```

A row declares the banner's NAME, never the rendered banner. `banner-grammar.ts`
owns the `=` underline for every prompt in the product, so a section cannot ship a
width of its own: `renderBanner` writes one, `leadingBannerName` reads one back, and
`bannerTable` turns a set of rows into the table a splitter is driven by. Anything
that needs to know what a banner looks like asks that module rather than spelling
the rule out again.

The row's own fields (`id`, `name`, `purpose`, `optional`) come from `PromptSection`
in `packages/utils/src/prompt-registry.ts`. `TemplateSection` and `RuntimeSection`
extend it with the two things only the system prompt needs, `source` and `input`, and
every other registry uses it as it is. The grammar and the row shape are separate
because they answer separate questions: the grammar decides what the bytes look like,
the row states what a section claims about itself.

`optional` says whether the section may be absent, and it is checked rather than
believed. A settings-gated section is `optional: true`, because it disappears when
its setting is off. Mark one `false` and it must render from the barest options the
builder accepts; mark one `true` and it must be absent until its input is supplied.
`system-prompt-section-presence.test.ts` holds both directions, so the flag cannot
become a comment that stopped being true.

Second, declare that key on `BuildSystemPromptOptions` in `system-prompt.ts`:

```ts
/** The house-style preamble, present when the `houseStyle` setting is on. */
houseStylePreamble?: string;
```

That is the whole change. The assembler reads the registry, so it needs no edit: the section is emitted in registry order, under its own banner, and omitted entirely when the option is absent rather than rendered as a bare heading.

Four mistakes are caught rather than shipped. Three are compile errors:

- Naming an option that is not a field of `BuildSystemPromptOptions`. The error names the offending key.
- Declaring the field as something other than a string.
- Marking the section `computed` without giving `computedText` an entry for it.

Two more are test failures rather than compile errors, because no type can see them. Declaring an option and never setting it in `sdk.ts` leaves the section permanently empty; `system-prompt-wiring.test.ts` fails if a declared option has no production caller. And getting `optional` wrong in either direction fails `system-prompt-section-presence.test.ts`.

Two things are worth knowing before you edit `section-registry.ts`.

`RUNTIME_SECTIONS` ends in `as const satisfies readonly RuntimeSection[]` rather than carrying a `: readonly RuntimeSection[]` annotation. The annotation typechecks and reads better, and it silently disables every check above: it widens `input.key` to `string`, so "is this a real option field" starts accepting anything. `system-prompt-section-derivation.test.ts` fails if the annotation comes back.

Position is the row's position in the array. There is no separate order list to keep in step, and `promptSectionOrder` permutes template and runtime sections together from the same list, so a new runtime section is reorderable by a harness profile with no extra wiring.

A runtime section lands in its own entry of the returned `string[]`, outside block 0. Block 0 is the byte-stable prefix a provider caches, and `system-prompt-cached-prefix-stability.test.ts` records its digest: adding a runtime section leaves that digest alone, and a change that moves text into the prefix fails there with the section named.

---

## 11) Adding a prompt (contributors)

Drop the `.md` under the directory that matches WHEN it fires, add its import and its row to that directory's `rows.ts`, and use it through that module. That is the whole procedure, and each step is checked:

```ts
// packages/coding-agent/src/prompts/turn-control/rows.ts
import turnControlAutoContinue from "./auto-continue.md" with { type: "text" };

export const turnControlPrompts = {
	"turn-control/auto-continue": {
		text: turnControlAutoContinue,
		purpose: "continues a turn the model ended without finishing",
	},
	// ...
} satisfies Record<string, PromptEntry>;
```

Read it back from the same module:

```ts
import { turnControlPrompts } from "../prompts/turn-control/rows";

const text = turnControlPrompts["turn-control/auto-continue"].text;
```

The import is the registration, so there is nothing else to remember. A file with no row is unreachable code rather than a prompt that quietly ships unlisted, and `prompt-registry-coverage.test.ts` fails if the directory and the rows disagree in either direction.

`prompts/registry.ts` aggregates all twenty-one row modules into `PROMPTS`, which is still the aggregate every cross-directory consumer takes, and `PromptId` is still the union of every id. Prefer the row module: it is the reason the rows are split at all. The registry held all 163 `.md` imports itself, so importing it for one string reached all 163 prompt modules, which cost the file-reading tool 167 modules for its own description. Reach for the aggregate when a module genuinely spans directories, or when the id is not known statically and you need `requirePrompt`.

The `satisfies` clause is not decoration. An annotation (`: Record<string, PromptEntry>`) typechecks and widens every key to `string`, and `PromptId` then accepts any string: a typo compiles and renders as the empty prompt.

Three things that suite will refuse, each because it has happened:

- **Importing a `.md` outside a registry.** Registration would go back to being optional, and the registry back to being an incomplete list that looks authoritative. A relative path into another package's prompts tree is refused even for a file that is otherwise fine to read, because it records that package's layout a second time.
- **Writing a prompts directory down twice.** Consumers read `dir` off the descriptor. Four of them used to type the path themselves and one had gone stale.
- **A row whose `purpose` says nothing.** The purpose is what makes the registry a list a person can read instead of a directory listing with extra steps.

If you are adding the first prompt to a package that has none, give it a `src/prompts/registry.ts` of its own rather than reaching into another package's. Rows per directory are worth it once a registry is large enough that a consumer of one prompt paying for all of them matters; the other three packages hold their rows in the registry itself. A package owns its prompts; sharing the row SHAPE is what `@veyyon/utils` is for.

---

## 12) Settings that change the prompt

### The rule: policy is a setting, not a sentence

The outer `system-prompt.md` scaffold holds no policy, prose, conditions, or banners. Anything that decides **what the model should do** belongs to a setting and a statement row. Put whole-statement presence conditions in `statement-registry.ts`. Put wording-level Handlebars variables inside that statement's Markdown module.

The failure this rule exists to prevent is concrete. The delegation section used to carry a
literal category list:

> "...multi-file changes, refactors, new features, tests, **investigations** — MUST be
> decomposed and delegated."

An audit is an investigation, so the prompt instructed the model to delegate audits, in every
session, whether or not an agent suited to that work existed. That policy was invisible in
`/settings`, unaffected by the Agents table, and only findable by reading the template. It was
not a wording problem: a hardcoded list cannot follow a setting, so it was wrong in every
session that did not happen to match it.

The check to apply when writing template text:

| Kind of text | Belongs in the template? |
|---|---|
| Structure: headings, ordering, the shape of a list | Yes |
| A fact about this session (`{{cwd}}`, the tool names, the concurrency cap) | Yes, as a variable |
| A behavior a setting decides | No — a `{{#if}}` on that setting's gate |
| A behavior nothing decides, stated as a rule the operator cannot see or change | No — make it a setting first |

For delegation this means the template never names what is delegable. The enabled agents are
the instruction: `subagentNames` and `hasSubagentSpecialists` carry the operator's answer, and
the template reads them. Enabling `reviewer` is how an operator says reviews are delegable
here, so nothing needs to say it in prose.

### The gates

Some of the prompt's text is decided by a setting. The IRC coordination clause appears only
when the session can still spawn subagents, the delegation section changes wording with
`subagent.delegation`, and the personality block disappears when `personality` is `none`.

Those settings are listed in one place,
`packages/coding-agent/src/system-prompt-builder/gate-registry.ts`. Each row records the
setting path, the template variables it decides, one line on what the model sees change, and
whether flipping it reaches a running session.

### Live and frozen gates

A **live** gate takes effect when you change it. The settings UI rebuilds the system prompt
from the registry, so the model sees the new text on its next request. These are live today:

| Setting | What changes in the prompt |
| --- | --- |
| `personality` | the personality block, or nothing when set to `none` |
| `tui.renderMermaid` | whether the model is told Mermaid fences render as terminal diagrams |
| `subagent.enabled` | the whole Delegation section, which is absent when subagents are off |
| `subagent.delegation` | whether the section asks for delegation, and whether it uses MUST/ONLY wording |
| `subagent.batch` | which call shape the delegation guidance teaches |
| `subagent.maxConcurrency` | the concurrency limit quoted in that guidance |
| `subagent.maxNestedSpawnDepth` | the IRC coordination clause, present only when this session can spawn |
| `subagent.agents` | which specialists delegation prose names |
| `includeModelInPrompt` | whether the active model is surfaced in the workstation block |
| `tools.format` | whether tools are described inline or left to the provider's tool list |
| `inlineToolDescriptors` | whether descriptors live in the prompt or provider schemas for the active model |
| `tools.intentTracing` | whether the prompt explains the intent field, and whether tool schemas carry it |

`tools.intentTracing` and `inlineToolDescriptors` also decide provider schema shape. When intent
tracing is on, every tool schema sent to the model carries an extra `intent` field and the prompt
explains it. Descriptor placement sends full descriptions in exactly one place. In `auto` mode,
Gemini receives them inline while other native tool-calling models receive them in their schemas.
The agent resolves both settings on every request, so a model switch rebuilds the prompt and updates
the schemas together.

A **frozen** gate is read once at session start, so changing it mid-session saves the new value and
leaves the prompt as it was. The settings screen tells you when a change applies on the next session.
One gate remains frozen:

| Setting | Why |
| --- | --- |
| `includeWorkspaceTree` | read into a session constant before the prompt builder is defined |

### What a gate is worth when nobody says

`buildSystemPrompt` takes every gate as an optional argument, so a caller can omit all of them.
That is what the SDK does when it builds a prompt outside a session, and what tests do. The
fallbacks live in one table, `OMITTED_GATE_DEFAULTS` in
`packages/coding-agent/src/system-prompt-builder/gate-inputs.ts`, and the builder reads them from
there rather than repeating a value next to each argument.

An omitted gate means the caller has no configuration to offer, so the gate renders off or empty.
That is not the same as a default session, and on four gates it is deliberately different:

| Gate | Omitted | A default session |
| --- | --- | --- |
| `eagerTasks` | `false`, no delegation ask | `true`, because `subagent.delegation` ships as `preferred` |
| `taskIrcEnabled` | `false`, no coordination clause | `true`, because the recursion limit allows spawning |
| `subagentNames` | `[]`, prose names no specialist | the agents this session can spawn |
| `taskMaxConcurrency` | `0`, quote no cap | `32`, the shipped limit |

You want the resolved values, not the fallbacks, whenever you are showing or benchmarking a real
configuration. Call `resolveGateInputs(settings, { tools, model })` and spread the result, which is
what both `sdk.ts` and `veyyon prompt` do. Building by omission is how `veyyon prompt` once printed
a prompt with no delegation guidance for a session that had it.

`prompt-gate-inputs.test.ts` renders the prompt both ways and asserts the four differences above by
value, so a fallback that starts disagreeing with its setting for no stated reason fails there.

### Adding a gate

When a setting controls whether a whole statement is present, add a row to `PROMPT_GATES` and use that variable in the statement row's condition. When the setting changes wording inside one statement, keep the Handlebars conditional in that statement's Markdown file. Never add a gate to the outer `system-prompt.md` scaffold.

You declare the gate's builder input in one place. `GateInputs` in
`system-prompt-builder/gate-inputs.ts` holds the field and its doc comment, and
`BuildSystemPromptOptions` extends `Partial<GateInputs>`, so a field you add there is a builder
option immediately. Do not restate the default in the doc comment. `OMITTED_GATE_DEFAULTS` owns what
an omitted option means.

Then pass the variable in the statement context in `system-prompt.ts`. This step has no type that
can prove the runtime value was supplied, because statement templates read context by name. A gate
you omit renders as off. `prompt-gate-registry.test.ts` and the statement gate matrix check that
declared variables reach observable statement output.

`prompt-gate-registry.test.ts` refuses five things, each because it has happened:

- **An unclassified gate.** Every `{{#if}}` variable in the template must be either a
  registered settings gate or listed as fed by something else. A new one fails until you
  decide which it is.
- **A setting path the schema does not define.** Rows carry paths as strings, so a typo would
  produce a gate that never fires and reads like a working row.
- **A per-setting rebuild call in the controller.** That hand-written list carried two of the
  nine gates, which is how seven settings came to change the configuration and leave the
  prompt describing the previous one.
- **A registered gate the context never passes.** The suite builds a real prompt and reads the
  `statementContext` it rendered with, so a variable that is missing, `undefined`, or shadowed by a
  later spread fails there rather than rendering as off.
- **A context value pinned to a constant.** Present but fixed is the same bug with a key in place, so
  the suite also asserts the value follows what the caller asked for.

A row marked `frozen-by-placement` also has its claim checked against `sdk.ts`: the setting
really is read above the prompt builder. Move that read inside and the test fails, which is
the reminder to reclassify the gate rather than leave a stale label on one that now works.

That is how `tools.intentTracing` stopped being frozen. Its row said what would have to change,
in the row itself: not only moving the read, but making the tool-schema injection follow the
setting as well. Both happened, so the row now reads `live`, and a separate suite in
`packages/agent` proves the schema half by flipping the resolver between two requests to the same
agent. The prompt suite alone could not prove it, because it passes just as well on a build where
the schemas never change.

---

## 13) Statements: the prompt is a list, not a document

The system prompt is a list of **statements**. A statement is a fragment of prompt text with an id,
a condition, and a purpose. Its text lives in
`src/system-prompt-builder/statements/<section>/<id>.md`, and the row that registers it lives in
`statement-registry.ts`.

### Why

Sections were already rows, so a section is addressable, orderable and overridable. The
conditions inside a section were `{{#if}}` blocks buried in prose, so they were none of those
things. Two consequences you can see in the tests: the gate suite had to run a regular expression
over `system-prompt.md` to find out what the prompt gates on, and the end-to-end suite could only
assert that two 76KB strings differed, because a single gated line had no name to assert on.

A statement has a name. That is what lets you refine one point of the prompt, assert that it
appears under the right conditions, measure what it costs in tokens, and ablate it in an eval.

### How fine is a statement

One rule decides it:

> A statement is the smallest unit that can independently be present, absent, or different across
> sessions. If you cannot name a condition or configuration under which it would change, it is not
> a statement, it is part of one.

So the ROLE section's fourteen lines are two statements, not fourteen. The role sentence and the
five engineering principles are always present together, so they are one statement. The Mermaid
bullet is a second, because `renderMermaid` removes it.

The rule has one addition, and the last two sections are why. A unit the **prompt itself delimits**
may be its own statement even when nothing varies it. DELIVERY CONTRACT is five unconditional XML
blocks (`<contract>`, `<completeness>`, `<evidence-and-output>`, `<yielding>`, `<critical>`) and
EXECUTION WORKFLOW is six numbered steps under markdown headings. The rule as stated would merge each
set into a single row. It should not, because those boundaries are declared by the document rather
than invented by the registry, and an eval that ablates one contract block or one workflow step needs
each to have a name.

So the check is: two adjacent `always` rows are a merge to make unless the second one opens a unit the
document declares, meaning its text starts with a markdown heading or an XML tag. Two adjacent
`always` rows of plain prose are still reported, which is the case the rule was written for.

### Conditions

A row carries one of six conditions:

| Condition | Meaning | Template shape it replaces |
| --- | --- | --- |
| `always` | in every prompt | plain text |
| `when` | a variable is truthy | `{{#if x}}` |
| `whenContains` | a collection holds a member, such as a tool being active | `{{#has tools "task"}}` |
| `whenAll` | every nested condition holds | nested `{{#if}}` blocks |
| `whenAny` | any nested condition holds | `{{#ifAny a b}}` |
| `not` | the nested condition does not hold | a block-level `{{else}}` arm |

`whenAll` and `whenAny` hold conditions rather than variable names, so they nest. The condition
algebra can therefore say "A and not B". For example, the descriptor statement uses
`allOf(when("hasTools"), not(when("toolListMode")))`. Write conditions with the builders
(`when`, `contains`, `allOf`, `anyOf`, `not`) rather than object literals; they construct exactly the
same values and the rows stay readable.

The variable a condition names has to be either a registered settings gate (`gate-registry.ts`) or a
row in `SESSION_FACT_VARIABLES`. A typo, or a variable the builder renamed, would otherwise produce a
statement that never appears and reports nothing, so `statement-registry.test.ts` rejects it.

### What stays in Handlebars

Only **block-level** conditions become separate statements. Wording-level conditionality stays
inside the relevant statement module:

```
- {{#if label}}{{label}}: `{{name}}`{{else}}`{{name}}`{{/if}}
```

That is one bullet inside an `{{#each}}`, not two statements. Splitting it would shatter a sentence
into fragments and make the registry finer than behavior requires. The division is:

- the statement registry decides whether a statement is **present**,
- Handlebars inside the statement module decides what the statement **says**.

This is why statement Markdown can still contain `{{#each skills}}`, `{{toolRefs.task}}`, and
`{{#list globs join=", "}}`. The outer `system-prompt.md` scaffold contains none of them.

### The registry owns section structure

A statement file never contains a section banner. `assembleSection` renders the banner from the
section registry at the width `banner-grammar.ts` owns. A `PROMPT_SECTIONS/<id>.md` replacement also
contains body text only. The same assembler adds its registry banner, so shipped statements and
operator replacements cannot disagree about a section boundary.

### How statements reach the model

`assembleSection` returns Handlebars template text, not rendered text.
`assembleStatementSections` creates the complete static section map. Operator overrides apply to
that map, and `assembleDefaultTemplate` fills the outer scaffold:

```ts
const statementSections = assembleStatementSections(data, statementOverrides);
const sectionOverrides = applySectionOverrides(files, statementSections);
assembleDefaultTemplate({ ...statementSections, ...sectionOverrides });
```

The scaffold is:

```handlebars
{{templateSections}}
```

The complete document is rendered once, so formatting and variable expansion are global rather
than changing with statement boundaries. `assembleDefaultTemplate` owns the one newline between
adjacent static sections. Statement modules own only their own final line.

Operator section overrides win because they are spread after the shipped statement map. Append mode
starts from the complete statement-assembled section, then adds your body inside that region. There
is no prose-bearing template fallback.

### Structural invariants

The test suites enforce these contracts directly:

- `system-prompt.md` contains exactly the `{{templateSections}}` variable and no literal prose,
  condition, or banner.
- Every static section declared by `section-registry.ts` owns at least one statement. A missing
  section fails module loading.
- The registry supplies section order and banner bytes.
- Replacement files are body-only. A legacy file carrying its own banner fails loudly.
- The gate matrix renders every statement condition through the modular assembly.
- Production `buildSystemPrompt` output proves the statement modules, operator precedence, and
  section ordering reach the model.

There is no frozen prose copy and no migration byte-parity fixture. Prompt behavior is tested from
the one modular source.

### What each rule costs, and testing one of them

Two things follow from a rule having a name, and both are the reason the migration was worth doing.

`veyyon prompt --statements` prints what each rule costs. The number is MARGINAL: what the prompt
would be shorter by without that rule, not the length of the rule's text. The distinction matters
because `render` ends in a `format` pass that normalizes whitespace across statement boundaries, so
the lengths of the statement texts do not add up to the length of the section they form. Measured the
other way, the parts reconcile with the whole exactly:

```
section bytes = banner + sum of statement bytes + separator
```

The banner belongs to the section registry, and `assembleDefaultTemplate` owns the one newline
between adjacent static sections. `prompt-inspect.test.ts` asserts that the reported parts reconcile,
so a change to either convention cannot silently corrupt the cost breakdown.

`veyyon prompt --statement <id>` prints one rule's rendered text. The text it prints weighs exactly
what the table charges the rule, which is asserted, so the two surfaces cannot disagree about the same
rule. A rule that is not in this prompt reports the condition that would include it and exits 0,
because a rule being off is a configuration rather than a failure.

`VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS` changes one rule. It is a JSON object of statement id to
replacement text, or to `null` to remove the rule entirely:

```
VEYYON_EVAL_SYSTEM_PROMPT_STATEMENTS='{"tool-policy/delegation-gates": null}'
```

Same instrument as `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`, one level finer, and deliberately the same
shape: environment variable only, no config key, no CLI flag. A config-reachable prompt override could
silently contaminate a production run, and a contaminated eval reports a number that looks valid.

`null` and `""` are different operations, so pick deliberately. `null` ablates: the row and the
separation it carries both leave the prompt, because a statement's text includes its own separation.
`""` keeps the row present and empty, so the separation stays and only the words go. Use the first to
ask whether a rule is worth having, the second to ask whether it needs saying at all.

Every way an override could do nothing is an error rather than a no-op: an unknown statement id, a
value that is neither a string nor `null`, malformed JSON. An arm that quietly did nothing would
report the shipped prompt's score as the arm's score, which is a false result with no signal that
anything went wrong.

An override targeting a rule whose condition is false is rejected. A statement override also cannot
target a section replaced wholesale by a section override, because the section replacement would
silently discard the statement arm. These conflicts fail before the prompt is assembled.

All six static sections come from statements. `STATEMENT_SECTIONS` is derived from the sections the
registry declares, and the module refuses to load if any one has no statements. The zero-prose
`system-prompt.md` scaffold cannot supply fallback instructions, so losing a section is a loud
assembly failure rather than a silent reversion.
