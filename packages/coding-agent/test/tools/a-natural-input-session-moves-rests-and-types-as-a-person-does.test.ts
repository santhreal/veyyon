/**
 * WHY: the browser tool pressed an element by jumping the pointer to its exact centre and pressing at
 * once, typed with no pause between keys, filled a field in one insertion whatever its length, and
 * scrolled to an element in one jump. A page that records its events tells that from a person at a
 * glance, and a challenge follows.
 *
 * The contract, with `browser.naturalInput` on: before each press several pointer moves travel from
 * where the pointer last was along a bent path to a point inside the element, the button goes down on
 * the last move's point after a rest and comes up after a hold; the pointer never presses outside
 * the element even where the element's box holds points that are not its own; a hover travels the same
 * way and presses nothing; `tab.type` and a short `tab.fill` send a keydown and keyup per character,
 * holding and pausing within their ranges, the field and a framework's tracker ending on the value; a
 * long fill and an empty one are one insertion; a drag speeds up and slows down along a bent path; an
 * element off-screen is scrolled to with wheel notches. With the setting off, for the next run of the
 * same tab: one pointer move straight to the press point and an instant press, keys with no pause, a
 * short fill in one insertion, and a scroll with no wheel. Every timing is bounded on both sides.
 *
 * Driven through the real tool against real headless Chromium. Skipped where Chromium cannot run.
 *
 * What it does NOT catch: the pace a real person keeps (the ranges are asserted, not their
 * plausibility), coalescing a slower machine does to pointer moves beyond the counts below, and the
 * cmux backend, which natural input does not reach.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as http from "node:http";
import type { AddressInfo } from "node:net";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { ToolSession } from "@veyyon/coding-agent/sdk";
import { BrowserTool } from "@veyyon/coding-agent/tools/web/browser";
import { NATURAL_INPUT } from "@veyyon/coding-agent/tools/web/browser/natural-input";
import { chromiumCanLaunch } from "../helpers/chromium-can-launch";

const CHROMIUM_AVAILABLE = await chromiumCanLaunch();

/** How much later than its range an event may land on a loaded machine: a protocol round trip, a timer. */
const LATE_MS = 150;
/** How much earlier than its range an event's timestamp may read: timer and clock granularity. */
const EARLY_MS = 5;
/** Pointer moves a travel shows the page at least, which a frame's coalescing may take one of. */
const MOVES_SEEN = NATURAL_INPUT.moveSteps[0] - 1;

const PAGE = `<!doctype html><title>natural</title>
<style>
body{margin:0;font:16px sans-serif;height:4000px;position:relative}
#a,#b,#far,#field,#src,#dst,#shape{position:absolute;margin:0;padding:0;border:0}
#a{left:40px;top:40px;width:120px;height:40px}
#b{left:700px;top:500px;width:160px;height:50px}
#field{left:300px;top:200px;width:300px;height:28px}
#src{left:100px;top:330px;width:100px;height:40px;background:#fa0}
#dst{left:600px;top:320px;width:160px;height:80px;background:#0a6}
#holder{position:absolute;left:1000px;top:90px;width:100px;height:100px;background:#eee}
#shape{left:10px;top:10px;width:80px;height:80px;background:#08f;clip-path:polygon(50% 0,100% 100%,0 100%)}
#far{left:300px;top:3000px;width:120px;height:40px}
</style>
<button id="a">A</button><button id="b">B</button><input id="field"><div id="src"></div><div id="dst"></div>
<div id="holder"><button id="shape"></button></div><button id="far">Far</button>
<script>
window.log = [];
const keep = e => log.push({ type: e.type, t: e.timeStamp, x: e.clientX, y: e.clientY, key: e.key, target: e.target && e.target.id, inputType: e.inputType, shift: e.shiftKey, buttons: e.buttons, dy: e.deltaY });
for (const type of ["pointermove", "mousedown", "mouseup", "click", "keydown", "keyup", "input", "wheel"]) addEventListener(type, keep, { capture: true, passive: true });
const field = document.getElementById("field");
const native = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
let written = field.value;
window.changes = [];
Object.defineProperty(field, "value", { get() { return native.get.call(this); }, set(v) { written = String(v); native.set.call(this, v); } });
field.addEventListener("input", () => { const now = field.value; if (now !== written) { written = now; changes.push(now); } });
</script>`;

