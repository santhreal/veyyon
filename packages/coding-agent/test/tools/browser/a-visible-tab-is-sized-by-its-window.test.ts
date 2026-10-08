/**
 * WHY: a tab in a browser window emulated the headless viewport, 1365x768 at scale 1.25, inside a
 * window whose content area was 87 px shorter. The page laid out for a viewport the window could not
 * show, so its bottom edge was out of reach of the person the window is for, it did not follow the
 * window when the person resized it, and it reported a window with no chrome (`outerHeight` equal to
 * `innerHeight`) and a scale the display does not have. A stuck run's replacement worker then put the
 * emulation back over any size the person gave the window.
 *
 * The contract: a visible tab emulates no viewport. Its viewport is the window's content area at the
 * display's scale; a requested viewport, on `open` or on a reused `open`, resizes the window to hold it;
 * a window keeps its size through a stuck run's replacement worker; `scale` is refused on a visible tab
 * before anything opens; the viewport `open` and `tab.observe()` report is the one the page has. A
 * hidden tab emulates the requested viewport, at scale 1.25 when none is given, on `open` and on a
 * reused `open` alike.
 *
 * The tool's visible browser runs here without a display (`setVisibleLaunchesHeadlessForTest`), whose
 * window has no chrome; the window sizing itself is driven on a headful Chromium with window chrome
 * and no display (`--ozone-platform=headless`, Linux only).
 *
 * What it does not catch: a window manager that refuses a size, and a maximized window on a desktop,
 * neither of which a host with no display has.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { applyViewport, ensureChromiumExecutable, loadPuppeteer } from "@veyyon/coding-agent/tools/web/browser/launch";
import { setVisibleLaunchesHeadlessForTest } from "@veyyon/coding-agent/tools/web/browser/registry";
import { getTab } from "@veyyon/coding-agent/tools/web/browser/tab-supervisor";
import { setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, type DirOverridesSnapshot, restoreDirOverrides } from "@veyyon/utils/dirs";
import type { Browser, Page } from "puppeteer-core";
import { CHROMIUM_AVAILABLE } from "./chromium";

const PAGE = `data:text/html,${encodeURIComponent("<!doctype html><title>sized</title><p>sized</p>")}`;

interface Viewport {
	width: number;
	height: number;
	deviceScaleFactor?: number;
}

/** What a run reads of its page: the viewport puppeteer emulates, if any, and the window's own size and scale. */
interface PageSize {
	emulated: Viewport | null;
	window: Required<Viewport>;
}

const READ_SIZE = `return JSON.stringify({ emulated: page.viewport(), window: await page.evaluate(() => ({ width: innerWidth, height: innerHeight, deviceScaleFactor: devicePixelRatio })) });`;

let root: TempDir;
let dirOverrides: DirOverridesSnapshot | undefined;
let tool: BrowserTool;

function text(result: { content: ReadonlyArray<{ type: string; text?: string }> }): string {
	return result.content.map(part => (part.type === "text" ? (part.text ?? "") : "")).join("\n");
}

async function open(params: Record<string, unknown>): Promise<Viewport | undefined> {
	const result = await tool.execute("open", { action: "open", ...params } as never);
	return (result.details as { viewport?: Viewport } | undefined)?.viewport;
}

async function readSize(name: string): Promise<PageSize> {
	return JSON.parse(text(await tool.execute("run", { action: "run", name, code: READ_SIZE }))) as PageSize;
}

async function refusal(params: Record<string, unknown>): Promise<string> {
	try {
		await tool.execute("x", params as never);
		return "accepted";
	} catch (error) {
		return (error as Error).message;
	}
}

function toolSession(settings: Settings): ToolSession {
	return { cwd: root.path(), hasUI: false, getSessionFile: () => null, getSessionSpawns: () => "*", settings };
}

beforeAll(() => {
	dirOverrides = captureDirOverrides();
	root = TempDir.createSync("@veyyon-browser-window-size-");
	setAgentDir(root.join("agent"));
	tool = new BrowserTool(toolSession(Settings.isolated({ "browser.headless": true, "browser.cmux": false })));
});

afterEach(() => {
	setVisibleLaunchesHeadlessForTest(false);
});

