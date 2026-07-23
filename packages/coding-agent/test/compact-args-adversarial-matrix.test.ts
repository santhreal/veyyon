/**
 * parseCompactArgs adversarial against the shipped COMPACT_MODES registry
 * (soft + remote). Unknown first token is full instructions (backward compat).
 */
import { describe, expect, it } from "bun:test";
import { COMPACT_MODES, findCompactMode, parseCompactArgs } from "@veyyon/coding-agent/session/compact-modes";

describe("parseCompactArgs adversarial matrix", () => {
	for (const mode of ["soft", "remote"] as const) {
		for (const casing of [mode, mode.toUpperCase(), mode[0].toUpperCase() + mode.slice(1)]) {
			it(`mode token ${JSON.stringify(casing)}`, () => {
				expect(parseCompactArgs(casing)).toEqual({ mode });
			});
		}
	}

	it("leading/trailing whitespace on bare mode", () => {
		expect(parseCompactArgs("  soft  ")).toEqual({ mode: "soft" });
		expect(parseCompactArgs("\tremote\n")).toEqual({ mode: "remote" });
	});

	it("soft/remote accept focus", () => {
		expect(parseCompactArgs("soft keep auth")).toEqual({
			mode: "soft",
			instructions: "keep auth",
		});
		expect(parseCompactArgs("remote   multi  spaces")).toEqual({
			mode: "remote",
			instructions: "multi  spaces",
		});
	});

	it("unknown first token is full instructions (backward compat)", () => {
		expect(parseCompactArgs("summarize the auth flow")).toEqual({
			instructions: "summarize the auth flow",
		});
		expect(parseCompactArgs("softly do things")).toEqual({
			instructions: "softly do things",
		});
		expect(parseCompactArgs("softx")).toEqual({ instructions: "softx" });
		// removed mode names become plain focus text
		expect(parseCompactArgs("snapcompact keep diffs")).toEqual({
			instructions: "snapcompact keep diffs",
		});
	});

	it("empty and whitespace-only", () => {
		expect(parseCompactArgs("")).toEqual({});
		expect(parseCompactArgs("   \t  ")).toEqual({});
	});
});

describe("findCompactMode registry contract", () => {
	it("ships soft and remote only", () => {
		expect(COMPACT_MODES.map(m => m.name).sort()).toEqual(["remote", "soft"]);
		expect(findCompactMode("soft")?.name).toBe("soft");
		expect(findCompactMode("remote")?.requiresRemote).toBe(true);
		expect(findCompactMode("snapcompact")).toBeUndefined();
		expect(findCompactMode("hard")).toBeUndefined();
	});
});
