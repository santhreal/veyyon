/**
 * WHY: every headless browser ran on a temporary profile removed when it closed, so a sign-in, a
 * cleared bot check or a site's stored data ended with the browser, and the next session started
 * signed out. A named profile is a persistent directory under the agent directory.
 *
 * The class: a profile that loses its data, leaks it to another profile, or is opened twice. Data a
 * tab writes (a persistent cookie, localStorage, IndexedDB) is there after the profile's browser
 * closes and starts again; another profile and a tab with no profile see none of it; an isolated
 * context inside a profile sees none of it either; a state file loaded into a profile stays in it;
 * the password-manager preferences hold on every launch, even after the file says otherwise; a
 * profile another Chromium process holds, or a host other than this one, is refused naming the
 * profile and the lock, and opens once that process is gone or when its lock names a process on this
 * host that no longer runs; a name that is not one directory under the profiles directory is refused
 * before anything is created.
 *
 * Driven through the real tool against real headless Chromium and a local server, with the agent
 * directory in a temporary directory. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: the Windows lock (`lockfile` held without sharing), which this Linux
 * suite cannot reach; which of the two lock checks refused (the one before the launch, or the one
 * after a launch that lost a race for the lock), since both give the same refusal; session cookies,
 * which end with the browser as they do in Chrome.
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
import { ensureChromiumExecutable, loadPuppeteer } from "@veyyon/coding-agent/tools/web/browser/launch";
import { profileDirectory } from "@veyyon/coding-agent/tools/web/browser/profiles";
import { getBrowserProfilesDir, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

let server: http.Server;
let base = "";
let root: TempDir;
let dirOverrides: DirOverridesSnapshot | undefined;
let tool: BrowserTool;

/** `/login?user=x` sets a cookie that outlives the browser; every page shows the cookies its request carried. */
function serve(request: http.IncomingMessage, response: http.ServerResponse): void {
	const url = new URL(request.url ?? "/", "http://localhost");
	const user = url.searchParams.get("user");
	if (url.pathname === "/login" && user) response.setHeader("Set-Cookie", `sid=${user}; Path=/; Max-Age=3600`);
	const sent = (request.headers.cookie ?? "").replace(/[<&]/g, "");
	response.setHeader("Content-Type", "text/html");
	response.end(`<!doctype html><title>t</title><pre id="sent">${sent}</pre>`);
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function run(name: string, code: string): Promise<string> {
	return text(await tool.execute("run", { action: "run", name, code }));
}

/** Write `who` to the page's localStorage and IndexedDB. */
const WRITE_STORAGE = `return await tab.evaluate(async who => {
	localStorage.setItem("who", who);
	const opened = Promise.withResolvers();
	const request = indexedDB.open("veyyon-test", 1);
	request.onupgradeneeded = () => request.result.createObjectStore("kv");
	request.onsuccess = () => opened.resolve(request.result);
	request.onerror = () => opened.reject(request.error);
	const db = await opened.promise;
	const written = Promise.withResolvers();
	const tx = db.transaction("kv", "readwrite");
	tx.objectStore("kv").put(who, "who");
	tx.oncomplete = () => written.resolve();
	tx.onerror = () => written.reject(tx.error);
	await written.promise;
	db.close();
	return "written";
}, "ann");`;

/** The cookies the page's request carried, its localStorage and its IndexedDB, as one string. */
const READ_SESSION = `return await tab.evaluate(async () => {
	const cookies = document.getElementById("sent").textContent;
	const local = localStorage.getItem("who");
	const names = (await indexedDB.databases()).map(entry => entry.name);
	let stored = null;
	if (names.includes("veyyon-test")) {
		const opened = Promise.withResolvers();
		const request = indexedDB.open("veyyon-test", 1);
		request.onsuccess = () => opened.resolve(request.result);
		request.onerror = () => opened.reject(request.error);
		const db = await opened.promise;
		const read = Promise.withResolvers();
		const get = db.transaction("kv").objectStore("kv").get("who");
		get.onsuccess = () => read.resolve(get.result ?? null);
		get.onerror = () => read.reject(get.error);
		stored = await read.promise;
		db.close();
	}
	return JSON.stringify({ cookies, local, stored });
});`;

async function session(name: string, params: { profile?: string; context?: string }): Promise<unknown> {
	await tool.execute("open", { action: "open", name, url: `${base}/whoami`, ...params });
	return JSON.parse(await run(name, READ_SESSION));
}

async function close(name: string): Promise<void> {
	await tool.execute("close", { action: "close", name });
}

beforeAll(async () => {
	dirOverrides = captureDirOverrides();
	root = TempDir.createSync("@veyyon-browser-profile-");
	setAgentDir(root.join("agent"));
	const toolSession: ToolSession = {
		cwd: root.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(toolSession);
	server = http.createServer(serve);
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
	await root.remove();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a named browser profile", () => {
	it("keeps a cookie, localStorage and IndexedDB after its browser closes and starts again, and shares them with no one else", async () => {
		const opened = text(
			await tool.execute("open", {
				action: "open",
				name: "alpha-1",
				profile: "alpha",
				url: `${base}/login?user=ann`,
			}),
		);
		expect(opened).toContain('on headless browser (hidden, profile "alpha")');
		expect(await run("alpha-1", WRITE_STORAGE)).toBe("written");
		// The last tab closes the profile's browser.
		await close("alpha-1");
		expect(fs.existsSync(path.join(getBrowserProfilesDir(), "alpha", "Default"))).toBe(true);

		const seen = {
			alpha: await session("alpha-2", { profile: "alpha" }),
			beta: await session("beta-1", { profile: "beta" }),
			plain: await session("plain-1", {}),
			alphaContext: await session("alpha-iso", { profile: "alpha", context: "iso" }),
		};
		expect(seen).toEqual({
			alpha: { cookies: "sid=ann", local: "ann", stored: "ann" },
			beta: { cookies: "", local: null, stored: null },
			plain: { cookies: "", local: null, stored: null },
			alphaContext: { cookies: "", local: null, stored: null },
		});
		for (const name of ["alpha-2", "beta-1", "plain-1", "alpha-iso"]) await close(name);
	}, 120_000);

	it("keeps a state file loaded into it", async () => {
		const file = root.join("delta-state.json");
		fs.writeFileSync(
			file,
			JSON.stringify({
				cookies: [
					{ name: "sid", value: "from-file", domain: "127.0.0.1", path: "/", expires: Date.now() / 1000 + 3600 },
				],
				origins: [],
			}),
		);
		await tool.execute("open", { action: "open", name: "delta-1", profile: "delta", storage_state: file });
		await close("delta-1");
		expect(await session("delta-2", { profile: "delta" })).toEqual({
			cookies: "sid=from-file",
			local: null,
			stored: null,
		});
		await close("delta-2");
	}, 90_000);

	it("runs with the password manager's save offer and breach check off, even after its preferences said otherwise", async () => {
		await tool.execute("open", { action: "open", name: "eps-1", profile: "eps", url: "about:blank" });
		await close("eps-1");
		const file = path.join(profileDirectory("eps"), "Default", "Preferences");
		const prefs = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
		fs.writeFileSync(
			file,
			JSON.stringify({
				...prefs,
				credentials_enable_service: true,
				profile: { password_manager_leak_detection: true },
			}),
		);
		await tool.execute("open", { action: "open", name: "eps-2", profile: "eps", url: "about:blank" });
		const effective = await run(
			"eps-2",
			`await page.goto("chrome://prefs-internals"); const all = JSON.parse(await page.evaluate(() => document.body.innerText));
return { save: all.credentials_enable_service?.value, breach: all.profile?.password_manager_leak_detection?.value };`,
		);
		expect(JSON.parse(effective)).toEqual({ save: false, breach: false });
		await close("eps-2");
	}, 90_000);

	it("is refused while another Chromium process holds it, naming the profile and the lock, and opens once that process is gone", async () => {
		const dir = profileDirectory("gamma");
		fs.mkdirSync(dir, { recursive: true });
		const puppeteer = await loadPuppeteer();
		const other = await puppeteer.launch({
			headless: true,
			executablePath: await ensureChromiumExecutable(),
			args: ["--no-sandbox"],
			userDataDir: dir,
		});
		const pid = other.process()?.pid;
		let refusal = "";
		try {
			await tool.execute("open", { action: "open", name: "gamma-1", profile: "gamma", url: `${base}/whoami` });
		} catch (error) {
			refusal = (error as Error).message;
		} finally {
			await other.close();
		}
		expect(refusal).toBe(
			process.platform === "win32"
				? `Browser profile "gamma" is in use by another Chromium process (lock ${path.join(dir, "lockfile")}). Close the browser running on it, or open another profile.`
				: `Browser profile "gamma" is in use by pid ${pid} (lock ${path.join(dir, "SingletonLock")}). Close the browser running on it, or open another profile.`,
		);
		const opened = text(
			await tool.execute("open", { action: "open", name: "gamma-1", profile: "gamma", url: `${base}/whoami` }),
		);
		expect(opened).toContain('Opened tab "gamma-1" on headless browser (hidden, profile "gamma")');
		await close("gamma-1");
	}, 90_000);

	it.skipIf(process.platform === "win32")(
		"is refused under a lock from another host, and opens over one left by a process on this host that is gone, as Chromium does",
		async () => {
			const dir = profileDirectory("stale");
			const lock = path.join(dir, "SingletonLock");
			fs.mkdirSync(dir, { recursive: true });
			fs.symlinkSync("another-host-123", lock);
			let refusal = "";
			try {
				await tool.execute("open", { action: "open", name: "stale-1", profile: "stale", url: `${base}/whoami` });
			} catch (error) {
				refusal = (error as Error).message;
			}
			expect(refusal).toBe(
				`Browser profile "stale" is in use by pid 123 on host another-host (lock ${lock}). Close the browser running on it, or open another profile.`,
			);
			fs.unlinkSync(lock);
			// The largest pid Linux hands out by default: no process holds it in a test container.
			fs.symlinkSync(`${os.hostname()}-4194303`, lock);
			const opened = text(
				await tool.execute("open", { action: "open", name: "stale-1", profile: "stale", url: `${base}/whoami` }),
			);
			expect(opened).toContain('Opened tab "stale-1" on headless browser (hidden, profile "stale")');
			await close("stale-1");
		},
		90_000,
	);

	it("refuses a name that is not one directory under the profiles directory, before creating anything", async () => {
		const names = ["../escape", "a/b", "a\\b", "", "Work", "con", "nul.txt", ".hidden", "trailing.", "x".repeat(65)];
		const refusals: Record<string, string> = {};
		for (const profile of names) {
			try {
				await tool.execute("open", { action: "open", name: "bad", profile, url: `${base}/whoami` });
				refusals[profile] = "accepted";
			} catch (error) {
				refusals[profile] = (error as Error).message.split(":")[0] ?? "";
			}
		}
		expect(refusals).toEqual(
			Object.fromEntries(names.map(profile => [profile, `Invalid browser profile name ${JSON.stringify(profile)}`])),
		);
		expect(fs.existsSync(path.join(getBrowserProfilesDir(), "..", "escape"))).toBe(false);
		expect(fs.existsSync(path.join(getBrowserProfilesDir(), "a"))).toBe(false);
	}, 30_000);
});
