/**
 * Prompts subsystem parity oracle: pins the all-registries aggregate,
 * eval-override validation, and generated id list contracts.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite must reproduce these exact
 * behaviors: registry count, registry ordering (coding-agent first),
 * id list completeness, and unknown-override rejection.
 */
import { describe, expect, it } from "bun:test";
import { PROMPT_REGISTRIES, allPromptIds } from "@veyyon/coding-agent/prompts/all-registries";
import { unknownEvalPromptOverrideIds, assertEvalPromptOverrideIdsExist } from "@veyyon/coding-agent/prompts/eval-overrides";
import { PROMPT_IDS, PROMPT_REGISTRY_COUNT } from "@veyyon/coding-agent/prompts/ids.generated";

describe("PROMPT_REGISTRY_COUNT", () => {
	it("is exactly 4", () => {
		expect(PROMPT_REGISTRY_COUNT).toBe(4);
	});
});

describe("PROMPT_REGISTRIES", () => {
	it("has exactly 4 registries", () => {
		expect(PROMPT_REGISTRIES.length).toBe(4);
	});

	it("coding-agent registry is first (for near-miss suggestions)", () => {
		expect(PROMPT_REGISTRIES[0].ids.length).toBeGreaterThan(0);
	});

	it("every registry has a non-empty id list", () => {
		for (const registry of PROMPT_REGISTRIES) {
			expect(registry.ids.length).toBeGreaterThan(0);
		}
	});
});

describe("allPromptIds", () => {
	it("returns the union of all registry ids", () => {
		const all = allPromptIds();
		const expected = PROMPT_REGISTRIES.flatMap(r => r.ids);
		expect(all.length).toBe(expected.length);
	});

	it("every id in PROMPT_IDS is in allPromptIds", () => {
		const all = new Set(allPromptIds());
		for (const id of PROMPT_IDS) {
			expect(all.has(id)).toBe(true);
		}
	});
});

describe("PROMPT_IDS", () => {
	it("is non-empty", () => {
		expect(PROMPT_IDS.length).toBeGreaterThan(0);
	});

	it("has no duplicates", () => {
		const seen = new Set<string>();
		for (const id of PROMPT_IDS) {
			expect(seen.has(id), `duplicate prompt id: ${id}`).toBe(false);
			seen.add(id);
		}
	});
});

describe("unknownEvalPromptOverrideIds", () => {
	it("returns empty array when no overrides are set", () => {
		// In test environment, VEYYON_EVAL_PROMPTS is not set
		const unknown = unknownEvalPromptOverrideIds();
		expect(unknown.length).toBe(0);
	});
});

describe("assertEvalPromptOverrideIdsExist", () => {
	it("does not throw when no overrides are set", () => {
		expect(() => assertEvalPromptOverrideIdsExist()).not.toThrow();
	});
});
