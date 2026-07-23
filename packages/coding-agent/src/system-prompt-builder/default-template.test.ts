import { describe, expect, it } from "bun:test";
import systemPromptTemplate from "../prompts/system/system-prompt.md" with { type: "text" };
import {
	assembleDefaultTemplate,
	DEFAULT_TEMPLATE_SECTION_ORDER,
	DEFAULT_TEMPLATE_SECTIONS,
	splitDefaultTemplate,
} from "./default-template";

/**
 * Golden and behavior tests for the default-template composition seam.
 *
 * WHY THIS EXISTS: `assembleDefaultTemplate` lets prompt experiments swap one
 * banner section (e.g. tool policy) while leaving the rest byte-for-byte
 * untouched. That promise only holds if (a) reassembly with no overrides equals
 * the shipped file exactly, and (b) an override replaces exactly the one section
 * it targets. If either breaks, an experiment could shift or drop content in a
 * region it never meant to edit — the silent-drop failure this seam exists to
 * prevent (delegation settings rendered dead by a stray monolith edit).
 */

describe("assembleDefaultTemplate byte-equality", () => {
	/**
	 * The core golden invariant: with no overrides, the assembled template is
	 * byte-for-byte identical to the single source file. The sections are exact
	 * slices at banner offsets, so any drift here means the slice/rejoin logic
	 * lost or duplicated bytes.
	 */
	it("reproduces the source template exactly with no overrides", () => {
		expect(assembleDefaultTemplate()).toBe(systemPromptTemplate);
	});

	/** Empty override object must behave identically to no argument at all. */
	it("treats an empty override object as no override", () => {
		expect(assembleDefaultTemplate({})).toBe(systemPromptTemplate);
	});

	/** Concatenating the exported sections in canonical order is the source file. */
	it("concatenates its sections in order back into the source", () => {
		const joined = DEFAULT_TEMPLATE_SECTION_ORDER.map(key => DEFAULT_TEMPLATE_SECTIONS[key]).join("");
		expect(joined).toBe(systemPromptTemplate);
	});
});

describe("default template section boundaries", () => {
	/**
	 * Each non-preamble section owns its banner: the slice for `role` starts with
	 * `ROLE\n==`, and so on. This pins that the offsets landed on the banner
	 * starts (not mid-line), which is what makes an override target the intended
	 * region rather than a shifted one.
	 */
	it("starts each banner section with its banner line", () => {
		expect(DEFAULT_TEMPLATE_SECTIONS.role.startsWith("ROLE\n==")).toBe(true);
		expect(DEFAULT_TEMPLATE_SECTIONS.runtime.startsWith("RUNTIME\n==")).toBe(true);
		expect(DEFAULT_TEMPLATE_SECTIONS.toolPolicy.startsWith("TOOL POLICY\n==")).toBe(true);
		expect(DEFAULT_TEMPLATE_SECTIONS.executionWorkflow.startsWith("EXECUTION WORKFLOW\n==")).toBe(true);
		expect(DEFAULT_TEMPLATE_SECTIONS.deliveryContract.startsWith("DELIVERY CONTRACT\n==")).toBe(true);
	});

	/** The preamble (`conventions`) precedes ROLE and carries no later banner. */
	it("puts the conventions preamble first and free of later banners", () => {
		expect(systemPromptTemplate.startsWith(DEFAULT_TEMPLATE_SECTIONS.conventions)).toBe(true);
		expect(DEFAULT_TEMPLATE_SECTIONS.conventions).not.toContain("ROLE\n==");
		expect(DEFAULT_TEMPLATE_SECTIONS.conventions).not.toContain("DELIVERY CONTRACT\n==");
	});

	/** Every section is non-empty; a blank slice means two banners collided. */
	it("produces a non-empty slice for every section", () => {
		for (const key of DEFAULT_TEMPLATE_SECTION_ORDER) {
			expect(DEFAULT_TEMPLATE_SECTIONS[key].length).toBeGreaterThan(0);
		}
	});
});

describe("assembleDefaultTemplate overrides", () => {
	/**
	 * An override replaces exactly its target section and nothing else. We swap
	 * `toolPolicy` for a sentinel and assert: the sentinel is present, the
	 * original tool-policy body is gone, and every other section's bytes are
	 * still verbatim in the output.
	 */
	it("replaces only the targeted section, leaving the rest byte-for-byte", () => {
		const sentinel = "TOOL POLICY\n====\nSENTINEL-REPLACEMENT-BODY\n";
		const out = assembleDefaultTemplate({ toolPolicy: sentinel });

		expect(out).toContain("SENTINEL-REPLACEMENT-BODY");
		// The original tool-policy body must be gone (pick a stable phrase from it).
		expect(DEFAULT_TEMPLATE_SECTIONS.toolPolicy).toContain("# Delegation");
		expect(out).not.toContain("# Delegation");

		// Every untouched section survives verbatim, in order, around the sentinel.
		for (const key of DEFAULT_TEMPLATE_SECTION_ORDER) {
			if (key === "toolPolicy") continue;
			expect(out).toContain(DEFAULT_TEMPLATE_SECTIONS[key]);
		}
		// And the result equals the source with only the tool-policy slice swapped.
		const expected = systemPromptTemplate.replace(DEFAULT_TEMPLATE_SECTIONS.toolPolicy, sentinel);
		expect(out).toBe(expected);
	});

	/** Overriding several sections at once composes; each lands in document order. */
	it("applies multiple section overrides together", () => {
		const out = assembleDefaultTemplate({ role: "ROLE\n====\nR\n", deliveryContract: "DELIVERY CONTRACT\n====\nD\n" });
		expect(out).toContain("\nR\n");
		expect(out).toContain("\nD\n");
		expect(out.indexOf("\nR\n")).toBeLessThan(out.indexOf("\nD\n"));
	});
});

describe("splitDefaultTemplate fail-loud contract", () => {
	/**
	 * A template missing a banner must throw, not silently merge two sections.
	 * Silent merging would let an override for the swallowed section rewrite the
	 * wrong region — the exact class of bug this seam prevents (Law 10: no silent
	 * fallbacks).
	 */
	it("throws when a required banner is absent", () => {
		const mangled = systemPromptTemplate.replace("TOOL POLICY\n==", "TOOL POLICY REMOVED\n==");
		expect(() => splitDefaultTemplate(mangled)).toThrow(/TOOL POLICY.*banner/s);
	});

	/** The named section appears in the error so the failure is diagnosable. */
	it("names the missing section in the error", () => {
		const mangled = systemPromptTemplate.replace("EXECUTION WORKFLOW\n==", "EXECUTION FLOW\n==");
		expect(() => splitDefaultTemplate(mangled)).toThrow(/executionWorkflow/);
	});
});
