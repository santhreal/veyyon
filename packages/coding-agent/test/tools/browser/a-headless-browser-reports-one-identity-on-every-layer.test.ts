/**
 * WHY: detectors compare what a page, its workers and its HTTP requests say about the browser. The
 * headless tool browser claimed Windows in the page while its workers, its `navigator.platform` and its
 * requests said Linux and `HeadlessChrome`, its WebGL in a worker was SwiftShader, its screen was the
 * size of its window, and a clicked event's screen offset did not match the window it reported. A tab
 * opened with a viewport of its own reported the shared window's width around it, 254 pixels of
 * "frame" that devtools detectors read as an open DevTools panel. A tab whose hung run had its worker
 * replaced lost its viewport, its client hints and its page scripts: they went with the old worker's
 * connection.
 *
 * The contract, driven through the real tool against real headless Chromium and a local server: the
 * page, a dedicated worker, a shared worker and a service worker report one user agent, platform,
 * brand list and core count, none of them `Headless`; the HTTP `User-Agent` of the page and of every
 * worker's request is that user agent and the page's client-hints headers carry the same brands and
 * platform; WebGL names the same GPU in the page and in a worker and it is not SwiftShader; the screen
 * is larger than the window and the window larger than its viewport; a `tab.click` event's screen
 * position is its viewport position plus the window's screen position and chrome. All of it holds for
 * a viewport the tab chose, and a tab whose worker was replaced reports the same values on its next
 * page while the old thread is still stuck.
 *
 * What it does not catch: how a remote detector scores these values, which the bot-detection bench
 * measures, and hosts other than the one it runs on, which the pure identity sweep covers.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { TempDir } from "@veyyon/utils";
import { chromiumCanLaunch } from "../../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();
const TAB = `identity-${process.pid}`;

const COLLECT = `
async function collect(kind) {
	const nav = self.navigator;
	const canvas = typeof document !== "undefined" ? document.createElement("canvas") : new OffscreenCanvas(8, 8);
	const gl = canvas.getContext("webgl");
	const debug = gl && gl.getExtension("WEBGL_debug_renderer_info");
	const high = nav.userAgentData ? await nav.userAgentData.getHighEntropyValues(["platformVersion", "architecture", "fullVersionList"]) : null;
	await fetch(self.location.origin + "/echo?from=" + kind);
	return {
		userAgent: nav.userAgent,
		platform: nav.platform,
		hardwareConcurrency: nav.hardwareConcurrency,
		brands: nav.userAgentData ? nav.userAgentData.brands.map(b => b.brand + "/" + b.version).join(",") : "",
		chPlatform: nav.userAgentData ? nav.userAgentData.platform : "",
		architecture: high ? high.architecture : "",
		webgl: debug ? gl.getParameter(debug.UNMASKED_VENDOR_WEBGL) + " | " + gl.getParameter(debug.UNMASKED_RENDERER_WEBGL) : "",
	};
}`;

const WORKER_JS = `${COLLECT}
if (typeof ServiceWorkerGlobalScope !== "undefined" && self instanceof ServiceWorkerGlobalScope) {
	self.addEventListener("install", () => self.skipWaiting());
	self.addEventListener("activate", event => event.waitUntil(self.clients.claim()));
	self.addEventListener("message", event => event.waitUntil(collect("service").then(values => event.ports[0].postMessage(values))));
} else if (typeof SharedWorkerGlobalScope !== "undefined" && self instanceof SharedWorkerGlobalScope) {
	self.onconnect = event => { const port = event.ports[0]; port.onmessage = async () => port.postMessage(await collect("shared")); };
} else {
	self.onmessage = async () => self.postMessage(await collect("dedicated"));
}`;

const PAGE_HTML = `<!doctype html><title>identity</title>
<button id="target" style="position:absolute;left:300px;top:200px;width:120px;height:40px">target</button>
<script>
${COLLECT}
window.clicks = [];
document.addEventListener("mousedown", e => window.clicks.push({ trusted: e.isTrusted, screenX: e.screenX, screenY: e.screenY, clientX: e.clientX, clientY: e.clientY }), true);
const within = (promise, label) => Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error(label + " did not answer")), 15000))]);
window.collectAll = async () => {
	const main = await collect("main");
	const worker = new Worker("/worker.js");
	const dedicated = await within(new Promise(resolve => { worker.onmessage = e => resolve(e.data); worker.postMessage(0); }), "dedicated worker");
	const sharedWorker = new SharedWorker("/worker.js?shared");
	const shared = await within(new Promise(resolve => { sharedWorker.port.onmessage = e => resolve(e.data); sharedWorker.port.postMessage(0); }), "shared worker");
	const registration = await navigator.serviceWorker.register("/worker.js?service");
	await within(navigator.serviceWorker.ready, "service worker");
	const active = registration.active || registration.waiting || registration.installing;
	const service = await within(new Promise(resolve => { const channel = new MessageChannel(); channel.port1.onmessage = e => resolve(e.data); active.postMessage(0, [channel.port2]); }), "service worker");
	return {
		layers: { main, dedicated, shared, service },
		geometry: { screenWidth: screen.width, screenHeight: screen.height, outerWidth, outerHeight, innerWidth, innerHeight, screenX, screenY },
	};
};
</script>`;

interface Layer {
	userAgent: string;
	platform: string;
	hardwareConcurrency: number;
	brands: string;
	chPlatform: string;
	architecture: string;
	webgl: string;
}

interface Collected {
	layers: Record<"main" | "dedicated" | "shared" | "service", Layer>;
	geometry: Record<string, number>;
	clicks: Array<{ trusted: boolean; screenX: number; screenY: number; clientX: number; clientY: number }>;
}

const requests: Array<{ path: string; headers: http.IncomingHttpHeaders }> = [];
let server: http.Server;
let origin: string;
let tool: BrowserTool;

beforeAll(async () => {
	server = http.createServer((request, response) => {
		requests.push({ path: request.url ?? "", headers: request.headers });
		response.setHeader("Accept-CH", "Sec-CH-UA-Platform-Version, Sec-CH-UA-Arch, Sec-CH-UA-Full-Version-List");
		if (request.url?.startsWith("/worker.js")) {
			response.setHeader("Content-Type", "text/javascript");
			response.end(WORKER_JS);
		} else if (request.url?.startsWith("/page")) {
			response.setHeader("Content-Type", "text/html");
			response.end(PAGE_HTML);
		} else {
			response.statusCode = 204;
			response.end();
		}
	});
	const listening = Promise.withResolvers<void>();
	server.listen(0, "127.0.0.1", () => listening.resolve());
	await listening.promise;
	origin = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
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
	const closed = Promise.withResolvers<void>();
	server.close(() => closed.resolve());
	await closed.promise;
});

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("");
}

/** Load the page again on tab `name`, collect every layer and the geometry, and click the target once. */
async function collectOn(name: string, load: number): Promise<Collected> {
	const result = await tool.execute("run", {
		action: "run",
		name,
		timeout: 60,
		code: `await tab.goto(${JSON.stringify(`${origin}/page?load=${load}`)});
const collected = await tab.evaluate(() => window.collectAll());
await tab.click("#target");
const clicks = await tab.evaluate(() => window.clicks);
return { ...collected, clicks };`,
	});
	return JSON.parse(text(result)) as Collected;
}

