import { describe, expect, it } from "bun:test";
import type { Settings } from "@veyyon/coding-agent/config/settings";
import { isIrcEnabled } from "@veyyon/coding-agent/tools/irc-enabled";

/**
 * isIrcEnabled decides whether the IRC tool is offered: IRC needs a peer to talk to.
 * Any subagent (taskDepth > 0) always has a parent, so it is always enabled without
 * consulting settings. A top-level session (taskDepth 0) has peers only if it can
 * still spawn subagents, so it reuses the SAME spawn-capacity gate the task tool uses
 * (canSpawnAtDepth over task.maxRecursionDepth, default 2) rather than a second copy
 * that could drift. This locks: subagents always on, a top-level session on only while
 * it can spawn, off once the depth budget is exhausted, and the default of 2.
 */

const settings = (maxRecursionDepth: number | undefined): Settings =>
	({ get: () => maxRecursionDepth }) as unknown as Settings;

describe("isIrcEnabled subagents", () => {
	it("is always enabled for a subagent regardless of the depth cap", () => {
		expect(isIrcEnabled(settings(0), 1)).toBe(true);
		expect(isIrcEnabled(settings(2), 2)).toBe(true);
	});
});

describe("isIrcEnabled top-level session", () => {
	it("is enabled when it can still spawn subagents", () => {
		expect(isIrcEnabled(settings(2), 0)).toBe(true);
	});

	it("is disabled when the depth budget forbids spawning", () => {
		expect(isIrcEnabled(settings(0), 0)).toBe(false);
	});

	it("uses a default max recursion depth of 2 when unset", () => {
		expect(isIrcEnabled(settings(undefined), 0)).toBe(true);
	});

	it("is enabled for a negative (unlimited) depth cap", () => {
		expect(isIrcEnabled(settings(-1), 0)).toBe(true);
	});
});
