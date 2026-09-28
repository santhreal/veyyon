/**
 * WHY: `tab.select` assigned `selected` in script and dispatched its own `input` and `change`, whose
 * `isTrusted` is false: a form that checks how its fields changed saw a select no person had touched.
 * It now selects by Chromium's type-ahead, planned by replaying `TypeAhead::HandleEvent`, and adds a
 * multiple select's further options by a modified click; the script path remains for what no key or
 * click reaches.
 *
 * The contract, driven through the real tool against real headless Chromium in both input modes:
 * for every option of every select below, `tab.select` leaves that option selected, returns its value,
 * and every `input` and `change` the select receives is trusted. The selects are the cases the replay
 * has to agree with Chromium on: options sharing a first letter, a doubled first letter, a label that
 * starts another, case and accents, Cyrillic and CJK labels, disabled options and groups, `<hr>`
 * separators, a list box, a multiple select with nothing selected and a group first, and a drop-down
 * whose popup a click opened. A disabled option is still selected, by script, as before; and selecting
 * what is selected already sends nothing.
 *
 * What it does not catch: a customizable `appearance: base-select`, which the script sets; and the
 * macOS modifier for a multiple select, which only a macOS host drives.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

const opts = (labels: readonly string[]): string => labels.map(label => `<option>${label}</option>`).join("");

/** Each select's markup; every option's value is its text unless the markup gives one. */
const SELECTS: Record<string, string> = {
	shared: `<select id="shared">${opts(["Alpha", "Beta", "Bravo", "Brick", "Charlie"])}</select>`,
	doubled: `<select id="doubled">${opts(["Llama", "Lion", "Llanfair", "Beta", "Beta 2", "Beta 22"])}</select>`,
	accents: `<select id="accents">${opts(["Éclair", "eagle", "Émile", "ECHO", "Ember"])}</select>`,
	cyrillic: `<select id="cyrillic">${opts(["Москва", "Минск", "Киев", "Мурманск"])}</select>`,
	cjk: `<select id="cjk">${opts(["東京", "大阪", "京都", "東北"])}</select>`,
	groups: `<select id="groups"><optgroup label="Fruit"><option>Apple</option><option disabled>Apricot</option></optgroup><optgroup label="Off" disabled><option>Avocado</option></optgroup><hr><option>Banana</option><option>Almond</option></select>`,
	// Nothing selected and a group first: type-ahead starts at the first option, which only counting the
	// group among the list items predicts, and no longer prefix tells "Mo" from the labels it starts.
	groupfirst: `<select id="groupfirst" multiple size="4"><optgroup label="G"><option>Mo</option><option>Mo 2</option></optgroup><option>Mo 3</option></select>`,
	listbox: `<select id="listbox" size="4">${opts(["Red", "Rose", "Ruby", "Rust", "Sand", "Sage"])}</select>`,
	multiple: `<select id="multiple" multiple size="5"><optgroup label="Top"><option>Mint</option><option>Maple</option></optgroup><option>Moss</option><option>Oak</option><option>Olive</option></select>`,
};

const PAGE = `<!doctype html><title>selects</title>${Object.values(SELECTS).join("\n")}
<script>
window.events = {};
for (const type of ["input", "change"]) {
	document.addEventListener(type, event => {
		const id = event.target.id;
		(window.events[id] ??= []).push(type + ":" + event.isTrusted);
	}, true);
}
window.takeEvents = id => { const taken = window.events[id] ?? []; window.events[id] = []; return taken; };
</script>`;

interface Outcome {
	select: string;
	value: string;
	returned: string[];
	held: string[];
	events: string[];
	disabled: boolean;
}

