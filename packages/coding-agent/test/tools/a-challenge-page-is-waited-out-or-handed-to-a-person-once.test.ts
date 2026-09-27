/**
 * WHY: a page behind a bot check came back from `open` and `run` as if it were the site. A model read
 * "Just a moment..." as the page, waited by hand, or tried to click through a CAPTCHA. The tool now
 * reads the page after every open and run: a check that clears on its own is waited out, within a
 * bound, and the result states where it led or that it did not clear; a check that needs a person is
 * stated once per page, with the hand-off to a person.
 *
 * The class: a challenge the model is not told about, told about on every call, or waited on without
 * end. An interstitial that clears is waited out by `open` and by a `run` that ends on it; one that
 * never clears is reported when the bound passes, which is the call's timeout when shorter and
 * CHALLENGE_WAIT_MAX_MS otherwise, from both sides; a page already reported holds no later run. An
 * interactive challenge is reported once per document, by `open`, `run` and a failed `run`, and again
 * for a new document. A frame inside a closed shadow root, which the page cannot list, is seen through
 * puppeteer's frame list. A challenge frame the page shows is reported, and one it hides or puts off
 * the page is not; a widget's container is reported before its script adds a frame, and an invisible
 * widget's is not. An article about CAPTCHAs is not reported.
 *
 * Driven through the real tool against real headless Chromium and a local server. Skipped where
 * Chromium cannot run.
 *
 * What it does NOT catch: real vendors' pages, which change without notice and need a network; the
 * classifier suite pins the vendor table on synthetic signals. Nor the cmux backend, whose probe runs
 * the same code through cmux's eval.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool, CHALLENGE_WAIT_MAX_MS } from "@veyyon/coding-agent/tools/web/browser";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

/** Past a wait's bound, what an open or run may add: its navigation, the probes and the page snapshot. */
const OVERHEAD_MS = 3_000;

/**
 * A Cloudflare-shaped interstitial. The redirecting one leaves for /real on a page-side 2 s timer: the
 * wait under test is the tool's, against a real page's clock, which no fake timer reaches.
 */
const INTERSTITIAL = (redirect: boolean) =>
	`<!doctype html><title>Just a moment...</title><script src="/cdn-cgi/challenge-platform/h/g/orchestrate/chl_page/v1?ray=not-a-real-ray"></script><p>Verifying you are human. This may take a few seconds.</p>${redirect ? '<script>setTimeout(() => location.replace("/real"), 2000)</script>' : ""}`;

const PAGES: Record<string, string> = {
	"/clears": INTERSTITIAL(true),
	"/stuck": INTERSTITIAL(false),
	"/real": "<!doctype html><title>Real page</title><h1>Welcome</h1>",
	"/hold":
		'<!doctype html><title>Access to this page has been denied</title><p>Press &amp; Hold to confirm you are a human</p><div id="px-captcha"></div>',
	"/turnstile":
		'<!doctype html><title>Sign up</title><p>Create your account</p><div id="host"></div><script>const root = document.getElementById("host").attachShadow({ mode: "closed" }); const frame = document.createElement("iframe"); frame.src = "https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal"; root.appendChild(frame);</script>',
	"/article": `<!doctype html><title>How CAPTCHAs work</title><article>${"<p>Sites ask you to verify you are human, to press and hold a button, or wait while checking your browser before accessing them. A reCAPTCHA checkbox, an hCaptcha grid and a Turnstile widget each decide differently.</p>".repeat(20)}</article>`,
	"/hidden-frame":
		'<!doctype html><title>Checkout</title><p>Pay</p><div style="visibility: hidden"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=not-a-real-key" width="400" height="580"></iframe></div>',
	"/offpage-frame":
		'<!doctype html><title>Checkout</title><p>Pay</p><div style="position: absolute; top: -10000px"><iframe src="https://www.google.com/recaptcha/api2/bframe?k=not-a-real-key" width="400" height="580"></iframe></div>',
	"/shown-frame":
		'<!doctype html><title>Checkout</title><p>Pay</p><iframe src="https://www.google.com/recaptcha/api2/bframe?k=not-a-real-key" width="400" height="580"></iframe>',
	"/widget-turnstile":
		'<!doctype html><title>Sign up</title><div class="cf-turnstile" data-sitekey="not-a-real-key"></div>',
	"/widget-recaptcha":
		'<!doctype html><title>Contact</title><div class="g-recaptcha" data-sitekey="not-a-real-key"></div>',
	"/widget-hcaptcha":
		'<!doctype html><title>Contact</title><div class="h-captcha" data-sitekey="not-a-real-key"></div>',
	"/widget-invisible":
		'<!doctype html><title>Contact</title><button class="g-recaptcha" data-sitekey="not-a-real-key">Send</button><div class="h-captcha" data-sitekey="not-a-real-key" data-size="invisible"></div><div class="cf-turnstile" data-sitekey="not-a-real-key" data-appearance="interaction-only"></div>',
};

