/**
 * WHY: `open` with `visible` moves a tab between a hidden browser and a window by reading its
 * cookies and localStorage, closing it, and opening it again on the other browser with them. A move
 * that failed or was cancelled after the tab closed (the page it was sent to would not load, the
 * window's browser failed to start, the call was interrupted while it started) left no tab at all:
 * the page, the context and every cookie it held were gone, as if the tab had been closed.
 *
 * The class: a move that ends without the tab, or that hangs before it starts. Each case moves a
 * signed-in tab in an isolated context with a dialog policy and fails the move a different way: a page
 * that cannot load in the window, and an interrupt while the window's browser starts. The tab is then
 * on the hidden browser again, in its context, with its dialog policy, its localStorage, and its page
 * loaded with the cookie it had. A page that answers nothing while the move reads the session (one
 * whose main thread is blocked) fails the move within the call's timeout, before the tab leaves.
 *
 * The visible browser is launched without a window here (`setVisibleLaunchesHeadlessForTest`): it
 * keeps its own registry key and process, so the move between two Chromium processes is real.
 *
 * What it does NOT catch: a profile tab interrupted while its window's browser starts, whose return
 * finds the profile still locked by that start and fails (the profile directory keeps the session);
 * and a return that itself fails, which the error then states.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as net from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import * as registry from "@veyyon/coding-agent/tools/web/browser/registry";
import { getTab } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

let server: http.Server;
let base = "";
let unreachable = "";
let root: TempDir;
let dirOverrides: DirOverridesSnapshot | undefined;
let tool: BrowserTool;
/** Every page request the server answered, as `path cookies`. */
const requests: string[] = [];
/** `/gate` requests the server has not answered: a page waiting on one synchronously answers nothing. */
const gated: http.ServerResponse[] = [];
const gateReached = Promise.withResolvers<void>();