afterAll(async () => {
	if (CHROMIUM_AVAILABLE) await tool.execute("close", { action: "close", all: true, kill: true });
	if (dirOverrides !== undefined) restoreDirOverrides(dirOverrides);
	await root.remove();
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a visible tab", () => {
	it("emulates no viewport: open and observe report the window's content area at the display's scale", async () => {
		setVisibleLaunchesHeadlessForTest(true);
		const reported = await open({ name: "plain", visible: true, url: PAGE });
		const size = await readSize("plain");
		expect(size.emulated).toBeNull();
		expect(reported).toEqual(size.window);
		const observed = text(
			await tool.execute("run", {
				action: "run",
				name: "plain",
				code: "return JSON.stringify((await tab.observe()).viewport);",
			}),
		);
		expect(JSON.parse(observed)).toEqual(size.window);
		await tool.execute("close", { action: "close", name: "plain" });
	}, 90_000);

	it("is resized to a requested viewport on open and on a reused open", async () => {
		setVisibleLaunchesHeadlessForTest(true);
		const opened = await open({ name: "sized", visible: true, url: PAGE, viewport: { width: 1100, height: 650 } });
		const first = await readSize("sized");
		expect({ emulated: first.emulated, width: first.window.width, height: first.window.height }).toEqual({
			emulated: null,
			width: 1100,
			height: 650,
		});
		expect(opened).toEqual(first.window);

		const reused = await open({ name: "sized", viewport: { width: 900, height: 600 } });
		const second = await readSize("sized");
		expect({ emulated: second.emulated, width: second.window.width, height: second.window.height }).toEqual({
			emulated: null,
			width: 900,
			height: 600,
		});
		expect(reused).toEqual(second.window);
		await tool.execute("close", { action: "close", name: "sized" });
	}, 90_000);

	it("keeps the size a person gave its window when a stuck run's tab gets a new worker", async () => {
		setVisibleLaunchesHeadlessForTest(true);
		await open({ name: "kept", visible: true, url: PAGE, viewport: { width: 1100, height: 650 } });
		// The person drags the window to another size.
		await tool.execute("run", {
			action: "run",
			name: "kept",
			code: `const session = await page.createCDPSession();
const { windowId } = await session.send("Browser.getWindowForTarget");
await session.send("Browser.setWindowBounds", { windowId, bounds: { width: 1000, height: 900 } });
await session.detach();
await wait(() => page.evaluate(() => innerWidth !== 1100 && innerHeight !== 650), { timeout: 5000 });`,
		});
		const dragged = await readSize("kept");
		expect(dragged.window.width).toBeLessThanOrEqual(1000);
		expect(dragged.window.height).toBeGreaterThan(650);
		const stuck = await refusal({ action: "run", name: "kept", code: "await new Promise(() => {});", timeout: 2 });
		expect(stuck).toContain("Browser code execution timed out");
		expect(await readSize("kept")).toEqual({ emulated: null, window: dragged.window });
		await tool.execute("close", { action: "close", name: "kept" });
	}, 90_000);

	it("refuses scale before anything opens", async () => {
		setVisibleLaunchesHeadlessForTest(true);
		const message = await refusal({
			action: "open",
			name: "scaled",
			visible: true,
			url: PAGE,
			viewport: { width: 800, height: 600, scale: 2 },
		});
		expect(message).toContain("viewport.scale needs a hidden tab");
		expect(getTab("scaled")).toBeUndefined();
	}, 30_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("a hidden tab", () => {
	it("emulates the requested viewport at scale 1.25 unless one is given, on open and on a reused open", async () => {
		const opened = await open({ name: "hidden", url: PAGE, viewport: { width: 1100, height: 650 } });
		const first = await readSize("hidden");
		expect(first).toEqual({
			emulated: { width: 1100, height: 650, deviceScaleFactor: 1.25 },
			window: { width: 1100, height: 650, deviceScaleFactor: 1.25 },
		});
		expect(opened).toEqual(first.emulated as Viewport);

		await open({ name: "hidden", viewport: { width: 900, height: 600 } });
		expect(await readSize("hidden")).toEqual({
			emulated: { width: 900, height: 600, deviceScaleFactor: 1.25 },
			window: { width: 900, height: 600, deviceScaleFactor: 1.25 },
		});

		await open({ name: "hidden", viewport: { width: 800, height: 500, scale: 2 } });
		expect(await readSize("hidden")).toEqual({
			emulated: { width: 800, height: 500, deviceScaleFactor: 2 },
			window: { width: 800, height: 500, deviceScaleFactor: 2 },
		});
		await tool.execute("close", { action: "close", name: "hidden" });
	}, 90_000);
});

/**
 * A headful Chromium: chrome above the content area, and no display (`--ozone-platform=headless`, Linux
 * only). Undefined elsewhere, and on a host without the libraries a window's toolkit needs.
 */
async function launchHeadfulWindow(): Promise<Browser | undefined> {
	if (!CHROMIUM_AVAILABLE || process.platform !== "linux") return undefined;
	try {
		const puppeteer = await loadPuppeteer();
		return await puppeteer.launch({
			headless: false,
			defaultViewport: null,
			executablePath: await ensureChromiumExecutable(),
			args: ["--no-sandbox", "--disable-setuid-sandbox", "--ozone-platform=headless", "--window-size=1365,768"],
		});
	} catch {
		return undefined;
	}
}

const headful = await launchHeadfulWindow();

describe.skipIf(!headful)("a window with chrome", () => {
	let page: Page;

	const read = (): Promise<{ outer: number[]; inner: number[] }> =>
		page.evaluate(() => {
			const view = globalThis as unknown as {
				outerWidth: number;
				outerHeight: number;
				innerWidth: number;
				innerHeight: number;
			};
			return { outer: [view.outerWidth, view.outerHeight], inner: [view.innerWidth, view.innerHeight] };
		});

	beforeAll(async () => {
		page = await (headful as Browser).newPage();
	});

	afterAll(async () => {
		await headful?.close();
	});

	it("has the requested content area, with the chrome kept around it", async () => {
		const before = await read();
		expect(before.outer[1]).toBeGreaterThan(before.inner[1]);

		await applyViewport(page, { width: 1100, height: 650 }, true);
		const sized = await read();
		expect(sized.inner).toEqual([1100, 650]);
		expect(sized.outer[1]).toBeGreaterThan(650);
		expect(page.viewport()).toBeNull();

		// Without a requested viewport the window keeps its size.
		await applyViewport(page, undefined, true);
		expect((await read()).inner).toEqual([1100, 650]);

		// A window takes whole pixels; a fractional request is rounded.
		await applyViewport(page, { width: 1050.4, height: 620.6 }, true);
		expect((await read()).inner).toEqual([1050, 621]);
	}, 60_000);

	it("is made normal before it is sized when it was minimized", async () => {
		const session = await page.createCDPSession();
		const { windowId } = await session.send("Browser.getWindowForTarget");
		await session.send("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
		await applyViewport(page, { width: 1000, height: 600 }, true);
		const { bounds } = await session.send("Browser.getWindowForTarget");
		await session.detach();
		expect({ state: bounds.windowState, inner: (await read()).inner }).toEqual({
			state: "normal",
			inner: [1000, 600],
		});
	}, 60_000);
});
