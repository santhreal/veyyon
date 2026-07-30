import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { isIrcEnabled } from "@veyyon/coding-agent/tools/irc-enabled";

/**
 * isIrcEnabled decides whether the IRC tool is offered: IRC needs a peer to talk to.
 * Any subagent (taskDepth > 0) always has a parent, so it remains enabled even when
 * that child is a leaf. A root session has potential peers only when delegation is
 * enabled and the same inclusive spawn-capacity gate as the task tool permits it.
 * The default cap is zero: the root may spawn direct children, while depth-one
 * children cannot spawn again.
 */

const settings = (maxNestedSpawnDepth?: number, enabled = true): Settings =>
	Settings.isolated({
		"subagent.enabled": enabled,
		...(maxNestedSpawnDepth === undefined ? {} : { "subagent.maxNestedSpawnDepth": maxNestedSpawnDepth }),
	});

describe("isIrcEnabled subagents", () => {
	it("is always enabled for a subagent regardless of the depth cap or master switch", () => {
		expect(isIrcEnabled(settings(0), 1)).toBe(true);
		expect(isIrcEnabled(settings(0, false), 1)).toBe(true);
	});
});

describe("isIrcEnabled top-level session", () => {
	it("is enabled at the default zero cap because the root can spawn direct children", () => {
		expect(isIrcEnabled(settings(0), 0)).toBe(true);
	});

	it("is disabled when delegation is switched off", () => {
		expect(isIrcEnabled(settings(0, false), 0)).toBe(false);
	});

	it("uses a default maximum nested spawn depth of zero when unset", () => {
		expect(isIrcEnabled(settings(), 0)).toBe(true);
	});

	it("is enabled for a negative (unlimited) depth cap", () => {
		expect(isIrcEnabled(settings(-1), 0)).toBe(true);
	});
});
