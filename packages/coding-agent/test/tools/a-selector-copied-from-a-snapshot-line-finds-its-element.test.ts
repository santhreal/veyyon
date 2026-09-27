/**
 * WHY: a snapshot line reads `textbox "Email" [ref=e9]`, and models copy its `textbox "Email"` part
 * into `tab.fill` or `tab.click`. That is no CSS, so the call failed after the zero-match wait and the
 * model spent a turn rewriting the selector.
 *
 * The contract: a selector of the form `role "name"` finds the element with that role and that exact
 * accessible name, for `fill`, `click` and `waitFor`, a name holding an escaped quote included; an
 * element whose name only contains the name is not taken for it.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a role word that is also a CSS type selector followed by a quoted string,
 * which CSS never allowed, so nothing that worked before changes meaning.
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

const PAGE = `<!doctype html><title>form</title>
<label>Email <input id="email"></label>
<button id="save" onclick="note('save:' + document.getElementById('email').value)">Save</button>
<button id="save-all" onclick="note('save-all')">Save all</button>
<button id="quoted" onclick="note('quoted')">Say "hi"</button>
<ol id="log"></ol>
<script>function note(text) { const item = document.createElement("li"); item.textContent = text; document.getElementById("log").append(item); }</script>`;

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `lines-${process.pid}`;

async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code });
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
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
	files = await TempDir.create("@snapshot-line-selectors-");
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

describe.skipIf(!CHROMIUM_AVAILABLE)("a selector copied from a snapshot line", () => {
	it("fills, waits for and presses the element with that role and that exact name", async () => {
		const log = JSON.parse(
			await run(`await tab.goto(${JSON.stringify(`${base}/`)});
await tab.fill('textbox "Email"', "jo@example.test");
await tab.waitFor('button "Save"');
await tab.click('button "Save"');
await tab.click('button "Say \\\\"hi\\\\""');
return await tab.evaluate(() => Array.from(document.querySelectorAll("#log li"), item => item.textContent));`),
		);
		expect(log).toEqual(["save:jo@example.test", "quoted"]);
	}, 60_000);
});
