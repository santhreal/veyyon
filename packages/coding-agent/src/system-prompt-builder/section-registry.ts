/**
 * The single registry of every section of the model's SYSTEM prompt.
 *
 * Rows only. What a banner is, and what fields a section row has, belong to every
 * prompt rather than to this one and live in `banner-grammar.ts`; this file says
 * which sections the system prompt has, in what order, and where each one's text
 * comes from.
 *
 * NAMED FOR SECTIONS, NOT BLOCKS. It was `section-registry.ts` and contained no
 * blocks: a "block" in this subsystem is an entry of the `string[]` that
 * `buildSystemPrompt` returns, which is the provider caching boundary that
 * `prompt-inspect.ts` reports as `blockIndex` and that the stability guard pins as
 * block 0. Using the same word for a registry row meant one term with two meanings
 * in one directory, and the more important meaning was the one the file was not
 * about.
 *
 * WHY THIS EXISTS. The prompt used to be described in three places that could
 * disagree with each other, and one of them could disagree silently:
 *
 *   1. `default-template.ts` defined the template's banner sections one way
 *      (camelCase keys, `indexOf` byte-offset splitting) so evals could override
 *      one region.
 *   2. `prompt-sections.ts` defined the SAME sections a second, independent way
 *      (kebab-case names, line-by-line splitting) so the harness could reorder
 *      them.
 *   3. `system-prompt.ts` appended MORE blocks after the rendered template with
 *      ad-hoc `push()` calls. Those had no banners, so they appeared in neither
 *      of the above: they could not be reordered and could not be overridden.
 *
 * That third group was the real damage. It made the prompt two-tiered for no
 * reason anyone chose — the split tracked PROVENANCE (text from the .md file vs
 * text computed at runtime), which is an implementation detail, and leaked it
 * into the prompt's structure as a capability difference. The one section an eval
 * most wants to ablate, the shorthand notation, was in the tier the override
 * mechanism could not touch.
 *
 * There is now ONE model: the prompt is an ordered list of banner-delimited
 * sections. `source` records where a section's text comes from, and that is all
 * it does — every section is split, addressed, and overridden the same way.
 *
 * BANNER OWNERSHIP. A row declares a NAME; {@link renderBanner} turns it into the
 * two-line banner the model sees. Where those bytes physically come from still
 * differs by source, and that part is deliberate:
 *   - `template` sections carry their banner INSIDE
 *     `prompts/session/system-prompt.md`, because those banners are the split
 *     points of a single readable document. The registry asserts the file agrees
 *     with it (`section-registry.test.ts`) rather than writing the file.
 *   - `runtime` sections have no document to carry one, so the assembler prepends
 *     it, which is one owner instead of asking each producer to remember one.
 *
 * Either way the WIDTH is decided in exactly one place and no row states it, which
 * is `banner-grammar.ts` — the leaf that owns what a banner IS for every prompt in
 * the product, not just this one. Three widths used to ship at once, none written
 * down.
 *
 * ORDER is the order the model receives. For `template` sections it is also a
 * fact about the .md file — concatenating them reproduces it byte for byte, and
 * the splitter asserts that.
 *
 * WHY THE ARRAY BOUNDARY SURVIVES: `buildSystemPrompt` still returns template
 * sections in one entry and runtime sections in their own. That is a caching
 * contract, not a structural tier — the static prefix stays byte-stable so the
 * provider can cache it, while a volatile section (the handle table, which
 * changes whenever a dictionary loads) cannot invalidate it. Sections are
 * uniformly addressable across that boundary; only reordering ACROSS it is
 * refused, because that would move volatile text into the cached prefix.
 */
import { kebabToCamel, type PromptSection } from "@veyyon/utils";
import { hasBanner, renderBanner } from "./banner-grammar";

export interface TemplateSection extends PromptSection {
	readonly source: "template";
}

