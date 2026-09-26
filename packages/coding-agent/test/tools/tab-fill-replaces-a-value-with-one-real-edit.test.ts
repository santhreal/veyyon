/**
 * WHY: `tab.fill` cleared a field by writing its value and then typed the new one a keystroke at a
 * time. A framework that tracks the value it last wrote never saw the clear, so filling a field with
 * nothing left its state holding the old text, and a long value cost three protocol messages per
 * character. A replacement setter with synthetic events fixed the first and broke contenteditable.
 *
 * The contract: fill replaces the whole value of an input, textarea or contenteditable element in one
 * trusted text insertion, which a framework's tracker counts as a change, the empty value included;
 * an input holding a date, time, colour or range takes its value past the framework's tracker with
 * the `input` and `change` a person's edit fires, and a value it cannot hold is refused with the field
 * left as it was; an element fill cannot fill is refused with the call that can. A selector fill waits
 * for its field to be visible, as a click does; an element that cannot take focus is refused before
 * anything is typed, so the value never lands in the field that holds focus instead. A line inside
 * an editor is replaced through the editor that holds it. Every way to reach fill (a selector, an
 * aria ref, a handle from `tab.id` or `tab.waitFor`) replaces the value the same way.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a field inside a cross-origin frame, and a framework's own component code;
 * the tracker below is the check React's onChange makes, not React.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

const PAGE = `<!doctype html><title>fill</title>
<input id="text" value="old">
<textarea id="area">old</textarea>
<div id="edit" contenteditable>old <b>bold</b></div>
<input id="date" type="date">
<input id="check" type="checkbox">
<select id="pick"><option>a</option></select>
<input id="locked" readonly value="x">
<p id="para">text</p>
<input id="tracked" value="old">
<input id="gone" value="kept" hidden>
<div id="gone-edit" contenteditable hidden>kept</div>
<div inert><input id="frozen" value="kept"></div>
<input id="late" hidden>
<div id="editor" contenteditable><p id="line">first</p><p>second</p></div>
<input id="when" type="date">
<script>
window.events = [];
for (const id of ["text", "area", "edit", "date"]) {
	const el = document.getElementById(id);
	el.addEventListener("input", e => events.push(id + ":input:" + e.isTrusted));
	el.addEventListener("change", () => events.push(id + ":change"));
}
// A framework's tracker: the value the page last wrote through the element, and an input event
// counted as a change only when the field now holds something else.
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
function track(id, sink) {
	const el = document.getElementById(id);
	let written = el.value;
	Object.defineProperty(el, "value", {
		get() { return native.get.call(this); },
		set(v) { written = String(v); native.set.call(this, v); },
	});
	el.addEventListener("input", () => {
		const now = el.value;
		if (now !== written) { written = now; sink.push(now); }
	});
}
window.changes = [];
window.dateChanges = [];
track("tracked", changes);
track("when", dateChanges);
</script>`;

let server: http.Server;
let url = "";
let tool: BrowserTool;
const TAB = `fill-${process.pid}`;

async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code });
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

async function fresh(): Promise<void> {
	await run(`await tab.goto(${JSON.stringify(url)});`);
}

/**
 * The message `code` fails with. Awaited here rather than through `expect(...).rejects`, which stalls
 * until the supervisor kills the tab when the rejection arrives as the tab worker's reply.
 */
