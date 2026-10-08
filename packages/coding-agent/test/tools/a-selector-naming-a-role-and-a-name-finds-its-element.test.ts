/**
 * WHY: a snapshot line reads `textbox "Email" [ref=e9]`, and models copy its `textbox "Email"` part
 * into `tab.fill` or `tab.click`, or write the role and name in attribute form, `textbox[name="Email"]`
 * or Playwright's `role=button[name="Save"]`. None of these is CSS that matches anything, so the call
 * failed after the zero-match wait and the model spent a turn rewriting the selector.
 *
 * The contract: a selector of the form `role "name"`, `role[name="name"]` for a role no HTML element
 * is named after, or `role=role[name="name"]`, finds the element with that role and that exact
 * accessible name, for `fill`, `click` and `waitFor`, a name holding an escaped quote included; an
 * element whose name only contains the name is not taken for it; and a CSS selector on an HTML
 * element's `name` attribute, `input[name="query"]`, keeps its CSS meaning.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a role word that is also a CSS type selector followed by a quoted string,
 * which CSS never allowed, so nothing that worked before changes meaning; and a role outside the list
 * the attribute form accepts without `role=`, which stays CSS and matches nothing.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

const PAGE = `<!doctype html><title>form</title>
<label>Email <input id="email"></label>
<label>Search <input id="query" name="query"></label>
<a href="#done" onclick="note('link')">Done</a>
<button id="save" onclick="note('save:' + document.getElementById('email').value + ':' + document.getElementById('query').value)">Save</button>
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

/** Run `steps` on a fresh copy of the page and return what its buttons and link recorded. */
async function logAfter(steps: string): Promise<string[]> {
	return JSON.parse(
		await run(`await tab.goto(${JSON.stringify(`${base}/`)});
${steps}
return await tab.evaluate(() => Array.from(document.querySelectorAll("#log li"), item => item.textContent));`),
	);
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
	files = await TempDir.create("@role-name-selectors-");
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

describe.skipIf(!CHROMIUM_AVAILABLE)("a selector naming a role and a name", () => {
	it("in a snapshot line's form fills, waits for and presses the element with that exact name", async () => {
		const log = await logAfter(`await tab.fill('textbox "Email"', "jo@example.test");
await tab.waitFor('button "Save"');
await tab.click('button "Save"');
await tab.click('button "Say \\\\"hi\\\\""');`);
		expect(log).toEqual(["save:jo@example.test:", "quoted"]);
	}, 60_000);

	it("in attribute form finds the element with that exact name, and CSS on a name attribute stays CSS", async () => {
		const log = await logAfter(`await tab.fill('textbox[name="Email"]', "ana@example.test");
await tab.fill('input[name="query"]', "lamps");
await tab.waitFor("role=button[name='Save']");
await tab.click('role=button[name="Save"]');
await tab.click('link[name="Done"]');`);
		expect(log).toEqual(["save:ana@example.test:lamps", "link"]);
	}, 60_000);
});
