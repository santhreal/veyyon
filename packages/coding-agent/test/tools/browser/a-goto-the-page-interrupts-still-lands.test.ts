/**
 * WHY: Chromium cancels a pending navigation when the page starts one of its own with user
 * activation, and `page.goto` reports the cancelled navigation as `net::ERR_ABORTED`. A page whose
 * click handler navigates once a request settles (a login form, a router that redirects after a
 * fetch) failed every `tab.goto` the agent issued while that request was in flight, though the goto
 * was the newer instruction.
 *
 * The class this closes: every kind of navigation a page starts (an assignment to `location`,
 * `location.replace`, a reload, a meta refresh, a form submission, an anchor activation) that aborts
 * a pending `tab.goto` sends the goto once more, and the goto resolves on its own URL; so does one to
 * the goto's own URL under another fragment, which is another document's navigation. Two gotos that
 * keep aborting each other stop after the second attempt: one fails naming its URL and the
 * navigation that aborted it last, the other lands, and neither is sent a third time. An abort that
 * no main-frame navigation to another URL explains (a response with no content, which Chromium
 * reports with the same error as a download) fails with puppeteer's error and is never sent twice,
 * whether the goto followed a redirect, carried a fragment, was spelled other than the browser spells
 * it, or the page sent a fetch or navigated a child frame meanwhile; a retry that ends in such an
 * abort fails with puppeteer's error too.
 *
 * Not caught: a page-started navigation kind missing from INTERRUPTIONS; a navigation the page starts
 * more than NAVIGATION_INTERRUPT_GRACE_MS after the abort, which the retry never sees; a page that
 * navigates to the goto's own URL, which reads as the goto's own request; and a page that aborts a
 * goto twice by itself, which Chromium did not allow in any sequence tried, since the second
 * navigation from a page whose first one was cancelled is dropped.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { CHROMIUM_AVAILABLE } from "./chromium";

/**
 * Navigations the start page begins once the goto's request reaches the server. Each runs from a
 * click handler the test triggers through CDP input, so the navigation carries user activation.
 */
const INTERRUPTIONS: Record<string, { act: string; interrupter: string }> = {
	"an assignment to location": { act: "location.href = '/landed'", interrupter: "/landed" },
	"location.replace": { act: "location.replace('/landed')", interrupter: "/landed" },
	"a reload": { act: "location.reload()", interrupter: "/start?act=a%20reload" },
	"a meta refresh": {
		act: "document.head.insertAdjacentHTML('beforeend', '<meta http-equiv=refresh content=0;url=/landed>')",
		interrupter: "/landed",
	},
	"a form submission": {
		act: "const f = document.createElement('form'); f.action = '/landed'; document.body.append(f); f.submit()",
		interrupter: "/landed",
	},
	"an anchor activation": {
		act: "const a = document.createElement('a'); a.href = '/landed'; document.body.append(a); a.click()",
		interrupter: "/landed",
	},
};

/** Requests the start page sends while a goto is in flight that are not a main-frame navigation. */
const BYSTANDERS: Record<string, string> = {
	"a fetch": "fetch('/fetched')",
	"a child frame navigation":
		"document.body.append(Object.assign(document.createElement('iframe'), { src: '/framed' }))",
};

const ACTS: Record<string, string> = {
	...Object.fromEntries(Object.entries(INTERRUPTIONS).map(([name, { act }]) => [name, act])),
	...BYSTANDERS,
	"the goto's URL with another fragment": "location.href = '/target#theirs'",
};

const TAB = `goto-interrupt-${process.pid}`;
let tool: BrowserTool;
let server: http.Server;
let base: string;

/**
 * What the server does in the current test: how many requests to each goto destination it holds
 * open before it answers one, and every request it received.
 */
let scene: { hold: Record<string, number>; requests: string[] };
/** Responses the server holds open; ended after each test. */
const held: http.ServerResponse[] = [];

function start(act: string): string {
	const script = act ? `<script>go.onclick = () => fetch('/when-goto').then(() => { ${ACTS[act]} });</script>` : "";
	return `<title>start</title><body><button id=go>go</button>${script}</body>`;
}

/** Runs `code` in the shared tab and returns its result text. */
async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code, timeout: 30 });
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * Loads the start page, clicks its button when `act` names a navigation, then sends `tab.goto(path)`
 * and returns `ok <pathname>` or `error: <message>`.
 */
function gotoFrom(act: string, path: string): Promise<string> {
	const opening = `await tab.goto(${JSON.stringify(`${base}/start?act=${encodeURIComponent(act)}`)});${act ? "\nawait tab.click('#go');" : ""}`;
	return run(
		`${opening}\ntry { await tab.goto(${JSON.stringify(`${base}${path}`)}); } catch (e) { return 'error: ' + e.message; }\nreturn 'ok ' + await tab.evaluate(() => location.pathname);`,
	);
}

function requestsTo(pathname: string): number {
	return scene.requests.filter(request => request.split("?")[0] === pathname).length;
}

