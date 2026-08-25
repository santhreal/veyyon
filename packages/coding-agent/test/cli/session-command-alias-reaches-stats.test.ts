/**
 * WHY THIS SUITE EXISTS:
 * `veyyon session` provides session analysis (timing, tool cost, turn cadence).
 * Users and autocomplete expect the plural `veyyon sessions` to reach the exact
 * same command. The command class must declare `static aliases = ["sessions"]`
 * so CLI discovery, help generation, and runtime dispatch recognize the alias
 * without colliding with other commands.
 */

import { describe, expect, it } from "bun:test";
import { commands } from "@veyyon/coding-agent/cli-commands";
import Session from "@veyyon/coding-agent/commands/session";

describe("session command plural alias", () => {
	it("declares static aliases matching the plural form", () => {
		expect(Session.aliases).toEqual(["sessions"]);
	});

	it("has a registered command table entry with the sessions alias", async () => {
		const sessionEntry = commands.find(c => c.name === "session");
		expect(sessionEntry).toBeDefined();
		expect(sessionEntry?.aliases).toContain("sessions");

		const loadedCtor = await sessionEntry?.load();
		expect(loadedCtor).toBe(Session);
	});

	it("does not collide with any other registered command name or alias", () => {
		const allNames = new Set<string>();
		for (const entry of commands) {
			expect(allNames.has(entry.name)).toBe(false);
			allNames.add(entry.name);
			for (const alias of entry.aliases ?? []) {
				if (entry.name === "session" && alias === "sessions") continue;
				expect(alias).not.toBe("sessions");
			}
		}
	});
});