/** The screen holds the window, the window holds the viewport, and a click lands where the window says. */
function expectOneWindow(collected: Collected): void {
	const geometry = collected.geometry;
	expect(geometry.screenWidth).toBeGreaterThan(geometry.outerWidth!);
	expect(geometry.screenHeight).toBeGreaterThan(geometry.outerHeight!);
	expect(geometry.outerHeight).toBeGreaterThan(geometry.innerHeight!);
	expect(geometry.outerWidth).toBeGreaterThanOrEqual(geometry.innerWidth!);

	const click = collected.clicks.find(entry => entry.trusted);
	expect(click).toBeDefined();
	const frame = (geometry.outerWidth! - geometry.innerWidth!) / 2;
	expect(click!.screenX - click!.clientX).toBe(geometry.screenX! + frame);
	expect(click!.screenY - click!.clientY).toBe(
		geometry.screenY! + geometry.outerHeight! - geometry.innerHeight! - frame,
	);
}

const exists = (file: string): Promise<boolean> =>
	fs.access(file).then(
		() => true,
		() => false,
	);

describe.skipIf(!CHROMIUM_AVAILABLE)("a headless browser", () => {
	it("reports one identity in the page, every worker kind, its requests and its geometry", async () => {
		await tool.execute("open", { action: "open", name: TAB, url: `${origin}/page?load=1` });
		const collected = await collectOn(TAB, 2);
		const { main, dedicated, shared, service } = collected.layers;

		for (const layer of [dedicated, shared, service]) {
			expect(layer.userAgent).toBe(main.userAgent);
			expect(layer.platform).toBe(main.platform);
			expect(layer.brands).toBe(main.brands);
			expect(layer.chPlatform).toBe(main.chPlatform);
			expect(layer.architecture).toBe(main.architecture);
			expect(layer.hardwareConcurrency).toBe(main.hardwareConcurrency);
			expect(layer.webgl).toBe(main.webgl);
		}
		const everything = JSON.stringify(collected.layers);
		expect(everything).not.toContain("Headless");
		expect(main.brands).not.toBe("");
		expect(main.webgl).not.toMatch(/swiftshader|llvmpipe/i);

		const fromWorkers = requests.filter(entry => /from=(main|dedicated|shared|service)|worker\.js/.test(entry.path));
		expect(fromWorkers.length).toBeGreaterThanOrEqual(7);
		for (const entry of fromWorkers) expect(entry.headers["user-agent"]).toBe(main.userAgent);
		const pageLoad = requests.find(entry => entry.path === "/page?load=2");
		const brandHeader = String(pageLoad?.headers["sec-ch-ua"]);
		for (const brand of main.brands.split(",")) {
			const [name, version] = brand.split("/");
			expect(brandHeader).toContain(`"${name}";v="${version}"`);
		}
		expect(pageLoad?.headers["sec-ch-ua-platform"]).toBe(`"${main.chPlatform}"`);
		expect(pageLoad?.headers["sec-ch-ua-arch"]).toBe(`"${main.architecture}"`);

		expectOneWindow(collected);
	}, 120_000);

	it("keeps one window around a viewport of the tab's own, and keeps both once a hung run's worker is replaced", async () => {
		const replaced = `${TAB}-replaced`;
		await tool.execute("open", {
			action: "open",
			name: replaced,
			url: `${origin}/page?load=3`,
			viewport: { width: 1111, height: 777 },
		});
		const before = await collectOn(replaced, 4);
		expect(before.geometry.innerWidth).toBe(1111);
		expect(before.geometry.innerHeight).toBe(777);
		expectOneWindow(before);

		// The replaced thread stays stuck until its `sleep` returns and the marker is written; the page is
		// read before that, through the new worker alone, and it starts a worker of its own on the way.
		const scratch = await TempDir.create("@identity-replaced-");
		try {
			const marker = path.join(scratch.path(), "hang-ended");
			let failure = "";
			try {
				await tool.execute("run", {
					action: "run",
					name: replaced,
					timeout: 2,
					code: `require("node:child_process").execSync(${JSON.stringify(`sleep 8; touch '${marker}'`)});\nreturn "never";`,
				});
			} catch (error) {
				failure = error instanceof Error ? error.message : String(error);
			}
			expect(failure).toContain("The worker was replaced and the page kept");

			const after = await collectOn(replaced, 5);
			expect(await exists(marker)).toBe(false);
			expect(after.layers).toEqual(before.layers);
			expect(after.geometry).toEqual(before.geometry);
			expectOneWindow(after);
		} finally {
			await scratch.remove();
		}
	}, 120_000);
});
