/**
 * WHY: a run that times out leaves its tab with a new worker, started to take over the page. A close
 * that arrived while that worker was starting released the tab against the worker it had before, and
 * the new one, ready after the release, was then handed to the released tab: it kept its browser
 * connection and its thread, and nothing was left that would ever stop it.
 *
 * The contract: a worker started for a tab whose release began is stopped, and the released tab stays
 * released. The replacement's `init` is held until the close has run to its end, which is the order
 * that leaked; a connected browser keeps the page open through the close, so the replacement does
 * attach.
 *
 * Driven through the real tool against a Chromium the test launched and the tool reaches by
 * `app.cdp_url`. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: the inline fallback worker, which has no thread of its own to leak.
 */

import { afterAll, afterEach, beforeAll, describe, expect, it, spyOn, vi } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { getTab } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";
import { type DebuggableChromium, launchDebuggableChromium } from "../helpers/debuggable-chromium";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

let chromium: DebuggableChromium | undefined;
let tool: BrowserTool;
const TAB = `recovering-${process.pid}`;

async function failureOf(call: Promise<unknown>): Promise<string> {
	try {
		await call;
		return "(it did not fail)";
	} catch (error) {
		return (error as Error).message;
	}
}

/** Whether `message` is the `init` a timed-out run's tab sends the worker that is to take over its page. */
function isReplacementInit(message: unknown): boolean {
	if (typeof message !== "object" || message === null || !("type" in message) || message.type !== "init") return false;
	if (!("payload" in message) || typeof message.payload !== "object" || message.payload === null) return false;
	return "recover" in message.payload && message.payload.recover === true;
}

beforeAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	chromium = await launchDebuggableChromium();
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated({ "browser.headless": true }),
	};
	tool = new BrowserTool(session);
});

afterEach(() => {
	vi.restoreAllMocks();
});

afterAll(async () => {
	if (!CHROMIUM_AVAILABLE) return;
	await tool.execute("close", { action: "close", name: TAB });
	await chromium?.close();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a tab closed while its timed-out run's worker is replaced", () => {
	it("stops the replacement worker and stays released", async () => {
		await tool.execute("open", { action: "open", name: TAB, app: { cdp_url: chromium?.cdpUrl ?? "" } });
		const tab = getTab(TAB);
		let replacement: Worker | undefined;
		let closing: Promise<unknown> | undefined;
		const stopped = new Set<Worker>();
		const post = Worker.prototype.postMessage;
		spyOn(Worker.prototype, "postMessage").mockImplementation(function (
			this: Worker,
			message: unknown,
			...rest: never[]
		) {
			if (isReplacementInit(message)) {
				// The replacement starts only once the close has released the tab.
				replacement = this;
				closing = tool
					.execute("close", { action: "close", name: TAB })
					.finally(() => post.call(this, message, ...rest));
				return;
			}
			post.call(this, message, ...rest);
		});
		const terminate = Worker.prototype.terminate;
		spyOn(Worker.prototype, "terminate").mockImplementation(function (this: Worker) {
			stopped.add(this);
			terminate.call(this);
		});

		const failure = await failureOf(
			tool.execute("run", { action: "run", name: TAB, timeout: 2, code: "await new Promise(() => {});" }),
		);
		expect(failure).toContain("Browser code execution timed out after 2000ms");
		await closing;
		expect({
			replaced: replacement !== undefined,
			replacementStopped: replacement !== undefined && stopped.has(replacement),
			tab: getTab(TAB),
			state: tab?.state,
		}).toEqual({ replaced: true, replacementStopped: true, tab: undefined, state: "dead" });
	}, 60_000);
});