interface Recorded {
	readonly type: string;
	readonly t: number;
	readonly x?: number;
	readonly y?: number;
	readonly key?: string;
	readonly target?: string;
	readonly inputType?: string;
	readonly shift?: boolean;
	readonly buttons?: number;
	readonly dy?: number;
}

interface Box {
	readonly left: number;
	readonly top: number;
	readonly right: number;
	readonly bottom: number;
}

let server: http.Server;
let url = "";
let settings: Settings;
let tool: BrowserTool;
const TAB = `natural-${process.pid}`;

async function run(code: string): Promise<string> {
	const result = await tool.execute("run", { action: "run", name: TAB, code });
	return result.content.map(part => (part.type === "text" ? part.text : "")).join("\n");
}

async function load(): Promise<void> {
	await run(`await tab.goto(${JSON.stringify(url)});`);
}

/** Run `steps` and return the events the page recorded while they ran. */
async function record(steps: string): Promise<Recorded[]> {
	return JSON.parse(
		await run(`await tab.evaluate(() => { log.length = 0; });
${steps}
return await tab.evaluate(() => log);`),
	);
}

async function boxOf(id: string): Promise<Box> {
	// A DOMRect's fields are getters, which a value returned from the page does not carry: read them there.
	return JSON.parse(
		await run(
			`return await tab.evaluate(() => { const r = document.getElementById(${JSON.stringify(id)}).getBoundingClientRect(); return { left: r.left, top: r.top, right: r.right, bottom: r.bottom }; });`,
		),
	);
}

/** Run `steps` with `browser.naturalInput` set to `on`, then set it back on. */
async function withNaturalInput<T>(on: boolean, steps: () => Promise<T>): Promise<T> {
	settings.set("browser.naturalInput", on);
	try {
		return await steps();
	} finally {
		settings.set("browser.naturalInput", true);
	}
}

function within(value: number, [low, high]: readonly [number, number]): boolean {
	return value >= low && value <= high;
}

function inside(box: Box, point: Recorded): boolean {
	const { x = Number.NaN, y = Number.NaN } = point;
	return x >= box.left && x <= box.right && y >= box.top && y <= box.bottom;
}

/** The pointer moves between `from` (exclusive) and `to` (exclusive), indices into `log`. */
function movesBetween(log: readonly Recorded[], from: number, to: number): Recorded[] {
	return log.slice(from + 1, to).filter(event => event.type === "pointermove");
}

/** How far the farthest of `points` lies off the straight line from `start` to `end`. */
function deviation(start: Recorded, end: Recorded, points: readonly Recorded[]): number {
	const [x0, y0, x1, y1] = [start.x ?? 0, start.y ?? 0, end.x ?? 0, end.y ?? 0];
	const length = Math.hypot(x1 - x0, y1 - y0);
	return Math.max(
		0,
		...points.map(point => Math.abs((x1 - x0) * (y0 - (point.y ?? 0)) - (x0 - (point.x ?? 0)) * (y1 - y0)) / length),
	);
}