async function failureOf(code: string): Promise<string> {
	try {
		await run(code);
		return "(it did not fail)";
	} catch (error) {
		return (error as Error).message;
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
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	if (!CHROMIUM_AVAILABLE) return;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, url });
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", name: TAB, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("tab.fill", () => {
	it("replaces a text field's value in one trusted edit, and clears it with one", async () => {
		await fresh();
		const filled = await run(
			'await tab.fill("#text", "fresh value"); return { value: await tab.evaluate(() => document.getElementById("text").value), events: await tab.evaluate(() => events) };',
		);
		expect(JSON.parse(filled)).toEqual({ value: "fresh value", events: ["text:input:true"] });
		const cleared = await run(
			'await tab.fill("#text", ""); return { value: await tab.evaluate(() => document.getElementById("text").value), events: await tab.evaluate(() => events) };',
		);
		expect(JSON.parse(cleared)).toEqual({ value: "", events: ["text:input:true", "text:input:true"] });
	}, 60_000);

	it("is a change to a framework's tracker, the empty value included", async () => {
		await fresh();
		const changes = await run(
			'await tab.fill("#tracked", "fresh"); await tab.fill("#tracked", ""); return await tab.evaluate(() => changes);',
		);
		expect(JSON.parse(changes)).toEqual(["fresh", ""]);
	}, 60_000);

	it("replaces a textarea's lines and a contenteditable element's whole contents, and clears the element", async () => {
		await fresh();
		const filled = await run(
			'await tab.fill("#area", "one\\ntwo"); await tab.fill("#edit", "plain"); return { area: await tab.evaluate(() => document.getElementById("area").value), edit: await tab.evaluate(() => document.getElementById("edit").textContent), bold: await tab.evaluate(() => document.querySelectorAll("#edit b").length) };',
		);
		expect(JSON.parse(filled)).toEqual({ area: "one\ntwo", edit: "plain", bold: 0 });
		const cleared = await run(
			'await tab.fill("#edit", ""); return { edit: await tab.evaluate(() => document.getElementById("edit").textContent) };',
		);
		expect(JSON.parse(cleared)).toEqual({ edit: "" });
	}, 60_000);

	it("sets a date field with the input and change a person's edit fires, and refuses a value it cannot hold, leaving the field as it was", async () => {
		await fresh();
		const filled = await run(
			'await tab.fill("#date", "2026-09-26"); return { value: await tab.evaluate(() => document.getElementById("date").value), events: await tab.evaluate(() => events) };',
		);
		expect(JSON.parse(filled)).toEqual({ value: "2026-09-26", events: ["date:input:false", "date:change"] });
		// Set past a tracker on the element, as a person's pick is: a framework counts it as a change,
		// whether the field is reached by a selector or by an aria ref.
		const tracked = await run(`
			await tab.fill("#when", "2026-09-27");
			const ref = (await tab.ariaSnapshot("#when")).match(/\\[ref=(e\\d+)\\]/)[1];
			await tab.fill("aria-ref=" + ref, "2026-09-28");
			return await tab.evaluate(() => dateChanges);
		`);
		expect(JSON.parse(tracked)).toEqual(["2026-09-27", "2026-09-28"]);
		expect(await failureOf('await tab.fill("#date", "tomorrow");')).toContain(
			'fill: "tomorrow" is not a value an <input type="date"> holds',
		);
		const kept = await run(
			'return { value: await tab.evaluate(() => document.getElementById("date").value), events: await tab.evaluate(() => events) };',
		);
		expect(JSON.parse(kept)).toEqual({ value: "2026-09-26", events: ["date:input:false", "date:change"] });
	}, 60_000);

	it("refuses an element it cannot fill with the call that can", async () => {
		await fresh();
		const refusals: Record<string, string> = {};
		for (const [id, selector] of Object.entries({
			check: "#check",
			pick: "#pick",
			locked: "#locked",
			para: "#para",
		})) {
			const failure = await failureOf(`await tab.fill(${JSON.stringify(selector)}, "x");`);
			refusals[id] = (failure.match(/fill: [^\n]*/) ?? [failure])[0];
		}
		expect(refusals).toEqual({
			check: 'fill: an <input type="checkbox"> is set by clicking it',
			pick: "fill: a <select> is set with tab.select(selector, ...values)",
			locked: "fill: the <input> is read-only",
			para: "fill: a <p> is not an <input>, a <textarea> or contenteditable",
		});
	}, 60_000);

	it("refuses an element that cannot take focus, and the field holding focus keeps its value", async () => {
		await fresh();
		const refusals = {
			// Visible but inert: the selector's wait for visibility passes, and focus does not move.
			inert: await failureOf(
				'await tab.evaluate(() => document.getElementById("text").focus()); await tab.fill("#frozen", "stray");',
			),
			// Hidden, reached through a handle, which is filled as it is rather than waited for.
			hidden: await failureOf('await (await tab.waitFor("#gone")).fill("stray");'),
			// With nothing focused the page's body is active, and it holds every element: it is not an editor.
			editor: await failureOf(
				'await tab.evaluate(() => document.activeElement.blur()); await (await tab.waitFor("#gone-edit")).fill("stray");',
			),
		};
		const reason = (failure: string): string => (failure.match(/fill: [^\n]*/) ?? [failure])[0];
		expect({
			inert: reason(refusals.inert),
			hidden: reason(refusals.hidden),
			editor: reason(refusals.editor),
		}).toEqual({
			inert: "fill: the <input> cannot take focus: it is hidden, inert or not rendered",
			hidden: "fill: the <input> cannot take focus: it is hidden, inert or not rendered",
			editor: "fill: the <div> cannot take focus: it is hidden, inert or not rendered",
		});
		const values = await run(
			'return { text: await tab.evaluate(() => document.getElementById("text").value), frozen: await tab.evaluate(() => document.getElementById("frozen").value), gone: await tab.evaluate(() => document.getElementById("gone").value), goneEdit: await tab.evaluate(() => document.getElementById("gone-edit").textContent) };',
		);
		expect(JSON.parse(values)).toEqual({ text: "old", frozen: "kept", gone: "kept", goneEdit: "kept" });
	}, 60_000);

	it("waits for a field that is not visible yet, as a click does", async () => {
		await fresh();
		const filled = await run(
			'await tab.evaluate(() => setTimeout(() => { document.getElementById("late").hidden = false; }, 500)); await tab.fill("#late", "arrived"); return { late: await tab.evaluate(() => document.getElementById("late").value) };',
		);
		expect(JSON.parse(filled)).toEqual({ late: "arrived" });
	}, 60_000);

	it("replaces one line of an editor through the editor that holds it", async () => {
		await fresh();
		const filled = await run(
			'await tab.fill("#line", "plain"); return await tab.evaluate(() => Array.from(document.querySelectorAll("#editor p"), p => p.textContent));',
		);
		expect(JSON.parse(filled)).toEqual(["plain", "second"]);
	}, 60_000);

	it("replaces the value the same way through an aria ref, tab.id and tab.waitFor", async () => {
		await fresh();
		const values = await run(`
			const snapshot = await tab.ariaSnapshot("#text");
			const ref = snapshot.match(/\\[ref=(e\\d+)\\]/)[1];
			await tab.fill("aria-ref=" + ref, "by ref");
			const byRef = await tab.evaluate(() => document.getElementById("text").value);
			const observed = await tab.observe({ includeAll: true });
			const area = observed.elements.find(e => e.role === "textbox" && e.value === "old");
			await (await tab.id(area.id)).fill("by id");
			await (await tab.waitFor("#tracked")).fill("by handle");
			return { byRef, area: await tab.evaluate(() => document.getElementById("area").value), tracked: await tab.evaluate(() => changes) };
		`);
		expect(JSON.parse(values)).toEqual({ byRef: "by ref", area: "by id", tracked: ["by handle"] });
	}, 60_000);
});
