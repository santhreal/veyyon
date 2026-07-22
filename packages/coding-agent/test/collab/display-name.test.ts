import { describe, expect, it } from "bun:test";
import * as os from "node:os";
import { collabDisplayName } from "@veyyon/coding-agent/collab/display-name";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";

/**
 * collabDisplayName resolves the name shown to collab peers. It prefers the trimmed
 * `collab.displayName` setting and otherwise falls back to the OS username. The trim
 * matters: a setting that is only whitespace must be treated as unset (else peers see
 * a blank name), and an undefined setting must not throw. This locks the precedence
 * and the whitespace-is-empty rule.
 */

const ctxWith = (value: string | undefined): Pick<InteractiveModeContext, "settings"> =>
	({ settings: { get: () => value } }) as unknown as Pick<InteractiveModeContext, "settings">;

describe("collabDisplayName", () => {
	it("returns the configured display name", () => {
		expect(collabDisplayName(ctxWith("Alice"))).toBe("Alice");
	});

	it("trims surrounding whitespace from the configured name", () => {
		expect(collabDisplayName(ctxWith("  Bob  "))).toBe("Bob");
	});

	it("falls back to the OS username when the setting is whitespace only", () => {
		expect(collabDisplayName(ctxWith("   "))).toBe(os.userInfo().username);
	});

	it("falls back to the OS username when the setting is unset", () => {
		expect(collabDisplayName(ctxWith(undefined))).toBe(os.userInfo().username);
	});
});
