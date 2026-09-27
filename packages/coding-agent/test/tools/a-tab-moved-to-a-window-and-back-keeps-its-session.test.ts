/**
 * WHY: a CAPTCHA in a headless tab could only be solved by a person, and a person cannot see a
 * headless tab. `open` with `visible: true` moves the tab to a browser window with its page, cookies
 * and localStorage, and `visible: false` moves it back with whatever the person earned there, such
 * as a clearance cookie.
 *
 * The class: a move that loses the session, the page or the tab. The moved tab lands on another
 * Chromium process, keeps its context and dialog policy, reloads the page it was on, and that
 * page's first request already carries the cookies; its localStorage is there. A cookie set in the
 * window comes back headless. A move to a window on a Linux host with no display fails before the tab
 * leaves its browser. A profile tab moves only when no other tab holds the profile's browser, and
 * then relaunches the profile on the same directory. `visible` and `profile` are refused on an app
 * browser and on the cmux browser, and on actions other than `open`.
 *
 * The visible browser is launched without a window here (`setVisibleLaunchesHeadlessForTest`): it
 * keeps its own registry key and process, so the move between two Chromium processes is real.
 *
 * What it does NOT catch: the window itself on a desktop, which a host with no display cannot show,
 * nor a site that binds its clearance cookie to a browser fingerprint the window does not share.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import {
	getBrowsersMapForTest,
	setVisibleLaunchesHeadlessForTest,
} from "@veyyon/coding-agent/tools/web/browser/registry";
import { getTab } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

let server: http.Server;
let base = "";
let root: TempDir;
let dirOverrides: DirOverridesSnapshot | undefined;
let tool: BrowserTool;
/** Every page request the server answered, as `path cookies`. */
const requests: string[] = [];

