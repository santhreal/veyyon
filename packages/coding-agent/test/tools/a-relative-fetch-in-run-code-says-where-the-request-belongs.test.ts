/**
 * WHY: run code executes in the tab worker, and a model that calls `fetch("/api/…")` there, as the
 * page's own scripts do, got a bare "fetch() URL is invalid": the worker has no page URL to resolve
 * the path against. Models spent turns on it in three calibration trials.
 *
 * The contract: a run whose `fetch` fails on a relative URL fails with an error that says the call
 * ran outside the page and gives the `tab.evaluate` form, and that form makes the page's own request,
 * with the page's cookies. A failure with any other cause keeps its own message.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a relative URL that another runtime rejects with a message of its own; the
 * hint matches Bun's and undici's.
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
const TAB = `fetch-${process.pid}`;

async function run(code: string): Promise<{ text: string; failure: string | null }> {
	try {
		const result = await tool.execute("run", { action: "run", name: TAB, code });
		return { text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"), failure: null };
	} catch (error) {
		return { text: "", failure: error instanceof Error ? error.message : String(error) };
	}
}

beforeAll(async () => {
	server = http.createServer((request, response) => {
		if (request.url === "/api/me") {
			response.setHeader("Content-Type", "application/json");
			response.end(JSON.stringify({ session: request.headers.cookie ?? null }));
			return;
		}
		response.setHeader("Content-Type", "text/html");
		response.setHeader("Set-Cookie", "session=signed-in; Path=/");
		response.end("<!doctype html><title>app</title><h1>App</h1>");
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@relative-fetch-");
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

describe.skipIf(!CHROMIUM_AVAILABLE)("a relative fetch in run code", () => {
	it("fails naming the tab.evaluate form, which makes the page's own request", async () => {
		const outside = await run(`return await fetch("/api/me").then(r => r.json());`);
		expect(outside.failure).toContain("run code executes in the tab worker");
		expect(outside.failure).toContain('await tab.evaluate(() => fetch("/path").then(r => r.json()))');
		const inside = await run(`return await tab.evaluate(() => fetch("/api/me").then(r => r.json()));`);
		expect(inside.failure).toBeNull();
		expect(JSON.parse(inside.text)).toEqual({ session: "session=signed-in" });
	}, 60_000);

	it("leaves a failure with another cause as it was", async () => {
		const other = await run(`throw new TypeError("fetch() URL is fine, the payload is not");`);
		expect(other.failure).toContain("fetch() URL is fine, the payload is not");
		expect(other.failure).not.toContain("tab worker");
	}, 60_000);
});
