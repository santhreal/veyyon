# System Prompt Customization

How the coding-agent assembles the system prompt sent to the model, and what users can control via `SYSTEM.md`, `APPEND_SYSTEM.md`, and the matching CLI flags.

Primary implementation:

- `packages/coding-agent/src/system-prompt.ts` (`buildSystemPrompt`, `loadSystemPromptFiles`)
- `packages/coding-agent/src/main.ts` (`discoverSystemPromptFile`, `discoverAppendSystemPromptFile`)
- `packages/coding-agent/src/prompts/registry.ts` (every prompt file, with its id and purpose)
- `packages/coding-agent/src/system-prompt-builder/banner-grammar.ts` (what a banner IS, for every prompt: how one is written, how one is recognised)
- `packages/coding-agent/src/system-prompt-builder/section-registry.ts` (the section registry: which sections exist, their banners, and their order)
- `packages/coding-agent/src/system-prompt-builder/prompt-sections.ts` (`splitBanneredDocument`, the one parser that cuts a prompt at its banners)
- `packages/coding-agent/src/prompts/session/system-prompt.md` (default stable instruction template)
- `packages/coding-agent/src/prompts/session/custom-system-prompt.md` (internal custom-prompt template; not the normal CLI `SYSTEM.md` path)
- `packages/coding-agent/src/prompts/session/project-prompt.md` (project/environment footer)

Every prompt file lives under `packages/coding-agent/src/prompts/`, and `registry.ts` is the only module that imports one. To find a prompt, read that file or run `veyyon prompt --prompts`, which lists each id with a line saying what it is for. An id is the file's path under `src/prompts/` without the `.md`, so `system/auto-continue` is `src/prompts/turn-control/auto-continue.md`.

---

## 1) Inputs

Four user-controllable inputs feed prompt assembly. All four resolve a value as either a literal string or, if the argument looks like a file path, the contents of that file (`resolvePromptInput`).

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

Normal CLI startup builds the default provider-facing prompt blocks first, then applies CLI / discovered file overrides in `packages/coding-agent/src/main.ts`:

```ts
if (resolvedSystemPrompt && resolvedAppendPrompt) {
  options.systemPrompt = defaultPrompt => [resolvedSystemPrompt, resolvedAppendPrompt, ...defaultPrompt.slice(1)];
} else if (resolvedSystemPrompt) {
  options.systemPrompt = defaultPrompt => [resolvedSystemPrompt, ...defaultPrompt.slice(1)];
} else if (resolvedAppendPrompt) {
  options.systemPrompt = defaultPrompt => [...defaultPrompt, resolvedAppendPrompt];
}
```

The default blocks come from `buildSystemPrompt`:

- block 0: `system-prompt.md`: the stable default instructions (staff-engineer preamble, tool inventory, exploration rules, workflow rules, etc.);
- block 1, when non-empty: `project-prompt.md`: dynamic project/environment context (workstation info, context files, dir-context list, workspace tree, current date/cwd, and other project footer content).

Consequences for normal CLI use:

- Providing `--system-prompt` or `SYSTEM.md` replaces only block 0. The stable default instructions are removed, but the dynamic project/environment footer from `project-prompt.md` remains as `defaultPrompt.slice(1)`.
- Providing `--append-system-prompt` or `APPEND_SYSTEM.md` without a custom system prompt appends a new block after all default blocks.
- Providing both a custom system prompt and an append prompt produces: custom system prompt block, append prompt block, then the preserved dynamic project/environment footer.

If you want to keep both default blocks and add to them, use `--append-system-prompt` / `APPEND_SYSTEM.md` without `--system-prompt` / `SYSTEM.md`. If you want to replace the stable default instructions while keeping the dynamic footer, use `--system-prompt` / `SYSTEM.md`.

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

### "Customize while keeping generated skills/rules/tool guidance"

Use `APPEND_SYSTEM.md`, not `SYSTEM.md`. Skills, rulebook summaries, always-apply rules, the tool inventory, and the built-in guidance that tells the model when to read `skill://<name>` are part of block 0 (`system-prompt.md`). Because `SYSTEM.md` replaces block 0, those generated lists are not available to the model in a custom system prompt.

The dynamic project/environment footer that remains after `SYSTEM.md` is only block 1 (`project-prompt.md`): workstation info, AGENTS.md context files, dir-context list, workspace tree, current date, cwd, and related project context. It does not include discovered skills.

There is no supported CLI mode for "replace the WHOLE stable default instruction block but keep the generated skills/rules/tool guidance." For automatic skills loading, keep the default block and add customization via `APPEND_SYSTEM.md`. A full `SYSTEM.md` replacement must hard-code any skill names/instructions you want the model to know about (they will not track discovery).

If you wanted a full replacement only in order to change part of it, use `PROMPT_SECTIONS/` (section 8) instead. It edits one section and leaves the generated lists in place.

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
| Preserve generated skills/rules/tool guidance while customizing | `APPEND_SYSTEM.md`; `SYSTEM.md` replaces that generated block |
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
- A replacement must keep its section's banner: the name on its own line, then a line of `=` under it. Four or more is enough; the shipped prompts use fourteen. The banner is where sections are cut apart, so a replacement without one would merge two sections into one, and an underline shorter than four `=` is refused rather than accepted and then silently not cut on.
- Project files win over user files for the same section, section by section. A project `role.append.md` does not discard your user `runtime.append.md`.
- `PROMPT_SECTIONS/` cannot be combined with `SYSTEM.md` or `--system-prompt`. A custom prompt has no sections to override, so asking for both is an error rather than a silent choice between them.

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

The system prompt is not the only prompt a model receives. Delegated tasks run under a subagent prompt, and there are separate prompts for summarizing a session, naming it, writing a commit message, classifying a turn, and more. List them with:

```
veyyon prompt --prompts
```

Then look at one:

```
veyyon prompt --prompt subagent
```

That reports the prompt's sections and which of them are optional, so you can tell a subagent prompt that rendered three of its five sections because the task had no plan and no worktree from one that lost two sections to a bug.

Most of these prompts are a single region with no internal structure, and they report one `body` section. The subagent prompt has five: `role`, `context`, `plan`, `coop`, and `completion`.

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

A row declares the banner's NAME, never the rendered banner. `renderBanner` owns
the `=` underline for every prompt in the product, so a section cannot ship a
width of its own.

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
