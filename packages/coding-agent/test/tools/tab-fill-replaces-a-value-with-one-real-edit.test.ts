/**
 * WHY: `tab.fill` cleared a field by writing its value and then typed the new one a keystroke at a
 * time. A framework that tracks the value it last wrote never saw the clear, so filling a field with
 * nothing left its state holding the old text, and a long value cost three protocol messages per
 * character. A replacement setter with synthetic events fixed the first and broke contenteditable.
 *
 * The contract: fill replaces the whole value of an input, textarea or contenteditable element with
 * trusted edits a framework's tracker counts as changes, the empty value included: one text insertion
 * with `browser.naturalInput` off, and with it on one key per character of a short one-line value and
 * one insertion for any other (the pace of the keys is
 * `a-natural-input-session-moves-rests-and-types-as-a-person-does.test.ts`'s);
 * a date or time input takes its value by a press and the digits on each field of its editor, a range
 * by its keys, so every `input` and `change` either sends is trusted, and a framework's tracker sees the
 * values a person's typing passes through; a colour, which no key sets, is assigned with the two
 * events. A value an input holds in another form (a colour in capitals, a date-time with zero seconds,
 * a range as a decimal) is set in the form the input keeps, and a value it cannot hold is refused with
 * the field left as it was. An element fill cannot fill
 * is refused with the call that can. A selector fill waits for its field to be visible, as a click
 * does; an element that cannot take focus is refused before anything is typed, so the value never
 * lands in the field that holds focus instead. A line inside an editor is replaced through the
 * editor that holds it. Every way to reach fill (a selector, an aria ref, a handle from `tab.id` or
 * `tab.waitFor`) replaces the value the same way. Every case runs with the setting off and on.
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
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

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
<input id="colour" type="color" value="#123456">
<input id="stamp" type="datetime-local" value="2026-01-01T08:00">
<input id="level" type="range" min="0" max="100" value="10">
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
let settings: Settings;
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
	settings = Settings.isolated({ "browser.headless": true });
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
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
	for (const natural of [false, true])
		describe(`with natural input ${natural ? "on" : "off"}`, () => {
			/** What a tracker records while a short `value` goes in: each prefix when typed key by key, the value when inserted. */
			const edits = (value: string): string[] =>
				natural ? Array.from(value, (_, end) => value.slice(0, end + 1)) : [value];

			beforeAll(() => {
				settings.set("browser.naturalInput", natural);
			});

			it("replaces a text field's value with trusted edits, and clears it with one", async () => {
				await fresh();
				const filled = await run(
					'await tab.fill("#text", "fresh value"); return { value: await tab.evaluate(() => document.getElementById("text").value), events: await tab.evaluate(() => events) };',
				);
				const typed = edits("fresh value").map(() => "text:input:true");
				expect(JSON.parse(filled)).toEqual({ value: "fresh value", events: typed });
				const cleared = await run(
					'await tab.fill("#text", ""); return { value: await tab.evaluate(() => document.getElementById("text").value), events: await tab.evaluate(() => events) };',
				);
				expect(JSON.parse(cleared)).toEqual({ value: "", events: [...typed, "text:input:true"] });
			}, 60_000);

			it("is a change to a framework's tracker, the empty value included", async () => {
				await fresh();
				const changes = await run(
					'await tab.fill("#tracked", "fresh"); await tab.fill("#tracked", ""); return await tab.evaluate(() => changes);',
				);
				expect(JSON.parse(changes)).toEqual([...edits("fresh"), ""]);
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

			it("sets a date field with trusted events a person's typing sends, and refuses a value it cannot hold, leaving the field as it was", async () => {
				await fresh();
				const filled = JSON.parse(
					await run(
						'await tab.fill("#date", "2026-09-26"); return { value: await tab.evaluate(() => document.getElementById("date").value), events: await tab.evaluate(() => events) };',
					),
				) as { value: string; events: string[] };
				expect(filled.value).toBe("2026-09-26");
				expect(filled.events).toContain("date:input:true");
				expect(filled.events).toContain("date:change");
				expect(filled.events.filter(event => event === "date:input:false")).toEqual([]);
				// Set past a tracker on the element, as a person's typing is: a framework counts each value it
				// passes through as a change, whether the field is reached by a selector or by an aria ref.
				const tracked = JSON.parse(
					await run(`
			await tab.fill("#when", "2026-09-27");
			const ref = (await tab.ariaSnapshot("#when")).match(/\\[ref=(e\\d+)\\]/)[1];
			await tab.fill("aria-ref=" + ref, "2026-09-28");
			return await tab.evaluate(() => dateChanges);
		`),
				) as string[];
				expect(tracked).toContain("2026-09-27");
				expect(tracked.at(-1)).toBe("2026-09-28");
				expect(await failureOf('await tab.fill("#date", "tomorrow");')).toContain(
					'fill: "tomorrow" is not a value an <input type="date"> holds',
				);
				const kept = await run(
					'return { value: await tab.evaluate(() => document.getElementById("date").value), events: await tab.evaluate(() => events) };',
				);
				expect(JSON.parse(kept)).toEqual(filled);
			}, 60_000);

			it("sets a value a colour, date-time or range input holds in another form, and refuses one it cannot hold", async () => {
				await fresh();
				const read =
					"return { colour: await tab.evaluate(() => document.getElementById('colour').value), stamp: await tab.evaluate(() => document.getElementById('stamp').value), level: await tab.evaluate(() => document.getElementById('level').value) };";
				const filled = await run(
					`await tab.fill("#colour", "#FF8800"); await tab.fill("#stamp", "2026-09-26T10:30:00"); await tab.fill("#level", "40.0"); ${read}`,
				);
				expect(JSON.parse(filled)).toEqual({ colour: "#ff8800", stamp: "2026-09-26T10:30", level: "40" });
				await fresh();
				const refusals = {
					colour: await failureOf('await tab.fill("#colour", "red");'),
					stamp: await failureOf('await tab.fill("#stamp", "2026-09-26T25:00");'),
					level: await failureOf('await tab.fill("#level", "150");'),
				};
				const reason = (failure: string): string => (failure.match(/fill: [^\n]*/) ?? [failure])[0];
				expect({
					colour: reason(refusals.colour),
					stamp: reason(refusals.stamp),
					level: reason(refusals.level),
				}).toEqual({
					colour: 'fill: "red" is not a value an <input type="color"> holds',
					stamp: 'fill: "2026-09-26T25:00" is not a value an <input type="datetime-local"> holds',
					level: 'fill: "150" is not a value an <input type="range"> holds',
				});
				expect(JSON.parse(await run(read))).toEqual({ colour: "#123456", stamp: "2026-01-01T08:00", level: "10" });
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
				expect(JSON.parse(values)).toEqual({ byRef: "by ref", area: "by id", tracked: edits("by handle") });
			}, 60_000);
		});
});
