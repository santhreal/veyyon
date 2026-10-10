/**
 * WHY: a `browser` run's result text is capped at the session's inline budget, but a failed run's
 * text (what it displayed, folded into the error, and the error itself) was sent whole. An `execSync`
 * whose command printed a permission error per file failed with 218 KB of stderr, which the model read
 * on that turn and every turn after it.
 *
 * The contract: a failed run's text is held to the same inline budget as a result's, keeping its head
 * and its tail, so the reason at the end survives; a failure within the budget is sent as it was.
 *
 * Driven through the real tool against real headless Chromium, with the budget lowered through
 * `tools.artifactSpillThreshold` so the test stays small. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: an aborted run, whose short message is left alone, and failures of actions
 * other than `run`, whose messages the tool writes itself.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { CHROMIUM_AVAILABLE } from "./browser/chromium";

/** The inline budget the session is given, in KB, as `tools.artifactSpillThreshold` takes it. */
const BUDGET_KB = 4;

let server: http.Server;
let base = "";
let tool: BrowserTool;
let files: TempDir;
const TAB = `capped-${process.pid}`;

async function failureOf(code: string): Promise<string> {
	try {
		await tool.execute("run", { action: "run", name: TAB, code });
	} catch (error) {
		return error instanceof Error ? error.message : String(error);
	}
	throw new Error("the run was expected to fail");
}

beforeAll(async () => {
	server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end("<!doctype html><title>page</title><h1>Page</h1>");
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
	files = await TempDir.create("@capped-failure-");
	if (!CHROMIUM_AVAILABLE) return;
	const session: ToolSession = {
		cwd: files.path(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true, "tools.artifactSpillThreshold": BUDGET_KB }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, url: `${base}/` });
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", name: TAB, kill: true });
	await files.remove();
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a failed browser run", () => {
	it("holds a long error to the inline budget, keeping its first and last lines", async () => {
		const failure = await failureOf(
			`throw new Error(Array.from({ length: 3000 }, (_, i) => "grep: /srv/file-" + i + ": Permission denied").join("\\n"));`,
		);
		expect(Buffer.byteLength(failure, "utf-8")).toBeLessThanOrEqual(BUDGET_KB * 1024);
		expect(failure).toContain("grep: /srv/file-0: Permission denied");
		expect(failure).toContain("grep: /srv/file-2999: Permission denied");
		expect(failure).toMatch(/\[…\d+B elided…\]/);
	}, 60_000);

	it("holds what the run displayed to the budget and keeps the reason it failed", async () => {
		const failure = await failureOf(
			`display(Array.from({ length: 3000 }, (_, i) => "row " + i).join("\\n"));
throw new Error("the reason it failed");`,
		);
		expect(Buffer.byteLength(failure, "utf-8")).toBeLessThanOrEqual(BUDGET_KB * 1024);
		expect(failure).toContain("row 0\n");
		expect(failure).toContain("the reason it failed");
		expect(failure).toMatch(/\[…\d+B elided…\]/);
	}, 60_000);

	it("sends a failure within the budget as it was", async () => {
		const failure = await failureOf(`display("row 1\\nrow 2"); throw new Error("the reason it failed");`);
		expect(failure).toBe("row 1\nrow 2\n\nthe reason it failed");
	}, 60_000);
});
