/**
 * WHY: run code that blocks its worker thread (an `execSync` of a long command, a busy loop) cannot
 * answer its own deadline, and the supervisor killed the whole tab once the grace after the deadline
 * ran out: the page, what was typed into it and its session were lost, and the next run had to open
 * the site and sign in again. Calibration runs hit this ten times in eight trials.
 *
 * A thread stuck that way also held its browser connection open, and the browser holds each new
 * target, a tab or a page's worker among them, until each connection lets it run: another tab could
 * not start a worker, and no tab could open, until the stuck command ended.
 *
 * The contract: a run that hangs its worker fails with a message saying the worker was replaced and
 * the page kept, and the next run on the tab finds the same page with the state the stuck run left
 * in it. While the stuck command still runs, a new tab opens and a page starts a worker. The new
 * worker drives the tab as the old one did: a saved session loads into it, a click lands after another
 * tab was the active one, and closing the tab closes its page.
 *
 * Driven through the real tool against real headless Chromium, with a worker thread. Skipped where
 * Chromium cannot run.
 *
 * What it does NOT catch: the inline fallback, which shares the main thread with the stuck code and
 * still kills its tab, a replacement worker that cannot attach, which kills the tab as before, and the
 * seconds between the hang and its replacement, when the browser still waits on the stuck thread.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `stuck-${process.pid}`;

async function run(code: string, timeout?: number, name = TAB): Promise<{ text: string; failure: string | null }> {
	try {
		const result = await tool.execute("run", { action: "run", name, code, ...(timeout ? { timeout } : {}) });
		return { text: result.content.map(part => (part.type === "text" ? part.text : "")).join("\n"), failure: null };
	} catch (error) {
		return { text: "", failure: error instanceof Error ? error.message : String(error) };
	}
}

beforeAll(async () => {
	server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(`<!doctype html><title>form</title><label>Note <input id="note"></label>`);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@stuck-run-");
	if (!CHROMIUM_AVAILABLE) return;
	const session: ToolSession = {
		cwd: files.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, url: `${base}/form` });
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
	await files.remove();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a run stuck in synchronous work", () => {
	it("fails saying its worker was replaced, and the next run finds the page as it left it", async () => {
		// The marker is written as the stuck command ends: until then its thread is blocked.
		const marker = path.join(files.path(), "hang-ended");
		const stuckEnded = (): Promise<boolean> =>
			fs.access(marker).then(
				() => true,
				() => false,
			);
		const stuck = await run(
			`await tab.fill("#note", "typed before the hang");
await tab.evaluate(() => sessionStorage.setItem("mark", "kept"));
require("node:child_process").execSync(${JSON.stringify(`sleep 10; touch '${marker}'`)});
return "never";`,
			2,
		);
		expect(stuck.failure).toContain("The worker was replaced and the page kept");

		const other = `${TAB}-other`;
		await tool.execute("open", { action: "open", name: other, url: `${base}/other` });
		const started = await run(
			`return { worker: await tab.evaluate(() => new Promise(resolve => {
	const worker = new Worker(URL.createObjectURL(new Blob(["onmessage = () => postMessage('started')"])));
	worker.onmessage = event => resolve(event.data);
	worker.postMessage(0);
})) };`,
			15,
			other,
		);
		expect(started.failure).toBeNull();
		expect(JSON.parse(started.text)).toEqual({ worker: "started" });
		expect(await stuckEnded()).toBe(false);

		const after = await run(
			`return { url: await tab.evaluate(() => location.pathname), note: await tab.evaluate(() => document.getElementById("note").value), mark: await tab.evaluate(() => sessionStorage.getItem("mark")) };`,
		);
		expect(after.failure).toBeNull();
		expect(JSON.parse(after.text)).toEqual({ url: "/form", note: "typed before the hang", mark: "kept" });

		const resumed = await run(
			`const loaded = await tab.loadStorageState({ cookies: [{ name: "kept", value: "1", domain: "127.0.0.1" }] });
await tab.click("#note");
return { loaded, focused: await tab.evaluate(() => document.activeElement.id) };`,
			15,
		);
		expect(resumed.failure).toBeNull();
		expect(JSON.parse(resumed.text)).toEqual({ loaded: { cookies: 1, origins: [] }, focused: "note" });

		await tool.execute("close", { action: "close", name: TAB });
		const open = await run("return (await browser.pages()).map(each => each.url());", undefined, other);
		expect(open.failure).toBeNull();
		expect(JSON.parse(open.text)).not.toContain(`${base}/form`);
		expect(JSON.parse(open.text)).toContain(`${base}/other`);
	}, 60_000);
});
