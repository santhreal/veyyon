/**
 * WHY: the browser tool ships off, and a description that names it anyway tells the model to use a
 * tool it cannot call. The `read` description said "not a browser tool … browser only when `read`
 * can't deliver" in every session.
 *
 * The invariant, over every tool the session builds: with the browser tool off, no description names
 * a browser; with it on, `read` says when to reach for it. The tools come from `createTools`, so a
 * tool added tomorrow is swept without editing this file.
 *
 * What it does NOT catch: parameter schema descriptions, which no tool uses for this today, and the
 * system prompt's own statements, which `a-tool-conditioned-statement-needs-its-tool.test.ts` owns.
 */

import { describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createTools, type ToolSession } from "@veyyon/coding-agent/tools";

function session(browser: boolean): ToolSession {
	return {
		cwd: "/tmp/test",
		hasUI: true,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.enabled": browser, "lsp.enabled": true, "ask.enabled": true }),
	};
}

describe("a session without the browser tool", () => {
	it("reads no tool description that names a browser", async () => {
		const tools = await createTools(session(false));
		expect(tools.map(tool => tool.name)).not.toContain("browser");
		expect(tools.length).toBeGreaterThan(10);
		const naming = tools.filter(tool => /\bbrowser\b/i.test(tool.description)).map(tool => tool.name);
		expect(naming).toEqual([]);
	});

	it("reads in the read description when to reach for the browser once the tool is on", async () => {
		const tools = await createTools(session(true));
		const read = tools.find(tool => tool.name === "read");
		expect(tools.map(tool => tool.name)).toContain("browser");
		expect(read?.description).toContain("browser only when `read` can't deliver");
	});
});