let server: http.Server;
let base = "";
let dir = "";
let tool: BrowserTool;

function serve(request: http.IncomingMessage, response: http.ServerResponse): void {
	const url = new URL(request.url ?? "/", "http://localhost");
	if (url.pathname.startsWith("/cdn-cgi/")) {
		response.setHeader("Content-Type", "text/javascript");
		response.end("");
		return;
	}
	response.setHeader("Content-Type", "text/html");
	response.end(PAGES[url.pathname] ?? "<!doctype html><title>blank</title>");
}

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

function notices(body: string): number {
	return body.split("Challenge:").length - 1;
}

async function run(name: string, code: string): Promise<string> {
	return text(await tool.execute("run", { action: "run", name, code }));
}

/** An open of `pathname` in tab `name`, already on about:blank so no browser start is timed, with its wall time. */
async function timedOpen(name: string, pathname: string, timeout?: number): Promise<{ body: string; ms: number }> {
	await tool.execute("open", { action: "open", name, url: "about:blank" });
	const started = performance.now();
	const result = await tool.execute("open", { action: "open", name, url: `${base}${pathname}`, timeout });
	return { body: text(result), ms: performance.now() - started };
}

beforeAll(async () => {
	dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-challenge-"));
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
	base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
	fs.rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!CHROMIUM_AVAILABLE)("an interstitial check", () => {
	it("is waited out by an open, which states how long it took and where it led", async () => {
		const { body } = await timedOpen("clears-open", "/clears");
		const cleared =
			/Challenge: Cloudflare interstitial check cleared after (\d+\.\d) s; the tab is now at (\S+) "Real page"\./.exec(
				body,
			);
		expect(cleared?.[2]).toBe(`${base}/real`);
		const seconds = Number(cleared?.[1]);
		expect(seconds).toBeGreaterThanOrEqual(1);
		expect(seconds).toBeLessThan(5);
		expect(body).toContain(`URL: ${base}/real`);
		expect(body).toContain("Welcome");
		expect(notices(body)).toBe(1);
	}, 60_000);

	it("is waited out by a run that ends on it", async () => {
		await tool.execute("open", { action: "open", name: "clears-run", url: "about:blank" });
		const body = await run("clears-run", `await tab.goto(${JSON.stringify(`${base}/clears`)}); return "navigated";`);
		expect(body).toContain("navigated");
		expect(body).toMatch(
			new RegExp(
				`Challenge: Cloudflare interstitial check cleared after \\d+\\.\\d s; the tab is now at ${base}/real "Real page"\\.`,
			),
		);
		expect(await run("clears-run", "return page.url();")).toBe(`${base}/real`);
	}, 60_000);

	it("that never clears is reported when the call's shorter timeout passes, and holds no later run on the page", async () => {
		const { body, ms } = await timedOpen("stuck-short", "/stuck", 4);
		expect(body).toContain("Challenge: Cloudflare interstitial check did not clear within 4 s; the tab is at");
		expect(body).toContain("evidence: script ");
		expect(body).toContain("open this tab with visible: true");
		expect(ms).toBeGreaterThanOrEqual(4_000);
		expect(ms).toBeLessThan(4_000 + OVERHEAD_MS);
		const started = performance.now();
		const again = await run("stuck-short", "return 1;");
		expect(performance.now() - started).toBeLessThan(2_000);
		expect(notices(again)).toBe(0);
	}, 60_000);

	it("that never clears is reported after CHALLENGE_WAIT_MAX_MS when the call's timeout is longer", async () => {
		const { body, ms } = await timedOpen("stuck-long", "/stuck", 60);
		expect(body).toContain(
			`Challenge: Cloudflare interstitial check did not clear within ${CHALLENGE_WAIT_MAX_MS / 1000} s;`,
		);
		expect(ms).toBeGreaterThanOrEqual(CHALLENGE_WAIT_MAX_MS);
		expect(ms).toBeLessThan(CHALLENGE_WAIT_MAX_MS + OVERHEAD_MS);
	}, 90_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a challenge that needs a person", () => {
	it("is handed to a person once per page, by open, by run and by a failed run", async () => {
		const opened = text(await tool.execute("open", { action: "open", name: "hold", url: `${base}/hold` }));
		expect(notices(opened)).toBe(1);
		expect(opened).toContain(
			"Challenge: HUMAN press-and-hold check on the page, which needs a person (evidence: element #px-captcha). This tool does not solve CAPTCHAs: open this tab with visible: true",
		);
		expect(notices(await run("hold", "return 1;"))).toBe(0);

		const reloaded = await run("hold", `await tab.goto(${JSON.stringify(`${base}/hold`)}); return 2;`);
		expect(notices(reloaded)).toBe(1);
		expect(notices(await run("hold", "return 3;"))).toBe(0);

		let failure = "";
		try {
			await run("hold", `await tab.goto(${JSON.stringify(`${base}/hold`)}); throw new Error("no buy button");`);
		} catch (error) {
			failure = (error as Error).message;
		}
		expect(failure).toContain("no buy button");
		expect(notices(failure)).toBe(1);
		expect(notices(await run("hold", "return 4;"))).toBe(0);
	}, 60_000);

	it("is seen in a cross-origin frame inside a closed shadow root, which only the frame list shows", async () => {
		await tool.execute("open", { action: "open", name: "turnstile", url: "about:blank" });
		const body = await run(
			"turnstile",
			`await page.setRequestInterception(true);
page.on("request", request => {
	if (request.url().startsWith("https://challenges.cloudflare.com/")) void request.respond({ status: 200, contentType: "text/html", body: "<p>widget</p>" });
	else void request.continue();
});
await tab.goto(${JSON.stringify(`${base}/turnstile`)});
await wait(() => page.frames().some(frame => frame.url().includes("turnstile")), { timeout: 5000 });
return "loaded";`,
		);
		expect(body).toContain("loaded");
		expect(body).toContain(
			"Challenge: Cloudflare Turnstile widget on the page, which needs a person (evidence: frame https://challenges.cloudflare.com/cdn-cgi/challenge-platform/h/b/turnstile/if/ov2/av0/rcv0/0/abc/light/normal).",
		);
	}, 60_000);

	it("is not reported for an article about CAPTCHAs", async () => {
		const body = text(await tool.execute("open", { action: "open", name: "article", url: `${base}/article` }));
		expect(body).toContain("Title: How CAPTCHAs work");
		expect(notices(body)).toBe(0);
	}, 60_000);

	it("is reported for a challenge frame or widget the page shows, and not for one it hides, puts off the page or makes invisible", async () => {
		const pages = [
			"/shown-frame",
			"/hidden-frame",
			"/offpage-frame",
			"/widget-turnstile",
			"/widget-recaptcha",
			"/widget-hcaptcha",
			"/widget-invisible",
		];
		const reported: Record<string, string | null> = {};
		for (const pathname of pages) {
			const body = text(await tool.execute("open", { action: "open", name: "frames", url: `${base}${pathname}` }));
			reported[pathname] = /Challenge: ([^(]+) on the page/.exec(body)?.[1]?.trim() ?? null;
		}
		expect(reported).toEqual({
			"/shown-frame": "reCAPTCHA image challenge",
			"/hidden-frame": null,
			"/offpage-frame": null,
			"/widget-turnstile": "Cloudflare Turnstile widget",
			"/widget-recaptcha": "reCAPTCHA v2 checkbox",
			"/widget-hcaptcha": "hCaptcha challenge",
			"/widget-invisible": null,
		});
	}, 60_000);
});
