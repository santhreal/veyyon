import { describe, expect, it, spyOn } from "bun:test";
import * as os from "node:os";
import { collabDisplayName } from "@veyyon/coding-agent/collab/display-name";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";

/**
 * WHY: collabDisplayName resolves the name every collab peer is listed under —
 * the host row of the desktop share card, the roster `/collab` prints, and the
 * greeting a guest sends. A uid with no passwd entry reports the literal
 * `unknown` instead of raising, so the `catch` that was meant to answer for an
 * unresolvable account never ran and a share hosted from a container listed its
 * host as "unknown".
 *
 * THE CLASS THIS CLOSES: a name shown to peers that names nothing. Every rung of
 * the ladder is asserted, in precedence order, including both ways an account
 * fails to resolve: the raise and the placeholder.
 *
 * WHAT IT DOES NOT CATCH: whether a name is unique among peers, and what a
 * guest's own client does with a name it is handed.
 */

const ctxWith = (value: string | undefined): Pick<InteractiveModeContext, "settings"> =>
	({ settings: { get: () => value } }) as unknown as Pick<InteractiveModeContext, "settings">;

/**
 * The account this process reports, for the length of one test.
 *
 * The sandbox itself runs as a uid with no passwd entry, so a test that
 * compared against the real `os.userInfo()` compared against the placeholder
 * this module reads as no answer.
 */
const withAccount = (username: string) =>
	spyOn(os, "userInfo").mockReturnValue({
		username,
		uid: 0,
		gid: 0,
		shell: "/bin/sh",
		homedir: "/sandbox/home",
	});

describe("collabDisplayName", () => {
	it("returns the configured display name", () => {
		expect(collabDisplayName(ctxWith("Alice"))).toBe("Alice");
	});

	it("trims surrounding whitespace from the configured name", () => {
		expect(collabDisplayName(ctxWith("  Bob  "))).toBe("Bob");
	});

	it("falls back to the account name when the setting is whitespace only", () => {
		const account = withAccount("rowan");
		try {
			expect(collabDisplayName(ctxWith("   "))).toBe("rowan");
		} finally {
			account.mockRestore();
		}
	});

	it("falls back to the account name when the setting is unset", () => {
		const account = withAccount("rowan");
		try {
			expect(collabDisplayName(ctxWith(undefined))).toBe("rowan");
		} finally {
			account.mockRestore();
		}
	});

	it("names the machine when the account is the placeholder a bare uid reports", () => {
		const account = withAccount("unknown");
		const machine = spyOn(os, "hostname").mockReturnValue("recorder-7f3a");
		try {
			expect(collabDisplayName(ctxWith(undefined))).toBe("recorder-7f3a");
		} finally {
			account.mockRestore();
			machine.mockRestore();
		}
	});

	it("names the machine when the account cannot be read at all", () => {
		const account = spyOn(os, "userInfo").mockImplementation(() => {
			throw new Error("no passwd entry");
		});
		const machine = spyOn(os, "hostname").mockReturnValue("recorder-7f3a");
		try {
			expect(collabDisplayName(ctxWith(undefined))).toBe("recorder-7f3a");
		} finally {
			account.mockRestore();
			machine.mockRestore();
		}
	});

	it("is anonymous when neither the account nor the machine resolves", () => {
		const account = withAccount("unknown");
		const machine = spyOn(os, "hostname").mockReturnValue("   ");
		try {
			expect(collabDisplayName(ctxWith(undefined))).toBe("anonymous");
		} finally {
			account.mockRestore();
			machine.mockRestore();
		}
	});
});
