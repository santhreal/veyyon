/**
 * WHY: run code reached for `tab.reload()`, which the tab API did not have, and the call failed as an
 * unknown member; the page had to be loaded again by hand with `tab.goto(tab.url())`.
 *
 * The contract: `tab.reload()` loads the tab's current URL again with `goto`'s waiting, so the page's
 * server sees a new request; a page that a form's POST produced is fetched with a GET, so the form is
 * not submitted a second time.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: the cmux backend's `reload`, which loads its last URL through `goto` and
 * has no Chromium here.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `reload-${process.pid}`;
/** Requests the server answered, by method and path. */
const seen = new Map<string, number>();

async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code });
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

beforeAll(async () => {
	server = http.createServer((request, response) => {
		const key = `${request.method} ${request.url}`;
		seen.set(key, (seen.get(key) ?? 0) + 1);
		response.setHeader("Content-Type", "text/html");
		response.end(
			request.url === "/submit"
				? `<!doctype html><title>sent</title><p id="sent">sent</p>`
				: `<!doctype html><title>form</title><form method="post" action="/submit"><button id="go">Go</button></form>`,
		);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@tab-reload-");
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

describe.skipIf(!CHROMIUM_AVAILABLE)("tab.reload", () => {
	it("loads the current URL again, and fetches a POST's page with a GET", async () => {
		const pagesBefore = seen.get("GET /") ?? 0;
		await run("await tab.reload();");
		expect(seen.get("GET /")).toBe(pagesBefore + 1);

		const title = await run(`await Promise.all([tab.waitForNavigation(), tab.click("#go")]);
await tab.reload();
return await tab.title();`);
		expect(title).toBe("sent");
		expect(seen.get("POST /submit")).toBe(1);
		expect(seen.get("GET /submit")).toBe(1);
	}, 60_000);
});
