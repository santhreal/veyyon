/**
 * WHY: two shapes cost a model turns and tokens in every browser session.
 *
 * A run that reaches for `document`, `window` or a page's own global fails with a bare "X is not
 * defined", and the model spends a turn finding out that run code executes outside the page. When
 * the page has that name, the error says where it lives and how to reach it; a name the page does
 * not have either (a typo, an unset variable) keeps its plain error.
 *
 * `display(x); return x;` sent `x` twice, and every copy is re-sent on each later turn. A return
 * value the run already displayed is sent once; a different return value is still sent.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: a page global read inside a callback that runs after the run ends, whose
 * error reaches no result at all.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

const PAGE = `<!doctype html><title>globals</title><p id="p">text</p><script>window.appState = { ready: true };</script>`;

let server: http.Server;
let url = "";
let tool: BrowserTool;
const TAB = `globals-${process.pid}`;

function texts(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string[] {
	return result.content.filter(part => part.type === "text").map(part => part.text ?? "");
}

async function failureOf(code: string): Promise<string> {
	try {
		await tool.execute("run", { action: "run", name: TAB, code });
		return "(it did not fail)";
	} catch (error) {
		return (error as Error).message;
	}
}

beforeAll(async () => {
	server = http.createServer((_request, response) => {
		response.setHeader("Content-Type", "text/html");
		response.end(PAGE);
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
	if (!CHROMIUM_AVAILABLE) return;
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
	await tool.execute("open", { action: "open", name: TAB, url });
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", name: TAB, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a run", () => {
	it("says where a DOM or page global lives when run code reaches for it, and leaves other names alone", async () => {
		const failures = {
			dom: await failureOf("return document.getElementById('p').textContent;"),
			app: await failureOf("return appState.ready;"),
			typo: await failureOf("return notAnywhere.value;"),
		};
		const where =
			"exists in the page, but run code executes in the tab worker. Use it inside `await tab.evaluate(() => …)`.";
		expect(failures.dom).toContain(`\`document\` ${where}`);
		expect(failures.app).toContain(`\`appState\` ${where}`);
		expect(failures.typo).toContain("notAnywhere");
		expect(failures.typo).not.toContain("exists in the page");
	}, 60_000);

	it("sends a return value it already displayed once, and a different one as well", async () => {
		const same = await tool.execute("run", {
			action: "run",
			name: TAB,
			code: "const v = { title: await tab.evaluate(() => document.title) }; display(v); return v;",
		});
		expect(texts(same)).toEqual(['{"title":"globals"}']);
		const shownString = await tool.execute("run", {
			action: "run",
			name: TAB,
			code: 'const s = "the same line"; display(s); return s;',
		});
		expect(texts(shownString)).toEqual(["the same line"]);
		const different = await tool.execute("run", {
			action: "run",
			name: TAB,
			code: "display({ step: 1 }); return { step: 2 };",
		});
		expect(texts(different)).toEqual(['{"step":1}', '{"step":2}']);
	}, 60_000);
});
