/**
 * The runtime-section registry is the ONE place a prompt section is described,
 * and every other statement about sections is derived from it.
 *
 * WHY THIS SUITE EXISTS. `RUNTIME_SECTIONS` says, per section, where its text
 * comes from: `{ kind: "computed" }` (the builder produces it) or
 * `{ kind: "option", key }` (a caller passes it in). Two consumers have to agree
 * with that, and both were hand-written restatements that could not disagree
 * loudly:
 *
 *   1. `ComputedRuntimeSectionId` keyed the assembler's `computedText` map. It was
 *      spelled `Exclude<RuntimeSectionId, "shorthand" | "shorthand-handles">` — a
 *      literal list of the option-backed ids, retyped by hand. Adding an
 *      option-backed section therefore demanded a `computedText` entry for a
 *      section the builder does not compute (proved: adding a `house-style`
 *      option section produced `TS2741: Property '"house-style"' is missing`),
 *      and the only way to satisfy it was to add a bogus entry or to widen the
 *      map, both of which reintroduce the silent-empty failure.
 *
 *   2. The compile-time proof that each declared option key is a real field of
 *      `BuildSystemPromptOptions` cast its own input:
 *      `section => section.input.key as StringOptionKeys`. A cast asserts, it does
 *      not check, so the proof proved nothing. Proved by experiment: pointing a
 *      section at `"thisOptionDoesNotExist"` compiled clean, and the section would
 *      have rendered nothing for the life of the product while the comment above
 *      the check told the reader it was covered.
 *
 * Both are now derived from the registry itself (`Extract<...>` over
 * `typeof RUNTIME_SECTIONS[number]`), which is why the registry is declared
 * `as const satisfies` rather than annotated: an annotation widens `input.kind`
 * to the union and `input.key` to `string`, and a derivation over widened types
 * collapses to `string` and stops discriminating. That is the subtlety this file
 * guards, because it is invisible at the call site and re-annotating the registry
 * looks like a tidy-up.
 *
 * The contract these tests hold: adding a settings-gated preamble section costs
 * exactly two edits (a registry row, and the option field it names), the compiler
 * rejects it if either is missing or they disagree, and nothing about the
 * assembler has to be touched.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import {
	type ComputedRuntimeSectionId,
	isOptionBackedSection,
	OPTION_BACKED_RUNTIME_SECTIONS,
	type OptionBackedSectionKey,
	RUNTIME_SECTION_IDS,
	RUNTIME_SECTIONS,
} from "@veyyon/coding-agent/system-prompt-builder/section-registry";

const readSource = (rel: string): string => readFileSync(fileURLToPath(new URL(rel, import.meta.url)), "utf8");
const PROMPT_BLOCKS_SOURCE = readSource("../src/system-prompt-builder/section-registry.ts");
const SYSTEM_PROMPT_SOURCE = readSource("../src/system-prompt.ts");

/**
 * Source with comments removed, for the "this cast must not come back" scans.
 *
 * Both files explain the bug by QUOTING the code that caused it, so a scan over
 * the raw text matches the explanation and fails on a file that is correct. The
 * comments are the most valuable part of these files and must not have to be
 * written around, so the scan looks at code instead. Strings are left alone: no
 * assertion below targets text that could legitimately appear in a string
 * literal, and stripping them properly needs a parser.
 */
const codeOf = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");
const SYSTEM_PROMPT_CODE = codeOf(SYSTEM_PROMPT_SOURCE);
const PROMPT_BLOCKS_CODE = codeOf(PROMPT_BLOCKS_SOURCE);

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

type BuildOptions = Parameters<typeof buildSystemPrompt>[0];
const baseOptions = (): BuildOptions =>
	({
		toolNames: ["read"],
		contextFiles: [],
		skills: [],
		rules: [],
		workspaceTree: EMPTY_TREE,
		activeRepoContext: null,
	}) as BuildOptions;

/**
 * A type is exactly `string` (fully widened) rather than a union of literals.
 * `[T] extends [string]` alone is true of any literal union, so the reverse
 * direction is what actually detects widening.
 */
type IsExactlyString<T> = [T] extends [string] ? ([string] extends [T] ? true : false) : false;

