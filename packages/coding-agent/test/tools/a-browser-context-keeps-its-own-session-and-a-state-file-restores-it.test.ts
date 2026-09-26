/**
 * WHY: one browser tab signed in as one user at a time meant a second role needed a second
 * browser, and a session died with its browser. `context` gives each role its own cookie jar, and
 * a state file carries a signed-in session from one tab, run or agent to the next.
 *
 * The class: a session that leaks or is lost. Every tab naming one context shares its cookies, and
 * no tab of another context, or of the default one, sees them; the context goes with its last tab;
 * a live tab is never moved to another context, and one opened again with no context stays in its
 * own. A state file holds every cookie of the context, on every host, not only the current page's,
 * and is readable by its owner alone; loaded, the first request already carries its cookies, and
 * its localStorage is written once, with no request reaching any server, so a site that clears a key
 * after load does not find it back on the next reload. A tab opened again with a state file loads it
 * into the context it is in.
 *
 * Driven through the real tool against real headless Chromium and a local server reached as both
 * 127.0.0.1 and localhost, which are two cookie hosts. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: an isolated context on a spawned or connected browser, which is refused
 * before a browser starts and is covered by the state-file suite that needs no Chromium.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

let server: http.Server;
let port = 0;
let dir = "";
let tool: BrowserTool;
const opened = new Set<string>();
/** Every request the server answered, as `path cookies`. */
const requests: string[] = [];

/** `/login?user=x` sets `sid=x` on the host it was asked on; every page shows the cookies its request carried. */
function serve(request: http.IncomingMessage, response: http.ServerResponse): void {
	const url = new URL(request.url ?? "/", "http://localhost");
	const user = url.searchParams.get("user");
	if (url.pathname === "/login" && user) response.setHeader("Set-Cookie", `sid=${user}; Path=/; HttpOnly`);
	const sent = (request.headers.cookie ?? "").replace(/[<&]/g, "");
	requests.push(`${url.pathname} ${sent}`);
	response.setHeader("Content-Type", "text/html");
	response.end(`<!doctype html><title>t</title><pre id="sent">${sent}</pre>`);
}

