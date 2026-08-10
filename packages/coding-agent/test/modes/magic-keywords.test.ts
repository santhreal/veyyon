import { beforeAll, describe, expect, it } from "bun:test";
import {
	hasMagicKeyword,
	highlightMagicKeywords,
	MAGIC_KEYWORD_TOKENS,
} from "@veyyon/coding-agent/modes/magic-keywords";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";

beforeAll(async () => {
	// Gradient palettes read the active theme's color mode.
	await initTheme(false);
});

describe("highlightMagicKeywords", () => {
	it("paints every magic keyword in a single prose pass, preserving visible text", () => {
		const input = "first ultrathink then orchestratez the workflowz";
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(decorated).toContain("\x1b[38");
		expect(Bun.stripANSI(decorated)).toBe(input);
		// Each keyword is gradient-painted character-by-character, so none survives as a
		// contiguous run in the decorated output.
		for (const keyword of MAGIC_KEYWORD_TOKENS) {
			expect(decorated).not.toContain(keyword);
			expect(Bun.stripANSI(decorated)).toContain(keyword);
		}
	});

	it("paints punctuation-adjacent prose keywords without changing visible text", () => {
		const input = 'first "ultrathink," then orchestratez. Finally workflowz!';
		const decorated = highlightMagicKeywords(input);
		expect(decorated).not.toBe(input);
		expect(Bun.stripANSI(decorated)).toBe(input);
		for (const keyword of MAGIC_KEYWORD_TOKENS) {
			expect(decorated).not.toContain(keyword);
		}
	});

	it("never paints keywords inside code spans, fenced blocks, or XML sections", () => {
		const input = "`ultrathink`\n```\norchestratez\n```\n<x>workflowz</x>";
		expect(highlightMagicKeywords(input)).toBe(input);
	});

	it("paints only the prose occurrence when the keyword also appears in code", () => {
		const decorated = highlightMagicKeywords("`orchestratez` but please orchestratez now");
		// The code-span occurrence stays literal; the prose one is split by gradient escapes.
		expect(decorated).toContain("`orchestratez`");
		expect(Bun.stripANSI(decorated)).toBe("`orchestratez` but please orchestratez now");
		// Exactly one prose occurrence painted ⇒ one contiguous "orchestratez" remains (the code one).
		expect(decorated.split("orchestratez").length - 1).toBe(1);
	});

	it("restores the supplied foreground after each painted keyword", () => {
		const reset = "\x1b[38;2;1;2;3m";
		const decorated = highlightMagicKeywords("go orchestratez go", reset);
		expect(decorated).toContain(reset);
		// The reset must land before the trailing prose so it keeps the bubble color.
		expect(decorated.endsWith(`${reset} go`)).toBe(true);
	});

	it("shifts the gradient when phase advances — same visible text, different SGR bytes", () => {
		const text = "go ultrathink now";
		const frame0 = highlightMagicKeywords(text, undefined, 0);
		const frame1 = highlightMagicKeywords(text, undefined, 0.5);
		expect(Bun.stripANSI(frame0)).toBe(text);
		expect(Bun.stripANSI(frame1)).toBe(text);
		// The visible output is unchanged width-wise but the painted bytes differ
		// because the per-stop palette has cycled.
		expect(frame0).not.toBe(frame1);
	});

	it("treats out-of-range phase values as wrapping into [0, 1)", () => {
		const text = "do ultrathink please";
		// 1.0 wraps back to 0, so the painted output must match.
		expect(highlightMagicKeywords(text, undefined, 1)).toBe(highlightMagicKeywords(text, undefined, 0));
		// Negative phase wraps too — -0.25 ≡ 0.75.
		expect(highlightMagicKeywords(text, undefined, -0.25)).toBe(highlightMagicKeywords(text, undefined, 0.75));
	});
});

describe("hasMagicKeyword", () => {
	/**
	 * EVERY token, derived from the inventory, so a keyword added to the family
	 * without a detector behind it turns this red instead of shipping inert.
	 */
	it("detects every standalone keyword in prose", () => {
		for (const token of MAGIC_KEYWORD_TOKENS) {
			expect(hasMagicKeyword(`please ${token} this`)).toBe(true);
			expect(hasMagicKeyword(`${token}`)).toBe(true);
			expect(hasMagicKeyword(`then ${token}, please`)).toBe(true);
		}
	});

	/**
	 * A TRIGGER IS A TOKEN NOBODY TYPES BY ACCIDENT. Ordinary operator prose,
	 * including the verbs and nouns the keywords are built from, may not carry a
	 * hidden notice into the turn. `orchestrate` is the one that did.
	 */
	it("never fires on ordinary operator prose", () => {
		for (const text of [
			"orchestrate the release",
			"please orchestrate this migration yourself",
			"do not orchestrate anything, just fix the one file",
			"write the workflow for the release",
			"the workflows are green",
			"think harder about this",
			"let us think through the plan",
			"ultra think about it",
		]) {
			expect(hasMagicKeyword(text)).toBe(false);
			expect(highlightMagicKeywords(text)).toBe(text);
		}
	});

	it("rejects keywords used as code symbols or calls", () => {
		for (const text of [
			"ultrathink()",
			"orchestratez()",
			"workflowz()",
			"foo::ultrathink",
			"foo::orchestratez",
			"foo::workflowz",
		]) {
			expect(hasMagicKeyword(text)).toBe(false);
			expect(highlightMagicKeywords(text)).toBe(text);
		}
	});

	it("rejects casing, inflections, old workflow names, and paths", () => {
		expect(hasMagicKeyword("Ultrathink")).toBe(false);
		expect(hasMagicKeyword("ORCHESTRATEZ")).toBe(false);
		expect(hasMagicKeyword("workflow")).toBe(false);
		expect(hasMagicKeyword("workflows")).toBe(false);
		expect(hasMagicKeyword("ultrathinking is fun")).toBe(false);
		expect(hasMagicKeyword("workflowzed already")).toBe(false);
		expect(hasMagicKeyword("src/modes/ultrathink.ts")).toBe(false);
		expect(hasMagicKeyword("orchestratez.ts is a file")).toBe(false);
		expect(hasMagicKeyword("packages/coding-agent/test/modes/workflowz.test.ts")).toBe(false);
	});

	it("rejects keywords inside code spans, fences, and xml sections", () => {
		expect(hasMagicKeyword("`ultrathink`")).toBe(false);
		expect(hasMagicKeyword("```\norchestratez\n```")).toBe(false);
		expect(hasMagicKeyword("<x>workflowz</x>")).toBe(false);
	});

	it("returns false for empty / keyword-free text", () => {
		expect(hasMagicKeyword("")).toBe(false);
		expect(hasMagicKeyword("plain message with no keywords")).toBe(false);
	});
});
