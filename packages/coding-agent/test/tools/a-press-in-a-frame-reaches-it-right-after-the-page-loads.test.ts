/**
 * WHY: Chromium sends a press to the frame its last drawn picture shows at the point. A frame from
 * another site runs in a process of its own, and right after a page loads, such a frame (or a frame
 * inside it) may not have drawn yet: every document already places the element at the point and the
 * cover probes find it clear, yet the press lands on the document above the frame. A ref click on a
 * button in a frame reported success and pressed nothing about one time in four.
 *
 * The class: a press on an element in a frame of another process that is made before that frame and
 * the frames above it have drawn, for each way a press is made (the default press and natural input)
 * and for a frame directly in the page and a frame inside a frame. Each case loads the page afresh and
 * presses at once, many times over, and requires every press to reach the button.
 *
 * Driven through the real tool against real headless Chromium, with the outer page on 127.0.0.1 and
 * the frames on `localhost`, a different site, so Chromium runs each frame in a process of its own.
 * Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a frame that draws, then moves before the press (the probes see the move);
 * a frame the browser draws nothing for within the wait, as in a page in the background, which a
 * press does not wait out; and a natural-input press made before the frames draw, since its pointer
 * travel outlasts a frame's first draw here and that case passes without the wait.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

let outer: http.Server;
let inner: http.Server;
let outerBase = "";
let innerBase = "";
let files: TempDir;
const tools = new Map<string, BrowserTool>();
/** Each way a press is made, on a tab of its own. */
const CASES = [
	{ label: "the default press", tab: `frame-press-default-${process.pid}`, naturalInput: false },
	{ label: "natural input", tab: `frame-press-natural-${process.pid}`, naturalInput: true },
] as const;

/** Loads of each page per input: a press that misses one time in four passes all of them about once in 10^5. */
const LOADS = 30;

const FRAME_STYLE = "width:420px;height:180px;border:3px solid #333;padding:7px;margin:30px";

/** A page's `note(text)`: append one item to its `#log`. */
const NOTE = `<script>function note(text) { const item = document.createElement("li"); item.textContent = text; document.getElementById("log").append(item); }</script>`;

function outerPage(pathname: string): string {
	switch (pathname) {
		case "/checkout":
			return `<h1>Checkout</h1><iframe title="Payment" src="${innerBase}/card" style="${FRAME_STYLE}"></iframe>`;
		case "/nested":
			return `<h1>Portal</h1><iframe title="Shell" src="${innerBase}/shell" style="${FRAME_STYLE};height:260px"></iframe>`;
		case "/leaf":
			return `<button onclick="note('confirm')">Confirm</button><ol id="log"></ol>${NOTE}`;
		default:
			return "<h1>Elsewhere</h1>";
	}
}

function innerPage(pathname: string): string {
	switch (pathname) {
		case "/card":
			return `<button onclick="note('pay')">Pay</button><ol id="log"></ol>${NOTE}`;
		case "/shell":
			return `<p>Shell</p><iframe title="Leaf" src="${outerBase}/leaf" style="width:300px;height:80px"></iframe>`;
		default:
			return "";
	}
}

async function listen(server: http.Server, host?: string): Promise<number> {
	const listening = Promise.withResolvers<void>();
	server.listen(0, host, () => listening.resolve());
	await listening.promise;
	return (server.address() as AddressInfo).port;
}

/**
 * Load `path`, wait for the frame whose URL holds `frame`, press the button named `button` there by its
 * snapshot ref, and return what the frame recorded.
 */
async function pressAfterLoad(tab: string, path: string, frame: string, button: string): Promise<string[]> {
	const tool = tools.get(tab);
	if (!tool) throw new Error(`no tool for tab ${tab}`);
	const result = await tool.execute("run", {
		action: "run",
		name: tab,
		code: `await tab.goto(${JSON.stringify(`${outerBase}${path}`)});
const frame = await page.waitForFrame(candidate => candidate.url().includes(${JSON.stringify(frame)}));
const snapshot = await tab.ariaSnapshot();
const ref = snapshot.match(new RegExp(${JSON.stringify(`button "${button}"`)} + '[^\\\\n]*?\\\\[ref=(f\\\\d+e\\\\d+)\\\\]'))[1];
await tab.ref(ref).click();
return await frame.evaluate(() => Array.from(document.querySelectorAll("#log li"), item => item.textContent));`,
	});
	const text = result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
	return JSON.parse(text) as string[];
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
	files = await TempDir.create("@frame-press-");
	if (!CHROMIUM_AVAILABLE) return;
	for (const { tab, naturalInput } of CASES) {
		const session: ToolSession = {
			cwd: files.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "browser.headless": true, "browser.naturalInput": naturalInput }),
		};
		const tool = new BrowserTool(session);
		tools.set(tab, tool);
		await tool.execute("open", { action: "open", name: tab, url: `${outerBase}/` });
	}
});

afterAll(async () => {
	for (const [tab, tool] of tools) await tool.execute("close", { action: "close", name: tab, kill: true });
	await files.remove();
	for (const server of [outer, inner]) {
		const closed = Promise.withResolvers<void>();
		server.close(() => closed.resolve());
		await closed.promise;
	}
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a press in a frame of another process right after its page loads", () => {
	for (const { label, tab } of CASES) {
		it(`with ${label} reaches the button on every load, in a frame and in a frame inside a frame`, async () => {
			const missed: string[] = [];
			for (let load = 0; load < LOADS; load++) {
				const paid = await pressAfterLoad(tab, "/checkout", "/card", "Pay");
				if (paid.join() !== "pay") missed.push(`load ${load} /checkout: ${JSON.stringify(paid)}`);
				const confirmed = await pressAfterLoad(tab, "/nested", "/leaf", "Confirm");
				if (confirmed.join() !== "confirm") missed.push(`load ${load} /nested: ${JSON.stringify(confirmed)}`);
			}
			expect(missed).toEqual([]);
		}, 240_000);
	}
});
