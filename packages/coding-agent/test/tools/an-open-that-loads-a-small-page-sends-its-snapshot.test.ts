/**
 * WHY: nearly every `open` that loads a page was followed by a `run` whose only job was to read the
 * page, and every call re-sends the whole conversation. On a small page that read is sent with the
 * open instead.
 *
 * The contract: an open with a `url` carries the page's `tab.ariaSnapshot()` when it is at most
 * `OPEN_SNAPSHOT_MAX_CHARS`, and the refs in it drive the next run (`aria-ref=eN`) without another
 * read; a larger page is not sent, and the open states its size and how to read a part of it; an
 * open that loads nothing (a reused tab with no `url`) carries no snapshot.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a page whose snapshot is exactly at the bound, and a snapshot that fails,
 * which the open reports in one line rather than failing; neither has a page that produces it on
 * demand.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool, OPEN_SNAPSHOT_MAX_CHARS } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

const SMALL = `<!doctype html><title>Sign in</title><h1>Sign in to continue</h1>
<label>User <input id="user"></label><button id="go">Submit</button>`;
const LARGE = `<!doctype html><title>Listing</title><h1>Listing</h1>${Array.from(
	{ length: 400 },
	(_unused, index) => `<p>Entry ${index + 1} with a line of text long enough to be read.</p>`,
).join("")}`;

let server: http.Server;
let base = "";
let tool: BrowserTool;
const TAB = `snapshot-${process.pid}`;

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

beforeAll(async () => {
	server = http.createServer((request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(request.url === "/large" ? LARGE : SMALL);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", name: TAB, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("an open that loads a page", () => {
	it("carries a small page's snapshot, whose refs the next run acts on without reading the page again", async () => {
		const opened = text(await tool.execute("open", { action: "open", name: TAB, url: `${base}/small` }));
		const page = opened.slice(opened.indexOf("Page:\n") + "Page:\n".length);
		expect(opened).toContain("Page:\n");
		expect(page.length).toBeLessThanOrEqual(OPEN_SNAPSHOT_MAX_CHARS);
		expect(page).toContain("Sign in to continue");
		const ref = page.match(/textbox[^\n]*\[ref=(e\d+)\]/)?.[1];
		expect(ref).toBeDefined();

		const filled = await tool.execute("run", {
			action: "run",
			name: TAB,
			code: `await tab.fill("aria-ref=${ref}", "sam"); return await tab.evaluate(() => document.getElementById("user").value);`,
		});
		expect(text(filled)).toBe("sam");
	}, 60_000);

	it("states a large page's size instead of sending it, and a tab reused without a url carries nothing", async () => {
		const opened = text(await tool.execute("open", { action: "open", name: TAB, url: `${base}/large` }));
		const size = Number(opened.match(/Page snapshot not sent: (\d+) chars\./)?.[1]);
		expect(size).toBeGreaterThan(OPEN_SNAPSHOT_MAX_CHARS);
		expect(opened).toContain("Read what you need with tab.observe() or tab.ariaSnapshot(selector).");
		expect(opened).not.toContain("Entry 1 ");

		const reused = text(await tool.execute("open", { action: "open", name: TAB }));
		expect(reused).toContain(`Reused tab "${TAB}"`);
		expect(reused).not.toContain("Page");
	}, 60_000);
});
