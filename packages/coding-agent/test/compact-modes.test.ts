import { describe, expect, it } from "bun:test";
import {
	COMPACT_MODES,
	findCompactMode,
	parseCompactArgs,
} from "@veyyon/coding-agent/session/compact-modes";

describe("compact mode registry", () => {
	it("maps each shipped mode to the settings overrides the engine relies on", () => {
		// These override values are load-bearing: the engine merges them over the
		// configured compaction.* settings, so a regression here silently changes
		// what `/compact <mode>` does.
		expect(findCompactMode("soft")?.overrides).toEqual({
			strategy: "context-full",
			remoteEnabled: false,
		});
		expect(findCompactMode("remote")?.overrides).toEqual({
			strategy: "context-full",
			remoteEnabled: true,
		});
		// snapcompact is no longer a /compact subcommand mode (image archive is
		// strategy-level, not a focus-rejecting parse mode).
		expect(findCompactMode("snapcompact")).toBeUndefined();
	});

	it("flags remote as remote-requiring; soft does not require remote", () => {
		expect(findCompactMode("remote")?.requiresRemote).toBe(true);
		expect(findCompactMode("soft")?.requiresRemote).toBeUndefined();
	});

	it("registry is exactly soft and remote", () => {
		expect(COMPACT_MODES.map(m => m.name).sort()).toEqual(["remote", "soft"]);
	});

	it("resolves mode names case-insensitively and rejects unknowns", () => {
		expect(findCompactMode("SOFT")?.name).toBe("soft");
		expect(findCompactMode("  Remote ")?.name).toBe("remote");
		expect(findCompactMode("bogus")).toBeUndefined();
		expect(findCompactMode("")).toBeUndefined();
	});
});

describe("parseCompactArgs", () => {
	it("returns no mode and no instructions for empty args", () => {
		expect(parseCompactArgs("")).toEqual({});
		expect(parseCompactArgs("   ")).toEqual({});
	});

	it("detects a leading mode token", () => {
		expect(parseCompactArgs("soft")).toEqual({ mode: "soft" });
		expect(parseCompactArgs("remote")).toEqual({ mode: "remote" });
	});

	it("splits a mode from its trailing focus instructions", () => {
		expect(parseCompactArgs("soft focus on the parser bug")).toEqual({
			mode: "soft",
			instructions: "focus on the parser bug",
		});
		expect(parseCompactArgs("remote   keep auth details")).toEqual({
			mode: "remote",
			instructions: "keep auth details",
		});
	});

	it("treats a non-mode first token as plain focus instructions (backward compatible)", () => {
		expect(parseCompactArgs("summarize the auth flow")).toEqual({
			instructions: "summarize the auth flow",
		});
		expect(parseCompactArgs("everything")).toEqual({ instructions: "everything" });
		// Former mode names that left the registry become focus text, not errors.
		expect(parseCompactArgs("snapcompact keep the diffs")).toEqual({
			instructions: "snapcompact keep the diffs",
		});
	});
});