describe("the registry keeps literal types, so derivations over it discriminate", () => {
	/**
	 * The load-bearing declaration. `RUNTIME_SECTIONS` is
	 * `[...] as const satisfies readonly RuntimeSection[]`, NOT
	 * `: readonly RuntimeSection[] = [...]`. The annotated form typechecks, reads
	 * cleaner, and silently destroys every derivation in this file: `input.key`
	 * widens to `string`, so `OptionBackedSectionKey` becomes `string`, so the
	 * "is this a real option field" proof accepts every string, so a typo in a key
	 * ships. This asserts the source, because the failure it prevents is somebody
	 * "fixing" the odd-looking declaration.
	 */
	it("declares RUNTIME_SECTIONS with `as const satisfies` and no widening annotation", () => {
		expect(PROMPT_BLOCKS_SOURCE).toContain("export const RUNTIME_SECTIONS = [");
		expect(PROMPT_BLOCKS_SOURCE).toContain("] as const satisfies readonly RuntimeSection[];");
		expect(PROMPT_BLOCKS_CODE).not.toContain("export const RUNTIME_SECTIONS: readonly RuntimeSection[]");
	});

	/**
	 * The type-level consequence, checked by the package typecheck rather than at
	 * runtime: option keys must still be a union of literals. If the annotation
	 * above comes back, `OptionBackedSectionKey` becomes `string` and this
	 * initializer stops being assignable.
	 */
	it("keeps OptionBackedSectionKey a union of literals rather than plain string", () => {
		const optionKeysAreLiterals: IsExactlyString<OptionBackedSectionKey> extends false ? true : never = true;
		const computedIdsAreLiterals: IsExactlyString<ComputedRuntimeSectionId> extends false ? true : never = true;

		expect(optionKeysAreLiterals).toBe(true);
		expect(computedIdsAreLiterals).toBe(true);
	});
});

describe("computed and option-backed sections are derived from the rows, not restated", () => {
	/**
	 * Non-vacuity first. Every assertion below compares sets built from the
	 * registry; if the registry were empty they would all pass while proving
	 * nothing, which is the way a structural guard rots into decoration.
	 */
	it("has both kinds of section to compare", () => {
		expect(RUNTIME_SECTIONS.length).toBeGreaterThan(2);
		expect(OPTION_BACKED_RUNTIME_SECTIONS.map(s => s.id).sort()).toEqual([
			"available-secrets",
			"shorthand",
			"shorthand-handles",
		]);
		expect(RUNTIME_SECTIONS.filter(s => s.input.kind === "computed").map(s => s.id)).toEqual(["project"]);
	});

	/**
	 * The partition is total and disjoint. A section in neither set has no text
	 * source and renders empty forever; a section in both has two, and whichever
	 * the assembler consults first silently wins.
	 */
	it("puts every runtime section in exactly one of the two sets", () => {
		const optionIds = new Set<string>(OPTION_BACKED_RUNTIME_SECTIONS.map(s => s.id));
		const computedIds = new Set<string>(RUNTIME_SECTIONS.filter(s => !isOptionBackedSection(s)).map(s => s.id));

		expect([...optionIds].filter(id => computedIds.has(id))).toEqual([]);
		expect([...optionIds, ...computedIds].sort()).toEqual([...RUNTIME_SECTION_IDS].sort());
	});

	/**
	 * `isOptionBackedSection` is the one predicate both the filter and the
	 * assembler use. Inlining `section.input.kind === "option"` at either site
	 * does not narrow `section` (TypeScript does not narrow a parent value from a
	 * nested discriminant), which is what forced the casts that hid the drift.
	 */
	it("agrees with the row's own declared kind in both directions", () => {
		for (const section of RUNTIME_SECTIONS) {
			expect(isOptionBackedSection(section), `${section.id} disagrees with its declared kind`).toBe(
				section.input.kind === "option",
			);
		}
	});

	/**
	 * The specific hand-written restatement that caused the bug. `Exclude<
	 * RuntimeSectionId, ...>` names option-backed ids by hand, so it goes stale the
	 * moment a section is added or reclassified, and it goes stale silently.
	 */
	it("derives ComputedRuntimeSectionId from the rows instead of Exclude-ing ids by hand", () => {
		expect(PROMPT_BLOCKS_SOURCE).toContain(
			'export type ComputedRuntimeSectionId = Extract<RuntimeSectionEntry, { input: { kind: "computed" } }>["id"];',
		);
		for (const source of [PROMPT_BLOCKS_CODE, SYSTEM_PROMPT_CODE]) {
			expect(source).not.toContain("Exclude<RuntimeSectionId");
		}
	});
});

