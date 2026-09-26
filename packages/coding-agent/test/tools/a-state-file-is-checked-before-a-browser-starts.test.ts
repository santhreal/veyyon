/**
 * WHY: a state file that could not be read used to be logged and skipped, and the tab opened signed
 * out while the tool reported the file as loaded. A state file is now read and checked before any
 * browser starts, and a parameter an action cannot honour is refused rather than ignored.
 *
 * The class: an input that reads as honoured and is not. A missing, non-JSON or wrongly shaped
 * state file fails the open naming the file and the field, and leaves no tab behind; an origin that
 * is not a scheme, host and port is refused; `context` outside `open`, `storage_state` outside
 * `open` and `save_state`, a `save_state` with no file, and either parameter on a spawned or
 * connected browser are refused before anything starts. A written state file is its owner's alone,
 * including one that existed before; a load drops expired cookies and writes a session cookie with
 * no expiry.
 *
 * What it does NOT catch: what a load does inside Chromium, which the context suite drives against
 * a real browser.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import {
	applyStorageState,
	parseStorageState,
	readStorageStateFile,
	writeStorageStateFile,
} from "@veyyon/coding-agent/tools/web/browser/storage-state";
import { getTab } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import type { BrowserContext, CookieData } from "puppeteer-core";

let dir = "";
let tool: BrowserTool;

beforeAll(() => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-state-file-"));
	const session: ToolSession = {
		cwd: dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
});

afterAll(() => {
	fs.rmSync(dir, { recursive: true, force: true });
});

describe("a storage state", () => {
	it("reads a Playwright-shaped state, and a file with either list missing as an empty list", () => {
		const state = {
			cookies: [
				{
					name: "sid",
					value: "a",
					domain: ".example.com",
					path: "/",
					expires: -1,
					httpOnly: true,
					secure: true,
					sameSite: "Lax" as const,
				},
			],
			origins: [{ origin: "https://example.com", localStorage: [{ name: "k", value: "v" }] }],
		};
		expect(parseStorageState(state, "s.json")).toEqual(state);
		expect(parseStorageState({}, "s.json")).toEqual({ cookies: [], origins: [] });
	});

	it("refuses a wrong shape or an origin that is not a scheme, host and port, naming the source", () => {
		const refusals: Record<string, string> = {};
		for (const [name, raw] of Object.entries({
			cookieWithoutDomain: { cookies: [{ name: "sid", value: "a" }] },
			sameSiteMisspelt: { cookies: [{ name: "sid", value: "a", domain: "x", sameSite: "lax" }] },
			originsNotAList: { origins: "https://example.com" },
			hostOnly: { origins: [{ origin: "example.com", localStorage: [] }] },
			withPath: { origins: [{ origin: "https://example.com/app", localStorage: [] }] },
			fileScheme: { origins: [{ origin: "file://", localStorage: [] }] },
		})) {
			try {
				parseStorageState(raw, "s.json");
				refusals[name] = "accepted";
			} catch (error) {
				refusals[name] = (error as Error).message;
			}
		}
		for (const [name, message] of Object.entries(refusals)) {
			expect({ name, starts: message.startsWith("s.json ") }).toEqual({ name, starts: true });
		}
		expect(refusals.cookieWithoutDomain).toContain("domain");
		expect(refusals.hostOnly).toBe(
			's.json names "example.com" as an origin; an origin is a scheme, host and port such as https://example.com',
		);
		expect(refusals.withPath).toContain('"https://example.com/app"');
		expect(refusals.fileScheme).toContain('"file://"');
	});

	it("reports a file it cannot read or parse by its path", async () => {
		const missing = path.join(dir, "missing.json");
		await expect(readStorageStateFile(missing)).rejects.toThrow(`Cannot read storage state ${missing}: `);
		const garbled = path.join(dir, "garbled.json");
		fs.writeFileSync(garbled, "{cookies:");
		await expect(readStorageStateFile(garbled)).rejects.toThrow(`Storage state ${garbled} is not JSON: `);
	});

	it.skipIf(process.platform === "win32")("is written for its owner alone, an existing file included", async () => {
		const file = path.join(dir, "nested", "state.json");
		fs.mkdirSync(path.dirname(file), { recursive: true });
		fs.writeFileSync(file, "{}", { mode: 0o644 });
		await writeStorageStateFile(file, { cookies: [], origins: [] });
		expect(fs.statSync(file).mode & 0o777).toBe(0o600);
		expect(JSON.parse(fs.readFileSync(file, "utf8"))).toEqual({ cookies: [], origins: [] });
	});

	it("loads the cookies that have not expired, a session cookie with no expiry", async () => {
		const set: CookieData[] = [];
		const context = {
			setCookie: async (...cookies: CookieData[]) => {
				set.push(...cookies);
			},
		} as unknown as BrowserContext;
		const now = Date.now() / 1000;
		const loaded = await applyStorageState(context, {
			cookies: [
				{ name: "gone", value: "x", domain: "a.test", expires: now - 60 },
				{ name: "session", value: "s", domain: "a.test", path: "/", expires: -1 },
				{ name: "kept", value: "k", domain: "a.test", expires: now + 3600, httpOnly: true, sameSite: "Strict" },
			],
			origins: [],
		});
		expect(loaded).toEqual({ cookies: 2, origins: [] });
		expect(set).toEqual([
			{ name: "session", value: "s", domain: "a.test", path: "/" },
			{ name: "kept", value: "k", domain: "a.test", expires: now + 3600, httpOnly: true, sameSite: "Strict" },
		]);
	});
});

describe("the browser tool before any browser starts", () => {
	it("fails an open whose state file is missing or malformed, naming it, and leaves no tab", async () => {
		const missing = path.join(dir, "absent.json");
		await expect(
			tool.execute("open", { action: "open", name: "absent", storage_state: "absent.json" }),
		).rejects.toThrow(`Cannot read storage state ${missing}`);
		const wrong = path.join(dir, "wrong.json");
		fs.writeFileSync(wrong, JSON.stringify({ cookies: [{ name: "sid" }] }));
		await expect(tool.execute("open", { action: "open", name: "wrong", storage_state: wrong })).rejects.toThrow(
			`${wrong} is not a storage state: `,
		);
		expect({ absent: getTab("absent"), wrong: getTab("wrong") }).toEqual({ absent: undefined, wrong: undefined });
	});

	it("refuses a parameter the action cannot honour", async () => {
		const refusals: Record<string, string> = {};
		const calls = {
			contextOnRun: { action: "run", name: "x", code: "1", context: "a" },
			contextOnClose: { action: "close", name: "x", context: "a" },
			stateOnClose: { action: "close", name: "x", storage_state: "s.json" },
			stateOnRun: { action: "run", name: "x", code: "1", storage_state: "s.json" },
			saveWithoutFile: { action: "save_state", name: "x" },
			contextOnConnected: { action: "open", name: "x", context: "a", app: { cdp_url: "http://127.0.0.1:1" } },
			stateOnSpawned: { action: "open", name: "x", storage_state: "s.json", app: { path: "/bin/true" } },
		} as const;
		for (const [name, params] of Object.entries(calls)) {
			try {
				await tool.execute(name, params);
				refusals[name] = "accepted";
			} catch (error) {
				refusals[name] = (error as Error).message;
			}
		}
		expect(refusals).toEqual({
			contextOnRun: "context applies to open, which puts a tab in it; run takes none.",
			contextOnClose: "context applies to open, which puts a tab in it; close takes none.",
			stateOnClose:
				"storage_state applies to open, which loads it, and save_state, which writes it; close takes none.",
			stateOnRun: "storage_state applies to open, which loads it, and save_state, which writes it; run takes none.",
			saveWithoutFile:
				"save_state needs storage_state, the file to write the tab's cookies and localStorage to. The file holds live session credentials: keep it out of version control.",
			contextOnConnected:
				"context and storage_state need the headless browser; connected:http://127.0.0.1:1 runs in the app's own session.",
			stateOnSpawned: `context and storage_state need the headless browser; spawned:${path.resolve(dir, "/bin/true")} runs in the app's own session.`,
		});
	});
});
