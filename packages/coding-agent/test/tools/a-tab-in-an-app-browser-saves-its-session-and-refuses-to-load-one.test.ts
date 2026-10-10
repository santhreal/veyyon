/**
 * WHY: `open` refused a state file on a spawned or connected browser, whose tab runs in the browser's
 * own profile, but `tab.loadStorageState()` inside a run wrote cookies and localStorage into that
 * profile anyway: a person's signed-in browser, reached by `app.cdp_url`, had its session replaced.
 *
 * The contract: in a spawned or connected browser, reading the session is allowed (`save_state` and
 * `tab.storageState()`, the way a signed-in session is carried into a headless tab), and a load, from
 * an object or from a file, is refused naming why, with the profile's cookies left as they were.
 *
 * Driven through the real tool against a Chromium the test launched and the tool reaches by
 * `app.cdp_url`. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a spawned browser (`app.path`), which runs in the same attach mode as a
 * connected one and is not launched here.
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
import { type DebuggableChromium, launchDebuggableChromium } from "../helpers/debuggable-chromium";
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

let server: http.Server;
let base = "";
let dir = "";
let chromium: DebuggableChromium | undefined;
let tool: BrowserTool;
const TAB = `app-browser-${process.pid}`;

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function run(code: string): Promise<string> {
	return text(await tool.execute("run", { action: "run", name: TAB, code }));
}

async function failureOf(code: string): Promise<string> {
	try {
		return `(it did not fail: ${await run(code)})`;
	} catch (error) {
		return (error as Error).message;
	}
}

const COOKIES = 'return (await tab.storageState()).cookies.map(cookie => cookie.name + "=" + cookie.value);';

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-app-browser-state-"));
	server = http.createServer((request, response) => {
		const user = new URL(request.url ?? "/", "http://localhost").searchParams.get("user");
		if (user) response.setHeader("Set-Cookie", `sid=${user}; Path=/`);
		response.setHeader("Content-Type", "text/html");
		response.end("<!doctype html><title>t</title>");
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	if (!CHROMIUM_AVAILABLE) return;
	chromium = await launchDebuggableChromium();
	const session: ToolSession = {
		cwd: dir,
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, app: { cdp_url: chromium.cdpUrl } });
	await run(`await tab.goto(${JSON.stringify(`${base}/login?user=ada`)});`);
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) {
		await tool.execute("close", { action: "close", name: TAB });
		await chromium?.close();
	}
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a tab in a connected browser", () => {
	it("saves its session with save_state and tab.storageState()", async () => {
		const saved = await tool.execute("save_state", { action: "save_state", name: TAB, storage_state: "ada.json" });
		expect(text(saved)).toBe(`Saved 1 cookie and no localStorage to ${path.join(dir, "ada.json")}`);
		const file = JSON.parse(fs.readFileSync(path.join(dir, "ada.json"), "utf8")) as {
			cookies: Array<{ name: string; value: string }>;
		};
		expect(file.cookies.map(cookie => `${cookie.name}=${cookie.value}`)).toEqual(["sid=ada"]);
		expect(JSON.parse(await run(COOKIES))).toEqual(["sid=ada"]);
	}, 60_000);

	it("refuses to load a session into the browser's profile, from an object or a file, and keeps its cookies", async () => {
		fs.writeFileSync(
			path.join(dir, "eve.json"),
			JSON.stringify({ cookies: [{ name: "sid", value: "eve", domain: "127.0.0.1", path: "/" }] }),
		);
		const refusals = [
			await failureOf(
				'await tab.loadStorageState({ cookies: [{ name: "sid", value: "eve", domain: "127.0.0.1", path: "/" }], origins: [] });',
			),
			await failureOf('await tab.loadStorageState("eve.json");'),
		];
		for (const refusal of refusals) {
			expect(refusal).toContain("tab.loadStorageState() needs the headless browser");
			expect(refusal).toContain("a load would write cookies and localStorage into that profile");
		}
		expect(JSON.parse(await run(COOKIES))).toEqual(["sid=ada"]);
	}, 60_000);
});