describe("neither side of the assembler asserts what it should be checking", () => {
	/**
	 * The root cause, stated as a rule. The old proof read
	 * `section.input.key as StringOptionKeys`: it cast the value it was about to
	 * check, so it could not fail. A cast anywhere in this chain re-creates a proof
	 * that proves nothing while reading, to a reviewer, exactly like one that does.
	 */
	it("builds the option-key proof without casting its own input", () => {
		// Non-vacuity: the stripper must not have eaten the file, or every
		// `not.toContain` below passes against an empty string.
		expect(SYSTEM_PROMPT_CODE).toContain("export async function buildSystemPrompt");

		expect(SYSTEM_PROMPT_CODE).not.toContain("as StringOptionKeys");
		expect(SYSTEM_PROMPT_CODE).not.toContain("as keyof BuildSystemPromptOptions");
		expect(SYSTEM_PROMPT_CODE).not.toContain("as ComputedRuntimeSectionId");
		// The proof still has to exist. Deleting it would also satisfy the three
		// assertions above.
		expect(SYSTEM_PROMPT_CODE).toContain("type UnknownDeclaredOptionKeys = Exclude<OptionBackedSectionKey");
		expect(SYSTEM_PROMPT_SOURCE).toContain(
			"section-registry.ts declares a section option key that is not a string field of BuildSystemPromptOptions",
		);
	});

	/**
	 * The text lookup indexes with the registry's own literal types on both
	 * branches. If either branch is cast back to `string`/`any`, a key naming no
	 * option and an id missing from `computedText` both read `undefined`, the
	 * section renders nothing, and the build stays green.
	 */
	it("reads both branches through the predicate with no cast", () => {
		const lookup = /const runtimeText = \(section: RuntimeSectionEntry\): string \| undefined =>\n(.*?);\n/s.exec(
			SYSTEM_PROMPT_SOURCE,
		);

		expect(lookup, "the runtimeText lookup was renamed or restructured").not.toBeNull();
		const body = lookup?.[1] ?? "";
		expect(body).toContain("isOptionBackedSection(section)");
		expect(body).toContain("options[section.input.key]");
		expect(body).toContain("computedText[section.id]");
		expect(body).not.toMatch(/\bas\b/);
	});
});

describe("a section's text reaches the prompt from its declared source only", () => {
	/**
	 * What the derivation buys, checked as behaviour rather than as types. Each
	 * option-backed section renders from ITS OWN key: passing a marker under one
	 * key must not surface under another section's banner, which is the failure a
	 * mis-typed key produces.
	 */
	for (const section of OPTION_BACKED_RUNTIME_SECTIONS) {
		it(`renders ${section.id} from "${section.input.key}" and leaves the other sections alone`, async () => {
			const marker = `<<ONLY-${section.id.toUpperCase()}>>`;
			const result = await buildSystemPrompt({ ...baseOptions(), [section.input.key]: marker } as BuildOptions);
			const joined = result.systemPrompt.join("\n");

			expect(joined).toContain(marker);
			// Exactly once: a section read through two paths would emit it twice.
			expect(joined.split(marker).length - 1).toBe(1);

			const ownBanner = section.name;
			const markerAt = joined.indexOf(marker);
			const ownBannerAt = joined.lastIndexOf(ownBanner, markerAt);
			expect(ownBannerAt, `${marker} is not under the ${ownBanner} banner`).toBeGreaterThanOrEqual(0);
			// Nothing else may sit between the banner and the text it introduces.
			// Compared line by line, not by substring: banner names are prefixes of
			// each other ("SHORTHAND" is a prefix of "SHORTHAND HANDLES"), so a
			// substring check reports every handles section as containing a stray
			// shorthand banner.
			const betweenLines = new Set(joined.slice(ownBannerAt + ownBanner.length, markerAt).split("\n"));
			for (const other of RUNTIME_SECTIONS) {
				if (other.id === section.id) continue;
				const otherBanner = other.name;
				expect(
					betweenLines.has(otherBanner),
					`${other.id}'s banner opened between ${section.id}'s banner and its text`,
				).toBe(false);
			}
		});
	}

	/**
	 * The absent case. `withSectionBanner` returns "" for empty text so an omitted
	 * section stays omitted; emitting a bare banner would hand the model a heading
	 * promising content that is not there, which reads as truncation.
	 */
	it("omits an option-backed section entirely when its option is absent", async () => {
		const result = await buildSystemPrompt(baseOptions());
		const joined = result.systemPrompt.join("\n");

		// Line-exact, for the same prefix reason as above, and because a banner name
		// can legitimately occur as prose inside another section's body.
		const lines = new Set(joined.split("\n"));
		for (const section of OPTION_BACKED_RUNTIME_SECTIONS) {
			const banner = section.name;
			expect(lines.has(banner), `${section.id} emitted a bare banner with no body`).toBe(false);
		}
	});

	/**
	 * A computed section is NOT reachable through the options bag. If it were, a
	 * caller could overwrite text the builder is responsible for producing, and the
	 * two sources would race with no diagnostic.
	 */
	it("keeps computed section ids out of the option-key vocabulary", () => {
		const optionKeys = new Set<string>(OPTION_BACKED_RUNTIME_SECTIONS.map(s => s.input.key));
		const computed = RUNTIME_SECTIONS.filter(s => !isOptionBackedSection(s));

		expect(computed.length).toBeGreaterThan(0);
		for (const section of computed) {
			expect(optionKeys.has(section.id)).toBe(false);
			// camelCase form too: `shorthand-handles` -> `shorthandHandles`.
			const camel = section.id.replace(/-([a-z])/g, (_, c: string) => c.toUpperCase());
			expect(optionKeys.has(camel)).toBe(false);
		}
	});
});
