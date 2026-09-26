/**
 * WHY: after a sign-in form, Chrome's password manager offers to save the password and checks it
 * against breach lists; for a known-leaked password it opens a "Change your password" dialog over
 * the tab a few seconds later. Nothing in the page can see or dismiss it, and while it is up no
 * click or key reaches the page. A model that signed in to a shop with its test password found every
 * later click doing nothing, and fell back to clicking through `tab.evaluate`, 25 turns for a
 * checkout.
 *
 * The contract: the browser a headless tab runs in has the password manager's save offer and its
 * breach check off, read from Chrome's own effective preferences; closing the browser removes the
 * profile directory it ran on.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: the dialog itself, which needs Google's breach service and so a network
 * this suite does not have; the preference is what keeps it closed. Nor a connected or spawned
 * browser, whose profile belongs to whoever started it.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

let tool: BrowserTool;
const TAB = `prompts-${process.pid}`;

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function profileDirs(): string[] {
	return fs.readdirSync(os.tmpdir()).filter(name => name.startsWith("veyyon-chrome-profile-"));
}

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

describe.skipIf(!CHROMIUM_AVAILABLE)("a headless browser", () => {
	it("runs with the password manager's save offer and breach check off, and removes its profile when it closes", async () => {
		const before = new Set(profileDirs());
		await tool.execute("open", { action: "open", name: TAB, url: "about:blank" });
		const created = profileDirs().filter(name => !before.has(name));
		expect(created).toHaveLength(1);

		const prefs = await tool.execute("run", {
			action: "run",
			name: TAB,
			code: `await page.goto("chrome://prefs-internals"); const all = JSON.parse(await page.evaluate(() => document.body.innerText));
return { save: all.credentials_enable_service?.value, breach: all.profile?.password_manager_leak_detection?.value };`,
		});
		expect(JSON.parse(text(prefs))).toEqual({ save: false, breach: false });

		await tool.execute("close", { action: "close", name: TAB, kill: true });
		expect(fs.existsSync(path.join(os.tmpdir(), created[0]!))).toBe(false);
	}, 60_000);
});
