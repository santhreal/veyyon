/**
 * The single registry of every section in the model's system prompt.
 *
 * Rows declare section identity, order, purpose, source class, and banner name.
 * Statement modules own the static instruction text. Runtime producers own
 * volatile text. `renderBanner` turns every declared name into model-visible
 * bytes, so neither the zero-prose outer template nor an override file owns a
 * banner.
 *
 * The `template` source label means the static provider-cache prefix assembled
 * into the outer template slot. It does not mean prose is read from
 * `prompts/session/system-prompt.md`. The `runtime` label means a separately
 * emitted provider-cache part whose text may change during a session.
 *
 * `buildSystemPrompt` keeps the static prefix in one array entry and emits
 * volatile runtime sections separately. That boundary is a provider caching
 * contract, not a difference in addressability: all bannered sections use the
 * same registry, splitter, override vocabulary, and ordering rules.
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
 * A row in the system prompt's section list: static-prefix or runtime-sourced.
 *
 * This union extends the shared `PromptSection` shape with source information
 * used for provider-cache boundaries.
 */
export type SystemPromptSection = TemplateSection | RuntimeSection;

/**
 * Static cached-prefix sections in model-visible order.
 *
 * Their bodies come exclusively from statement modules and are inserted into
 * the zero-prose outer template as one complete document. `as const satisfies`
 * preserves literal ids for the unions derived below.
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
 * Banner-bearing static sections.
 *
 * These rows define the banner table used to split, inspect, override, and
 * reorder the statement-assembled cached prefix.
 */
export const BANNERED_TEMPLATE_SECTIONS: readonly (TemplateSection & { name: string })[] =
	TEMPLATE_SECTIONS.filter(hasBanner);

/** Type-level counterpart to {@link kebabToCamel} for registry-derived keys. */
type KebabToCamelKey<Value extends string> = Value extends `${infer Head}-${infer Tail}`
	? `${Head}${Capitalize<KebabToCamelKey<Tail>>}`
	: Value;

/** Internal camel-case key for one static section. */
export type TemplateSectionKey = KebabToCamelKey<TemplateSectionId>;

/**
 * The camelCase override keys for the template sections, in document order.
 *
 * Derived, never declared: the override keys and the section ids used to be two
 * hand-written lists, so renaming a section meant editing both and nothing caught
 * a mistake. `kebabToCamel` (@veyyon/utils) owns the conversion itself, so this
 * file does not hand-roll a second copy of it either.
 */
export const TEMPLATE_SECTION_CAMEL_KEYS: readonly TemplateSectionKey[] = TEMPLATE_SECTION_IDS.map(
	kebabToCamel,
) as TemplateSectionKey[];

/**
 * Prefix assembled section body text with its registered banner.
 *
 * Returns "" for empty text so an absent optional section stays absent rather
 * than becoming a bare banner. The same function serves default and runtime
 * sections, so the registry is the only owner of banner bytes.
 */
export function withSectionBanner(
	section: SystemPromptSection & { readonly name: string },
	text: string | undefined,
): string {
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
