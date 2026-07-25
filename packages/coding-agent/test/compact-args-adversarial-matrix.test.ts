/**
 * parseCompactArgs adversarial against the shipped COMPACT_MODES registry
 * (summary + handoff, the two compaction strategies). Unknown first token is
 * full instructions (backward compat), which is also what retired mode names
 * degrade to.
 */
import { describe, expect, it } from "bun:test";
import {
	COMPACT_MODES,
	findCompactMode,
	type ParsedCompactArgs,
	parseCompactArgs,
} from "@veyyon/coding-agent/session/compact-modes";

describe("parseCompactArgs adversarial matrix", () => {
	for (const mode of ["summary", "handoff"] as const) {
		for (const casing of [mode, mode.toUpperCase(), mode[0].toUpperCase() + mode.slice(1)]) {
			it(`mode token ${JSON.stringify(casing)}`, () => {
				expect(parseCompactArgs(casing)).toEqual({ mode });
			});
		}
	}

	it("leading/trailing whitespace on bare mode", () => {
		expect(parseCompactArgs("  summary  ")).toEqual({ mode: "summary" });
		expect(parseCompactArgs("\thandoff\n")).toEqual({ mode: "handoff" });
	});

	it("summary/handoff accept focus", () => {
		expect(parseCompactArgs("summary keep auth")).toEqual({
			mode: "summary",
			instructions: "keep auth",
		});
		expect(parseCompactArgs("handoff   multi  spaces")).toEqual({
			mode: "handoff",
			instructions: "multi  spaces",
		});
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
	/**
	 * The registry must stay exactly the two strategies. `soft` and `remote` were
	 * the provider-native remote compaction steering modes; their return would
	 * mean a per-provider compaction path came back.
	 */
	it("ships summary and handoff only", () => {
		expect(COMPACT_MODES.map(m => m.name).sort()).toEqual(["handoff", "summary"]);
		expect(findCompactMode("summary")?.name).toBe("summary");
		expect(findCompactMode("handoff")?.name).toBe("handoff");
		expect(findCompactMode("soft")).toBeUndefined();
		expect(findCompactMode("remote")).toBeUndefined();
		expect(findCompactMode("snapcompact")).toBeUndefined();
		expect(findCompactMode("hard")).toBeUndefined();
	});
});
