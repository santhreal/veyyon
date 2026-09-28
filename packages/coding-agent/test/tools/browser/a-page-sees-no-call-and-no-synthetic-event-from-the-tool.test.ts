/**
 * WHY: anti-bot scripts replace DOM methods and getters in the page's own world and look at who calls
 * them: a call whose stack holds none of the page's scripts came from outside, and a stack that names
 * `pptr:` names puppeteer. They count an event whose `isTrusted` is false, a mouse event whose page
 * coordinates equal its screen coordinates (the DevTools input leak, crbug 1477537), and an inspector
 * that serializes a `console.debug`ged error (`Runtime.enable`). The tool read the page for bot
 * challenges after every `open` and `run` with thirty `document.querySelector` calls in the page's own
 * world, and `tab.select` and `tab.fill` on a date input dispatched their `input` and `change` events
 * from script.
 *
 * The contract, driven through the real tool against real headless Chromium and a page that hooks
 * every method and getter of the DOM prototypes and of `window`: nothing the tool does on its own, the
 * snapshot and challenge probe `open` and `run` take, and every `tab` helper and handle action, calls a
 * hooked function from outside the page, dispatches an untrusted event, sends a mouse event whose page
 * and screen coordinates agree, or makes the inspector read an error. Both input modes are driven.
 * `tab` helpers are read from the tab at run time: a helper this file does not drive, or does not name
 * as leaving the page alone, fails it.
 *
 * What it does not catch: `tab.evaluate`, which runs the caller's function in the page's own world as
 * asked; a leak in a frame from another origin, which the page here does not have; and timing, which
 * the natural-input suite covers.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { chromiumCanLaunch } from "../../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

/** Installed in the page's head, before anything else runs in it. */
const TRAP_JS = `(() => {
	const beacon = Navigator.prototype.sendBeacon;
	const nav = navigator;
	const toJson = JSON.stringify;
	const origin = location.origin;
	const page = location.pathname;
	const sent = new Set();
	const send = (kind, detail) => {
		const key = kind + ":" + (detail.name || detail.type || "") + ":" + (detail.target || "");
		if (sent.has(key)) return;
		sent.add(key);
		beacon.call(nav, "/record", toJson({ kind, page, detail }));
	};
	// Frames 0 to 2 are the error, this function and the hook; the rest called the hook.
	const record = name => {
		const frames = String(new Error().stack).split("\\n");
		if (frames.slice(3).some(line => line.includes(origin))) return;
		send("call", { name, stack: frames.slice(3, 6).join(" | ").trim() });
	};
	const hook = (owner, key, label) => {
		const descriptor = Object.getOwnPropertyDescriptor(owner, key);
		if (!descriptor || !descriptor.configurable || key === "constructor") return;
		if (typeof descriptor.value === "function") {
			const original = descriptor.value;
			descriptor.value = function () { record(label); return Reflect.apply(original, this, arguments); };
		} else if (typeof descriptor.get === "function") {
			const original = descriptor.get;
			descriptor.get = function () { record(label); return Reflect.apply(original, this, []); };
		} else return;
		Object.defineProperty(owner, key, descriptor);
	};
	const prototypes = { EventTarget, Node, Element, HTMLElement, Document, CharacterData, HTMLInputElement,
		HTMLTextAreaElement, HTMLSelectElement, HTMLButtonElement, HTMLAnchorElement, HTMLIFrameElement, CSSStyleDeclaration };
	for (const [name, type] of Object.entries(prototypes)) {
		for (const key of Object.getOwnPropertyNames(type.prototype)) hook(type.prototype, key, name + "." + key);
	}
	for (const key of Object.getOwnPropertyNames(window)) {
		if (/^[A-Z]/.test(key)) continue;
		hook(window, key, "window." + key);
	}

	const stackTrap = new Error("trap");
	let stackLookups = 0;
	Object.defineProperty(stackTrap, "stack", { get() { stackLookups += 1; return ""; } });
	let nameLookups = 0;
	Object.defineProperty(Error.prototype, "name", { configurable: true, get() { nameLookups += 1; return "Error"; } });
	const inspect = () => {
		const before = stackLookups;
		console.debug(stackTrap);
		nameLookups = 0;
		console.debug(new Error(""));
		if (stackLookups > before || nameLookups >= 2) send("inspector", { name: "console", stack: stackLookups - before, names: nameLookups });
	};
	setInterval(inspect, 100);
	if (navigator.webdriver) send("webdriver", { name: "navigator.webdriver" });

	for (const type of ["mousedown", "mouseup", "click", "dblclick", "contextmenu", "mousemove", "mouseover",
		"pointerdown", "pointerup", "pointermove", "wheel", "keydown", "keyup", "keypress", "beforeinput", "input",
		"change", "dragstart", "dragend", "drop", "focusin", "focusout", "submit"]) {
		document.addEventListener(type, event => {
			if (!event.isTrusted) send("untrusted", { type, target: event.target && event.target.id });
			// A click a key made on a button has every coordinate at zero, in a person's browser too.
			const keyClick = event.clientX === 0 && event.clientY === 0 && event.screenX === 0 && event.screenY === 0;
			if ("screenX" in event && !keyClick && event.pageX === event.screenX && event.pageY === event.screenY) {
				send("coordinates", { type, x: event.pageX, y: event.pageY });
			}
		}, true);
	}
})();`;

