/**
 * WHY: a click pressed the centre of its element whatever lay on top of it. An autocomplete menu
 * left open over a submit button took the click, selected a suggestion and closed, and the run
 * reported success while the form was never submitted; the model then spent turns testing hit
 * targets with `elementFromPoint` before every click it made.
 *
 * The contract: `tab.click` by selector or by aria ref, and a handle's `click` and `hover` (from
 * `tab.ref`, awaited or not), press only a point that belongs to the element. A cover that goes
 * within the wait is waited out; one that stays fails the call naming the cover, within a bound
 * shorter than the action ceiling, and nothing is pressed; that holds for a cover inside the same
 * shadow root as the element. A styled checkbox drawn over its input inside the input's label, an
 * element in an open shadow root, an icon that lets pointer events through to its button, and an
 * element a fixed header hides until it is centred are pressed, not refused. A disabled control is
 * waited for until it is enabled, and fails naming that when it never is, before the op's own
 * deadline. `tab.ref(…)` methods work without awaiting the ref. `tab.uploadFile` hands files to the
 * chooser a control opens, refuses an input that takes no files, and fails naming a control that
 * opens no chooser.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: an element replaced between two looks, which a CSS selector resolves again
 * (no page replaces an element at a moment a test can pin), a cover in a parent frame over an
 * iframe's element, and a covering `::after` of one of the element's ancestors, which is taken for
 * the element's own box.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

const HEAD = `<!doctype html><title>press</title><style>body{margin:0;font:16px sans-serif}button{display:block;width:140px;height:40px;margin:20px}</style>
<script>window.presses = []; const note = name => presses.push(name);</script>`;

const PAGES: Record<string, string> = {
	covered: `<button id="go" onclick="note('go')" onmouseover="note('go:over')">Go</button>
<div id="cover" onclick="note('cover')" style="position:fixed;inset:0;background:rgba(0,0,0,.1)">menu open</div>`,
	fading: `<button id="go" onclick="note('go')">Go</button>
<div id="cover" onclick="note('cover')" style="position:fixed;inset:0">fading</div>
<script>setTimeout(() => document.getElementById("cover").remove(), 300);</script>`,
	checkbox: `<label><input id="agree" type="checkbox" style="position:absolute;opacity:0;width:24px;height:24px;margin:0">
<span style="display:inline-block;position:relative;width:24px;height:24px;background:#08f"></span> Agree</label>`,
	shadow: `<div id="host"></div>
<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML = '<button id="inner">In</button>';
document.getElementById("host").shadowRoot.getElementById("inner").onclick = () => note("inner");</script>`,
	"shadow-covered": `<div id="host"></div>
<script>document.getElementById("host").attachShadow({ mode: "open" }).innerHTML =
	'<button id="inner" onclick="note(\\'inner\\')">In</button><div id="veil" style="position:fixed;inset:0">veil</div>';</script>`,
	icon: `<button id="save" onclick="note('save')"><svg id="glyph" width="20" height="20" style="pointer-events:none"><rect width="20" height="20"/></svg> Save</button>`,
	sticky: `<header style="position:fixed;top:0;left:0;right:0;height:120px;background:#eee">header</header>
<div style="height:1000px"></div><button id="go" onclick="note('go')">Go</button><div style="height:3000px"></div>
<script>addEventListener("load", () => scrollTo(0, 1000));</script>`,
	disabled: `<button id="later" disabled onclick="note('later')">Later</button><button id="never" disabled>Never</button>
<script>setTimeout(() => { document.getElementById("later").disabled = false; }, 400);</script>`,
	upload: `<button id="pick">Choose</button><button id="inert">Nothing</button><input id="name" value="">
<p id="out"></p>
<script>document.getElementById("pick").onclick = () => {
	const input = document.createElement("input");
	input.type = "file";
	input.onchange = () => { document.getElementById("out").textContent = [...input.files].map(file => file.name).join(","); };
	input.click();
};</script>`,
};

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `press-${process.pid}`;

async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code });
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

async function load(page: string): Promise<void> {
	await run(`await tab.goto(${JSON.stringify(`${base}/${page}`)});`);
}

/** Run `action` in the page and report how it ended, how long it took and what the page recorded. */
async function attempt(action: string): Promise<{ failure: string | null; ms: number; presses: string[] }> {
	return JSON.parse(
		await run(`const started = Date.now();
let failure = null;
try { ${action} } catch (error) { failure = error.message; }
return { failure, ms: Date.now() - started, presses: await tab.evaluate(() => presses) };`),
	);
}

