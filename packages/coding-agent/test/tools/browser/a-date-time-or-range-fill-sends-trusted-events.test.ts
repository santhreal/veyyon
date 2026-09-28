/**
 * WHY: `tab.fill` set a date, time or range input by assigning its value in script and dispatching
 * `input` and `change` itself, whose `isTrusted` is false. It now presses each field of a date or time
 * input's editor and types that field's digits, and moves a range with its keys, so the events are the
 * browser's own; the script path remains for a colour and for a range too far for keys.
 *
 * The contract, driven through the real tool against real headless Chromium in both input modes: each
 * fill below leaves the value asked for, and every `input` and `change` the input receives is trusted.
 * The cases cover each field kind the editors have (year, month, day, week, hour on a 12-hour clock
 * with AM and PM, minute, second, millisecond), midnight and noon, a five-digit year, clearing, and a
 * range's step, negative bounds, right-to-left direction and vertical writing mode. A range whose
 * value is more than 40 keys away is set by script, with its events untrusted, as before.
 *
 * What it does not catch: a browser locale that orders or names the fields otherwise, which only a
 * browser launched in that locale shows; field order comes from the editor, so the plan does not
 * depend on it.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

/** Each case: the input's markup, the value filled, and whether script sets it. */
const CASES: ReadonlyArray<{
	readonly id: string;
	readonly markup: string;
	readonly value: string;
	readonly scripted?: true;
}> = [
	{ id: "d1", markup: `<input type="date" id="d1">`, value: "2026-09-26" },
	{ id: "d2", markup: `<input type="date" id="d2" value="2026-09-26">`, value: "1999-12-31" },
	{ id: "d3", markup: `<input type="date" id="d3">`, value: "10000-06-15" },
	{ id: "d4", markup: `<input type="date" id="d4" value="2026-09-26">`, value: "" },
	{ id: "t1", markup: `<input type="time" id="t1">`, value: "00:30" },
	{ id: "t2", markup: `<input type="time" id="t2" value="09:15">`, value: "12:00" },
	{ id: "t3", markup: `<input type="time" id="t3">`, value: "23:59" },
	{ id: "t4", markup: `<input type="time" id="t4" step="1">`, value: "07:05:09" },
	{ id: "t5", markup: `<input type="time" id="t5" step="0.001">`, value: "18:40:15.123" },
	{ id: "dt", markup: `<input type="datetime-local" id="dt" value="2026-01-01T08:00">`, value: "2026-02-28T13:07" },
	{ id: "m1", markup: `<input type="month" id="m1">`, value: "2026-12" },
	{ id: "w1", markup: `<input type="week" id="w1">`, value: "2026-W53" },
	{ id: "r1", markup: `<input type="range" id="r1">`, value: "73" },
	{ id: "r2", markup: `<input type="range" id="r2" step="5" value="10">`, value: "95" },
	{ id: "r3", markup: `<input type="range" id="r3" min="-50" max="50">`, value: "-25" },
	{ id: "r4", markup: `<input type="range" id="r4" dir="rtl">`, value: "12" },
	{ id: "r5", markup: `<input type="range" id="r5" style="writing-mode: vertical-lr">`, value: "70" },
	{ id: "r6", markup: `<input type="range" id="r6" max="10000">`, value: "4567", scripted: true },
];

const PAGE = `<!doctype html><title>fields</title>${CASES.map(c => c.markup).join("\n")}
<script>
window.events = {};
for (const type of ["input", "change"]) {
	document.addEventListener(type, event => { (window.events[event.target.id] ??= []).push(type + ":" + event.isTrusted); }, true);
}
</script>`;

const SWEEP = `const outcomes = [];
for (const { id, value } of CASES) {
	await tab.fill("#" + id, value);
	outcomes.push({ id, value: await tab.evaluate(id => document.getElementById(id).value, id), events: await tab.evaluate(id => window.events[id] ?? [], id) });
}
return outcomes;`;

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
	server = Bun.serve({ port: 0, fetch: () => new Response(PAGE, { headers: { "Content-Type": "text/html" } }) });
});

afterAll(() => {
	server?.stop(true);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a date, time or range fill", () => {
	for (const naturalInput of [false, true]) {
		it(`reaches each value with trusted events, natural input ${naturalInput ? "on" : "off"}`, async () => {
			const session: ToolSession = {
				cwd: process.cwd(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "browser.headless": true, "browser.naturalInput": naturalInput }),
			};
			const tool = new BrowserTool(session);
			const tab = `fields-${naturalInput}`;
			try {
				await tool.execute("open", { action: "open", name: tab, url: `http://127.0.0.1:${server!.port}/` });
				const code = SWEEP.replace("CASES", JSON.stringify(CASES.map(({ id, value }) => ({ id, value }))));
				const outcomes = JSON.parse(
					text(await tool.execute("run", { action: "run", name: tab, timeout: 240, code })),
				) as Array<{
					id: string;
					value: string;
					events: string[];
				}>;
				const seen = outcomes.map(outcome => {
					const wanted = CASES.find(c => c.id === outcome.id)!;
					return {
						id: outcome.id,
						value: outcome.value,
						sent: outcome.events.length > 0,
						trusted: outcome.events.every(event => event.endsWith(":true")),
						expected: { value: wanted.value, trusted: !wanted.scripted },
					};
				});
				expect(seen.map(s => ({ id: s.id, value: s.value, sent: s.sent, trusted: s.trusted }))).toEqual(
					seen.map(s => ({ id: s.id, value: s.expected.value, sent: true, trusted: s.expected.trusted })),
				);
			} finally {
				await tool.execute("close", { action: "close", all: true, kill: true });
			}
		}, 300_000);
	}
});
