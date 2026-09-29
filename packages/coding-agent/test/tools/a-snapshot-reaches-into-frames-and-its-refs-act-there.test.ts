/**
 * WHY: `tab.ariaSnapshot()` stopped at an iframe's line, and no `tab` route reached an element inside
 * one. A payment form or a sign-in widget in a frame was read and filled only through raw
 * `page.frames()` and `frame.evaluate`, which bypass the tool's fill and its cover check, and a model
 * spent turns finding the frame before it could act.
 *
 * The contract: a snapshot nests each iframe's content under the iframe's line, cross-site frames
 * included, with refs prefixed by their frame (`f1e3`), frames within frames included; those refs act
 * through `tab.ref`, `aria-ref=` selectors, `fill` and `click` like any ref; a press on an element in a
 * frame is refused, naming the cover, when the page above the frame covers its point; and a frame ref
 * from a snapshot of a page the tab has left fails as an unknown ref.
 *
 * Driven through the real tool against real headless Chromium, with the outer page on 127.0.0.1 and
 * the frame on `localhost`, a different site, so Chromium runs the frame in a process of its own.
 * Skipped where Chromium cannot run.
 *
 * What it does NOT catch: frames nested deeper than the snapshot follows (three), a frame whose
 * content box is transformed or zoomed (the parent point ignores CSS transforms), and `tab.observe()`,
 * whose ids still cover the top document only.
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

let outer: http.Server;
let inner: http.Server;
let outerBase = "";
let innerBase = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `frames-${process.pid}`;

const FRAME_STYLE = "width:420px;height:180px;border:3px solid #333;padding:7px;margin:30px";

/** A page's `note(text)`: append one item to its `#log`. */
const NOTE = `<script>function note(text) { const item = document.createElement("li"); item.textContent = text; document.getElementById("log").append(item); }</script>`;

/**
 * The pages each server answers; the frame's own pages record what reached them as items of `#log`, in
 * the DOM, which every script world of the frame reads alike.
 */
function outerPage(pathname: string): string {
	const frame = `<iframe id="pay" title="Payment" src="${innerBase}/card" style="${FRAME_STYLE}"></iframe>`;
	switch (pathname) {
		case "/":
			return `<h1>Checkout</h1>${frame}`;
		case "/covered":
			return `<h1>Checkout</h1>${frame}<div id="wall" style="position:fixed;inset:0;background:rgba(0,0,0,.2)">cookie wall</div>`;
		case "/nested":
			return `<h1>Portal</h1><iframe id="shell" title="Shell" src="${innerBase}/shell" style="${FRAME_STYLE};height:260px"></iframe>`;
		case "/leaf":
			return `<button id="confirm" onclick="note('confirm')">Confirm</button><ol id="log"></ol>${NOTE}`;
		default:
			return "<h1>Elsewhere</h1>";
	}
}

function innerPage(pathname: string): string {
	switch (pathname) {
		case "/card":
			return `<label>Card number <input id="card"></label><button id="pay" onclick="note('pay:' + document.getElementById('card').value)">Pay</button><ol id="log"></ol>${NOTE}`;
		case "/shell":
			return `<p>Shell</p><iframe id="leaf" title="Leaf" src="${outerBase}/leaf" style="width:300px;height:80px"></iframe>`;
		default:
			return "";
	}
}

async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code });
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

/** What the frame whose URL contains `part` recorded. */
function logOf(part: string): string {
	return `await page.frames().find(frame => frame.url().includes(${JSON.stringify(part)})).evaluate(() => Array.from(document.querySelectorAll("#log li"), item => item.textContent))`;
}

async function listen(server: http.Server, host?: string): Promise<number> {
	const listening = Promise.withResolvers<void>();
	server.listen(0, host, () => listening.resolve());
	await listening.promise;
	return (server.address() as AddressInfo).port;
}