/**
 * Where a runtime section's text comes from.
 *
 * `option` means the text is handed to `buildSystemPrompt` by its caller, which
 * is how every settings-gated section works: the caller reads the setting and
 * passes rendered text, or passes nothing. Declaring the option key here is what
 * lets the assembler read it THROUGH the registry instead of a hand-written map,
 * and lets a wiring test check that a production caller actually populates it.
 *
 * Without that declaration the chain setting -> option -> caller -> prompt was
 * enforced only at its last link: a section whose option was declared and
 * threaded into the assembly map but never populated from its setting compiled,
 * shipped, and rendered nothing forever.
 *
 * `computed` means the builder produces the text itself, so there is no option
 * to wire and nothing for a caller to forget.
 */
export type RuntimeSectionInput = { readonly kind: "computed" } | { readonly kind: "option"; readonly key: string };

export interface RuntimeSection extends PromptSection {
	readonly source: "runtime";
	/** Runtime sections always carry a registry-owned banner, so never `null`. */
	readonly name: string;
	readonly input: RuntimeSectionInput;
}

/**
 * A row in the SYSTEM prompt's section list: template-sourced or runtime-sourced.
 *
 * Named for the document it describes, not `PromptSection`. That name means the base
 * row shape every registry shares (`@veyyon/utils`), and this package exported both
 * meanings under it from sibling modules, so an editor auto-import of "the"
 * `PromptSection` picked whichever it offered first and the two are not
 * interchangeable: this union carries `source`, and the base shape does not.
 */
export type SystemPromptSection = TemplateSection | RuntimeSection;

/**
 * The template's regions, in document order.
 *
 * `as const satisfies` for the same reason {@link RUNTIME_SECTIONS} uses it: the
 * id list below is derived from this array, and an annotation would widen `id` to
 * `string` and leave the union with no members to derive.
 */
export const TEMPLATE_SECTIONS = [
	{
		id: "conventions",
		source: "template",
		name: null,
		purpose: "<system-conventions> preamble, everything before the ROLE banner",
		optional: false,
	},
	{ id: "role", source: "template", name: "ROLE", purpose: "who the agent is", optional: false },
	{
		id: "runtime",
		source: "template",
		name: "RUNTIME",
		purpose: "workstation, tool inventory, memory",
		optional: false,
	},
	{
		id: "tool-policy",
		source: "template",
		name: "TOOL POLICY",
		purpose: "tool rules, delegation, LSP/AST",
		optional: false,
	},
	{
		id: "execution-workflow",
		source: "template",
		name: "EXECUTION WORKFLOW",
		purpose: "how work is carried out",
		optional: false,
	},
	{
		id: "delivery-contract",
		source: "template",
		name: "DELIVERY CONTRACT",
		purpose: "output contract, personality",
		optional: false,
	},
] as const satisfies readonly TemplateSection[];

/**
 * The sections assembled from runtime state, in emission order.
 *
 * `project` carries the workstation/environment framing, the discovered context
 * files, the workspace tree, the cwd line, AND the active-repo-context clause.
 * That last one used to be its own block; it is the same concern by every measure
 * that matters — same input (the cwd), same lifetime, same invalidation — and
 * splitting it meant two things to remember on a working-directory change. Exactly
 * one of them got remembered, which is how the prompt kept describing the previous
 * project after a `/cd`.
 *
 * The two shorthand sections stay SEPARATE despite being one feature, because they
 * are separately meaningful: teaching the notation with no handle table is the
 * inert case, and an eval must be able to run it as its own arm to tell "the model
 * ignored available handles" from "there were no handles".
 *
 * `as const satisfies` rather than a `readonly RuntimeSection[]` annotation, and
 * the difference is the whole point: an annotation WIDENS every entry to
 * `RuntimeSection`, so `input.kind` becomes the union `"computed" | "option"` and
 * `input.key` becomes `string`. Everything downstream that wants to know which
 * sections are computed, or which option keys exist, then had to restate it by
 * hand — and both hand-written restatements were wrong (see
 * {@link ComputedRuntimeSectionId} and `system-prompt.ts`'s option-key proof).
 * Keeping the literals means those questions are answered by this array.
 */
