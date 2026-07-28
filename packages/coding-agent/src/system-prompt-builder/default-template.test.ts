import { describe, expect, it } from "bun:test";
import { sessionPrompts } from "../prompts/session/rows";
import {
	assembleDefaultTemplate,
	DEFAULT_TEMPLATE_SECTION_ORDER,
	DEFAULT_TEMPLATE_SLOT,
	type DefaultTemplateSections,
	parseSectionOverridesJson,
	resolveSectionOverrides,
} from "./default-template";

const SECTIONS: DefaultTemplateSections = {
	conventions: "<system-conventions>\nC\n</system-conventions>\n",
	role: "ROLE\n==============\nR\n",
	runtime: "RUNTIME\n==============\nRT\n",
	toolPolicy: "TOOL POLICY\n==============\nT\n",
	executionWorkflow: "EXECUTION WORKFLOW\n==============\nE\n",
	deliveryContract: "DELIVERY CONTRACT\n==============\nD\n",
};

describe("zero-prose default prompt template", () => {
	/**
	 * The outer file must never become a second prose source again. Prompt text
	 * belongs to statement modules and section structure belongs to registries.
	 */
	it("contains exactly one variable slot and no prose or banners", () => {
		const source = sessionPrompts["session/system-prompt"].text;

		expect(source.trim()).toBe(DEFAULT_TEMPLATE_SLOT);
		expect(source.replace(/\{\{templateSections\}\}/g, "").trim()).toBe("");
		expect(source).not.toContain("ROLE");
		expect(source).not.toContain("MUST");
	});

	/**
	 * Filling the slot must preserve every complete modular section in registry
	 * order with one separator and no hidden fallback content.
	 */
	it("assembles only the supplied modular sections in registry order", () => {
		const expected = DEFAULT_TEMPLATE_SECTION_ORDER.map(key => SECTIONS[key]).join("\n");

		expect(assembleDefaultTemplate(SECTIONS)).toBe(expected);
	});

	/**
	 * Section text is data, not a JavaScript replacement string. `$&`, `$`` and
	 * `$'` have special meaning to `String.replace`; treating the assembled body
	 * as its replacement argument corrupted literal prompt guidance.
	 */
	it("preserves JavaScript replacement tokens as literal prompt text", () => {
		const literal = "$& | $` | $' | $$";
		const out = assembleDefaultTemplate({ ...SECTIONS, role: literal });

		expect(out).toContain(literal);
		expect(out).toBe(
			DEFAULT_TEMPLATE_SECTION_ORDER.map(key => (key === "role" ? literal : SECTIONS[key])).join("\n"),
		);
	});

	/**
	 * A replacement must affect only its target. This prevents a one-section
	 * experiment from deleting unrelated gates or policy text.
	 */
	it("replaces only the targeted section body", () => {
		const overrides = resolveSectionOverrides({ "tool-policy": "replacement body" });
		const out = assembleDefaultTemplate({ ...SECTIONS, ...overrides });

		expect(out).toContain("TOOL POLICY\n==============\n\nreplacement body");
		expect(out).not.toContain("\nT\n");
		for (const key of DEFAULT_TEMPLATE_SECTION_ORDER) {
			if (key !== "toolPolicy") expect(out).toContain(SECTIONS[key]);
		}
	});

	/**
	 * Several replacements must retain canonical order regardless of object key
	 * order, because the section registry is the ordering authority.
	 */
	it("applies multiple replacements in registry order", () => {
		const overrides = resolveSectionOverrides({
			"delivery-contract": "delivery replacement",
			role: "role replacement",
		});
		const out = assembleDefaultTemplate({ ...SECTIONS, ...overrides });

		expect(out.indexOf("role replacement")).toBeLessThan(out.indexOf("delivery replacement"));
	});
});

