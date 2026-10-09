/**
 * WHY: an element handed out by `tab.observe()` (an id) or `tab.ariaSnapshot()` (an ARIA ref) is a
 * handle to one DOM node. A page that replaces the node with an equivalent one, as a framework
 * re-mount, a list redraw or a polling view does, left every action on the id or ref failing with
 * "Node is detached from document" or "Node is either not clickable or not an Element", and on a page
 * that redraws every 20 ms most clicks failed even right after a fresh lookup, because puppeteer reads
 * the click point over several round trips and the first waits a frame. On a page that redraws every
 * animation frame that wait crosses a redraw on every attempt, so a hover or tap through puppeteer
 * failed every time, and a scroll that evaluated on the node a lookup returned scrolled nothing
 * whenever a redraw landed between the lookup and the scroll.
 *
 * The class this closes: every action an id or ref handle carries, through `tab.id()`, `tab.ref()` and
 * the `aria-ref=` selector actions, lands exactly once on the element that replaced the node when that
 * element is the single one with the node's role and accessible name. The handle's wrapped actions are
 * read off a live handle, so wrapping a new action turns the sweep red until it has a case here. A
 * replacement the role and name cannot single out, and a node whose document a navigation replaced,
 * fail naming the id or ref as stale and act on nothing. On a page that replaces its nodes between
 * every two round trips, no node a lookup or a relocation returns is still in the document when the
 * action reaches it, so every action fails naming the id or ref as stale and acts on nothing: an
 * action that does not check the node reports success having scrolled, focused or selected a node
 * the page had dropped.
 *
 * Not caught: elements in child frames, which keep puppeteer's own path; a selector action added to
 * the `aria-ref=` set without a row in SELECTOR_ACTIONS; a redraw that moves the replacement between
 * the point lookup and the mouse event, which lands the click where the element was; a regression
 * that only shows when a redraw lands between two round trips, such as an action that checks the
 * node in one and acts in the next, which the redrawing pages hit on some iterations and not on
 * every one; keystrokes from `fill`, `type` and `press`, which go to whatever holds focus when
 * they arrive.
 *
 * A click with `browser.naturalInput` on holds the button down longer than the redrawing pages keep a
 * node, so the button goes down on one node and comes up on its replacement, and Chromium sends no
 * click. The click counts on those pages prove the press is made again on the replacement until it
 * reaches it, once: a missed click left unreported, or one pressed again after it reached the
 * element, changes the count. Not caught: such a click through a handle with no relocation (a CSS
 * selector), which ends without a click, as a press that takes its element away does.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { CHROMIUM_AVAILABLE } from "./chromium";

const MARKUP = [
	"<button>Save</button>",
	'<input aria-label="Query">',
	'<select aria-label="Size"><option value="s">s</option><option value="l">l</option></select>',
	'<select multiple aria-label="Sizes"><option value="s">s</option><option value="m">m</option><option value="l">l</option></select>',
	"<button>Item</button><button>Item</button>",
	'<div style="height:3000px"></div><button>Far</button>',
].join("");

/** What the redrawing pages draw: a button at the top and one below the fold. */
const REDRAWN_MARKUP = '<button>Save</button><div style="height:3000px"></div><button>Far</button>';

/** Records the events an action produces, labelled by the element they reached. */
const RECORDER = `
window.events = [];
window.points = [];
const label = t => (t.getAttribute && t.getAttribute('aria-label')) || t.textContent;
document.addEventListener('click', e => { events.push('click:' + label(e.target)); points.push(Math.round(e.clientX) + ',' + Math.round(e.clientY)); }, true);
document.addEventListener('mouseover', e => events.push('mouseover:' + label(e.target)), true);
document.addEventListener('pointerdown', e => events.push('pointerdown/' + e.pointerType + ':' + label(e.target)), true);
for (const type of ['focusin', 'input', 'change']) document.addEventListener(type, e => events.push(type + ':' + label(e.target)), true);
`;

