/**
 * Every option-backed prompt section must actually be wired by a real caller.
 *
 * WHY THIS SUITE EXISTS. A settings-gated section reaches the model through a
 * four-link chain:
 *
 *     setting -> BuildSystemPromptOptions field -> value resolved in sdk.ts -> prompt
 *
 * Only the last link was enforced. The assembler's map is keyed by the section-id
 * union, so a registered section with no text entry fails the build — but nothing
 * checked that the text was ever POPULATED. A section whose option was declared
 * and threaded through, yet never set from its setting at the real call site,
 * compiled, shipped, and rendered nothing forever. Every test passed, because the
 * parity harness passes text in directly as a builder option and so exercises the
 * builder, never the settings path.
 *
 * That is not hypothetical: `argotHandles` had exactly one production reference,
 * and "the handle table never appeared" was a live question for days. It turned
 * out to be wired correctly, but nothing structural would have caught the
 * opposite.
 *
 * The registry now declares each runtime section's input (`computed`, or
 * `option` with its key), a compile-time check in `system-prompt.ts` proves each
 * declared key is a real option, and this suite proves a production caller sets
 * it. The chain is enforced end to end.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { buildSystemPrompt } from "@veyyon/coding-agent/system-prompt";
import {
	OPTION_BACKED_RUNTIME_SECTIONS,
	RUNTIME_SECTIONS,
} from "@veyyon/coding-agent/system-prompt-builder/prompt-blocks";

/** The production entry point that builds the prompt for a real session. */
const SDK_SOURCE = readFileSync(fileURLToPath(new URL("../src/sdk.ts", import.meta.url)), "utf8");

const EMPTY_TREE = {
	rootPath: "/tmp",
	rendered: "",
	truncated: false,
	totalLines: 0,
	agentsMdFiles: [] as string[],
};

describe("option-backed sections are wired by a production caller", () => {
	/**
	 * The core contract. For each section the registry says arrives as an option,
	 * `sdk.ts` must set that option — and set it to something other than a bare
	 * `undefined`, which would be a wire that carries nothing.
	 */
	for (const section of OPTION_BACKED_RUNTIME_SECTIONS) {
		it(`sdk.ts populates "${section.input.key}" for the ${section.id} section`, () => {
			const assignment = new RegExp(`\\b${section.input.key}\\s*:\\s*([^,\\n]+)`).exec(SDK_SOURCE);
			expect(
				assignment,
				`no production caller sets "${section.input.key}", so the ${section.id} section can never render`,
			).not.toBeNull();

			const value = assignment?.[1]?.trim() ?? "";
			// A literal `undefined` is the shape of a section that was declared,
			// threaded through, and then never actually connected to its setting.
			expect(value, `"${section.input.key}" is wired to a constant undefined`).not.toBe("undefined");
		});
	}

	/**
	 * The registry must not quietly drift into having no option-backed sections at
	 * all, which would make every loop above vacuous and this file green while
	 * covering nothing.
	 */
	it("has option-backed sections to check", () => {
		expect(OPTION_BACKED_RUNTIME_SECTIONS.length).toBeGreaterThan(0);
		expect(OPTION_BACKED_RUNTIME_SECTIONS.every(s => s.input.kind === "option")).toBe(true);
	});

	/**
	 * Every runtime section is either computed by the builder or option-backed.
	 * A third state would be a section with no text source at all — registered,
	 * emitted, and permanently empty.
	 */
	it("gives every runtime section a declared text source", () => {
		for (const section of RUNTIME_SECTIONS) {
			expect(["computed", "option"]).toContain(section.input.kind);
		}
	});
});

describe("an option-backed section renders exactly what its option carries", () => {
	/**
	 * The behavioral half: the declared key is not merely present in the source,
	 * it is the key the builder actually reads. A registry pointing at the wrong
	 * option would pass the source scan above and still render nothing.
	 */
	for (const section of OPTION_BACKED_RUNTIME_SECTIONS) {
		it(`renders the ${section.id} section from its declared option key`, async () => {
			const marker = `<<WIRED-${section.id.toUpperCase()}>>`;
			const result = await buildSystemPrompt({
				toolNames: ["read"],
				contextFiles: [],
				skills: [],
				rules: [],
				workspaceTree: EMPTY_TREE,
				activeRepoContext: null,
				[section.input.key]: marker,
			} as Parameters<typeof buildSystemPrompt>[0]);
			const joined = result.systemPrompt.join("\n");

			expect(joined).toContain(marker);
			// It must arrive under its own banner, not smuggled into another section.
			const bannerLine = section.banner.split("\n")[0] as string;
			expect(joined.indexOf(marker)).toBeGreaterThan(joined.indexOf(bannerLine));
		});
	}
});