/** Each character key's hold, and the pause from the previous character key's release to its press. */
function keyTimings(log: readonly Recorded[]): Array<{ key: string; shift: boolean; holdMs: number; gapMs?: number }> {
	const keys = log.filter(event => (event.type === "keydown" || event.type === "keyup") && event.key !== "Shift");
	const timings: Array<{ key: string; shift: boolean; holdMs: number; gapMs?: number }> = [];
	let released: number | undefined;
	for (let index = 0; index < keys.length; index++) {
		const down = keys[index]!;
		if (down.type !== "keydown") continue;
		const up = keys.slice(index + 1).find(event => event.type === "keyup" && event.key === down.key);
		if (!up) throw new Error(`no keyup for ${down.key}`);
		timings.push({
			key: down.key ?? "",
			shift: down.shift === true,
			holdMs: up.t - down.t,
			gapMs: released === undefined ? undefined : down.t - released,
		});
		released = up.t;
	}
	return timings;
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
	settings = Settings.isolated({ "browser.headless": true });
	const session: ToolSession = {
		cwd: process.cwd(),
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings,
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

describe.skipIf(!CHROMIUM_AVAILABLE)("with natural input on", () => {
	it("travels along a bent path to a point inside the element, rests, and presses the point it arrived at", async () => {
		await load();
		const log = await record('await tab.click("#a"); await tab.click("#b");');
		const b = await boxOf("b");
		const downs = log.flatMap((event, index) => (event.type === "mousedown" ? [index] : []));
		const ups = log.flatMap((event, index) => (event.type === "mouseup" ? [index] : []));
		expect(downs.map(index => log[index]!.target)).toEqual(["a", "b"]);
		expect(log.filter(event => event.type === "click").map(event => event.target)).toEqual(["a", "b"]);
		const [firstDown, secondDown] = downs.map(index => log[index]!);
		const moves = movesBetween(log, ups[0]!, downs[1]!);
		const last = moves.at(-1)!;
		expect(moves.length).toBeGreaterThanOrEqual(MOVES_SEEN);
		// A mouse event's coordinates are whole pixels, rounded through the device scale; a pointer event's are not.
		expect(Math.abs((last.x ?? 0) - (secondDown!.x ?? 0))).toBeLessThanOrEqual(1);
		expect(Math.abs((last.y ?? 0) - (secondDown!.y ?? 0))).toBeLessThanOrEqual(1);
		expect(inside(b, secondDown!)).toBe(true);
		const distance = Math.hypot(
			(secondDown!.x ?? 0) - (firstDown!.x ?? 0),
			(secondDown!.y ?? 0) - (firstDown!.y ?? 0),
		);
		expect(deviation(firstDown!, secondDown!, moves.slice(0, -1))).toBeGreaterThanOrEqual(0.01 * distance);
		const travel = last.t - moves[0]!.t;
		expect(travel).toBeGreaterThanOrEqual(NATURAL_INPUT.moveMs[0] / 2);
		expect(travel).toBeLessThanOrEqual(NATURAL_INPUT.moveMs[1] + LATE_MS);
		const rest = secondDown!.t - last.t;
		expect(rest).toBeGreaterThanOrEqual(NATURAL_INPUT.dwellMs[0] - EARLY_MS);
		expect(rest).toBeLessThanOrEqual(NATURAL_INPUT.dwellMs[1] + LATE_MS);
		for (const [index, down] of downs.entries()) {
			const hold = log[ups[index]!]!.t - log[down]!.t;
			expect(hold).toBeGreaterThanOrEqual(NATURAL_INPUT.holdMs[0] - EARLY_MS);
			expect(hold).toBeLessThanOrEqual(NATURAL_INPUT.holdMs[1] + LATE_MS);
		}
	}, 60_000);

	it("presses only the element where its box holds points that are not its own, and not always at one point", async () => {
		await load();
		const log = await record('for (let i = 0; i < 16; i++) await tab.click("#shape");');
		const downs = log.filter(event => event.type === "mousedown");
		expect(downs.length).toBe(16);
		expect(downs.filter(event => event.target !== "shape")).toEqual([]);
		expect(new Set(downs.map(event => `${event.x},${event.y}`)).size).toBeGreaterThan(1);
	}, 60_000);

	it("hovers along the same kind of travel and presses nothing", async () => {
		await load();
		const log = await record('await tab.click("#a"); await (await tab.waitFor("#b")).hover();');
		const b = await boxOf("b");
		const up = log.findIndex(event => event.type === "mouseup");
		const moves = movesBetween(log, up, log.length);
		expect(moves.length).toBeGreaterThanOrEqual(MOVES_SEEN);
		expect(inside(b, moves.at(-1)!)).toBe(true);
		expect(log.filter(event => event.type === "mousedown").length).toBe(1);
	}, 60_000);

	it("types each key down and up with a hold and a pause in their ranges, Shift under a capital", async () => {
		await load();
		const log = await record('await tab.type("#field", "Hi there");');
		const timings = keyTimings(log);
		expect(timings.map(timing => timing.key).join("")).toBe("Hi there");
		expect(timings[0]!.shift).toBe(true);
		const shiftDown = log.findIndex(event => event.type === "keydown" && event.key === "Shift");
		const firstKey = log.findIndex(event => event.type === "keydown" && event.key === "H");
		expect(shiftDown).toBeGreaterThanOrEqual(0);
		expect(shiftDown).toBeLessThan(firstKey);
		for (const { holdMs, gapMs } of timings) {
			expect(within(holdMs, [NATURAL_INPUT.keyHoldMs[0] - EARLY_MS, NATURAL_INPUT.keyHoldMs[1] + LATE_MS])).toBe(
				true,
			);
			if (gapMs === undefined) continue;
			expect(within(gapMs, [NATURAL_INPUT.keyGapMs[0] - EARLY_MS, NATURAL_INPUT.keyGapMs[1] + LATE_MS])).toBe(true);
		}
		expect(log.filter(event => event.type === "input").length).toBe(8);
		expect(await run('return await tab.evaluate(() => document.getElementById("field").value);')).toBe("Hi there");
	}, 60_000);

	it("fills a short value key by key, and a long or empty one in one insertion, the tracker ending on each", async () => {
		await load();
		const short = await record('await tab.fill("#field", "short value");');
		const timings = keyTimings(short);
		expect(timings.map(timing => timing.key).join("")).toBe("short value");
		for (const { holdMs, gapMs } of timings) {
			expect(within(holdMs, [NATURAL_INPUT.keyHoldMs[0] - EARLY_MS, NATURAL_INPUT.keyHoldMs[1] + LATE_MS])).toBe(
				true,
			);
			if (gapMs === undefined) continue;
			expect(within(gapMs, [NATURAL_INPUT.keyGapMs[0] - EARLY_MS, NATURAL_INPUT.keyGapMs[1] + LATE_MS])).toBe(true);
		}
		expect(short.filter(event => event.type === "input").length).toBe(11);
		const long = "a value long enough that a person pastes it";
		const pasted = await record(`await tab.fill("#field", ${JSON.stringify(long)});`);
		expect(pasted.filter(event => event.type === "keydown")).toEqual([]);
		expect(pasted.filter(event => event.type === "input").map(event => event.inputType)).toEqual(["insertText"]);
		const cleared = await record('await tab.fill("#field", "");');
		expect(cleared.filter(event => event.type === "keydown")).toEqual([]);
		expect(cleared.filter(event => event.type === "input").length).toBe(1);
		const state = JSON.parse(
			await run(
				'return { value: await tab.evaluate(() => document.getElementById("field").value), changes: await tab.evaluate(() => changes) };',
			),
		);
		const typed = Array.from("short value", (_, index) => "short value".slice(0, index + 1));
		expect(state).toEqual({ value: "", changes: [...typed, long, ""] });
	}, 60_000);

	it("drags along a bent path that speeds up and slows down, and drops on the target", async () => {
		await load();
		const log = await record('await tab.drag("#src", "#dst");');
		const [src, dst] = [await boxOf("src"), await boxOf("dst")];
		const down = log.findIndex(event => event.type === "mousedown");
		const up = log.findIndex(event => event.type === "mouseup");
		expect(inside(src, log[down]!)).toBe(true);
		expect(inside(dst, log[up]!)).toBe(true);
		const held = movesBetween(log, down, up).filter(event => event.buttons === 1);
		expect(held.length).toBeGreaterThanOrEqual(MOVES_SEEN);
		// Speeds between the held moves only: the hold on the start before the first move is no part of the travel.
		const speeds = held.slice(1).map((point, index) => {
			const before = held[index]!;
			return Math.hypot((point.x ?? 0) - (before.x ?? 0), (point.y ?? 0) - (before.y ?? 0)) / (point.t - before.t);
		});
		const peak = Math.max(...speeds);
		expect(speeds[0]!).toBeLessThan(peak);
		expect(speeds.at(-1)!).toBeLessThan(peak);
		expect(deviation(log[down]!, held.at(-1)!, held.slice(0, -1))).toBeGreaterThan(2);
		const span = log[up]!.t - log[down]!.t;
		expect(span).toBeGreaterThanOrEqual(NATURAL_INPUT.dragHoldMs[0] + NATURAL_INPUT.dragMs[0] - EARLY_MS);
		expect(span).toBeLessThanOrEqual(
			NATURAL_INPUT.dragHoldMs[1] + NATURAL_INPUT.dragMs[1] + NATURAL_INPUT.dwellMs[1] + LATE_MS,
		);
	}, 60_000);

	it("scrolls an element off-screen into view with wheel notches before pressing it", async () => {
		await load();
		const log = await record('await tab.click("#far");');
		const wheels = log.filter(event => event.type === "wheel");
		const down = log.findIndex(event => event.type === "mousedown");
		expect(log[down]?.target).toBe("far");
		expect(wheels.length).toBeGreaterThanOrEqual(2);
		expect(log.findLastIndex(event => event.type === "wheel")).toBeLessThan(down);
		// Chromium reports a wheel event's delta divided by the emulated device scale, and scrolls the whole
		// notch: the page scrolled by the wheel alone when its scroll is the notches it was sent.
		const { scrollY, scale } = JSON.parse(
			await run("return await tab.evaluate(() => ({ scrollY, scale: devicePixelRatio }));"),
		);
		const notches = wheels.map(event => ((event.dy ?? 0) * scale) / NATURAL_INPUT.wheelNotchPx);
		expect(notches.every(count => count >= 1 && Math.abs(count - Math.round(count)) < 0.01)).toBe(true);
		expect(scrollY).toBe(Math.round(notches.reduce((sum, count) => sum + count, 0)) * NATURAL_INPUT.wheelNotchPx);
	}, 60_000);
});

describe.skipIf(!CHROMIUM_AVAILABLE)("with natural input off for a run", () => {
	it("moves once to the press point and presses at once, in the same tab the setting was on for", async () => {
		await load();
		await run('await tab.click("#a");');
		const log = await withNaturalInput(false, () => record('await tab.click("#b");'));
		const down = log.findIndex(event => event.type === "mousedown");
		const up = log.findIndex(event => event.type === "mouseup");
		const moves = movesBetween(log, -1, down);
		expect(moves.length).toBe(1);
		expect({ x: moves[0]!.x, y: moves[0]!.y }).toEqual({ x: log[down]!.x, y: log[down]!.y });
		const hold = log[up]!.t - log[down]!.t;
		expect(hold).toBeGreaterThanOrEqual(0);
		expect(hold).toBeLessThan(NATURAL_INPUT.holdMs[0]);
		// The next run has the setting on again, and travels.
		const after = await record('await tab.click("#a");');
		expect(
			movesBetween(
				after,
				-1,
				after.findIndex(event => event.type === "mousedown"),
			).length,
		).toBeGreaterThanOrEqual(MOVES_SEEN);
	}, 60_000);

	it("types keys with no pause, fills a short value in one insertion, and scrolls with no wheel", async () => {
		await load();
		const [typed, filled, scrolled] = await withNaturalInput(false, async () => [
			await record('await tab.type("#field", "abc");'),
			await record('await tab.fill("#field", "short value");'),
			await record('await tab.click("#far");'),
		]);
		for (const { holdMs, gapMs } of keyTimings(typed)) {
			expect(within(holdMs, [0, NATURAL_INPUT.keyHoldMs[0] - 1])).toBe(true);
			if (gapMs !== undefined) expect(within(gapMs, [0, NATURAL_INPUT.keyGapMs[0] - 1])).toBe(true);
		}
		expect(filled.filter(event => event.type === "keydown")).toEqual([]);
		expect(filled.filter(event => event.type === "input").length).toBe(1);
		expect(scrolled.filter(event => event.type === "wheel")).toEqual([]);
		expect(scrolled.find(event => event.type === "mousedown")?.target).toBe("far");
	}, 60_000);
});
