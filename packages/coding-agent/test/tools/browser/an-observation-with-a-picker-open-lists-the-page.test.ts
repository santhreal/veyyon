/**
 * WHY: `tab.observe()` failed with `Cannot read properties of null (reading 'nodeType')` whenever a
 * date picker was open: the accessibility tree includes the picker popup, whose nodes belong to no
 * document of the page, and puppeteer's lookup of such a node's element throws. One open picker made
 * the page unreadable by `observe` until something closed it.
 *
 * The contract, driven through the real tool against real headless Chromium: with the popup of each
 * input type that has one open, by a press on its indicator or on the input as a person opens it,
 * `observe` lists the page's controls, and every id it lists acts. The popup is proven open by the
 * accessibility tree growing when it opens.
 *
 * What it does not catch: whether the picker's own controls can be reached another way; they are left
 * out of the list.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();
const PICKER_TYPES = ["date", "datetime-local", "month", "week", "time", "color"] as const;

let tool: BrowserTool;

beforeAll(() => {
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
});

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

describe.skipIf(!CHROMIUM_AVAILABLE)("an observation with a picker open", () => {
	for (const type of PICKER_TYPES) {
		it(`lists the page, and every id acts, with the ${type} picker open`, async () => {
			const name = `picker-${type}`;
			const html = `<label>Query <input id="q"></label><label>Pick <input type="${type}" id="p"></label><button id="b" onclick="this.dataset.pressed='yes'">Go</button>`;
			await tool.execute("open", { action: "open", name, url: `data:text/html,${encodeURIComponent(html)}` });
			const result = await tool.execute("run", {
				action: "run",
				name,
				code: `const size = async () => {
	let nodes = 0;
	const walk = node => { nodes += 1; for (const child of node.children ?? []) walk(child); };
	walk(await page.accessibility.snapshot({ interestingOnly: false }));
	return nodes;
};
const closed = await size();
const before = await tab.observe();
const opener = before.elements.find(element => element.role === "button" && element.name !== "Go");
if (opener) await tab.id(opener.id).click();
else await tab.click("#p");
const open = await size();
const seen = await tab.observe();
for (const element of seen.elements) await tab.id(element.id).evaluate(el => el.tagName);
await tab.id(seen.elements.find(element => element.role === "button" && element.name === "Go").id).click();
return { grew: open > closed, roles: seen.elements.map(element => element.role + " " + (element.name ?? "")), pressed: await tab.evaluate(() => document.getElementById("b").dataset.pressed) };`,
			});
			const observed = JSON.parse(text(result)) as { grew: boolean; roles: string[]; pressed: string };
			expect(observed.grew).toBe(true);
			expect(observed.roles).toContain("textbox Query");
			expect(observed.roles).toContain("button Go");
			expect(observed.pressed).toBe("yes");
		}, 60_000);
	}
});