const PAGES: Record<string, string> = {
	// Redraws when the test calls redraw(); redrawDoubled() adds a second Save button, and
	// redrawSingle() leaves one Item button where the page held two.
	"/": `<title>redraw</title><div id="root"></div><script>${RECORDER}
const root = document.getElementById('root');
window.redraw = () => { root.innerHTML = ${JSON.stringify(MARKUP)}; };
window.redrawDoubled = () => { root.innerHTML = ${JSON.stringify(`${MARKUP}<button>Save</button>`)}; };
window.redrawSingle = () => { root.innerHTML = ${JSON.stringify(MARKUP.replace("<button>Item</button>", ""))}; };
redraw();
</script>`,
	// Redraws every 20 ms, as a polling view does. The interval runs in Chromium, not in the test
	// process: the defect is a race against the page's real frames, which no fake test clock drives.
	"/fast": `<title>fast</title><div id="root"></div><script>${RECORDER}
const root = document.getElementById('root');
const draw = () => { root.innerHTML = ${JSON.stringify(REDRAWN_MARKUP)}; };
draw();
setInterval(draw, 20);
</script>`,
	// Redraws on every animation frame, as an animated view does, so any wait for a frame sees a
	// replaced node.
	"/frame": `<title>frame</title><div id="root"></div><script>${RECORDER}
const root = document.getElementById('root');
const draw = () => { root.innerHTML = ${JSON.stringify(REDRAWN_MARKUP)}; requestAnimationFrame(draw); };
draw();
</script>`,
	// Redraws between every two tasks, so a node read in one round trip has left the document by the
	// next.
	"/task": `<title>task</title><div id="root"></div><script>${RECORDER}
const root = document.getElementById('root');
const channel = new MessageChannel();
const draw = () => { root.innerHTML = ${JSON.stringify(MARKUP)}; channel.port2.postMessage(0); };
channel.port1.onmessage = draw;
draw();
</script>`,
};

/** Page-side helper: the ref the latest snapshot printed for the element with this accessible name. */
const REF_OF = String.raw`const refOf = (snapshot, name) => snapshot.split('\n').find(line => line.includes('"' + name + '" [ref='))?.match(/\[ref=(e\d+)\]/)?.[1];`;

/** The two ways of holding a handle to the element named `name`, binding it as `h`. */
const REACH: Record<"tab.id" | "tab.ref", (name: string) => string> = {
	"tab.id": name =>
		`const h = await tab.id((await tab.observe()).elements.find(e => e.name === ${JSON.stringify(name)}).id);`,
	"tab.ref": name => `${REF_OF}\nconst h = await tab.ref(refOf(await tab.ariaSnapshot(), ${JSON.stringify(name)}));`,
};

interface ActionCase {
	element: string;
	act: string;
	/** Page-side expression read after the action. */
	read: string;
	expected: string;
}

const CLICKS_ON_SAVE = "events.filter(e => e === 'click:Save').length";
const CLICKS_ON_ITEM = "events.filter(e => e === 'click:Item').length";
const QUERY_VALUE = "document.querySelector('input').value";

/** One case per action a relocating handle wraps; the sweep below pins this set to the live handle's. */
const WRAPPED_ACTIONS: Record<string, ActionCase> = {
	click: { element: "Save", act: "await h.click();", read: CLICKS_ON_SAVE, expected: "1" },
	hover: { element: "Save", act: "await h.hover();", read: "events.includes('mouseover:Save')", expected: "true" },
	tap: { element: "Save", act: "await h.tap();", read: "events.includes('pointerdown/touch:Save')", expected: "true" },
	select: {
		element: "Size",
		act: "await h.select('l');",
		read: "document.querySelector('select').value",
		expected: "l",
	},
	scrollIntoView: { element: "Far", act: "await h.scrollIntoView();", read: "scrollY > 0", expected: "true" },
	focus: {
		element: "Query",
		act: "await h.focus();",
		read: "document.activeElement.getAttribute('aria-label') + ':' + document.activeElement.isConnected",
		expected: "Query:true",
	},
	fill: { element: "Query", act: "await h.fill('hello');", read: QUERY_VALUE, expected: "hello" },
	type: { element: "Query", act: "await h.type('abc');", read: QUERY_VALUE, expected: "abc" },
};

/** Puppeteer actions that reach the element through the handle's wrapped `focus()`. */
const FOCUS_ACTIONS: Record<string, ActionCase> = {
	press: { element: "Query", act: "await h.press('x');", read: QUERY_VALUE, expected: "x" },
};