beforeAll(async () => {
	outer = http.createServer((request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(`<!doctype html><title>outer</title>${outerPage(new URL(request.url ?? "/", "http://x").pathname)}`);
	});
	inner = http.createServer((request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(`<!doctype html><title>inner</title>${innerPage(new URL(request.url ?? "/", "http://x").pathname)}`);
	});
	outerBase = `http://127.0.0.1:${await listen(outer, "127.0.0.1")}`;
	// Every address, so `localhost` reaches it over either loopback family.
	innerBase = `http://localhost:${await listen(inner)}`;
	files = await TempDir.create("@frame-refs-");
	if (!CHROMIUM_AVAILABLE) return;
	const session: ToolSession = {
		cwd: files.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, url: `${outerBase}/` });
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", name: TAB, kill: true });
	await files.remove();
	for (const server of [outer, inner]) {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a snapshot of a page with a frame", () => {
	it("nests the frame's content under its line, and its refs fill and press inside the frame", async () => {
		const outcome = JSON.parse(
			await run(`await tab.goto(${JSON.stringify(`${outerBase}/`)});
await page.waitForFrame(frame => frame.url().includes("/card"));
const snapshot = await tab.ariaSnapshot();
const ref = name => snapshot.match(new RegExp(name + '[^\\\\n]*?\\\\[ref=(f\\\\d+e\\\\d+)\\\\]'))[1];
const card = ref('textbox "Card number"');
const pay = ref('button "Pay"');
await tab.ref(card).fill("4111 1111");
await tab.click("aria-ref=" + pay);
await tab.ref(pay).click();
return { snapshot, card, pay, log: ${logOf("/card")} };`),
		);
		expect(outcome.snapshot).toMatch(/- iframe[^\n]*\[ref=e\d+\]:\n\s+/);
		expect(outcome.card).toMatch(/^f1e\d+$/);
		expect(outcome.pay).toMatch(/^f1e\d+$/);
		expect(outcome.log).toEqual(["pay:4111 1111", "pay:4111 1111"]);
	}, 60_000);

	it("follows a frame inside a frame, with refs of its own", async () => {
		const outcome = JSON.parse(
			await run(`await tab.goto(${JSON.stringify(`${outerBase}/nested`)});
await page.waitForFrame(frame => frame.url().includes("/leaf"));
const snapshot = await tab.ariaSnapshot();
const confirm = snapshot.match(/button "Confirm"[^\\n]*?\\[ref=(f\\d+e\\d+)\\]/)[1];
await tab.ref(confirm).click();
return { confirm, log: ${logOf("/leaf")} };`),
		);
		expect(outcome.confirm).toMatch(/^f2e\d+$/);
		expect(outcome.log).toEqual(["confirm"]);
	}, 60_000);

	it("refuses a press on an element in the frame when the page above the frame covers it, naming the cover", async () => {
		const outcome = JSON.parse(
			await run(`await tab.goto(${JSON.stringify(`${outerBase}/covered`)});
await page.waitForFrame(frame => frame.url().includes("/card"));
const snapshot = await tab.ariaSnapshot();
const pay = snapshot.match(/button "Pay"[^\\n]*?\\[ref=(f\\d+e\\d+)\\]/)[1];
let failure = null;
const started = Date.now();
try { await tab.ref(pay).click(); } catch (error) { failure = error.message; }
return { failure, ms: Date.now() - started, log: ${logOf("/card")} };`),
		);
		expect(outcome.failure).toContain("<div#wall>");
		expect(outcome.failure).toContain("over its frame");
		expect(outcome.log).toEqual([]);
		expect(outcome.ms).toBeLessThan(10_000);
	}, 60_000);

	it("fails a frame ref from a page the tab has left as an unknown ref", async () => {
		const failure = await run(`await tab.goto(${JSON.stringify(`${outerBase}/`)});
await page.waitForFrame(frame => frame.url().includes("/card"));
const snapshot = await tab.ariaSnapshot();
const pay = snapshot.match(/button "Pay"[^\\n]*?\\[ref=(f\\d+e\\d+)\\]/)[1];
await tab.goto(${JSON.stringify(`${outerBase}/elsewhere`)});
try { await tab.ref(pay).click(); return "pressed"; } catch (error) { return error.message; }`);
		expect(failure).toContain("Unknown ARIA ref");
	}, 60_000);
});
