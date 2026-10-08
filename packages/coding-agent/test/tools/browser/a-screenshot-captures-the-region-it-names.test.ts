/**
 * WHY: `tab.screenshot()` sends `Page.captureScreenshot` on a CDP session of its own instead of
 * through `page.screenshot()`, so the clip, the viewport and the full-page extent are computed here
 * rather than by puppeteer. A clip taken in viewport coordinates while the page is scrolled, or one
 * that leaves out the scroll position, captures the wrong pixels and still reports success.
 *
 * The class this closes: every region a screenshot names (an element in view, an element below the
 * fold, an element right of the viewport, an element taller than the viewport, an element the page
 * scrolled past, the viewport, the full page) is captured at its own size and holds the pixels drawn
 * there, and every format a save path names is written in that format. An element with no visible
 * box, hidden or empty, fails naming the cause.
 *
 * Not caught: elements inside child frames, which `page.$` does not reach; device scale factors other
 * than 1; and the stall the capture is hedged against, which a-stalled-screenshot-capture-is-overtaken
 * covers.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { CHROMIUM_AVAILABLE } from "./chromium";

const RED = "255,0,0";
const GREEN = "0,255,0";
const BLUE = "0,0,255";
const YELLOW = "255,255,0";
const MAGENTA = "255,0,255";
const WHITE = "255,255,255";

const PAGE = `<!doctype html><title>shots</title><style>
html, body { margin: 0; background: rgb(255,255,255); }
div { position: absolute; }
#top { left: 10px; top: 20px; width: 200px; height: 100px; background: rgb(255,0,0); }
#mid { left: 300px; top: 40px; width: 50px; height: 30px; background: rgb(0,255,0); }
#far { left: 30px; top: 2500px; width: 120px; height: 80px; background: rgb(0,0,255); }
#right { left: 4000px; top: 60px; width: 70px; height: 40px; background: rgb(255,0,255); }
#tall { left: 500px; top: 200px; width: 60px; height: 2400px; background: rgb(255,255,0); }
#end { left: 0; top: 2999px; width: 1px; height: 1px; }
</style><div id=top></div><div id=mid></div><div id=far></div><div id=right></div><div id=tall></div><div id=end></div>
<div id=hidden style="display:none"></div><div id=empty></div>`;

const TAB = `screenshot-${process.pid}`;
let tool: BrowserTool;
let server: http.Server;
let base: string;
let dir: string;

interface Shot {
	mimeType: string;
	/** The saved image's natural size, `<width>x<height>`. */
	size: string;
	/** The saved image's RGB at each requested point. */
	colors: string[];
	/** The saved file's first bytes, hex. */
	magic: string;
}

async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code, timeout: 60 });
	return result.content.flatMap(part => (part.type === "text" ? [part.text] : [])).join("");
}

/**
 * Loads the page, runs `setup`, takes `tab.screenshot(options)` saved to `file`, and decodes the saved
 * image in the page to read its size and the colors at `points`.
 */
async function shoot(
	file: string,
	options: Record<string, unknown>,
	points: Array<[number, number]>,
	setup = "",
): Promise<Shot | string> {
	const dest = path.join(dir, file);
	const taken = await run(`await tab.goto(${JSON.stringify(`${base}/`)});
${setup}
try {
	return (await tab.screenshot(${JSON.stringify({ ...options, save: dest, silent: true })})).mimeType;
} catch (e) { return 'error: ' + e.message; }`);
	if (taken.startsWith("error: ")) return taken;
	const mimeType = taken;
	const bytes = await fs.readFile(dest);
	const decoded = await run(`return JSON.stringify(await tab.evaluate(async (src, points) => {
	const img = new Image();
	img.src = src;
	await img.decode();
	const canvas = document.createElement('canvas');
	canvas.width = img.naturalWidth;
	canvas.height = img.naturalHeight;
	const context = canvas.getContext('2d');
	context.drawImage(img, 0, 0);
	return {
		size: img.naturalWidth + 'x' + img.naturalHeight,
		colors: points.map(([x, y]) => Array.from(context.getImageData(x, y, 1, 1).data.slice(0, 3)).join(',')),
	};
}, ${JSON.stringify(`data:${mimeType};base64,${bytes.toString("base64")}`)}, ${JSON.stringify(points)}));`);
	const { size, colors }: Pick<Shot, "size" | "colors"> = JSON.parse(decoded);
	return { mimeType, size, colors, magic: bytes.subarray(0, 4).toString("hex") };
}