/** Selector actions that resolve an `aria-ref=` selector to a relocating handle; `sel` is bound to it. */
const SELECTOR_ACTIONS: Record<string, ActionCase> = {
	"tab.click": { element: "Save", act: "await tab.click(sel);", read: CLICKS_ON_SAVE, expected: "1" },
	"tab.type": { element: "Query", act: "await tab.type(sel, 'abc');", read: QUERY_VALUE, expected: "abc" },
	"tab.fill": { element: "Query", act: "await tab.fill(sel, 'hello');", read: QUERY_VALUE, expected: "hello" },
	"tab.scrollIntoView": {
		element: "Far",
		act: "await tab.scrollIntoView(sel);",
		read: "scrollY > 0",
		expected: "true",
	},
	"tab.waitFor": {
		element: "Save",
		act: "await (await tab.waitFor(sel)).click();",
		read: CLICKS_ON_SAVE,
		expected: "1",
	},
};

const TAB = `redraw-${process.pid}`;
const INSTANT_TAB = `redraw-instant-${process.pid}`;
/** A session with `browser.naturalInput` on. */
let tool: BrowserTool;
/** A session with `browser.naturalInput` off, whose presses are puppeteer's instant ones. */
let instantTool: BrowserTool;
let server: http.Server;
let base: string;

/** Loads `path` fresh in a shared tab, runs `body`, and returns its result or `error: <message>`. */
async function runOn(path: string, body: string, naturalInput = true): Promise<string> {
	const code = `await tab.goto(${JSON.stringify(`${base}${path}`)});\ntry {\n${body}\n} catch (e) { return 'error: ' + e.message; }`;
	const [runner, name] = naturalInput ? [tool, TAB] : [instantTool, INSTANT_TAB];
	const result = await runner.execute("run", { action: "run", name, code, timeout: 60 });
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

function sessionWith(settings: Record<string, unknown>): ToolSession {
	return {
		cwd: import.meta.dirname,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true, ...settings }),
	};
}

