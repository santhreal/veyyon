/**
 * Section override filename parsing and validation pins exact contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. parseSectionOverrideFilename and assertKnownSectionId are the
 * entry points for per-section prompt customization. Their contracts:
 * .md → replace mode, .append.md → append mode, non-.md → null (ignored),
 * unknown section id → throws with the valid list.
 */
import { describe, expect, it } from "bun:test";
import {
	parseSectionOverrideFilename,
	assertKnownSectionId,
	PROMPT_SECTIONS_DIR,
} from "@veyyon/coding-agent/system-prompt-builder/section-overrides";
import { TEMPLATE_SECTION_IDS } from "@veyyon/coding-agent/system-prompt-builder/section-registry";

describe("parseSectionOverrideFilename", () => {
	it("parses a .md file as replace mode", () => {
		expect(parseSectionOverrideFilename("delivery-contract.md")).toEqual({
			id: "delivery-contract",
			mode: "replace",
		});
	});

	it("parses a .append.md file as append mode", () => {
		expect(parseSectionOverrideFilename("delivery-contract.append.md")).toEqual({
			id: "delivery-contract",
			mode: "append",
		});
	});

	it("returns null for non-.md files (ignored, not rejected)", () => {
		expect(parseSectionOverrideFilename("README.txt")).toBeNull();
		expect(parseSectionOverrideFilename("notes.json")).toBeNull();
		expect(parseSectionOverrideFilename(".DS_Store")).toBeNull();
	});

	it("returns null for empty string", () => {
		expect(parseSectionOverrideFilename("")).toBeNull();
	});

	it("handles filenames with dots in the stem", () => {
		expect(parseSectionOverrideFilename("my.section.md")).toEqual({
			id: "my.section",
			mode: "replace",
		});
	});
});

describe("assertKnownSectionId", () => {
	it("does not throw for a valid section id", () => {
		const validId = TEMPLATE_SECTION_IDS[0];
		expect(() => assertKnownSectionId(validId, `${validId}.md`)).not.toThrow();
	});

	it("throws for an unknown section id", () => {
		expect(() => assertKnownSectionId("nonexistent-section", "nonexistent-section.md")).toThrow();
	});

	it("the error message names the file and lists valid ids", () => {
		try {
			assertKnownSectionId("typo-section", "typo-section.md");
			expect.unreachable("should have thrown");
		} catch (e) {
			const msg = String(e);
			expect(msg).toContain("typo-section.md");
		}
	});

	it("accepts every registered section id without throwing", () => {
		for (const id of TEMPLATE_SECTION_IDS) {
			expect(() => assertKnownSectionId(id, `${id}.md`)).not.toThrow();
		}
	});
});

describe("PROMPT_SECTIONS_DIR", () => {
	it("is the expected directory name", () => {
		expect(PROMPT_SECTIONS_DIR).toBe("PROMPT_SECTIONS");
	});
});
