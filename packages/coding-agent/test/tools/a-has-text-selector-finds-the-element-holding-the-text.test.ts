/**
 * WHY: Playwright's `css:has-text("text")` is the selector models reach for most after CSS
 * (`button:has-text("Sign in")`), and puppeteer has no such pseudo-class: the tool refused it, and the
 * model spent a turn rewriting it. Ten workflow trials refused seven.
 *
 * The contract: a selector ending in `:has-text(…)` acts on the first element its CSS matches whose
 * text holds the text, case and spacing aside; a bare `:has-text(…)` acts on the innermost element
 * holding the text, not an ancestor such as `<body>`; it works as an alternative of a comma list; one
 * that matches nothing fails within the zero-match window; `:has-text()` nested inside another
 * pseudo-class is still refused as Playwright-only.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: Playwright's other text engines (`text=`, `:text()`, `:text-is()`), which
 * stay refused, and text inside a shadow root, which a CSS query does not reach.
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

const PAGE = `<!doctype html><title>page</title>
<button onclick="note('cancel')">Cancel</button>
<button onclick="note('sign-in')">Sign   in</button>
<a href="#one" onclick="note('take-over')">Could you take over?</a>
<a href="#two" onclick="note('later')">Take over later</a>
<div id="box" onclick="note('box')" style="padding:40px"><span onclick="event.stopPropagation(); note('save')">Save</span></div>
<ol id="log"></ol>
<script>function note(text) { const item = document.createElement("li"); item.textContent = text; document.getElementById("log").append(item); }</script>`;

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `has-text-${process.pid}`;

async function run(code: string): Promise<{ text: string; failure: string | null; ms: number }> {
	const started = Date.now();
	try {
		const result = await tool.execute("run", { action: "run", name: TAB, code });
		const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
		return { text, failure: null, ms: Date.now() - started };
	} catch (error) {
		return { text: "", failure: error instanceof Error ? error.message : String(error), ms: Date.now() - started };
	}
}

beforeAll(async () => {
	server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(PAGE);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@has-text-");
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

describe.skipIf(!CHROMIUM_AVAILABLE)("a :has-text selector", () => {
	it("acts on the element its CSS matches that holds the text, case and spacing aside", async () => {
		const { text, failure } = await run(`await tab.goto(${JSON.stringify(`${base}/`)});
await tab.click('button:has-text("sign in")');
await tab.click('a[href^="#"]:has-text("could you take over")');
await tab.click(':has-text("Save")');
await tab.click('#nope, button:has-text("Cancel")');
return await tab.evaluate(() => Array.from(document.querySelectorAll("#log li"), item => item.textContent));`);
		expect(failure).toBeNull();
		expect(JSON.parse(text)).toEqual(["sign-in", "take-over", "save", "cancel"]);
	}, 60_000);

	it("fails within the zero-match window when nothing holds the text, and stays refused when nested", async () => {
		await run(`await tab.goto(${JSON.stringify(`${base}/`)});`);
		const none = await run(`await tab.click('button:has-text("Nowhere")');`);
		expect(none.failure).toContain("failed fast");
		expect(none.ms).toBeLessThan(5_000);
		const nested = await run(`await tab.click('div:has(span:has-text("Save"))');`);
		expect(nested.failure).toContain("Playwright-only selector");
	}, 60_000);
});