const SWEEP = `const outcomes = [];
for (const id of IDS) {
	const values = await tab.evaluate(id => Array.from(document.getElementById(id).options, o => ({ value: o.value, disabled: o.matches(":disabled") })), id);
	for (const { value, disabled } of values) {
		await tab.evaluate(id => window.takeEvents(id), id);
		const returned = await tab.select("#" + id, value);
		const held = await tab.evaluate(id => Array.from(document.getElementById(id).selectedOptions, o => o.value), id);
		outcomes.push({ select: id, value, returned, held, events: await tab.evaluate(id => window.takeEvents(id), id), disabled });
	}
}
await tab.evaluate(() => window.takeEvents("multiple"));
const several = await tab.select("#multiple", "Maple", "Oak", "Olive");
const severalHeld = await tab.evaluate(() => Array.from(document.getElementById("multiple").selectedOptions, o => o.value));
const severalEvents = await tab.evaluate(() => window.takeEvents("multiple"));
const again = await tab.select("#shared", "Charlie");
await tab.evaluate(() => window.takeEvents("shared"));
await tab.select("#shared", "Charlie");
const repeatEvents = await tab.evaluate(() => window.takeEvents("shared"));
await tab.click("#doubled");
const opened = await tab.select("#doubled", "Lion");
const openedEvents = await tab.evaluate(() => window.takeEvents("doubled"));
return { outcomes, several, severalHeld, severalEvents, again, repeatEvents, opened, openedEvents };`;

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

let origin = "";
let server: ReturnType<typeof Bun.serve> | undefined;

beforeAll(() => {
	server = Bun.serve({
		port: 0,
		fetch: () => new Response(PAGE, { headers: { "Content-Type": "text/html; charset=utf-8" } }),
	});
	origin = `http://127.0.0.1:${server.port}`;
});

afterAll(() => {
	server?.stop(true);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("tab.select", () => {
	for (const naturalInput of [false, true]) {
		it(`reaches every option with trusted events, natural input ${naturalInput ? "on" : "off"}`, async () => {
			const session: ToolSession = {
				cwd: process.cwd(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "browser.headless": true, "browser.naturalInput": naturalInput }),
			};
			const tool = new BrowserTool(session);
			const tab = `select-${naturalInput}`;
			try {
				await tool.execute("open", { action: "open", name: tab, url: `${origin}/` });
				const result = await tool.execute("run", {
					action: "run",
					name: tab,
					timeout: 240,
					code: SWEEP.replace("IDS", JSON.stringify(Object.keys(SELECTS))),
				});
				const swept = JSON.parse(text(result)) as {
					outcomes: Outcome[];
					several: string[];
					severalHeld: string[];
					severalEvents: string[];
					again: string[];
					repeatEvents: string[];
					opened: string[];
					openedEvents: string[];
				};
				expect(swept.outcomes.length).toBe(Object.values(SELECTS).join("").split("<option").length - 1);
				for (const outcome of swept.outcomes) {
					const label = `${outcome.select} ${outcome.value}`;
					expect({ label, returned: outcome.returned, held: outcome.held }).toEqual({
						label,
						returned: [outcome.value],
						held: [outcome.value],
					});
					if (!outcome.disabled) {
						expect({ label, untrusted: outcome.events.filter(event => event.endsWith(":false")) }).toEqual({
							label,
							untrusted: [],
						});
					}
				}
				expect(swept.several).toEqual(["Maple", "Oak", "Olive"]);
				expect(swept.severalHeld).toEqual(["Maple", "Oak", "Olive"]);
				expect(swept.severalEvents.length).toBeGreaterThan(0);
				expect(swept.severalEvents.filter(event => event.endsWith(":false"))).toEqual([]);
				expect(swept.again).toEqual(["Charlie"]);
				expect(swept.repeatEvents).toEqual([]);
				// A drop-down a click opened takes keys in its popup, which the select closes before it types.
				expect(swept.opened).toEqual(["Lion"]);
				expect(swept.openedEvents.length).toBeGreaterThan(0);
				expect(swept.openedEvents.filter(event => event.endsWith(":false"))).toEqual([]);
			} finally {
				await tool.execute("close", { action: "close", all: true, kill: true });
			}
		}, 300_000);
	}
});
