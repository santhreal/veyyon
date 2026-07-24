import { describe, expect, it } from "bun:test";
import systemPromptTemplate from "../prompts/system/system-prompt.md" with { type: "text" };
import {
	assembleDefaultTemplate,
	DEFAULT_TEMPLATE_SECTION_ORDER,
	DEFAULT_TEMPLATE_SECTIONS,
	parseSectionOverridesJson,
	resolveSectionOverrides,
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
		const out = assembleDefaultTemplate({
			role: "ROLE\n====\nR\n",
			deliveryContract: "DELIVERY CONTRACT\n====\nD\n",
		});
		expect(out).toContain("\nR\n");
		expect(out).toContain("\nD\n");
		expect(out.indexOf("\nR\n")).toBeLessThan(out.indexOf("\nD\n"));
	});
});

describe("resolveSectionOverrides", () => {
	/**
	 * The happy path: a valid section name whose replacement keeps the banner is
	 * accepted verbatim. This is the single-region prompt experiment working.
	 */
	it("passes a valid, banner-preserving override through unchanged", () => {
		const replacement = "TOOL POLICY\n====\ncompressed body\n";
		expect(resolveSectionOverrides({ toolPolicy: replacement })).toEqual({ toolPolicy: replacement });
	});

	/** No overrides (undefined or empty) resolves to an empty map, never throws. */
	it("resolves undefined and empty input to an empty map", () => {
		expect(resolveSectionOverrides(undefined)).toEqual({});
		expect(resolveSectionOverrides({})).toEqual({});
	});

	/**
	 * An unknown section name MUST throw. Silently ignoring it would run the eval
	 * against the unmodified prompt while the operator believes the change is
	 * live — a false result with no signal (Law 10: no silent fallback).
	 */
	it("throws loudly on an unknown section name, listing the valid sections", () => {
		expect(() => resolveSectionOverrides({ delegation: "whatever" })).toThrow(/unknown section "delegation"/);
		expect(() => resolveSectionOverrides({ toolpolicy: "x" })).toThrow(/valid sections:.*toolPolicy/s);
	});

	/**
	 * A replacement that drops its banner MUST throw. A banner-less section would
	 * collapse into its neighbor on the next split and let a later override target
	 * the wrong region — and it is the shape a from-scratch rewrite takes when it
	 * silently omits content. Requiring the banner forces editing the real
	 * section.
	 */
	it("throws when a banner-bearing section's replacement omits its banner", () => {
		expect(() => resolveSectionOverrides({ toolPolicy: "# General\njust the body, no banner\n" })).toThrow(
			/must begin with its section banner/,
		);
		expect(() => resolveSectionOverrides({ role: "You are a helpful assistant.\n" })).toThrow(
			/must begin with its section banner/,
		);
	});

	/** `conventions` has no banner, so a banner-less replacement is accepted. */
	it("accepts a banner-less replacement for the bannerless conventions preamble", () => {
		const replacement = "<system-conventions>\ncustom conventions\n</system-conventions>\n";
		expect(resolveSectionOverrides({ conventions: replacement })).toEqual({ conventions: replacement });
	});

	/**
	 * A non-string replacement value MUST throw. The env payload is arbitrary
	 * JSON, so a section could be given a number, an object, or null; coercing it
	 * to a string (`String(value)`) would splice `"[object Object]"` or `"null"`
	 * into the prompt and run a garbage eval that looks like it succeeded.
	 */
	it("throws when a section's replacement is not a string", () => {
		expect(() => resolveSectionOverrides({ role: 42 })).toThrow(/must be a string, got number/);
		expect(() => resolveSectionOverrides({ role: null })).toThrow(/must be a string, got null/);
		expect(() => resolveSectionOverrides({ role: { a: 1 } })).toThrow(/must be a string, got object/);
	});
});

/**
 * These tests lock the eval-only env payload parser. The override reaches the
 * prompt builder ONLY through `VEYYON_EVAL_SYSTEM_PROMPT_SECTIONS`, whose value
 * is an untrusted JSON string set by the benchmark harness. Every malformed
 * payload must fail loudly (never silently fall back to the production prompt,
 * which would invalidate the eval while appearing to succeed), and the only
 * quiet case is an absent/empty var meaning "use production".
 */
describe("parseSectionOverridesJson", () => {
	it("returns an empty map for an absent or blank var (the production prompt)", () => {
		expect(parseSectionOverridesJson(undefined)).toEqual({});
		expect(parseSectionOverridesJson("")).toEqual({});
		expect(parseSectionOverridesJson("   \n ")).toEqual({});
	});

	it("parses a valid single-section JSON payload", () => {
		const payload = JSON.stringify({ role: "ROLE\n====\ncompressed role\n" });
		expect(parseSectionOverridesJson(payload)).toEqual({ role: "ROLE\n====\ncompressed role\n" });
	});

	it("throws on non-JSON so a typo never silently reverts to the production prompt", () => {
		expect(() => parseSectionOverridesJson("{not json")).toThrow(/not valid JSON/);
		expect(() => parseSectionOverridesJson("role=ROLE")).toThrow(/not valid JSON/);
	});

	it("throws on a non-object JSON payload (array, string, number, null)", () => {
		expect(() => parseSectionOverridesJson("[]")).toThrow(/must be a JSON object.*got an array/s);
		expect(() => parseSectionOverridesJson('"role"')).toThrow(/must be a JSON object.*got string/s);
		expect(() => parseSectionOverridesJson("7")).toThrow(/must be a JSON object.*got number/s);
		expect(() => parseSectionOverridesJson("null")).toThrow(/must be a JSON object.*got null/s);
	});

	it("propagates the section validation (unknown name, banner-less, non-string)", () => {
		expect(() => parseSectionOverridesJson(JSON.stringify({ delegation: "x" }))).toThrow(/unknown section/);
		expect(() => parseSectionOverridesJson(JSON.stringify({ role: "no banner" }))).toThrow(
			/must begin with its section banner/,
		);
		expect(() => parseSectionOverridesJson(JSON.stringify({ role: 5 }))).toThrow(/must be a string/);
	});

	/**
	 * The catastrophe this whole seam exists to prevent: an eval that means to
	 * change one section (here, execution workflow) MUST NOT touch the
	 * settings-gated delegation block, which lives in the tool-policy section and
	 * renders only when the delegation setting is on (`{{#if eagerTasks}}`).
	 * Overriding executionWorkflow leaves tool-policy — banner, delegation
	 * heading, and the `{{#if eagerTasks}}` conditional — byte-for-byte intact,
	 * so the delegation setting keeps working. A whole-prompt snapshot is what
	 * silently deleted this branch; per-section override cannot.
	 */
	it("overriding one section leaves another section's settings-gated block intact", () => {
		const resolved = resolveSectionOverrides({
			executionWorkflow: "EXECUTION WORKFLOW\n====\ncompressed workflow\n",
		});
		const out = assembleDefaultTemplate(resolved);
		expect(out).toContain("compressed workflow");
		// Tool policy (where delegation lives) is untouched: its delegation
		// heading and its settings-gating conditional both survive verbatim.
		expect(DEFAULT_TEMPLATE_SECTIONS.toolPolicy).toContain("# Delegation");
		expect(DEFAULT_TEMPLATE_SECTIONS.toolPolicy).toContain("{{#if eagerTasks}}");
		expect(out).toContain("# Delegation");
		expect(out).toContain("{{#if eagerTasks}}");
		expect(out).toContain(DEFAULT_TEMPLATE_SECTIONS.toolPolicy);
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