describe.skipIf(!CHROMIUM_AVAILABLE)("a screenshot captures the region it names", () => {
	beforeAll(async () => {
		dir = await fs.mkdtemp(path.join(os.tmpdir(), "browser-screenshot-"));
		server = http.createServer((_req, res) => {
			res.writeHead(200, { "content-type": "text/html" }).end(PAGE);
		});
		const { promise, resolve } = Promise.withResolvers<void>();
		server.listen(0, "127.0.0.1", () => resolve());
		await promise;
		base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
		const session: ToolSession = {
			cwd: import.meta.dirname,
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			settings: Settings.isolated({ "browser.headless": true }),
		};
		tool = new BrowserTool(session);
		await tool.execute("open", { action: "open", name: TAB, url: "about:blank" });
	}, 60_000);

	afterAll(async () => {
		await tool.execute("close", { action: "close", name: TAB, kill: true });
		server.close();
		await fs.rm(dir, { recursive: true, force: true });
	});

	const elements: Record<string, { selector: string; setup: string; width: number; height: number; color: string }> = {
		"an element in view": { selector: "#top", setup: "", width: 200, height: 100, color: RED },
		"an element below the fold": { selector: "#far", setup: "", width: 120, height: 80, color: BLUE },
		"an element right of the viewport": { selector: "#right", setup: "", width: 70, height: 40, color: MAGENTA },
		"an element taller than the viewport": { selector: "#tall", setup: "", width: 60, height: 2400, color: YELLOW },
		"an element the page scrolled past": {
			selector: "#mid",
			setup: "await tab.evaluate(() => scrollTo(0, 1500));",
			width: 50,
			height: 30,
			color: GREEN,
		},
	};
	for (const [name, { selector, setup, width, height, color }] of Object.entries(elements)) {
		it(`a screenshot of ${name} holds exactly that element`, async () => {
			// Every corner pixel and the center: a clip off by one pixel shows the white around it.
			const points: Array<[number, number]> = [
				[0, 0],
				[width - 1, 0],
				[Math.floor(width / 2), Math.floor(height / 2)],
				[0, height - 1],
				[width - 1, height - 1],
			];
			expect(await shoot(`${selector.slice(1)}.png`, { selector }, points, setup)).toEqual({
				mimeType: "image/png",
				size: `${width}x${height}`,
				colors: points.map(() => color),
				magic: "89504e47",
			});
		}, 60_000);
	}

	it("a screenshot of the viewport holds what the viewport shows at its size", async () => {
		const viewport = await run(
			`await tab.goto(${JSON.stringify(`${base}/`)});\nreturn await tab.evaluate(() => innerWidth + 'x' + innerHeight);`,
		);
		// Inside #top, inside #mid, and the white between them.
		expect(
			await shoot("viewport.png", {}, [
				[15, 25],
				[320, 50],
				[250, 50],
			]),
		).toEqual({
			mimeType: "image/png",
			size: viewport,
			colors: [RED, GREEN, WHITE],
			magic: "89504e47",
		});
	}, 60_000);

	it("a full-page screenshot holds the page past the viewport", async () => {
		const shot = await shoot("full.png", { fullPage: true }, [
			[15, 25],
			[40, 2510],
			[40, 2700],
		]);
		expect(typeof shot === "string" ? shot : { ...shot, size: shot.size.split("x")[1] }).toEqual({
			mimeType: "image/png",
			size: "3000",
			colors: [RED, BLUE, WHITE],
			magic: "89504e47",
		});
	}, 60_000);

	const formats: Record<string, { mimeType: string; magic: string }> = {
		"shot.png": { mimeType: "image/png", magic: "89504e47" },
		"shot.jpg": { mimeType: "image/jpeg", magic: "ffd8ffe0" },
		"shot.webp": { mimeType: "image/webp", magic: "52494646" },
	};
	for (const [file, { mimeType, magic }] of Object.entries(formats)) {
		it(`a screenshot saved as ${file} is written as ${mimeType}`, async () => {
			const shot = await shoot(file, { selector: "#top" }, []);
			expect(
				typeof shot === "string" ? shot : { mimeType: shot.mimeType, size: shot.size, magic: shot.magic },
			).toEqual({
				mimeType,
				size: "200x100",
				magic,
			});
		}, 60_000);
	}

	for (const [name, selector] of Object.entries({ "a hidden element": "#hidden", "an empty element": "#empty" })) {
		it(`a screenshot of ${name} fails naming the cause`, async () => {
			expect(await shoot("none.png", { selector }, [])).toBe(
				"error: Screenshot selector matched an element with no visible box; it is hidden or empty",
			);
		}, 60_000);
	}
});