/** `/login?user=x` sets a session cookie `sid=x`; every page shows the cookies its request carried. */
function serve(request: http.IncomingMessage, response: http.ServerResponse): void {
	const url = new URL(request.url ?? "/", "http://localhost");
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

async function refusal(params: Record<string, unknown>, on: BrowserTool = tool): Promise<string> {
	try {
		await on.execute("x", params as never);
		return "accepted";
	} catch (error) {
		return (error as Error).message;
	}
}

function toolSession(settings: Settings): ToolSession {
	return { cwd: root.path(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings };
}

beforeAll(async () => {
	dirOverrides = captureDirOverrides();
	root = TempDir.createSync("@veyyon-browser-move-");
	setAgentDir(root.join("agent"));
	tool = new BrowserTool(toolSession(Settings.isolated({ "browser.headless": true, "browser.cmux": false })));
	server = http.createServer(serve);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterEach(() => {
	setVisibleLaunchesHeadlessForTest(false);
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
	await root.remove();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a tab moved with visible", () => {
	it("takes its page, cookies, localStorage, context and dialog policy to the window, and brings a cookie set there back", async () => {
		setVisibleLaunchesHeadlessForTest(true);
		await tool.execute("open", {
			action: "open",
			name: "mover",
			context: "shop",
			dialogs: "accept",
			url: `${base}/login?user=ann`,
		});
		await run(
			"mover",
			`await tab.goto(${JSON.stringify(`${base}/home`)}); await tab.evaluate(() => localStorage.setItem("cart", "3"));`,
		);
		const hiddenKey = getTab("mover")?.browser.key;
		requests.length = 0;

		const moved = text(await tool.execute("open", { action: "open", name: "mover", visible: true }));
		expect(moved).toContain('Moved tab "mover" from headless hidden to headless browser (visible) in context "shop"');
		expect(moved).toContain(`URL: ${base}/home`);
		expect(moved).toContain(`Carried 1 cookie and localStorage for ${base}`);
		const tab = getTab("mover");
		expect({
			key: tab?.browser.key,
			context: tab?.backend === "worker" ? tab.contextName : null,
			dialogs: tab?.dialogPolicy,
		}).toEqual({
			key: "headless:0",
			context: "shop",
			dialogs: "accept",
		});
		// The hidden browser held only this tab, so it closed.
		expect(hiddenKey).toBe("headless:1");
		expect(getBrowsersMapForTest().has("headless:1")).toBe(false);
		// The reload's first request carried the cookie: it was in the window's context before the page loaded.
		expect(requests[0]).toBe("/home sid=ann");
		expect(await run("mover", 'return await tab.evaluate(() => localStorage.getItem("cart"));')).toBe("3");

		// A person clears the check in the window; the clearance comes back headless.
		await run(
			"mover",
			`await tab.goto(${JSON.stringify(`${base}/login?user=cleared`)}); await tab.goto(${JSON.stringify(`${base}/home`)});`,
		);
		requests.length = 0;
		const back = text(await tool.execute("open", { action: "open", name: "mover", visible: false }));
		expect(back).toContain('Moved tab "mover" from headless visible to headless browser (hidden) in context "shop"');
		expect(getTab("mover")?.browser.key).toBe("headless:1");
		expect(requests[0]).toBe("/home sid=cleared");
		await tool.execute("close", { action: "close", name: "mover" });
	}, 120_000);

	it("keeps its window when opened again without visible", async () => {
		setVisibleLaunchesHeadlessForTest(true);
		await tool.execute("open", { action: "open", name: "stay", url: `${base}/a` });
		await tool.execute("open", { action: "open", name: "stay", visible: true });
		const again = text(await tool.execute("open", { action: "open", name: "stay", url: `${base}/b` }));
		expect(again).toContain('Reused tab "stay" on headless browser (visible)');
		await tool.execute("close", { action: "close", name: "stay" });
	}, 90_000);

	it.skipIf(process.platform !== "linux")(
		"to a window on a Linux host with no display fails before the tab leaves its browser",
		async () => {
			await tool.execute("open", { action: "open", name: "nodisplay", url: `${base}/a` });
			const saved = { DISPLAY: process.env.DISPLAY, WAYLAND_DISPLAY: process.env.WAYLAND_DISPLAY };
			delete process.env.DISPLAY;
			delete process.env.WAYLAND_DISPLAY;
			let message = "";
			try {
				message = await refusal({ action: "open", name: "nodisplay", visible: true });
			} finally {
				for (const [key, value] of Object.entries(saved)) {
					if (value === undefined) delete process.env[key];
					else process.env[key] = value;
				}
			}
			expect(message).toBe(
				"A visible browser needs a display, and this Linux host has none: DISPLAY and WAYLAND_DISPLAY are unset. Run veyyon in a desktop session, or under a virtual display such as Xvfb with DISPLAY set.",
			);
			expect({ alive: getTab("nodisplay")?.state, key: getTab("nodisplay")?.browser.key }).toEqual({
				alive: "alive",
				key: "headless:1",
			});
			expect(await run("nodisplay", "return page.url();")).toBe(`${base}/a`);
			await tool.execute("close", { action: "close", name: "nodisplay" });
		},
		60_000,
	);

	it("on a profile relaunches the profile in the window, only when no other tab holds its browser", async () => {
		setVisibleLaunchesHeadlessForTest(true);
		await tool.execute("open", { action: "open", name: "prof-1", profile: "movable", url: `${base}/login?user=pat` });
		await tool.execute("open", { action: "open", name: "prof-2", profile: "movable" });
		expect(await refusal({ action: "open", name: "prof-1", visible: true })).toBe(
			'Browser profile "movable" runs in one browser at a time, and tab "prof-2" is open on it. Close it first, then move this tab.',
		);
		// A new tab cannot open the profile in a window while its hidden browser runs.
		expect(await refusal({ action: "open", name: "prof-3", profile: "movable", visible: true })).toBe(
			'Browser profile "movable" is already open in the hidden browser; close its tabs first.',
		);
		await tool.execute("close", { action: "close", name: "prof-2" });
		requests.length = 0;
		const moved = text(await tool.execute("open", { action: "open", name: "prof-1", visible: true }));
		expect(moved).toContain(
			'Moved tab "prof-1" from headless hidden profile "movable" to headless browser (visible, profile "movable")',
		);
		expect(getTab("prof-1")?.browser.key).toBe("headless:0:profile:movable");
		expect(requests[0]).toBe("/login sid=pat");
		await tool.execute("close", { action: "close", name: "prof-1" });
		expect(fs.existsSync(path.join(root.join("agent"), "browser-profiles", "movable", "Default"))).toBe(true);
	}, 120_000);
});

describe("visible and profile", () => {
	it("are refused on actions other than open, on an app browser and on the cmux browser", async () => {
		const cmuxTool = new BrowserTool(toolSession(Settings.isolated({ "browser.cmux": true })));
		const savedSocket = process.env.CMUX_SOCKET_PATH;
		let cmux = "";
		try {
			process.env.CMUX_SOCKET_PATH = root.join("not-a-real-cmux.sock");
			cmux = await refusal({ action: "open", name: "c", profile: "work" }, cmuxTool);
		} finally {
			if (savedSocket === undefined) delete process.env.CMUX_SOCKET_PATH;
			else process.env.CMUX_SOCKET_PATH = savedSocket;
		}
		expect({
			profileOnRun: await refusal({ action: "run", name: "x", code: "1", profile: "work" }),
			visibleOnClose: await refusal({ action: "close", name: "x", visible: true }),
			profileOnSpawned: await refusal({ action: "open", name: "x", profile: "work", app: { path: "/bin/true" } }),
			visibleOnConnected: await refusal({
				action: "open",
				name: "x",
				visible: true,
				app: { cdp_url: "http://127.0.0.1:1" },
			}),
			cmux,
		}).toEqual({
			profileOnRun: "profile and visible apply to open, which picks the browser a tab runs in; run takes neither.",
			visibleOnClose:
				"profile and visible apply to open, which picks the browser a tab runs in; close takes neither.",
			profileOnSpawned: `profile and visible need the headless browser; spawned:${path.resolve(root.path(), "/bin/true")} runs in the app's own session and window.`,
			visibleOnConnected:
				"profile and visible need the headless browser; connected:http://127.0.0.1:1 runs in the app's own session and window.",
			cmux: "profile and visible need the headless browser; the cmux browser pane is already visible and keeps cmux's own session. Turn the browser.cmux setting off, or set VEYYON_BROWSER_CMUX=0, to open tabs in the headless browser.",
		});
	});
});
