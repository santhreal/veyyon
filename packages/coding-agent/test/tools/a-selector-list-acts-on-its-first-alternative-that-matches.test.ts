/**
 * WHY: models hedge a selector with a comma list, and mix the tool's own forms into it:
 * `input[type=email], textbox "Email"`, `select[name=reason], aria-ref=e22`, or a snapshot line's
 * `[ref=e9]`. None of those is CSS, so the whole list failed to parse, and the call waited out its
 * eight-second deadline before failing with no hint; an invalid selector of any kind did the same.
 * Ten workflow calibration trials lost eight calls this way.
 *
 * The contract: a comma list that holds a ref (`aria-ref=eN`, `[ref=eN]`), a snapshot line's form or a
 * query handler acts on its first alternative, in the order written, that matches an element; a plain
 * CSS list keeps its CSS meaning; a list none of whose alternatives matches, and a selector that does
 * not parse, fail within the zero-match window instead of the deadline; a selector that starts with a
 * query handler keeps its commas; `[ref=eN]` alone is a ref; `tab.select` and `tab.press`'s
 * `selector` take refs as the other actions do.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: the cmux backend, whose actions take its own selectors, and a list whose
 * first matching alternative is hidden while a later one is visible; the first match is taken.
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
<label>Email <input id="email" onkeydown="note('key:' + event.key)"></label>
<label>Reason <select id="reason"><option value="a">A</option><option value="b">B</option></select></label>
<button id="save" onclick="note('save:' + document.getElementById('email').value)">Save</button>
<button id="save-all" onclick="note('save-all')">Save all</button>
<button id="pay" onclick="note('pay')">Pay</button>
<button id="ship" onclick="note('ship')">Pay, then ship</button>
<ol id="log"></ol>
<script>function note(text) { const item = document.createElement("li"); item.textContent = text; document.getElementById("log").append(item); }</script>`;

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `lists-${process.pid}`;

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

/** Load a fresh copy of the page, run `steps`, and return what the page recorded. */
async function logAfter(steps: string): Promise<string[]> {
	const { text, failure } = await run(`await tab.goto(${JSON.stringify(`${base}/`)});
${steps}
return await tab.evaluate(() => Array.from(document.querySelectorAll("#log li"), item => item.textContent));`);
	expect(failure).toBeNull();
	return JSON.parse(text);
}

/** The ref the latest snapshot gives the line that starts with `line`, read in the same run. */
const REF_OF = `const refOf = (snapshot, line) => snapshot.split("\\n").find(row => row.trim().startsWith(line)).match(/\\[ref=(e\\d+)\\]/)[1];`;

beforeAll(async () => {
	server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(PAGE);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@selector-lists-");
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

describe.skipIf(!CHROMIUM_AVAILABLE)("a selector list", () => {
	it("acts on the first alternative that matches, a snapshot line's form or a ref among them", async () => {
		const log = await logAfter(`${REF_OF}
const snapshot = await tab.ariaSnapshot();
await tab.fill('input[type=email], textbox "Email"', "jo@example.test");
await tab.click("#missing, aria-ref=" + refOf(snapshot, '- button "Save"'));
await tab.click('button "Save all", button "Save"');`);
		// The field notes its keys, which a fill with `browser.naturalInput` on types one at a time; the value
		// the save reads is what shows which alternative the fill reached.
		expect(log.filter(entry => !entry.startsWith("key:"))).toEqual(["save:jo@example.test", "save-all"]);
	}, 60_000);

	it("keeps a plain CSS list's meaning and a leading handler's commas", async () => {
		// CSS takes the list's first match in document order, where #save comes before #save-all.
		const log = await logAfter(`await tab.click("#save-all, #save");
await tab.click("text/Pay, then ship");`);
		expect(log).toEqual(["save:", "ship"]);
	}, 60_000);

	it("takes [ref=eN] alone as a ref, and a ref in tab.select and tab.press", async () => {
		const log = await logAfter(`${REF_OF}
const snapshot = await tab.ariaSnapshot();
await tab.click("[ref=" + refOf(snapshot, '- button "Save all"') + "]");
await tab.select("select[name=reason], aria-ref=" + refOf(snapshot, '- combobox "Reason"'), "b");
await tab.press("Enter", { selector: "aria-ref=" + refOf(snapshot, '- textbox "Email"') });
await tab.evaluate(() => note("reason:" + document.getElementById("reason").value));`);
		expect(log).toEqual(["save-all", "key:Enter", "reason:b"]);
	}, 60_000);

	it("fails within the zero-match window when no alternative matches or the selector does not parse", async () => {
		await run(`await tab.goto(${JSON.stringify(`${base}/`)});`);
		const none = await run(`await tab.click('#missing, textbox "Nowhere"');`);
		expect(none.failure).toContain("no alternative of the list matches an element");
		expect(none.ms).toBeLessThan(5_000);
		const invalid = await run(`await tab.click("button[");`);
		expect(invalid.failure).toContain('"button[" is not a valid selector');
		expect(invalid.ms).toBeLessThan(5_000);
	}, 60_000);
});