describe.skipIf(!CHROMIUM_AVAILABLE)("an element the page redraws still takes the action", () => {
	beforeAll(async () => {
		server = http.createServer((req, res) => {
			res.writeHead(200, { "content-type": "text/html" });
			res.end(PAGES[req.url ?? "/"] ?? PAGES["/"]);
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => resolve());
		await promise;
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		tool = new BrowserTool(sessionWith({ "browser.naturalInput": true }));
		instantTool = new BrowserTool(sessionWith({ "browser.naturalInput": false }));
		await tool.execute("open", { action: "open", name: TAB, url: "about:blank" });
		await instantTool.execute("open", { action: "open", name: INSTANT_TAB, url: "about:blank" });
	}, 60_000);

	afterAll(async () => {
		await instantTool.execute("close", { action: "close", name: INSTANT_TAB });
		await tool.execute("close", { action: "close", name: TAB, kill: true });
		server.close();
	});

	for (const [reach, hold] of Object.entries(REACH)) {
		it(`a ${reach} handle wraps exactly the actions this suite drives`, async () => {
			const wrapped = await runOn(
				"/",
				`${hold("Save")}\nreturn JSON.stringify(Object.keys(h).filter(k => typeof h[k] === 'function').sort());`,
			);
			expect(JSON.parse(wrapped)).toEqual(Object.keys(WRAPPED_ACTIONS).sort());
		}, 60_000);

		for (const [action, { element, act, read, expected }] of Object.entries({
			...WRAPPED_ACTIONS,
			...FOCUS_ACTIONS,
		})) {
			it(`${action} on a ${reach} handle held across a redraw reaches the replacement once`, async () => {
				const body = `${hold(element)}\nawait tab.evaluate(() => redraw());\n${act}\nreturn String(await tab.evaluate(() => ${read}));`;
				expect(await runOn("/", body)).toBe(expected);
			}, 60_000);
		}
	}

	it("tab.id after a redraw resolves to the replacement", async () => {
		const body = `const id = (await tab.observe()).elements.find(e => e.name === 'Save').id;
await tab.evaluate(() => redraw());
await (await tab.id(id)).click();
return String(await tab.evaluate(() => ${CLICKS_ON_SAVE}));`;
		expect(await runOn("/", body)).toBe("1");
	}, 60_000);

	it("a tab.id handle stays usable after a later tab.id replaced its node", async () => {
		const body = `const id = (await tab.observe()).elements.find(e => e.name === 'Save').id;
const first = await tab.id(id);
await tab.evaluate(() => redraw());
await (await tab.id(id)).click();
await first.click();
return String(await tab.evaluate(() => ${CLICKS_ON_SAVE}));`;
		expect(await runOn("/", body)).toBe("2");
	}, 60_000);

	describe("a click on a handle held across a redraw aims as puppeteer's clickablePoint does", () => {
		it("scrolls an element below the fold into view before clicking it", async () => {
			const body = `${REACH["tab.id"]("Far")}
await tab.evaluate(() => redraw());
await h.click();
return String(await tab.evaluate(() => events.filter(e => e === 'click:Far').length + ' ' + (scrollY > 0)));`;
			expect(await runOn("/", body)).toBe("1 true");
		}, 60_000);

		it("clicks at the offset from the element's top-left corner", async () => {
			const body = `${REACH["tab.id"]("Save")}
await tab.evaluate(() => redraw());
await h.click({ offset: { x: 3, y: 4 } });
return String(await tab.evaluate(() => {
	const box = [...document.querySelectorAll('button')].find(b => b.textContent === 'Save').getBoundingClientRect();
	return points.join(';') + ' at ' + Math.round(box.x + 3) + ',' + Math.round(box.y + 4);
}));`;
			const [clicked, expected] = (await runOn("/", body)).split(" at ");
			expect(clicked).toBe(expected);
		}, 60_000);
	});

	describe("a select on a handle held across a redraw selects as puppeteer's select does", () => {
		const SELECTED = `[...document.querySelectorAll('select')].map(s => s.getAttribute('aria-label') + '=' + [...s.selectedOptions].map(o => o.value).join('+')).join(' ') + ' ' + events.filter(e => /^(input|change):/.test(e)).join(',')`;
		const cases: Record<string, { element: string; values: string; expected: string }> = {
			"a single select takes the first option whose value is listed": {
				element: "Size",
				values: "'l', 's'",
				expected: '["s"] | Size=s Sizes= input:Size,change:Size',
			},
			"a multiple select takes every option whose value is listed": {
				element: "Sizes",
				values: "'l', 's'",
				expected: '["s","l"] | Size=s Sizes=s+l input:Sizes,change:Sizes',
			},
			"an element that is not a select fails": {
				element: "Save",
				values: "'s'",
				expected: "error: Element is not a <select> element. | Size=s Sizes= ",
			},
			"a value that is not a string fails": {
				element: "Size",
				values: "1",
				expected: 'error: Values must be strings. Found value "1" of type "number" | Size=s Sizes= ',
			},
		};
		for (const [label, { element, values, expected }] of Object.entries(cases)) {
			it(label, async () => {
				const body = `${REACH["tab.ref"](element)}
await tab.evaluate(() => redraw());
let outcome;
try { outcome = JSON.stringify(await h.select(${values})); } catch (e) { outcome = 'error: ' + e.message; }
return outcome + ' | ' + await tab.evaluate(() => ${SELECTED});`;
				expect(await runOn("/", body)).toBe(expected);
			}, 60_000);
		}
	});

	for (const [action, { element, act, read, expected }] of Object.entries(SELECTOR_ACTIONS)) {
		it(`${action}("aria-ref=…") after a redraw reaches the replacement once`, async () => {
			const body = `${REF_OF}
const sel = 'aria-ref=' + refOf(await tab.ariaSnapshot(), ${JSON.stringify(element)});
await tab.evaluate(() => redraw());
${act}
return String(await tab.evaluate(() => ${read}));`;
			expect(await runOn("/", body)).toBe(expected);
		}, 60_000);
	}

	describe("a replacement the role and name cannot single out is stale", () => {
		// The redrawn page holds one Item: a pair the original page held twice still names no element.
		it("an id whose role and name the page held twice", async () => {
			const body = `const id = (await tab.observe()).elements.find(e => e.name === 'Item').id;
await tab.evaluate(() => redrawSingle());
let outcome = 'clicked';
try { await (await tab.id(id)).click(); } catch (e) { outcome = 'error: ' + e.message; }
return outcome + ' | clicks=' + await tab.evaluate(() => ${CLICKS_ON_ITEM});`;
			expect(await runOn("/", body)).toMatch(
				/^error: Element id \d+ is stale \(the page re-rendered it\)\. Run tab\.observe\(\) again\. \| clicks=0$/,
			);
		}, 60_000);

		it("an id whose role and name the redrawn page holds twice", async () => {
			const body = `const h = await tab.id((await tab.observe()).elements.find(e => e.name === 'Save').id);
await tab.evaluate(() => redrawDoubled());
let outcome = 'clicked';
try { await h.click(); } catch (e) { outcome = 'error: ' + e.message; }
return outcome + ' | clicks=' + await tab.evaluate(() => ${CLICKS_ON_SAVE});`;
			expect(await runOn("/", body)).toMatch(
				/^error: Element id \d+ is stale \(.+\), and no single element with role "button" and name "Save" replaced it\. Run tab\.observe\(\) again\. \| clicks=0$/,
			);
		}, 60_000);

		it("a held ref whose role and name the page held twice", async () => {
			const body = `${REACH["tab.ref"]("Item")}
await tab.evaluate(() => redrawSingle());
let outcome = 'clicked';
try { await h.click(); } catch (e) { outcome = 'error: ' + e.message; }
return outcome + ' | clicks=' + await tab.evaluate(() => ${CLICKS_ON_ITEM});`;
			expect(await runOn("/", body)).toMatch(
				/^error: ARIA ref "e\d+" is stale \(.+\)\. Run tab\.ariaSnapshot\(\) to refresh refs\. \| clicks=0$/,
			);
		}, 60_000);
	});

	describe("a node whose document a navigation replaced is stale, and nothing on the next page is acted on", () => {
		const navigate = "await Promise.all([tab.waitForNavigation(), tab.evaluate(() => { location.href = '/'; })]);";

		it("an id", async () => {
			const body = `const id = (await tab.observe()).elements.find(e => e.name === 'Save').id;
${navigate}
let outcome = 'clicked';
try { await (await tab.id(id)).click(); } catch (e) { outcome = 'error: ' + e.message; }
return outcome + ' | clicks=' + await tab.evaluate(() => ${CLICKS_ON_SAVE});`;
			expect(await runOn("/", body)).toMatch(
				/^error: Element id \d+ is stale \(the page navigated\)\. Run tab\.observe\(\) again\. \| clicks=0$/,
			);
		}, 60_000);

		it("a ref", async () => {
			const body = `${REF_OF}
const ref = refOf(await tab.ariaSnapshot(), 'Save');
${navigate}
let outcome = 'clicked';
try { await tab.click('aria-ref=' + ref); } catch (e) { outcome = 'error: ' + e.message; }
return outcome + ' | clicks=' + await tab.evaluate(() => ${CLICKS_ON_SAVE});`;
			expect(await runOn("/", body)).toMatch(
				/^error: Unknown ARIA ref "e\d+"\. Run tab\.ariaSnapshot\(\) to refresh refs \(they renumber each snapshot\)\. \| clicks=0$/,
			);
		}, 60_000);
	});

	describe("on a page that replaces its nodes between every two round trips, every action fails as stale and acts on nothing", () => {
		const ACTED_ON = "events.filter(e => /:(Save|Query|Size|Far)$/.test(e)).join(',') + ' scrollY=' + scrollY";
		// A redraw under a resting pointer sends the replacement a mouseover, so the pointer leaves the elements first.
		const attempt = (hold: string, act: string) =>
			`await page.mouse.move(0, 0);\nlet outcome = 'acted';\ntry {\n${hold}\n${act}\n} catch (e) { outcome = 'error: ' + e.message; }\nreturn outcome + '\\n' + await tab.evaluate(() => ${ACTED_ON});`;
		const STALE: Record<string, RegExp> = {
			"tab.id": /^error: Element id \d+ is stale \(/,
			"tab.ref": /^error: ARIA ref "e\d+" is stale \(/,
		};

		for (const [reach, hold] of Object.entries(REACH)) {
			for (const [action, { element, act }] of Object.entries({ ...WRAPPED_ACTIONS, ...FOCUS_ACTIONS })) {
				it(`${action} on a ${reach} handle`, async () => {
					const [outcome, actedOn] = (await runOn("/task", attempt(hold(element), act))).split("\n");
					expect(outcome).toMatch(STALE[reach]!);
					expect(actedOn).toBe(" scrollY=0");
				}, 60_000);
			}
		}

		for (const [action, { element, act }] of Object.entries(SELECTOR_ACTIONS)) {
			it(`${action}("aria-ref=…")`, async () => {
				const hold = `${REF_OF}\nconst sel = 'aria-ref=' + refOf(await tab.ariaSnapshot(), ${JSON.stringify(element)});`;
				const [outcome, actedOn] = (await runOn("/task", attempt(hold, act))).split("\n");
				expect(outcome).toMatch(STALE["tab.ref"]!);
				expect(actedOn).toBe(" scrollY=0");
			}, 60_000);
		}
	});

	const REDRAWING_PAGES: Record<string, string> = { "/fast": "every 20 ms", "/frame": "every animation frame" };
	for (const [path, cadence] of Object.entries(REDRAWING_PAGES)) {
		describe(`on a page that redraws ${cadence}, every pointer action reaches the live node`, () => {
			const TIMES = 20;
			const SAVE_ID = "const id = (await tab.observe()).elements.find(e => e.name === 'Save').id;";
			const loops: Record<string, { loop: string; read: string; expected: string }> = {
				"click through tab.id": {
					loop: `${SAVE_ID}\nfor (let i = 0; i < ${TIMES}; i++) await (await tab.id(id)).click();`,
					read: CLICKS_ON_SAVE,
					expected: String(TIMES),
				},
				"click through a held tab.ref handle": {
					loop: `${REACH["tab.ref"]("Save")}\nfor (let i = 0; i < ${TIMES}; i++) await h.click();`,
					read: CLICKS_ON_SAVE,
					expected: String(TIMES),
				},
				'click through tab.click("aria-ref=…")': {
					loop: `${REF_OF}\nconst sel = 'aria-ref=' + refOf(await tab.ariaSnapshot(), 'Save');\nfor (let i = 0; i < ${TIMES}; i++) await tab.click(sel);`,
					read: CLICKS_ON_SAVE,
					expected: String(TIMES),
				},
				"tap through tab.id": {
					loop: `${SAVE_ID}\nfor (let i = 0; i < ${TIMES}; i++) await (await tab.id(id)).tap();`,
					read: "events.filter(e => e === 'pointerdown/touch:Save').length",
					expected: String(TIMES),
				},
				// The pointer stays on the button between hovers, so a replacement under it may or may not
				// receive a fresh mouseover; every hover completing is the contract.
				"hover through tab.id": {
					loop: `${SAVE_ID}\nfor (let i = 0; i < ${TIMES}; i++) await (await tab.id(id)).hover();`,
					read: "events.includes('mouseover:Save')",
					expected: "true",
				},
				// Each scroll is read and undone before the next, so every one has to move the page.
				'scroll through tab.scrollIntoView("aria-ref=…")': {
					loop: `${REF_OF}\nconst sel = 'aria-ref=' + refOf(await tab.ariaSnapshot(), 'Far');\nfor (let i = 0; i < ${TIMES}; i++) {\n\tawait tab.scrollIntoView(sel);\n\tawait tab.evaluate(() => { window.scrolls = (window.scrolls ?? 0) + (scrollY > 0 ? 1 : 0); scrollTo(0, 0); });\n}`,
					read: "window.scrolls",
					expected: String(TIMES),
				},
			};
			for (const naturalInput of [true, false]) {
				for (const [label, { loop, read, expected }] of Object.entries(loops)) {
					it(`${label}, natural input ${naturalInput ? "on" : "off"}`, async () => {
						const body = `${loop}\nreturn String(await tab.evaluate(() => ${read}));`;
						expect(await runOn(path, body, naturalInput)).toBe(expected);
					}, 60_000);
				}
			}
		});
	}
});
