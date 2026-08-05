/**
 * `parseCompactArgs` adversarial coverage for the single shipped `summary`
 * mode, backward-compatible focus text, and the explicit handoff refusal.
 */
import { describe, expect, it } from "bun:test";
import {
	COMPACT_MODES,
	findCompactMode,
	type ParsedCompactArgs,
	parseCompactArgs,
} from "@veyyon/coding-agent/session/compact-modes";

describe("parseCompactArgs adversarial matrix", () => {
	for (const casing of ["summary", "SUMMARY", "Summary"]) {
		it(`mode token ${JSON.stringify(casing)}`, () => {
			expect(parseCompactArgs(casing)).toEqual({ mode: "summary" });
		});
	}

	it("leading/trailing whitespace on bare summary mode", () => {
		expect(parseCompactArgs("  summary  ")).toEqual({ mode: "summary" });
	});

	it("summary accepts focus", () => {
		expect(parseCompactArgs("summary keep auth")).toEqual({
			mode: "summary",
			instructions: "keep auth",
		});
	});

	it("handoff fails rather than becoming a compaction mode or focus text", () => {
		for (const args of ["handoff", "\tHANDOFF\n", "Handoff   multi  spaces"]) {
			const result = parseCompactArgs(args);
			expect(result).toHaveProperty("error");
			if ("error" in result) expect(result.error).toContain("/handoff");
		}
	});

	it("unknown first token is full instructions (backward compat)", () => {
		expect(parseCompactArgs("condense the auth flow")).toEqual({
			instructions: "condense the auth flow",
		});
		expect(parseCompactArgs("summarily do things")).toEqual({
			instructions: "summarily do things",
		});
		expect(parseCompactArgs("summaryx")).toEqual({ instructions: "summaryx" });
		// removed mode names become plain focus text
		expect(parseCompactArgs("snapcompact keep diffs")).toEqual({
			instructions: "snapcompact keep diffs",
		});
		// A RETIRED mode name is also plain focus text, and additionally carries the
		// notice that the name is gone (see the "a retired compact mode name" suite in
		// compact-modes.test.ts). The text itself must still arrive untouched, which is
		// what this matrix is about, so the notice is read off separately rather than
		// pinned here.
		for (const args of ["soft keep auth", "remote keep auth"]) {
			const retired = parseCompactArgs(args);
			expect("error" in retired, args).toBe(false);
			expect((retired as ParsedCompactArgs).instructions, args).toBe(args);
			expect((retired as ParsedCompactArgs).mode, args).toBeUndefined();
			expect((retired as ParsedCompactArgs).notice, args).toContain("no longer a compaction mode");
		}
	});

	it("empty and whitespace-only", () => {
		expect(parseCompactArgs("")).toEqual({});
		expect(parseCompactArgs("   \t  ")).toEqual({});
	});
});

describe("findCompactMode registry contract", () => {
	it("ships summary only", () => {
		expect(COMPACT_MODES.map(mode => mode.name)).toEqual(["summary"]);
		expect(findCompactMode("summary")?.name).toBe("summary");
		expect(findCompactMode("handoff")).toBeUndefined();
		expect(findCompactMode("soft")).toBeUndefined();
		expect(findCompactMode("remote")).toBeUndefined();
		expect(findCompactMode("snapcompact")).toBeUndefined();
		expect(findCompactMode("hard")).toBeUndefined();
	});
});