export const RUNTIME_SECTIONS = [
	{
		id: "project",
		source: "runtime",
		name: "PROJECT",
		input: { kind: "computed" },
		purpose: "environment, cwd, context files, workspace tree, active repo context",
		// Renders even with an empty workspace tree and no context files: it always
		// carries at least the environment framing and the cwd.
		optional: false,
	},
	{
		id: "shorthand",
		source: "runtime",
		name: "SHORTHAND",
		input: { kind: "option", key: "argotPreamble" },
		purpose: "the shorthand notation block, taught when the encode gate is open",
		optional: true,
	},
	{
		id: "shorthand-handles",
		source: "runtime",
		name: "SHORTHAND HANDLES",
		input: { kind: "option", key: "argotHandles" },
		purpose: "the handle table for loaded projects, so the model can learn the handles at all",
		optional: true,
	},
] as const satisfies readonly RuntimeSection[];

/** One entry of {@link TEMPLATE_SECTIONS}, with its literal id and name intact. */
export type TemplateSectionEntry = (typeof TEMPLATE_SECTIONS)[number];

/** One entry of {@link RUNTIME_SECTIONS}, with its literal id, kind and key intact. */
export type RuntimeSectionEntry = (typeof RUNTIME_SECTIONS)[number];

export type TemplateSectionId = TemplateSectionEntry["id"];
export type RuntimeSectionId = RuntimeSectionEntry["id"];

/**
 * The ids of the template's regions, in document order, read off the rows.
 *
 * Declared as its own literal list until now, which made adding a section two
 * edits that had to agree: the `satisfies` above rejects a row whose id is not in
 * the list, but nothing rejected a list entry with no row, so a renamed section
 * could leave a phantom id behind that `section-overrides.ts` still advertised as
 * a valid override target.
 */
export const TEMPLATE_SECTION_IDS: readonly TemplateSectionId[] = TEMPLATE_SECTIONS.map(section => section.id);

/** The ids of the runtime sections, in emission order, read off the rows. */
export const RUNTIME_SECTION_IDS: readonly RuntimeSectionId[] = RUNTIME_SECTIONS.map(section => section.id);

/**
 * The ids of the sections whose text the BUILDER produces, derived from the
 * registry's own `input.kind`.
 *
 * `system-prompt.ts` used to spell this as `Exclude<RuntimeSectionId, "shorthand"
 * | "shorthand-handles">` — a second hand-written list of which sections are
 * option-backed, with no connection to the `input` each row declares. It was
 * wrong in both directions. Registering a new OPTION-backed section made the
 * builder's computed-text map demand an entry for it, so the obvious way through
 * the error was to add a key that is never read and now claims the section is
 * computed. Flipping an existing section from `option` to `computed` did the
 * opposite and was worse: this type kept excluding it, so the map did not require
 * its text, the lookup found nothing, and the section rendered empty forever with
 * a green build.
 */
export type ComputedRuntimeSectionId = Extract<RuntimeSectionEntry, { input: { kind: "computed" } }>["id"];

/**
 * Every option key the registry declares, as a union of literals.
 *
 * This is what lets `system-prompt.ts` prove the keys are real fields of
 * `BuildSystemPromptOptions`. The registry cannot import that interface (a
 * cycle), so it names keys as strings; exporting the literals instead of `string`
 * is what makes the check on the other side possible at all.
 */
export type OptionBackedSectionKey = Extract<RuntimeSectionEntry, { input: { kind: "option" } }>["input"]["key"];

/**
 * The banner that introduces the argot handle table, read off the section that
 * owns it rather than restated.
 *
 * Callers that need to ask "did the handle table actually reach this prompt?"
 * (the arm's post-refresh probe in `sdk.ts`, and the bench that reads its record)
 * must test for the same bytes the assembler emits. Spelling the banner out a
 * second time would let the two drift apart silently, and the failure mode of
 * that drift is a probe that reports "no handles taught" on a perfectly armed
 * session.
 */
const SHORTHAND_HANDLES_SECTION = RUNTIME_SECTIONS[2];