function base(host: "127.0.0.1" | "localhost" = "127.0.0.1"): string {
	return `http://${host}:${port}`;
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function open(name: string, params: { url?: string; context?: string; storage_state?: string } = {}) {
	opened.add(name);
	return await tool.execute("open", { action: "open", name, ...params });
}

/** The cookies the tab's last page request carried, as the server saw them. */
async function sentCookies(name: string, url: string): Promise<string> {
	const result = await tool.execute("run", {
		action: "run",
		name,
		code: `await tab.goto(${JSON.stringify(url)}); return await tab.evaluate(() => document.getElementById("sent").textContent);`,
	});
	return text(result);
}

async function close(name: string): Promise<void> {
	opened.delete(name);
	await tool.execute("close", { action: "close", name });
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-browser-context-"));
	const session: ToolSession = {
		cwd: dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	server = http.createServer(serve);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	port = (server.address() as AddressInfo).port;
});

afterAll(async () => {
	for (const name of opened) await tool.execute("close", { action: "close", name, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("an isolated browser context", () => {
	it("shares its cookies with every tab that names it and with no other tab", async () => {
		await open("alice-1", { context: "alice", url: `${base()}/login?user=alice` });
		await open("alice-2", { context: "alice" });
		await open("bob-1", { context: "bob" });
		await open("plain-1");
		const seen = {
			alice2: await sentCookies("alice-2", `${base()}/whoami`),
			bob: await sentCookies("bob-1", `${base()}/whoami`),
			plain: await sentCookies("plain-1", `${base()}/whoami`),
		};
		expect(seen).toEqual({ alice2: "sid=alice", bob: "", plain: "" });
		for (const name of ["alice-1", "alice-2", "bob-1", "plain-1"]) await close(name);
	}, 90_000);

	it("goes with its last tab: a tab opened in the same name later starts with no cookies", async () => {
		// A tab in the default context keeps the browser up, so the context ends with its tabs and not with the browser.
		await open("carol-keeper");
		await open("carol-1", { context: "carol", url: `${base()}/login?user=carol` });
		await open("carol-2", { context: "carol" });
		await close("carol-1");
		expect(await sentCookies("carol-2", `${base()}/whoami`)).toBe("sid=carol");
		await close("carol-2");
		await open("carol-3", { context: "carol" });
		expect(await sentCookies("carol-3", `${base()}/whoami`)).toBe("");
		await close("carol-3");
		await close("carol-keeper");
	}, 90_000);

	it("never moves a live tab to another context, and keeps a tab opened again with none in its own", async () => {
		await open("dave", { context: "dave", url: `${base()}/login?user=dave` });
		await expect(open("dave", { context: "erin" })).rejects.toThrow(
			'Tab "dave" is open in context "dave"; close it first, or open context "erin" under another tab name.',
		);
		const again = await open("dave", { url: `${base()}/whoami` });
		expect(text(again)).toContain('Reused tab "dave"');
		expect(text(again)).toContain('in context "dave"');
		expect(await sentCookies("dave", `${base()}/whoami`)).toBe("sid=dave");
		await close("dave");
	}, 90_000);

	it("reopens a tab whose dialog policy changed in the context it was in", async () => {
		await open("fay", { context: "fay", url: `${base()}/login?user=fay` });
		// A new policy recreates the tab; its context, and the cookies in it, stay.
		const reopened = await tool.execute("open", { action: "open", name: "fay", dialogs: "accept" });
		expect(text(reopened)).toContain('Opened tab "fay"');
		expect(text(reopened)).toContain('in context "fay"');
		expect(await sentCookies("fay", `${base()}/whoami`)).toBe("sid=fay");
		await close("fay");
	}, 90_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a storage state file", () => {
	it("holds every cookie of the context on every host, and localStorage of its open origins, for its owner alone", async () => {
		await open("sam-a", { context: "sam", url: `${base()}/login?user=sam` });
		await open("sam-b", { context: "sam", url: `${base("localhost")}/login?user=sky` });
		await tool.execute("run", {
			action: "run",
			name: "sam-a",
			code: 'await tab.evaluate(() => localStorage.setItem("theme", "dark"));',
		});
		const file = path.join(dir, "state", "sam.json");
		const saved = await tool.execute("save_state", {
			action: "save_state",
			name: "sam-a",
			storage_state: "state/sam.json",
		});
		expect(text(saved)).toBe(`Saved 2 cookies and localStorage for ${base()} to ${file}`);

		const state = JSON.parse(fs.readFileSync(file, "utf8")) as {
			cookies: Array<{ name: string; value: string; domain: string; httpOnly: boolean }>;
			origins: Array<{ origin: string; localStorage: Array<{ name: string; value: string }> }>;
		};
		expect(
			state.cookies.map(cookie => `${cookie.domain} ${cookie.name}=${cookie.value} ${cookie.httpOnly}`).sort(),
		).toEqual(["127.0.0.1 sid=sam true", "localhost sid=sky true"]);
		expect(state.origins).toEqual([{ origin: base(), localStorage: [{ name: "theme", value: "dark" }] }]);
		if (process.platform !== "win32") expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		await close("sam-a");
		await close("sam-b");
	}, 90_000);

	it("opens signed in on the first request, and writes localStorage once so a key the site clears stays cleared", async () => {
		const file = path.join(dir, "state", "rita.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({
				cookies: [{ name: "sid", value: "rita", domain: "127.0.0.1", path: "/", expires: -1, httpOnly: true }],
				origins: [{ origin: base(), localStorage: [{ name: "token", value: "t-1" }] }],
			}),
		);
		requests.length = 0;
		const openedTab = await open("rita", { context: "rita", storage_state: file, url: `${base()}/whoami` });
		expect(text(openedTab)).toContain(`Loaded 1 cookie and localStorage for ${base()} from ${file}`);
		// Writing localStorage reached no server: the tab's own page is the first request, and it is signed in.
		expect(requests.filter(request => !request.startsWith("/favicon.ico"))).toEqual(["/whoami sid=rita"]);
		const first = await tool.execute("run", {
			action: "run",
			name: "rita",
			code: 'return { sent: await tab.evaluate(() => document.getElementById("sent").textContent), token: await tab.evaluate(() => localStorage.getItem("token")) };',
		});
		expect(JSON.parse(text(first))).toEqual({ sent: "sid=rita", token: "t-1" });

		// The site signs out on its own and reloads: a state written on every new document would sign it back in.
		const reloaded = await tool.execute("run", {
			action: "run",
			name: "rita",
			code: `await tab.evaluate(() => localStorage.removeItem("token")); await tab.goto(${JSON.stringify(`${base()}/whoami`)}); return await tab.evaluate(() => localStorage.getItem("token"));`,
		});
		expect(text(reloaded)).toBe("null");
		await close("rita");
	}, 90_000);

	it("loads from inside a run into the tab's context, and says what it put there", async () => {
		await open("tess", { context: "tess", url: `${base()}/whoami` });
		const loaded = await tool.execute("run", {
			action: "run",
			name: "tess",
			code: `return await tab.loadStorageState({ cookies: [{ name: "sid", value: "tess", domain: "127.0.0.1", path: "/" }], origins: [] });`,
		});
		expect(JSON.parse(text(loaded))).toEqual({ cookies: 1, origins: [] });
		expect(await sentCookies("tess", `${base()}/whoami`)).toBe("sid=tess");
		await close("tess");
	}, 90_000);

	it("loads into a tab opened again, in the context it is in and no other", async () => {
		const file = path.join(dir, "state", "uma.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(
			file,
			JSON.stringify({ cookies: [{ name: "sid", value: "uma", domain: "127.0.0.1", path: "/" }] }),
		);
		await open("uma", { context: "uma", url: `${base()}/whoami` });
		await open("uma-other", { context: "uma-other" });
		const again = await open("uma", { storage_state: file });
		expect(text(again)).toContain('Reused tab "uma"');
		expect(text(again)).toContain(`Loaded 1 cookie and no localStorage from ${file}`);
		expect({
			uma: await sentCookies("uma", `${base()}/whoami`),
			other: await sentCookies("uma-other", `${base()}/whoami`),
		}).toEqual({ uma: "sid=uma", other: "" });
		await close("uma");
		await close("uma-other");
	}, 90_000);
});
