/**
 * `veyyon __complete <kind>` is the hidden helper the generated shell scripts
 * call. A kind nobody serves must not look like a kind with no matches —
 * the scripts discard stderr, so an unknown kind that prints nothing is
 * indistinguishable from "the catalog is empty".
 *
 * WHY THIS SUITE EXISTS. COMPLETE_KINDS is the one list the helper and the
 * generator share. It had no test. Pin:
 *
 *   - the exported roster is exactly models / sessions / settings / setting-values
 *   - a new kind cannot land in the generator without landing here
 *   - setting-values is distinct from settings (the former needs a key)
 *
 * Running the Command class would boot SessionManager; this suite pins the
 * contract the command comments claim, which is the list itself.
 */
import { describe, expect, it } from "bun:test";
import { COMPLETE_KINDS } from "@veyyon/coding-agent/commands/complete";

describe("COMPLETE_KINDS is the whole helper surface", () => {
	it("is exactly the four kinds the generated scripts know how to ask for", () => {
		expect([...COMPLETE_KINDS]).toEqual(["models", "sessions", "settings", "setting-values"]);
	});

	it("does not include a 'kind' that would collide with an argv flag", () => {
		expect(COMPLETE_KINDS).not.toContain("--");
		expect(COMPLETE_KINDS).not.toContain("");
		expect(COMPLETE_KINDS).not.toContain("help");
	});

	it("keeps setting-values distinct from settings so a TAB on a value does not dump every key", () => {
		expect(COMPLETE_KINDS).toContain("settings");
		expect(COMPLETE_KINDS).toContain("setting-values");
		expect(new Set(COMPLETE_KINDS).size).toBe(COMPLETE_KINDS.length);
	});
});