/** The ref the last snapshot gave the button named `name`. */
function refOf(name: string): string {
	return `(await tab.ariaSnapshot()).match(/button "${name}" \\[ref=(e\\d+)\\]/)[1]`;
}

beforeAll(async () => {
	server = http.createServer((request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(HEAD + (PAGES[(request.url ?? "/").slice(1)] ?? ""));
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@press-upload-");
	if (!CHROMIUM_AVAILABLE) return;
	const session: ToolSession = {
		cwd: files.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, url: `${base}/covered` });
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", name: TAB, kill: true });
	await files.remove();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a click", () => {
	it("fails naming a cover that stays, within a bound, and presses nothing, by every route to a click", async () => {
		const routes = [
			'await tab.click("#go");',
			`await tab.click("aria-ref=" + ${refOf("Go")});`,
			`await (await tab.ref(${refOf("Go")})).click();`,
			`await tab.ref(${refOf("Go")}).click();`,
			`await tab.ref(${refOf("Go")}).hover();`,
		];
		for (const route of routes) {
			await load("covered");
			const outcome = await attempt(route);
			expect({ route, failure: outcome.failure, presses: outcome.presses }).toEqual({
				route,
				failure: expect.stringContaining('<div#cover> "menu open" covers the point it would press'),
				presses: [],
			});
			expect(outcome.ms).toBeGreaterThanOrEqual(2_000);
			expect(outcome.ms).toBeLessThan(6_000);
		}
	}, 120_000);

	it("waits out a cover that goes, then presses the element", async () => {
		await load("fading");
		expect(await attempt('await tab.click("#go");')).toMatchObject({ failure: null, presses: ["go"] });
	}, 60_000);

	it("presses what reaches the element (a checkbox's label, a shadow root, an icon's button, a centred button), not a cover in its shadow root", async () => {
		await load("checkbox");
		const checked = await run(
			'await tab.click("#agree"); return await tab.evaluate(() => document.getElementById("agree").checked);',
		);
		expect(checked).toBe("true");
		await load("shadow");
		expect(await attempt('await tab.click("pierce/#inner");')).toMatchObject({ failure: null, presses: ["inner"] });
		await load("icon");
		expect(await attempt('await tab.click("#glyph");')).toMatchObject({ failure: null, presses: ["save"] });
		await load("shadow-covered");
		expect((await attempt('await tab.click("pierce/#inner");')).failure).toContain('<div#veil> "veil" covers');
		await load("sticky");
		expect(await attempt('await tab.click("#go");')).toMatchObject({ failure: null, presses: ["go"] });
	}, 60_000);

	it("waits for a disabled button to be enabled, and fails naming one that never is", async () => {
		await load("disabled");
		expect(await attempt('await tab.click("#later");')).toMatchObject({ failure: null, presses: ["later"] });
		const never = await attempt('await tab.click("#never");');
		expect(never.failure).toContain("stayed disabled");
		expect(never.ms).toBeLessThan(12_000);
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("tab.uploadFile", () => {
	it("hands files to the chooser a button opens", async () => {
		await fs.writeFile(files.join("report.txt"), "contents");
		await load("upload");
		const out = await run(
			'await tab.uploadFile("#pick", "report.txt"); return await tab.evaluate(() => document.getElementById("out").textContent);',
		);
		expect(out).toBe("report.txt");
	}, 60_000);

	it("refuses an input that takes no files, and names a control that opens no chooser", async () => {
		await load("upload");
		const text = await attempt('await tab.uploadFile("#name", "report.txt");');
		expect(text.failure).toContain('an <input type="text"> takes no files');
		const inert = await attempt('await tab.uploadFile("#inert", "report.txt");');
		expect(inert.failure).toContain("pressing the <button> opened no file chooser");
		expect(inert.ms).toBeLessThan(4_000);
	}, 60_000);
});