/**
 * The positional pick above is the `shorthand-handles` row, proved at build time.
 *
 * `RUNTIME_SECTIONS.find(...)` returns `T | undefined`, and the old code spent an
 * `as string` to get rid of the `undefined` — a cast that would have turned a
 * renamed or deleted row into a banner of literal `"undefined"` rather than a
 * failure. Indexing a const tuple has an exact type instead, so the row can be
 * checked rather than asserted, and this initializer stops being assignable if
 * the rows are ever reordered.
 */
const _assertHandlesRow: (typeof SHORTHAND_HANDLES_SECTION)["id"] extends "shorthand-handles" ? true : never = true;
void _assertHandlesRow;

export const ARGOT_HANDLES_BANNER: string = renderBanner(SHORTHAND_HANDLES_SECTION.name);

/** Every section, in the order it reaches the model. */
export const SYSTEM_PROMPT_SECTIONS: readonly SystemPromptSection[] = [...TEMPLATE_SECTIONS, ...RUNTIME_SECTIONS];

/**
 * Every banner-bearing section, in order — template and runtime alike.
 *
 * This is what makes the model uniform: the splitter and the reorderer key off
 * THIS list, so a runtime section is as addressable as a template one. Only
 * `conventions` is absent, because it has no banner to find.
 */
export const BANNERED_SECTIONS: readonly (SystemPromptSection & { name: string })[] =
	SYSTEM_PROMPT_SECTIONS.filter(hasBanner);

/**
 * The banner-bearing sections OF THE TEMPLATE FILE only.
 *
 * `default-template.ts` splits `system-prompt.md` on these offsets, so it must
 * look for exactly the banners that file contains — a runtime banner is not in
 * it, and searching for one would throw. The reorderer, which works on the
 * assembled prompt, uses {@link BANNERED_SECTIONS} instead.
 */
export const BANNERED_TEMPLATE_SECTIONS: readonly (TemplateSection & { name: string })[] =
	TEMPLATE_SECTIONS.filter(hasBanner);

/**
 * The camelCase override keys for the template sections, in document order.
 *
 * Derived, never declared: the override keys and the section ids used to be two
 * hand-written lists, so renaming a section meant editing both and nothing caught
 * a mistake. `kebabToCamel` (@veyyon/utils) owns the conversion itself, so this
 * file does not hand-roll a second copy of it either.
 */
export const TEMPLATE_SECTION_CAMEL_KEYS: readonly string[] = TEMPLATE_SECTION_IDS.map(kebabToCamel);

/**
 * Prefix a runtime section's rendered text with its registered banner.
 *
 * Returns "" for empty text so an absent section stays absent rather than
 * becoming a bare banner with nothing under it — a heading promising content
 * that is not there reads as a truncation bug to the model.
 */
export function withSectionBanner(section: RuntimeSection, text: string | undefined): string {
	const body = text?.trim();
	if (!body) return "";
	return `${renderBanner(section.name)}\n\n${body}`;
}

/**
 * Runtime sections whose text arrives as a `buildSystemPrompt` option.
 *
 * The wiring contract keys off this list: every entry names an option a
 * production caller must populate, and `system-prompt-wiring.test.ts` fails if
 * one is declared but never set at the real call site.
 */
export type OptionBackedRuntimeSection = Extract<RuntimeSectionEntry, { input: { kind: "option" } }>;

/**
 * Narrow a registry row to the option-backed case.
 *
 * A predicate rather than an inline `section.input.kind === "option"` because
 * TypeScript does not narrow a value from a check on a NESTED property: writing
 * the comparison inline leaves `section` un-narrowed, and the assembler's two
 * branches then need casts to index anything — which is exactly how it silently
 * drifted from the registry before. One predicate, used by the filter below and
 * by `system-prompt.ts`, keeps both branches checked with no cast anywhere.
 */
export function isOptionBackedSection(section: RuntimeSectionEntry): section is OptionBackedRuntimeSection {
	return section.input.kind === "option";
}

export const OPTION_BACKED_RUNTIME_SECTIONS: readonly OptionBackedRuntimeSection[] =
	RUNTIME_SECTIONS.filter(isOptionBackedSection);
