import { describe, expect, it } from "bun:test";
import {
	COMPACT_MODES,
	findCompactMode,
	type ParsedCompactArgs,
	parseCompactArgs,
} from "@veyyon/coding-agent/session/compact-modes";

/**
 * The parse, with the error branch ruled out.
 *
 * `parseCompactArgs` returns a union so a future mode can reject its arguments;
 * nothing rejects today, and every test below reads a field off the success shape.
 * Failing loudly here beats each test carrying its own cast, which would also
 * silence a real error the parser started returning.
 */
function parsed(args: string): ParsedCompactArgs {
	const result = parseCompactArgs(args);
	if ("error" in result) throw new Error(`parseCompactArgs(${JSON.stringify(args)}) refused: ${result.error}`);
	return result;
}

describe("compact mode registry", () => {
	it("maps each shipped mode to the settings overrides the engine relies on", () => {
		// These override values are load-bearing: the engine merges them over the
		// configured compaction.* settings, so a regression here silently changes
		// what `/compact <mode>` does.
		expect(findCompactMode("summary")?.overrides).toEqual({ strategy: "summary" });
		expect(findCompactMode("handoff")?.overrides).toEqual({ strategy: "handoff" });
		// snapcompact is no longer a /compact subcommand mode (image archive is
		// strategy-level, not a focus-rejecting parse mode).
		expect(findCompactMode("snapcompact")).toBeUndefined();
	});

	/**
	 * The registry IS the strategy list. `soft` and `remote` existed only to steer
	 * the provider-native remote compaction path — `soft` skipped it, `remote`
	 * demanded it. That path was removed because it stored an opaque provider blob
	 * and a placeholder summary, so both modes had nothing left to steer. If
	 * either name reappears here, a private per-provider compaction path came back
	 * with it.
	 */
	it("registry is exactly the two compaction strategies", () => {
		expect(COMPACT_MODES.map(m => m.name).sort()).toEqual(["handoff", "summary"]);
		expect(findCompactMode("soft")).toBeUndefined();
		expect(findCompactMode("remote")).toBeUndefined();
	});

	/** No mode may carry a remote demand — there is no remote path to demand. */
	it("no mode requests a provider-native path", () => {
		for (const mode of COMPACT_MODES) {
			expect(Object.keys(mode.overrides)).toEqual(["strategy"]);
			expect(mode).not.toHaveProperty("requiresRemote");
		}
	});

	it("resolves mode names case-insensitively and rejects unknowns", () => {
		expect(findCompactMode("SUMMARY")?.name).toBe("summary");
		expect(findCompactMode("  Handoff ")?.name).toBe("handoff");
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
		expect(parseCompactArgs("summary")).toEqual({ mode: "summary" });
		expect(parseCompactArgs("handoff")).toEqual({ mode: "handoff" });
	});

	it("splits a mode from its trailing focus instructions", () => {
		expect(parseCompactArgs("summary focus on the parser bug")).toEqual({
			mode: "summary",
			instructions: "focus on the parser bug",
		});
		expect(parseCompactArgs("handoff   keep auth details")).toEqual({
			mode: "handoff",
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

	/**
	 * A user with `/compact soft ...` or `/compact remote ...` in muscle memory or
	 * a saved command must not hit an error after the removal. The stale token
	 * degrades to focus text and the configured strategy runs.
	 */
	it("degrades retired mode names to focus text instead of erroring", () => {
		expect(parsed("soft").instructions).toBe("soft");
		expect(parsed("remote keep auth details").instructions).toBe("remote keep auth details");
		expect(parsed("soft")).not.toHaveProperty("mode");
	});
});

/**
 * A retired mode name degrades, and the degrade has to be audible.
 *
 * `soft` and `remote` left the registry, so `/compact soft` falls through to the
 * unknown-token path: the word becomes focus text and the configured strategy
 * runs. On its own that is a silent fallback of exactly the kind Law 10 bans — the
 * command reports a completed compaction, so you believe the mode you asked for is
 * what ran, and you would go on typing it for months. Compaction is also not free
 * and not reversible: you spent a request and rewrote your history under a
 * strategy you did not choose.
 *
 * So the parse still succeeds and carries a notice the caller must show. These
 * tests pin what the user is told, because a notice that does not name the
 * replacement leaves them exactly as stuck as no notice at all.
 */
describe("a retired compact mode name", () => {
	it("is reported as retired, by name", () => {
		expect(parsed("soft").notice).toContain("`soft` is no longer a compaction mode");
		expect(parsed("remote").notice).toContain("`remote` is no longer a compaction mode");
	});

	/** The one thing the user needs next: what to type instead. */
	it("names the mode to use instead", () => {
		expect(parsed("soft").notice).toContain("/compact summary");
		expect(parsed("remote").notice).toContain("/compact summary");
	});

	/** Each retired name gets its OWN reason, because the two were opposites: soft
	 * SKIPPED the provider-native path and remote DEMANDED it. A shared message
	 * would tell half its readers something untrue about what they asked for. */
	it("explains what that name used to do", () => {
		expect(parsed("soft").notice).toContain("SKIP");
		expect(parsed("remote").notice).toContain("provider");
		expect(parsed("soft").notice).not.toBe(parsed("remote").notice);
	});

	it("fires however the name is cased or padded", () => {
		for (const args of ["SOFT", "Soft", "  soft  ", "ReMoTe"]) {
			expect(parsed(args).notice, args).toBeDefined();
		}
	});

	/**
	 * The focus text is passed through EXACTLY as typed, retired word included.
	 * `/compact soft dependency bounds` is plausibly a real instruction that starts
	 * with the word "soft", and silently deleting a word from someone's prompt to
	 * fit a guess is a worse failure than telling them what ran.
	 */
	it("leaves the instruction text exactly as typed", () => {
		expect(parsed("soft keep the auth bits").instructions).toBe("soft keep the auth bits");
		expect(parsed("  REMOTE  and the parser  ").instructions).toBe("REMOTE  and the parser");
	});

	/** The notice must be scoped to the LEADING token. A sentence that happens to
	 * contain "soft" or "remote" further along is ordinary focus text, and warning
	 * about it would train the user to ignore the warning. */
	it("does not fire when the name is not the leading token", () => {
		expect(parsed("keep the soft dependency bounds").notice).toBeUndefined();
		expect(parsed("what changed in the remote branch").notice).toBeUndefined();
	});

	it("does not fire for a live mode, or for ordinary focus text", () => {
		expect(parsed("summary").notice).toBeUndefined();
		expect(parsed("handoff keep auth details").notice).toBeUndefined();
		expect(parsed("focus on the parser").notice).toBeUndefined();
		expect(parsed("").notice).toBeUndefined();
	});
});
