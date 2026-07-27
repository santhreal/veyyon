# System Prompt Customization

How the coding-agent assembles the system prompt sent to the model, and what users can control via `SYSTEM.md`, `APPEND_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`)
- `packages/coding-agent/src/prompts/<directory>/rows.ts` (the prompts one directory owns, each with its id and purpose) and `packages/coding-agent/src/prompts/registry.ts` (which aggregates all of them)
- `packages/utils/src/prompt-registry.ts` (what a registry IS: the row shape, `definePromptRegistry`, and `requirePromptFrom`, the one lookup that refuses an unknown id)
- `packages/coding-agent/src/system-prompt-builder/banner-grammar.ts` (what a banner IS for every prompt: how one is written, how one is recognised, and `splitBanneredDocument`, the one parser that cuts a prompt at its banners)
- `packages/coding-agent/src/system-prompt-builder/section-registry.ts` (the section registry: which sections exist, their banners, and their order)
- `packages/coding-agent/src/system-prompt-builder/prompt-sections.ts` (the system prompt's own section names and the reordering a harness profile asks for)
- `packages/coding-agent/src/prompts/session/system-prompt.md` (default stable instruction template)
- `packages/coding-agent/src/prompts/session/custom-system-prompt.md` (internal custom-prompt template; not the normal CLI `SYSTEM.md` path)
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

Four user-controllable inputs feed prompt assembly. All four resolve a value as either a literal string or, if the argument names a readable file, the contents of that file (`resolvePromptInput`).

A value that fails to read is an error when it has no spaces and either contains a path separator or ends in a prompt-file extension (`.md`, `.markdown`, `.txt`, `.text`, `.prompt`). `--system-prompt ./promtps/main.md` names the path and the reason rather than quietly using the string `./promtps/main.md` as your whole system prompt. Prompt text is unaffected: a one-line prompt containing a slash, or ending in a dotted word, is used as written. To pass text that would otherwise read as a path, put it on more than one line, since no path contains a newline.

| Input | Source | Effect |
|---|---|---|
| `--system-prompt <text-or-file>` | CLI flag | Replaces block 0: the default stable instructions. Highest precedence. |
| `SYSTEM.md` | `<cwd>/.veyyon/SYSTEM.md`, then `~/.veyyon/profiles/default/agent/SYSTEM.md` (and equivalent paths under `.claude`, `.codex`, `.gemini`) | Same effect as `--system-prompt`; used when the flag is absent. |
| `--append-system-prompt <text-or-file>` | CLI flag | Adds a prompt block. Without a custom system prompt it goes after all default blocks; with one it goes after the custom block and before the preserved project/environment footer. |
| `APPEND_SYSTEM.md` | Same discovery as `SYSTEM.md` | Same effect as `--append-system-prompt`; used when the flag is absent. |

Discovery for `SYSTEM.md` / `APPEND_SYSTEM.md` uses `findConfigFile` (`packages/coding-agent/src/config.ts`): the first existing file across the ordered bases (`.veyyon`, `.claude`, `.codex`, `.gemini`, project-level at `<cwd>` first, then user-level at `~`) wins. The user-level `.veyyon` base is profile-aware: under a named profile (`--profile <name>` / `VEYYON_PROFILE`) it resolves to `~/.veyyon/profiles/<name>/agent/SYSTEM.md` instead of `~/.veyyon/profiles/default/agent/SYSTEM.md`. **No ancestor walk-up.** Running `veyyon` from `<repo>/subdir` does not pick up `<repo>/.veyyon/SYSTEM.md`; the file must live directly under the cwd's config base or in the user-level location. See [`docs/config-usage.md`](./config-usage.md) for the full discovery contract.

Precedence (highest first):

1. `--system-prompt`
2. project `SYSTEM.md`
3. user `SYSTEM.md`

For append, the same precedence applies between `--append-system-prompt`, project `APPEND_SYSTEM.md`, and user `APPEND_SYSTEM.md`.

---

## 2) Replace vs. append

Normal CLI startup resolves the CLI / discovered file overrides first, then hands them to prompt assembly in `packages/coding-agent/src/main.ts`:

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

- No custom prompt: the default template is assembled from `system-prompt.md` sections: the stable default instructions (staff-engineer preamble, tool inventory, exploration rules, workflow rules, etc.), with skills, rules, and context files rendered in.
- Custom prompt present: the base template switches to `session/custom-system-prompt.md`, which renders your custom text plus `systemPromptCustomization`, the append prompt, context files, discovered skills, always-apply rules, and rules. The stable default instructions, tool inventory, and default workflow guidance are not rendered.

In both cases the dynamic project/environment footer from `project-prompt.md` still renders after the base template: workstation info, dir-context list, workspace tree, current date, cwd, and related project context. With a custom prompt the footer omits context files and the append prompt because the custom template already rendered them.

Consequences for normal CLI use:

- Providing `--system-prompt` or `SYSTEM.md` replaces the stable default instructions and tool inventory. Context files, skills, always-apply rules, and rules are kept (the custom template renders them), and the dynamic project/environment footer remains.
- Providing `--append-system-prompt` or `APPEND_SYSTEM.md` without a custom system prompt appends your text after the default instructions.
- Providing both a custom system prompt and an append prompt produces: custom system prompt text, append prompt text, then the kept skills/rules/context files and the dynamic project/environment footer.

If you want to keep the default instructions and add to them, use `--append-system-prompt` / `APPEND_SYSTEM.md` without `--system-prompt` / `SYSTEM.md`. If you want to replace the stable default instructions while keeping skills, rules, and project context, use `--system-prompt` / `SYSTEM.md`.

---

## 3) Templating contract

**Contents of `SYSTEM.md`, `APPEND_SYSTEM.md`, `--system-prompt`, and `--append-system-prompt` are treated as plain text.** They are resolved before prompt-block replacement and are not rendered as Handlebars templates.

The built-in prompt templates are Handlebars (`packages/utils/src/prompt.ts`), but user-provided strings are not compiled with that renderer. The secondary capability path can insert `systemPromptCustomization` into a Handlebars parent template, but a `{{value}}` reference in Handlebars still does not recursively render its substituted contents, the value is emitted as a string. Concretely:
```handlebars
{{! parent template, handled by Handlebars }}
{{#if systemPromptCustomization}}
{{systemPromptCustomization}}
{{/if}}
```

If `SYSTEM.md` contains:

```handlebars
Working in {{cwd}} on {{date}}.
{{#if hasMemoryRoot}}Memory enabled.{{/if}}
```

the rendered output contains those characters verbatim, `{{cwd}}`, `{{#if hasMemoryRoot}}`, etc. are NOT substituted. They will be shown to the model as literal Handlebars syntax.

This is by design. The internal template variables (`cwd`, `date`, `environment`, `workspaceTree`, `skills`, `rules`, `toolRefs`, `hasMemoryRoot`, `hasObsidian`, `mcpDiscoveryServerSummaries`, ...) are not a supported public surface, they change between releases as the prompt is rewritten, and they would couple user configs to internals. Treat them as private.

There is no supported public templating surface for `SYSTEM.md` today. Write plain text (or markdown) only.

---

## 4) Recommended patterns

### "Tweak the default": keep default, add a few rules

Use `APPEND_SYSTEM.md` (or `--append-system-prompt`) without `SYSTEM.md`. The default stable instructions and the dynamic project/environment footer stay intact; your text is appended as an additional block.

```text
# ~/.veyyon/profiles/default/agent/APPEND_SYSTEM.md
Prefer Bun APIs over Node APIs in this project.
When you change a public function, run `bun check` before yielding.
```

### "Replace the stable default instructions": bring your own base prompt

Use `SYSTEM.md` (or `--system-prompt`). You replace the stable default instructions in block 0, but normal CLI startup still preserves the dynamic project/environment footer block (`project-prompt.md`): workstation info, context files, dir-context list, workspace tree, current date, cwd, and related project context.

```text
# ~/.veyyon/profiles/default/agent/SYSTEM.md
You are a code reviewer. Read diffs, surface issues, never edit files.
- Cite paths with backticks.
- Prefer concrete fixes over abstract advice.
```

Reach for this only when you want a genuinely different base prompt. If you are keeping most of the default and changing one part, use `PROMPT_SECTIONS/` instead (section 8): it edits a single section and leaves the rest as shipped, so you do not have to maintain a copy of the default tool guidance, exploration rules, or workflow rules.

### "Customize while keeping the tool inventory and default workflow guidance"

Use `APPEND_SYSTEM.md`, not `SYSTEM.md`. The tool inventory, the staff-engineer preamble, and the default exploration/workflow guidance live only in the default template (`system-prompt.md`). Because `SYSTEM.md` switches the base template to `session/custom-system-prompt.md`, those parts are not available to the model in a custom system prompt.

A custom system prompt still keeps the generated project content: `session/custom-system-prompt.md` renders context files, discovered skills, always-apply rules, and rules alongside your text, and the `project-prompt.md` footer still carries workstation info, the workspace tree, the current date, and cwd.

If you wanted a full replacement only in order to change part of it, use `PROMPT_SECTIONS/` (section 8) instead. It edits one section and leaves the rest of the default template in place.

### "Customize automatic session titles"

`SYSTEM.md` and `APPEND_SYSTEM.md` do not affect the model call that names a new session. Create the title-specific prompt file instead:

```text
# ~/.veyyon/profiles/default/agent/TITLE_SYSTEM.md
Generate a session name using lowercase `<type>:<primary-objective>`.
If the message carries no concrete task, output exactly `none`.
```

`TITLE_SYSTEM.md` is discovered with the same project-then-user config-directory pattern as `SYSTEM.md` / `APPEND_SYSTEM.md`. When absent, Veyyon uses the bundled `title-system.md` / `tiny-title-system.md` prompts. When present, both the online title path and the local tiny-model path keep the `<title>...</title>` wrapper while using this file as the system turn.

### "Replace everything, including project context": SDK-only

The normal CLI file/flag path intentionally preserves `defaultPrompt.slice(1)`. Code using `CreateAgentSessionOptions.systemPrompt` directly can return a full replacement array and omit the project footer, but that is not what `.veyyon/SYSTEM.md`, `~/.veyyon/profiles/default/agent/SYSTEM.md`, or `--system-prompt` do.

### "Change one section of the default instructions, keep the rest"

Use `PROMPT_SECTIONS/`, described in section 8. Put your text in `PROMPT_SECTIONS/<section>.append.md` to add to a section, or `PROMPT_SECTIONS/<section>.md` to replace it. Every other section stays exactly as shipped, including the generated skills, rules, and tool guidance, so this is the option to reach for whenever you were considering a full `SYSTEM.md` replacement in order to change one thing.

Run `veyyon prompt --sections` to see the section names for your configuration.

---

## 5) Deduplication

The CLI path avoids double-injecting discovered `SYSTEM.md` by replacing block 0 after the default prompt blocks are rendered. Any `systemPromptCustomization` from the secondary capability path would have been rendered into block 0, and that block is discarded when `main.ts` applies `[resolvedSystemPrompt, ...defaultPrompt.slice(1)]`.

Inside `buildSystemPrompt` itself, secondary customization and always-apply rules are still deduplicated:

- `dedupePromptSource` drops a `systemPromptCustomization` block when it already appears in an internally supplied `customPrompt` or append prompt.
- `dedupeAlwaysApplyRules` omits always-apply rules whose body appears verbatim in any of `{customPrompt, appendPrompt, systemPromptCustomization}`.

---

## 6) Discovery paths

Only one path actually drives the customization a CLI user sees: the primary CLI path. The capability layer exists but its `SYSTEM.md` output never reaches the rendered prompt under normal CLI startup.

- The primary CLI path (`discoverSystemPromptFile` / `discoverAppendSystemPromptFile` in `main.ts`, which feeds `resolvedSystemPrompt` / `resolvedAppendPrompt`) calls `findConfigFile`. `findConfigFile` checks only `<cwd>/.veyyon`, `<cwd>/.claude`, `<cwd>/.codex`, `<cwd>/.gemini`, and the user-level equivalents: it does **not** walk up ancestors. Files in `<ancestor>/.veyyon/SYSTEM.md` are ignored when `veyyon` is started from a subdirectory.
- The secondary capability path (`loadSystemPromptFiles` → builtin discovery) does walk up via `findNearestProjectConfigDir` and requires the project `.veyyon/` directory to be non-empty. Its result is rendered into the template variable `systemPromptCustomization`. Under normal CLI startup the default template (`system-prompt.md`) never references that variable, so ancestor-walk capability content has no user-visible effect.

Net effect for CLI users: put `SYSTEM.md` / `APPEND_SYSTEM.md` directly under `<cwd>/.veyyon` (or another supported config base under cwd) or in the user-level location (`~/.veyyon/profiles/default/agent/SYSTEM.md` etc.). Ancestor paths are not searched.

---

## 7) Quick reference

| Goal | Use |
|---|---|
| Add an instruction on top of the full default prompt | `APPEND_SYSTEM.md` or `--append-system-prompt` |
| Replace the stable default instructions but keep project/environment context | `SYSTEM.md` or `--system-prompt` |
| Preserve the tool inventory and default workflow guidance while customizing | `APPEND_SYSTEM.md`; `SYSTEM.md` replaces those (skills, rules, and context files are kept) |
| Customize automatic session titles | `TITLE_SYSTEM.md`; chat-turn `SYSTEM.md` / `APPEND_SYSTEM.md` do not affect title generation |
| Use `{{cwd}}` / `{{date}}` / other internals in my file | Not supported. Files are inserted verbatim. |
| Change one section and keep the rest | `PROMPT_SECTIONS/<section>.append.md` (see section 8) |
| See the prompt a configuration actually produces | `veyyon prompt` (see section 9) |
| Override at a per-repo level | Project `.veyyon/SYSTEM.md` under the cwd you launch `veyyon` from |
| Override globally | `~/.veyyon/profiles/default/agent/SYSTEM.md` or `~/.veyyon/profiles/default/agent/APPEND_SYSTEM.md` |

---

## 8) Changing one section: `PROMPT_SECTIONS/`

`SYSTEM.md` replaces the whole default template. If you only want to add a rule or reword one part, that is a heavy trade: you lose the generated skills and rules lists, the tool inventory, and every setting-gated block, and you have to keep your copy in step with each release.

`PROMPT_SECTIONS/` changes one section and leaves the others exactly as shipped.

The default template is a sequence of named sections. To see the names for your configuration, run:

```
veyyon prompt --sections
```

Put a file named after a section in a `PROMPT_SECTIONS/` directory beside `SYSTEM.md`:

```
~/.veyyon/profiles/default/agent/PROMPT_SECTIONS/    # applies everywhere
<cwd>/.veyyon/PROMPT_SECTIONS/                       # applies in this project
```

Two filename forms decide what happens:

| File | Effect |
|---|---|
| `<section>.append.md` | Your text is added at the end of that section. The shipped text stays, including anything added to it in a later release. |
| `<section>.md` | Your text replaces that section. It must start with the section's banner: the name line, then a line of at least four `=`. |

Prefer append. It survives upgrades, because the shipped section is reused rather than copied.

To add a rule to the delivery contract for one repository:

```
# <cwd>/.veyyon/PROMPT_SECTIONS/delivery-contract.append.md
Always include the exact command you ran when you report a test result.
```

Everything else in the prompt is untouched. Overriding one section never changes another, and never disables a setting-gated block in a different section.

A few rules worth knowing:

- A file naming a section that does not exist is an error, not a no-op. The message lists the valid names. A typo that silently did nothing would leave you believing a change was live when it was not.
- Section names are the ids `veyyon prompt --sections` prints: `conventions`, `role`, `runtime`, `tool-policy`, `execution-workflow`, `delivery-contract`. The `systemPrompt.sectionOverrides` config key accepts the same ids, and also accepts the camelCase spelling (`toolPolicy`) that the SDK uses for its property names. Both reach the same section, so you can use the id everywhere and never think about the difference.
- A replacement must keep its section's banner: the name on its own line, then a line of `=` under it. Four or more is enough; the shipped prompts use fourteen. The banner is where sections are cut apart, so a replacement without one would merge two sections into one, and an underline shorter than four `=` is refused rather than accepted and then silently not cut on.
- Project files win over user files for the same section, section by section. A project `role.append.md` does not discard your user `runtime.append.md`.
- `PROMPT_SECTIONS/` cannot be combined with `SYSTEM.md` or `--system-prompt`. A custom prompt has no sections to override, so asking for both is an error rather than a silent choice between them.
- A directory that is not there means you have no overrides, and that is the ordinary case. A directory that IS there and cannot be read is an error naming the path and the reason, as is a file inside it that cannot be opened. Both would otherwise run the shipped prompt while your files sat on disk looking applied.

---

## 9) Seeing the prompt: `veyyon prompt`

`system-prompt.md` is a template, not a fixed document. Roughly a third of its lines are conditionals, so what the model receives depends on which tools are live, which settings are on, what the workspace contains, and which model you are using. Reading the file tells you what could be sent, not what was.

`veyyon prompt` prints the assembled prompt for your current configuration, without starting a session.

```
veyyon prompt                 # the full assembled prompt
veyyon prompt --sections      # a size breakdown, largest section first
veyyon prompt --section role  # one section's text
veyyon prompt --json          # the same breakdown, machine readable
veyyon prompt --no-tools      # assemble with no tools
```

`--sections` answers "what is taking up my prompt":

```
section             source    block    bytes   tokens  share
project             runtime       1    23191     5798   62.2%
tool-policy         template      0     4406     1102   11.8%
delivery-contract   template      0     4053     1014   10.9%
```

The `source` column tells you how a section can be changed. `template` sections come from `system-prompt.md` and can be overridden through `PROMPT_SECTIONS/`. `runtime` sections are computed from your workspace and settings, so you change them by changing those inputs.

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

The `block` column is the boundary between messages sent to the provider. Block 0 is the static prefix that providers cache; later blocks hold text that changes often. Moving content from a later block into block 0 would break that cache, which is why the breakdown reports the boundary rather than hiding it.

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

`TEMPLATE_SECTIONS` describes sections that live in `system-prompt.md`. `RUNTIME_SECTIONS` describes sections the builder emits itself, and each row says where its text comes from:

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

`system-prompt.md` is a template, and a template holds structure. Anything that decides
**what the model should do** belongs to a setting, reaches the template as a variable or a
conditional, and is written down once in the settings schema. Prose that states a policy
directly into the template is a bug, because there is then no way to change it, no way to see
it in `/settings`, and no way for the text to follow the session it is describing.

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
| `subagent.maxRecursionDepth` | the IRC coordination clause, present only when this session can spawn |
| `subagent.agents` | which specialists delegation prose names |
| `includeModelInPrompt` | whether the active model is surfaced in the workstation block |
| `tools.format` | whether tools are described inline or left to the provider's tool list |
| `tools.intentTracing` | whether the prompt explains the intent field, and whether tool schemas carry it |

`tools.intentTracing` is the one gate that decides something outside the prompt. When it is on,
every tool schema sent to the model carries an extra `intent` field, and the prompt has a bullet
explaining it. Those two have to agree: a prompt describing a field the schemas do not carry is
worse than one that says nothing. So the agent resolves the setting on every turn rather than
reading it once, and both halves change together.

A **frozen** gate is read once at session start, so changing it mid-session saves the new
value and leaves the prompt as it was. When you flip one, the settings screen says so and tells
you it applies on the next session. Two are frozen:

| Setting | Why |
| --- | --- |
| `inlineToolDescriptors` | fixed at startup on purpose, so a mid-session model switch keeps the start-time decision |
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

When you add a `{{#if}}` to `system-prompt.md` that a setting decides, add a row to
`PROMPT_GATES`. That is what makes the setting rebuild the prompt: the settings controller
asks `isLivePromptGate`, so there is no second list to update and nothing to forget.

You declare the gate's builder input in ONE place too. `GateInputs` in
`system-prompt-builder/gate-inputs.ts` holds the field and its doc comment, and
`BuildSystemPromptOptions` extends `Partial<GateInputs>`, so a field you add there is a builder
option immediately. Do not restate the default in the doc comment: `OMITTED_GATE_DEFAULTS` owns what
an omitted option is worth, and a comment repeating it is a second owner nothing compares.

Then pass the variable in the statement context in `system-prompt.ts`. This is the step with no type
to catch it, because the context is a plain object the template reads by name, so a gate you forget
here renders as though it were off: the setting resolves, the option arrives, the text never appears.
That is what happened to `taskIrcEnabled` and `eagerTasksAlways`, and nothing failed.

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

The system prompt is moving from one Handlebars document to a list of **statements**. A statement
is a fragment of prompt text with an id, a condition, and a purpose. Its text lives in
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

`whenAll` and `whenAny` hold conditions rather than variable names, so they nest. That is what lets
a row say "A and not B", which the template needs: the tool inventory sits inside
`{{#if toolInfo.length}}` and then splits on `{{#if toolListMode}}`, and the `{{else}}` arm is
`allOf(when("toolInfo"), not(when("toolListMode")))`. Write conditions with the builders
(`when`, `contains`, `allOf`, `anyOf`, `not`) rather than object literals; they construct exactly the
same values and the rows stay readable.

The variable a condition names has to be either a registered settings gate (`gate-registry.ts`) or a
row in `SESSION_FACT_VARIABLES`. A typo, or a variable the builder renamed, would otherwise produce a
statement that never appears and reports nothing, so `statement-registry.test.ts` rejects it.

### What stays in Handlebars

Only **block-level** conditions become statements. Most of the template's conditionality is
intra-line and stays where it is:

```
- {{#if label}}{{label}}: `{{name}}`{{else}}`{{name}}`{{/if}}
```

That is one bullet inside an `{{#each}}`, not two statements. Splitting it would shatter sentences
into fragments and give you a registry far finer than behaviour requires. The division is:

- the registry decides whether a statement is **present**,
- Handlebars decides what the statement **says**.

Which is why a statement's md file still contains `{{#each skills}}`, `{{toolRefs.task}}` and
`{{#list globs join=", "}}`, and they all still work.

### The banner belongs to the assembler

A statement file never contains a section banner. `assembleSection` renders it from the section's
registered name, at the one width `banner-grammar.ts` owns. This removes an old asymmetry: template
sections used to carry their banner inside the markdown because those banners doubled as the
document's split points, while runtime sections had theirs prepended. Statements have no document,
so the question disappears.

### How statements reach the model

`assembleSection` returns **template text**, not rendered text, and `buildSystemPrompt` splices it
into the document it renders:

```ts
assembleDefaultTemplate({ ...statementSectionOverrides(data), ...sectionOverrides })
```

One document, one render, one `format` pass, exactly as before statements existed. Rendering each
statement separately would normalize a given line once per statement instead of once per document,
so how you split the statements would change the output, and a split is not allowed to do that.

Two things follow from that call:

- **Your section overrides still win.** Statements are spread first, so a
  `.veyyon/prompt-sections/role.md` replacement beats them. A section that stopped honouring your
  override would be a feature lost to a refactor.
  An APPEND override needs one more thing to be correct. Appending produces a whole-section override,
  base text plus your addition, and a whole-section override beats the statements, so whatever base the
  append starts from becomes the section. It starts from the assembled statements. Starting from the
  copy in `system-prompt.md`, which is what it used to do, replaced the rest of the section with that
  copy and left your line intact on top of it.
- **The splice restores the section separator.** `prompt-sections.ts` documents two separator
  conventions on one splitter: the slicer keeps a section's trailing separator inside the section,
  and the reorderer keeps it between sections. `assembleSection` produces the reorderer's shape,
  because a statement must not own a byte that exists only because of where its section currently
  sits, and `statementSectionOverrides` adds the separator back for every section but the last.

### Migration and the byte-identity gate

Sections convert one at a time, and each one is gated twice.

`statement-assembly.test.ts` expands both documents with `compile` and no `format`, splits them into
sections, and compares the converted ones. Comparing before `format` separates two questions: which
statements are present and in what order, versus how the finished document is spaced. It runs over a
shared matrix of gate combinations, not just defaults, since the conditionals are the whole reason
statements exist.

`statement-wiring.test.ts` compares the **fully rendered** documents, post-`format`, across the same
matrix. That is the only comparison that cannot be fooled about what a model receives, and it is
also what proves the registry is wired in at all rather than merely correct in isolation.

### When a section cannot be byte-exact

Byte identity is the bar, and `SECTION_FIDELITY` is where a section declares it cannot meet it. Four
sections declare it, and there are exactly two mechanisms behind all of them. Both are worth knowing
before you convert a section.

`format` strips a run of two or more blank lines **entirely** and preserves a single one. RUNTIME's
template puts unconditional blank lines between its three conditional rule blocks. So when two of
those blocks are absent, two blank lines end up adjacent and both vanish, and `# Skills & Rules`
lands directly on `# Internal URLs` with no gap. The spacing between two present blocks depends on
how many **unrelated** blocks are missing.

A statement cannot own an unconditional blank line, because its bytes appear only when its condition
holds. So a converted RUNTIME gives each block the separation that follows it, and the spacing stops
depending on unrelated gates. Measured across the matrix: not one word of the prompt changes, most
points are byte-identical, and three differ by a single blank line. Those three are listed by name in
`statement-wiring.test.ts` with the exact delta recorded per case, and the list is asserted to be
exhaustive in both directions, so a new whitespace difference fails and so does one of them
disappearing.

There is a second mechanism, and the three larger sections all hit it. A **one-line inline**
conditional is not a standalone block-helper line:

```
- {{#has tools "ast_grep"}}Prefer `ast_grep` for structural search{{/has}}
```

Handlebars removes a standalone block helper line and its newline together. It cannot do that here,
because the line has other text on it, so when the condition is false the line collapses to an
**empty line** rather than vanishing. Next to an existing blank that makes a run of two, which
`format` deletes entirely, and the heading below lands on the bullet above. Alone inside a list it
survives as a stray blank splitting the list in half. Both were happening in the shipped prompt.
Statements have no empty line to leave behind, so converting a section fixes the class rather than
reproducing it, and the resulting deltas are recorded per matrix point like any other.

One shipped defect came out of the same section and is worth knowing about because the fix is not a
spacing delta. TOOL POLICY nested a `{{#has}}` inside an `{{#if}}` across a line boundary, and the
close tags left `delegated.- A subagent's value` as one token in every non-Codex session with
delegation required. The statement rows put the bullet on its own line, so the byte comparison would
have reported the repair as a difference; the template side of the gate applies the repair explicitly
and asserts it in both directions, so the defect cannot come back and the fix cannot be mistaken for
drift.

If you convert a section and it will not go byte-exact, do not loosen the comparison. Declare the
fidelity, enumerate the differences with their measured deltas, and keep the word-level comparison
strict. Words are never a reviewed difference. Measured across the whole matrix and all six sections:
**zero** word-level differences.

`SECTION_FIDELITY` classifies the pre-normalization comparison, which is why `delivery-contract` is
`spacing-normalized` even though its rendered output is unchanged: the template holds two raw blank
lines that `format` deletes anyway.

### What each rule costs, and testing one of them

Two things follow from a rule having a name, and both are the reason the migration was worth doing.

`veyyon prompt --statements` prints what each rule costs. The number is MARGINAL: what the prompt
would be shorter by without that rule, not the length of the rule's text. The distinction matters
because `render` ends in a `format` pass that normalizes whitespace across statement boundaries, so
the lengths of 34 statement texts do not add up to the length of the section they form. Measured the
other way, the parts reconcile with the whole exactly:

```
section bytes = banner + sum of statement bytes + separator
```

The banner belongs to the assembler, and the separator is the one newline `statementSectionOverrides`
adds after every section but the last. `prompt-inspect.test.ts` asserts that reconciliation, so a
change to either convention fails there rather than quietly making the numbers not add up.

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

An override cannot resurrect a rule whose condition is false. The condition decides whether a
statement is present, and an override decides what it says; a statement absent from this
configuration stays absent, whatever the override map holds.

All six sections come from statements. There is no partial state left to describe, so there is no
flag asking whether a section is converted: `STATEMENT_SECTIONS` is derived from the sections the
document DECLARES, and the registry refuses to load if any of them has no statements. That direction
matters. While the list was derived from the statement rows it could only ever agree with them, so
deleting a section's statements removed the section from the list, the splice quietly stopped
covering it, and the frozen copy in `system-prompt.md` reached the model with nothing reporting the
substitution. Now the same mistake is a startup error naming the section.

Two things are worth stating plainly about `system-prompt.md`: it is no longer the source of truth for
any section, and while it still holds a byte-identical duplicate the byte gate cannot notice if the
splice is removed, so a source-shape assertion in `statement-wiring.test.ts` pins the call site
instead.
