/**
 * WHY: Chromium runs no animation frames in a background page, and a locator's click waits on two of
 * them. With several tabs on one headless browser, every tab but the newest was in the background, so
 * a click there stalled until the action timed out: eight seconds, then an error that blamed the
 * element for being hidden or covered.
 *
 * The contract: a run in any tab of a headless browser acts as it does in the newest one. The run
 * below is given four seconds, less than the stall, so a stalled click fails it.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: two runs in two tabs at the same moment, where the second to start is
 * the one in front; and a spawned or connected browser, whose tabs are left as the person arranged
 * them.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

const PAGE = `<!doctype html><title>t</title><button id="b" onclick="this.textContent = 'clicked'">go</button>`;

let server: http.Server;
let url = "";
let tool: BrowserTool;
const FIRST = `earlier-${process.pid}`;
const SECOND = `later-${process.pid}`;

beforeAll(async () => {
	server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(PAGE);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("an action in an earlier tab", () => {
	it("clicks as it does in the newest tab, well inside a run shorter than the stall", async () => {
		await tool.execute("open", { action: "open", name: FIRST, url });
		await tool.execute("open", { action: "open", name: SECOND, url });
		const clicked = await tool.execute("run", {
			action: "run",
			name: FIRST,
			timeout: 4,
			code: 'await tab.click("#b"); return await tab.evaluate(() => document.getElementById("b").textContent);',
		});
		expect(clicked.content.map(part => (part.type === "text" ? part.text : "")).join("")).toBe("clicked");
	}, 60_000);
});
