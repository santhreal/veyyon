/**
 * WHY: `await tab.click("a"); await tab.waitForNavigation()` is the order run code writes, and the
 * click's navigation often commits before the wait starts listening, so the wait timed out on a
 * navigation that had already happened. Two workflow calibration trials lost five calls this way.
 *
 * The contract: `tab.waitForNavigation()` called after a tab action whose navigation already committed,
 * with nothing but reads and `wait` between them, returns once that page reaches the load state asked
 * for (`load` by default); started before the action, as in
 * `Promise.all([tab.waitForNavigation(), tab.click(…)])`, it waits for that action's navigation and not
 * for one an earlier `goto` made; after an action that navigated nowhere it still times out.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a navigation started by raw `page` calls, which are not tab actions, and a
 * wait called after a further tab action; both wait for a new navigation as before.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { setTimeout as delay } from "node:timers/promises";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

/** How long the next page's image takes, so its `load` comes well after its navigation commits. */
const SLOW_IMAGE_MS = 600;

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `nav-${process.pid}`;

async function run(code: string): Promise<{ text: string; failure: string | null }> {
	try {
		const result = await tool.execute("run", { action: "run", name: TAB, code });
		return { text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"), failure: null };
	} catch (error) {
		return { text: "", failure: error instanceof Error ? error.message : String(error) };
	}
}

beforeAll(async () => {
	server = http.createServer(async (request, response) => {
		if (request.url === "/slow.png") {
			await delay(SLOW_IMAGE_MS);
			response.setHeader("Content-Type", "image/svg+xml");
			response.end(`<svg xmlns="http://www.w3.org/2000/svg" width="1" height="1"/>`);
			return;
		}
		response.setHeader("Content-Type", "text/html");
		response.end(
			request.url === "/next"
				? `<!doctype html><title>next</title><img src="/slow.png"><p>next</p>`
				: `<!doctype html><title>start</title><a id="go" href="/next">Next</a><button id="noop">Nothing</button>`,
		);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@wait-for-navigation-");
	if (!CHROMIUM_AVAILABLE) return;
	const session: ToolSession = {
		cwd: files.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, url: `${base}/` });
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", name: TAB, kill: true });
	await files.remove();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("tab.waitForNavigation", () => {
	it("returns after a click whose navigation already committed, once that page has loaded", async () => {
		const { text, failure } = await run(`await tab.goto(${JSON.stringify(`${base}/`)});
await tab.click("#go");
await wait(200);
await tab.waitForNavigation({ timeout: 5000 });
return { path: new URL(tab.url()).pathname, state: await tab.evaluate(() => document.readyState) };`);
		expect(failure).toBeNull();
		expect(JSON.parse(text)).toEqual({ path: "/next", state: "complete" });
	}, 60_000);

	it("started before the click, waits for the click's navigation and not the goto's", async () => {
		const { text, failure } = await run(`await tab.goto(${JSON.stringify(`${base}/`)});
const [seen] = await Promise.all([
	tab.waitForNavigation({ timeout: 5000 }).then(() => new URL(tab.url()).pathname),
	wait(300).then(() => tab.click("#go")),
]);
return seen;`);
		expect(failure).toBeNull();
		expect(text).toBe("/next");
	}, 60_000);

	it("still times out after an action that navigated nowhere", async () => {
		const { failure } = await run(`await tab.goto(${JSON.stringify(`${base}/`)});
await tab.click("#noop");
await tab.waitForNavigation({ timeout: 1000 });`);
		expect(failure).toContain("tab.waitForNavigation() timed out");
	}, 60_000);
});
