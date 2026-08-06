import { describe, expect, it } from "bun:test";
import {
	COMPACT_MODES,
	findCompactMode,
	type ParsedCompactArgs,
	parseCompactArgs,
} from "@veyyon/coding-agent/session/compact-modes";

/** Parse a successful `/compact` invocation for assertions below. */
function parsed(args: string): ParsedCompactArgs {
	const result = parseCompactArgs(args);
	if ("error" in result) throw new Error(`parseCompactArgs(${JSON.stringify(args)}) refused: ${result.error}`);
	return result;
}

describe("compact mode registry", () => {
	it("maps the sole shipped mode to the summary strategy override", () => {
		expect(findCompactMode("summary")?.overrides).toEqual({ strategy: "summary" });
		expect(findCompactMode("handoff")).toBeUndefined();
		expect(findCompactMode("snapcompact")).toBeUndefined();
	});

	it("registry contains only the canonical in-place summary mode", () => {
		expect(COMPACT_MODES.map(mode => mode.name)).toEqual(["summary"]);
		expect(findCompactMode("handoff")).toBeUndefined();
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

	it("resolves summary case-insensitively and rejects unknowns", () => {
		expect(findCompactMode("SUMMARY")?.name).toBe("summary");
		expect(findCompactMode("  Handoff ")).toBeUndefined();
		expect(findCompactMode("bogus")).toBeUndefined();
		expect(findCompactMode("")).toBeUndefined();
	});
});

describe("parseCompactArgs", () => {
	it("returns no mode and no instructions for empty args", () => {
		expect(parseCompactArgs("")).toEqual({});
		expect(parseCompactArgs("   ")).toEqual({});
	});

	it("detects the canonical leading mode token and its focus", () => {
		expect(parseCompactArgs("summary")).toEqual({ mode: "summary" });
		expect(parseCompactArgs("summary focus on the parser bug")).toEqual({
			mode: "summary",
			instructions: "focus on the parser bug",
		});
	});

	it("refuses handoff as a compaction mode with the explicit replacement command", () => {
		for (const args of ["handoff", "HANDOFF keep auth details", "  Handoff  "]) {
			const result = parseCompactArgs(args);
			expect(result).toHaveProperty("error");
			if ("error" in result) expect(result.error).toContain("/handoff [focus instructions]");
		}
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
		for (const args of ["SOFT", "Soft", "  soft  "]) {
			expect(parsed(args).notice, args).toContain("`soft` is no longer a compaction mode");
		}
		expect(parsed("ReMoTe").notice).toContain("`remote` is no longer a compaction mode");
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

	it("does not fire for the live summary mode or ordinary focus text", () => {
		expect(parsed("summary").notice).toBeUndefined();
		expect(parsed("focus on the parser").notice).toBeUndefined();
		expect(parsed("").notice).toBeUndefined();
	});
});