describe.skipIf(!CHROMIUM_AVAILABLE)("a goto the page interrupts still lands", () => {
	beforeAll(async () => {
		let whenGoto: http.ServerResponse | undefined;
		const answerWhenGoto = () => {
			whenGoto?.end("go");
			whenGoto = undefined;
		};
		const whenRequested = new Map<string, http.ServerResponse[]>();
		server = http.createServer((req, res) => {
			const url = new URL(req.url ?? "/", base);
			if (url.pathname === "/favicon.ico") {
				res.writeHead(404).end();
				return;
			}
			scene.requests.push(url.pathname + url.search);
			for (const waiter of whenRequested.get(url.pathname)?.splice(0) ?? []) waiter.end("seen");
			const html = (body: string) => res.writeHead(200, { "content-type": "text/html" }).end(body);
			switch (url.pathname) {
				case "/start":
					return html(start(url.searchParams.get("act") ?? ""));
				case "/when-goto":
					whenGoto = res;
					return;
				case "/when-requested": {
					// Answers once the server has received a request to `path`.
					const path = url.searchParams.get("path") ?? "";
					res.setHeader("access-control-allow-origin", "*");
					if (requestsTo(path) > 0) return void res.end("seen");
					whenRequested.set(path, [...(whenRequested.get(path) ?? []), res]);
					return;
				}
				case "/target":
				case "/other":
				case "/vanishing":
					answerWhenGoto();
					if ((scene.hold[url.pathname] ?? 0) > 0) {
						scene.hold[url.pathname]--;
						held.push(res);
						return;
					}
					if (url.pathname === "/vanishing") return void res.writeHead(204).end();
					return html(`<title>${url.pathname}</title>`);
				case "/empty":
					answerWhenGoto();
					res.writeHead(204).end();
					return;
				case "/redirect":
					res.writeHead(302, { location: "/empty" }).end();
					return;
				default:
					return html(`<title>${url.pathname}</title>`);
			}
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => resolve());
		await promise;
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const session: ToolSession = {
			cwd: import.meta.dirname,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "browser.headless": true }),
		};
		tool = new BrowserTool(session);
		await tool.execute("open", { action: "open", name: TAB, url: "about:blank" });
	}, 60_000);

	afterEach(() => {
		for (const res of held.splice(0)) res.end();
	});

	afterAll(async () => {
		await tool.execute("close", { action: "close", name: TAB, kill: true });
		server.closeAllConnections();
		server.close();
	});

	for (const [name, { interrupter }] of Object.entries(INTERRUPTIONS)) {
		it(`a goto ${name} aborted is sent again and lands on its URL`, async () => {
			scene = { hold: { "/target": 1 }, requests: [] };
			expect(await gotoFrom(name, "/target")).toBe("ok /target");
			expect(requestsTo("/target")).toBe(2);
			expect(scene.requests).toContain(interrupter);
		}, 60_000);
	}

	it("a goto the page aborts by navigating to the goto's URL under another fragment is sent again", async () => {
		scene = { hold: { "/target": 1 }, requests: [] };
		expect(await gotoFrom("the goto's URL with another fragment", "/target")).toBe("ok /target");
		// The goto, the page's navigation, and the goto's retry.
		expect(requestsTo("/target")).toBe(3);
	}, 60_000);

	it("a retry that ends in an abort no navigation explains fails with puppeteer's error", async () => {
		// The page aborts the first attempt; the retry's response has no content.
		scene = { hold: { "/vanishing": 1 }, requests: [] };
		expect(await gotoFrom("an assignment to location", "/vanishing")).toBe(
			`error: net::ERR_ABORTED at ${base}/vanishing`,
		);
		expect(requestsTo("/vanishing")).toBe(2);
	}, 60_000);

	it("of two gotos that abort each other, the first fails after its second attempt and the second lands", async () => {
		// The first goto is held open on every attempt, the second on its first: the second aborts
		// the first, the first's retry aborts the second, and the second's retry aborts the first's.
		scene = { hold: { "/target": Number.POSITIVE_INFINITY, "/other": 1 }, requests: [] };
		const outcomes = await run(`const settle = p => p.then(() => 'ok', e => 'error: ' + e.message);
const first = settle(tab.goto(${JSON.stringify(`${base}/target`)}));
await fetch(${JSON.stringify(`${base}/when-requested?path=/target`)});
const second = settle(tab.goto(${JSON.stringify(`${base}/other`)}));
return [await first, await second, await tab.evaluate(() => location.pathname)].join(' | ');`);
		expect(outcomes).toBe(
			`error: tab.goto(${JSON.stringify(`${base}/target`)}) was aborted twice by other navigations, the last to ${base}/other; wait for the page to settle (tab.waitForNavigation()) and retry | ok | /other`,
		);
		expect([requestsTo("/target"), requestsTo("/other")]).toEqual([2, 2]);
	}, 60_000);

	const unexplained: Record<string, { act: string; path: string }> = {
		"a response with no content": { act: "", path: "/empty" },
		"a response with no content behind a redirect": { act: "", path: "/redirect" },
		"a URL with a fragment": { act: "", path: "/empty#part" },
		"a URL spelled other than the browser spells it": { act: "", path: "/./empty" },
		...Object.fromEntries(Object.keys(BYSTANDERS).map(act => [`${act} sent meanwhile`, { act, path: "/empty" }])),
	};
	for (const [name, { act, path }] of Object.entries(unexplained)) {
		it(`an abort with ${name} fails with puppeteer's error and is sent once`, async () => {
			scene = { hold: {}, requests: [] };
			expect(await gotoFrom(act, path)).toBe(`error: net::ERR_ABORTED at ${base}${path}`);
			expect(requestsTo("/empty")).toBe(1);
		}, 60_000);
	}
});