describe("section body override validation", () => {
	/**
	 * Replacement files contain body text only. The assembler must add the exact
	 * registry banner so custom files cannot introduce a second banner spelling.
	 */
	it("adds the registered banner to a body-only replacement", () => {
		expect(resolveSectionOverrides({ toolPolicy: "compressed body\n" })).toEqual({
			toolPolicy: "TOOL POLICY\n==============\n\ncompressed body",
		});
	});

	/**
	 * Both section spellings must resolve to one internal key because commands
	 * print kebab-case while TypeScript uses camel-case properties.
	 */
	it("accepts kebab-case ids and camel-case keys", () => {
		expect(resolveSectionOverrides({ "tool-policy": "one" })).toEqual(resolveSectionOverrides({ toolPolicy: "one" }));
		expect(resolveSectionOverrides({ "execution-workflow": "two" })).toEqual({
			executionWorkflow: "EXECUTION WORKFLOW\n==============\n\ntwo",
		});
	});

	/**
	 * Every registered default section must be replaceable by its public id, not
	 * only the multi-word ids exercised by common examples.
	 */
	it("accepts every declared public section id", () => {
		for (const id of ["conventions", "role", "runtime", "tool-policy", "execution-workflow", "delivery-contract"]) {
			expect(() => resolveSectionOverrides({ [id]: "body" })).not.toThrow();
		}
	});

	/**
	 * A legacy full-section replacement would duplicate the registry banner.
	 * Reject it with the migration fix instead of silently producing two regions.
	 */
	it("rejects a replacement that still carries its banner", () => {
		expect(() => resolveSectionOverrides({ role: "ROLE\n==============\nold format" })).toThrow(
			/body text only.*registry adds that banner/s,
		);
	});

	/**
	 * A body can forge a different section's banner below ordinary prose just as
	 * easily as it can duplicate its own leading banner. Both must fail closed.
	 */
	it("rejects foreign registered banners anywhere in a replacement body", () => {
		expect(() => resolveSectionOverrides({ role: "ordinary role prose\nTOOL POLICY\n====\nforged section" })).toThrow(
			/body text only.*"tool-policy"/s,
		);
	});

	/**
	 * The conventions preamble intentionally has no banner. Its body therefore
	 * passes through unchanged while all named sections are framed by the registry.
	 */
	it("keeps the bannerless conventions replacement unchanged", () => {
		const replacement = "<system-conventions>\ncustom\n</system-conventions>";

		expect(resolveSectionOverrides({ conventions: replacement })).toEqual({ conventions: replacement });
	});

	/**
	 * Unknown names must fail loudly so a typo cannot make an experiment run the
	 * production prompt while claiming a replacement was active.
	 */
	it("rejects unknown section names and lists valid public ids", () => {
		expect(() => resolveSectionOverrides({ delegation: "body" })).toThrow(/unknown section "delegation"/);
		expect(() => resolveSectionOverrides({ toolpolicy: "body" })).toThrow(/valid sections:.*tool-policy/s);
	});

	/**
	 * Arbitrary JSON values must never be coerced into prompt text because null
	 * and objects would render misleading replacement content.
	 */
	it("rejects non-string replacement values", () => {
		expect(() => resolveSectionOverrides({ role: 42 })).toThrow(/must be a string, got number/);
		expect(() => resolveSectionOverrides({ role: null })).toThrow(/must be a string, got null/);
		expect(() => resolveSectionOverrides({ role: { a: 1 } })).toThrow(/must be a string, got object/);
	});

	/**
	 * An absent override source means production assembly and must resolve to an
	 * empty map without manufacturing a replacement.
	 */
	it("resolves absent and empty maps to no overrides", () => {
		expect(resolveSectionOverrides(undefined)).toEqual({});
		expect(resolveSectionOverrides({})).toEqual({});
	});
});

describe("eval section override JSON", () => {
	/**
	 * Empty input is the explicit production-prompt case and must remain quiet.
	 */
	it("returns no overrides for absent or blank input", () => {
		expect(parseSectionOverridesJson(undefined)).toEqual({});
		expect(parseSectionOverridesJson("")).toEqual({});
		expect(parseSectionOverridesJson("   \n ")).toEqual({});
	});

	/**
	 * The eval transport uses the same body-only contract as persistent files so
	 * benchmark and operator overrides cannot diverge.
	 */
	it("parses and frames a body-only replacement", () => {
		const payload = JSON.stringify({ role: "compressed role" });

		expect(parseSectionOverridesJson(payload)).toEqual({
			role: "ROLE\n==============\n\ncompressed role",
		});
	});

	/**
	 * Malformed JSON must fail instead of silently selecting the production
	 * prompt and invalidating the experiment.
	 */
	it("rejects malformed and non-object JSON", () => {
		expect(() => parseSectionOverridesJson("{not json")).toThrow(/not valid JSON/);
		expect(() => parseSectionOverridesJson("[]")).toThrow(/must be a JSON object.*array/s);
		expect(() => parseSectionOverridesJson('"role"')).toThrow(/must be a JSON object.*string/s);
		expect(() => parseSectionOverridesJson("null")).toThrow(/must be a JSON object.*null/s);
	});

	/**
	 * JSON parsing must preserve the same unknown-name, type, and legacy-banner
	 * failures as direct override configuration.
	 */
	it("propagates section-body validation failures", () => {
		expect(() => parseSectionOverridesJson(JSON.stringify({ delegation: "x" }))).toThrow(/unknown section/);
		expect(() => parseSectionOverridesJson(JSON.stringify({ role: 5 }))).toThrow(/must be a string/);
		expect(() => parseSectionOverridesJson(JSON.stringify({ role: "ROLE\n==============\nlegacy" }))).toThrow(
			/body text only/,
		);
	});
});