/** `/login?user=x` sets a session cookie `sid=x`; every page shows the cookies its request carried. */
function serve(request: http.IncomingMessage, response: http.ServerResponse): void {
	const url = new URL(request.url ?? "/", "http://localhost");
	// The icon the browser asks for after a page is not a page.
	if (url.pathname === "/favicon.ico") {
		response.statusCode = 404;
		response.end();
		return;
	}
	if (url.pathname === "/gate") {
		gated.push(response);
		gateReached.resolve();
		return;
	}
	const user = url.searchParams.get("user");
	if (url.pathname === "/login" && user) response.setHeader("Set-Cookie", `sid=${user}; Path=/; HttpOnly`);
	const sent = (request.headers.cookie ?? "").replace(/[<&]/g, "");
	requests.push(`${url.pathname} ${sent}`);
	response.setHeader("Content-Type", "text/html");
	response.end(`<!doctype html><title>${url.pathname}</title><pre id="sent">${sent}</pre>`);
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function run(name: string, code: string): Promise<string> {
	return text(await tool.execute("run", { action: "run", name, code }));
}

async function failure(params: Record<string, unknown>, signal?: AbortSignal): Promise<Error> {
	try {
		await tool.execute("x", params as never, signal);
	} catch (error) {
		return error as Error;
	}
	throw new Error(`expected ${JSON.stringify(params)} to fail`);
}

/** Open tab `name` signed in as `user`, in context "shop", with a dialog policy and a localStorage entry, on `/home`. */
async function signedIn(name: string, user: string): Promise<void> {
	await tool.execute("open", {
		action: "open",
		name,
		context: "shop",
		dialogs: "accept",
		url: `${base}/login?user=${user}`,
	});
	await run(
		name,
		`await tab.goto(${JSON.stringify(`${base}/home`)}); await tab.evaluate(() => localStorage.setItem("cart", "3"));`,
	);
}

/** Where tab `name` is, and what it kept. */
async function placeOf(name: string): Promise<Record<string, unknown>> {
	const tab = getTab(name);
	return {
		state: tab?.state,
		key: tab?.browser.key,
		context: tab?.backend === "worker" ? tab.contextName : null,
		dialogs: tab?.dialogPolicy,
		url: tab ? await run(name, "return page.url();") : null,
		cart: tab ? await run(name, 'return await tab.evaluate(() => localStorage.getItem("cart"));') : null,
	};
}

function toolSession(settings: Settings): ToolSession {
	return { cwd: root.path(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings };
}

beforeAll(async () => {
	dirOverrides = captureDirOverrides();
	root = TempDir.createSync("@veyyon-browser-move-fails-");
	setAgentDir(root.join("agent"));
	tool = new BrowserTool(toolSession(Settings.isolated({ "browser.headless": true, "browser.cmux": false })));
	server = http.createServer(serve);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	// A port that was free a moment ago and has nothing listening: a page there fails to load at once.
	const probe = net.createServer();
	const bound = Promise.withResolvers<void>();
	probe.listen(0, "127.0.0.1", () => bound.resolve());
	await bound.promise;
	const port = (probe.address() as AddressInfo).port;
	const closed = Promise.withResolvers<void>();
	probe.close(() => closed.resolve());
	await closed.promise;
	unreachable = `http://127.0.0.1:${port}/`;
});

afterEach(() => {
	vi.restoreAllMocks();
	registry.setVisibleLaunchesHeadlessForTest(false);
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
	for (const response of gated.splice(0)) response.end();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
	await root.remove();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a tab whose move to a window fails", () => {
	it("on a page that cannot load goes back to its browser with its session, and the error says so", async () => {
		registry.setVisibleLaunchesHeadlessForTest(true);
		await signedIn("unloadable", "ann");
		requests.length = 0;

		const error = await failure({ action: "open", name: "unloadable", visible: true, url: unreachable });

		expect(error.message).toContain('Tab "unloadable" is back on headless hidden with its session.');
		// The return loaded the page the tab was on, and its first request carried the cookie.
		expect(requests).toEqual(["/home sid=ann"]);
		expect(await placeOf("unloadable")).toEqual({
			state: "alive",
			key: "headless:1",
			context: "shop",
			dialogs: "accept",
			url: `${base}/home`,
			cart: "3",
		});
		await tool.execute("close", { action: "close", name: "unloadable" });
	}, 120_000);

	it("when interrupted while the window's browser starts goes back to its browser with its session", async () => {
		registry.setVisibleLaunchesHeadlessForTest(true);
		await signedIn("interrupted", "bea");
		requests.length = 0;
		const interrupt = new AbortController();
		const acquire = registry.acquireBrowser;
		vi.spyOn(registry, "acquireBrowser").mockImplementation((kind, opts) => {
			if (kind.kind === "headless" && !kind.headless) interrupt.abort();
			return acquire(kind, opts);
		});

		const error = await failure({ action: "open", name: "interrupted", visible: true }, interrupt.signal);

		expect(error.name).toBe("ToolAbortError");
		expect(requests).toEqual(["/home sid=bea"]);
		expect(await placeOf("interrupted")).toEqual({
			state: "alive",
			key: "headless:1",
			context: "shop",
			dialogs: "accept",
			url: `${base}/home`,
			cart: "3",
		});
		await tool.execute("close", { action: "close", name: "interrupted" });
	}, 120_000);

	it("while a page in its context is not answering fails within the call's timeout and leaves the tab", async () => {
		registry.setVisibleLaunchesHeadlessForTest(true);
		await tool.execute("open", { action: "open", name: "held", context: "hold", url: `${base}/login?user=cal` });
		// A second page of the context, on another site so it runs in a renderer process of its own, blocks
		// its main thread on a synchronous request the server holds. The page's own timer sends it after
		// the evaluate has answered, which a request sent inside it would block.
		const elsewhere = `${base.replace("127.0.0.1", "localhost")}/home`;
		await run(
			"held",
			`const other = await page.browserContext().newPage();
			await other.goto(${JSON.stringify(elsewhere)});
			await other.evaluate(() => {
				setTimeout(() => {
					const request = new XMLHttpRequest();
					request.open("GET", "/gate", false);
					request.send();
				}, 0);
			});`,
		);
		await gateReached.promise;
		const started = performance.now();

		const error = await failure({ action: "open", name: "held", visible: true, timeout: 3 });

		expect(performance.now() - started).toBeLessThan(15_000);
		expect(error.message).toBe(
			'Reading the cookies and localStorage of tab "held" took longer than 3 s: a page in its context is not answering, such as one with a dialog open. The tab stays where it is; close the dialog or the page, then move it again.',
		);
		expect({ state: getTab("held")?.state, key: getTab("held")?.browser.key }).toEqual({
			state: "alive",
			key: "headless:1",
		});
		for (const response of gated.splice(0)) response.end();
		await tool.execute("close", { action: "close", name: "held" });
	}, 60_000);
});
