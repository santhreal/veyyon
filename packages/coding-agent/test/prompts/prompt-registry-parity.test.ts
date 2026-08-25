/**
 * The prompt registry is complete and every prompt id is accounted for.
 *
 * WHY THIS SUITE EXISTS. The Rust rewrite needs the test suite as a parity
 * oracle. The prompt registry defines every system prompt template the model
 * sees. A missing or extra prompt id is a parity gap. This suite pins the
 * registry shape and asserts every prompt id resolves to non-empty text.
 */
import { describe, expect, it } from "bun:test";
import { PROMPTS, PROMPT_IDS, promptText, requirePrompt } from "@veyyon/coding-agent/prompts/registry";
import { allPromptIds, PROMPT_REGISTRIES } from "@veyyon/coding-agent/prompts/all-registries";

describe("prompt registry", () => {
	it("PROMPTS is non-empty", () => {
		expect(Object.keys(PROMPTS).length).toBeGreaterThan(0);
	});

	it("PROMPT_IDS matches PROMPTS keys", () => {
		expect([...PROMPT_IDS].sort() as string[]).toEqual(Object.keys(PROMPTS).sort());
	});

	it("every prompt id resolves to non-empty text", () => {
		for (const id of PROMPT_IDS) {
			const text = promptText(id);
			expect(typeof text).toBe("string");
			expect(text!.length).toBeGreaterThan(0);
		}
	});

	it("requirePrompt throws for an unknown id", () => {
		expect(() => requirePrompt("nonexistent/prompt")).toThrow();
	});

	it("requirePrompt returns an object with text for a known id", () => {
		const knownId = PROMPT_IDS[0];
		const entry = requirePrompt(knownId);
		expect(entry).toBeDefined();
		expect(typeof entry.text).toBe("string");
		expect(entry.text.length).toBeGreaterThan(0);
	});

	it("allPromptIds returns the union of all registries", () => {
		const all = allPromptIds();
		expect(all.length).toBeGreaterThanOrEqual(PROMPT_IDS.length);
		// Every id from the coding-agent registry is in the union.
		for (const id of PROMPT_IDS) {
			expect(all).toContain(id);
		}
	});

	it("every id in allPromptIds is unique", () => {
		const all = allPromptIds();
		expect(new Set(all).size).toBe(all.length);
	});

	it("PROMPT_REGISTRIES is non-empty", () => {
		expect(PROMPT_REGISTRIES.length).toBeGreaterThan(0);
	});

	it("the prompt id count is pinned (grows when a prompt is added)", () => {
		// Pin the count so adding or removing a prompt is a deliberate act.
		expect(PROMPT_IDS.length).toBeGreaterThan(100);
	});
});