const PAGE_HTML = `<!doctype html><html><head><title>trap</title><script src="/trap.js"></script></head><body>
<label>Query <input id="q" name="q"></label>
<label>Notes <textarea id="t"></textarea></label>
<label>Day <input type="date" id="d"></label>
<label>Choice <select id="s"><option value="a">Alpha</option><option value="b">Beta</option></select></label>
<label>File <input type="file" id="f"></label>
<button id="b" type="button">Go</button>
<button id="ping" type="button" onclick="fetch('/api/ping')">Ping</button>
<a id="next" href="/next">Next page</a>
<div id="from" style="width:80px;height:40px;background:#ccc">from</div>
<div id="to" style="width:80px;height:40px;background:#eee">to</div>
<div style="height:2500px"></div>
<p id="far">far away</p>
</body></html>`;

interface TrapRecord {
	kind: "call" | "inspector" | "webdriver" | "untrusted" | "coordinates";
	page: string;
	detail: Record<string, unknown>;
}

const records: TrapRecord[] = [];
let server: http.Server;
let origin = "";
let files: TempDir;

beforeAll(async () => {
	server = http.createServer((request, response) => {
		const url = request.url ?? "/";
		if (url === "/record") {
			let body = "";
			request.on("data", chunk => {
				body += chunk;
			});
			request.on("end", () => {
				records.push(JSON.parse(body) as TrapRecord);
				response.statusCode = 204;
				response.end();
			});
			return;
		}
		if (url === "/trap.js") {
			response.setHeader("Content-Type", "text/javascript");
			response.end(TRAP_JS);
			return;
		}
		if (url.startsWith("/api/")) {
			response.setHeader("Content-Type", "application/json");
			response.end("{}");
			return;
		}
		response.setHeader("Content-Type", "text/html");
		response.end(PAGE_HTML);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@trap-page-");
	await fs.writeFile(path.join(files.path(), "upload.txt"), "upload");
});

afterAll(async () => {
	await files.remove();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** The `tab` members that run no code in the page, and why. Every other member is driven below. */
const LEAVE_THE_PAGE_ALONE: Record<string, string> = {
	name: "the tab's name",
	page: "puppeteer's page object, whose own evaluation runs in the isolated world",
	signal: "the run's abort signal",
	evaluate: "runs the caller's own function in the page's own world, as asked",
};

/** Each helper's call on the trap page, in order. `ref(role, name)` reads a ref from the latest snapshot. */
const ON_THE_PAGE = `
const done = [];
const step = async (name, action) => {
	try { await action(); done.push(name); } catch (error) { done.push(name + " failed: " + (error && (error.stack || error.message))); }
};
let snapshot = "";
const ref = (role, name) => (snapshot.match(new RegExp(role + ' "' + name + '"[^\\\\n]*\\\\[ref=(e\\\\d+)\\\\]')) || [])[1];
await step("ariaSnapshot", async () => { snapshot = await tab.ariaSnapshot(); });
await step("observe", async () => { const seen = await tab.observe(); await tab.id(seen.elements.find(e => e.role === "button" && e.name === "Go").id).click(); });
await step("id", async () => { const seen = await tab.observe(); await tab.id(seen.elements.find(e => e.role === "textbox").id).fill("by id"); });
await step("ref", async () => { await tab.ref(ref("button", "Go")).hover(); });
await step("click", () => tab.click("#b"));
await step("click text", () => tab.click("text/Go"));
await step("click has-text", () => tab.click('button:has-text("Go")'));
await step("click aria-ref", () => tab.click("aria-ref=" + ref("button", "Go")));
await step("type", () => tab.type("#q", "abc"));
await step("fill", () => tab.fill("#q", "hello"));
await step("fill long", () => tab.fill("#t", "x".repeat(40)));
await step("fill date", () => tab.fill("#d", "2026-01-02"));
await step("press", () => tab.press("Enter", { selector: "#q" }));
await step("select", () => tab.select("#s", "b"));
await step("uploadFile", () => tab.uploadFile("#f", UPLOAD));
await step("drag", () => tab.drag("#from", "#to"));
await step("scroll", () => tab.scroll(0, 200));
await step("scrollIntoView", () => tab.scrollIntoView("#far"));
await step("waitFor", async () => { const handle = await tab.waitFor("#q"); await handle.click(); await handle.type("de"); await handle.fill("by handle"); });
await step("waitForSelector", () => tab.waitForSelector("#b", { visible: true }));
await step("screenshot", () => tab.screenshot({ selector: "#b", silent: true }));
await step("extract", () => tab.extract("text"));
await step("title", () => tab.title());
await step("url", () => tab.url());
await step("storageState", () => tab.storageState());
await step("loadStorageState", () => tab.loadStorageState({ cookies: [{ name: "kept", value: "1", domain: "127.0.0.1" }] }));
await step("waitForResponse", async () => { const response = tab.waitForResponse("/api/ping"); await tab.click("#ping"); await response; });
await step("goto", () => tab.goto(ORIGIN + "/trap?second"));
await step("reload", () => tab.reload());
await step("waitForNavigation", async () => { await tab.click("#next"); await tab.waitForNavigation(); });
await step("waitForUrl", () => tab.waitForUrl("/next"));
return { done, members: Object.keys(tab) };`;

/** The helper each step drives. */
const DRIVEN = [
	"ariaSnapshot",
	"observe",
	"id",
	"ref",
	"click",
	"type",
	"fill",
	"press",
	"select",
	"uploadFile",
	"drag",
	"scroll",
	"scrollIntoView",
	"waitFor",
	"waitForSelector",
	"screenshot",
	"extract",
	"title",
	"url",
	"storageState",
	"loadStorageState",
	"waitForResponse",
	"goto",
	"reload",
	"waitForNavigation",
	"waitForUrl",
];

/** Wait until no record has arrived for 600 ms, at most `boundMs`: beacons land after the run returns. */
async function settledRecords(boundMs: number): Promise<TrapRecord[]> {
	const deadline = Date.now() + boundMs;
	let count = -1;
	while (count !== records.length && Date.now() < deadline) {
		count = records.length;
		await sleep(600);
	}
	return [...records];
}

describe.skipIf(!CHROMIUM_AVAILABLE)("a page that hooks the DOM", () => {
	for (const naturalInput of [true, false]) {
		it(`sees no call, synthetic event, coordinate leak or inspector from the tool with natural input ${naturalInput ? "on" : "off"}`, async () => {
			records.length = 0;
			const session: ToolSession = {
				cwd: files.path(),
				hasUI: false,
				getSessionFile: () => null,
				getSessionSpawns: () => "*",
				settings: Settings.isolated({ "browser.headless": true, "browser.naturalInput": naturalInput }),
			};
			const tool = new BrowserTool(session);
			const tab = `trap-${naturalInput ? "natural" : "instant"}-${process.pid}`;
			try {
				await tool.execute("open", { action: "open", name: tab, url: `${origin}/trap` });
				const code = ON_THE_PAGE.replace("UPLOAD", JSON.stringify(path.join(files.path(), "upload.txt"))).replace(
					"ORIGIN",
					JSON.stringify(origin),
				);
				const result = await tool.execute("run", { action: "run", name: tab, timeout: 90, code });
				const { done, members } = JSON.parse(text(result)) as { done: string[]; members: string[] };
				expect(done.filter(entry => entry.includes(" failed: "))).toEqual([]);
				expect([...members].sort()).toEqual([...DRIVEN, ...Object.keys(LEAVE_THE_PAGE_ALONE)].sort());
				// One more run, so the challenge probe after the last one has read the last page too.
				await tool.execute("run", { action: "run", name: tab, code: "return 1;" });
				const seen = await settledRecords(8_000);
				expect(seen).toEqual([]);
			} finally {
				await tool.execute("close", { action: "close", all: true, kill: true });
			}
		}, 180_000);
	}
});
