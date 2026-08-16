/**
 * WHY THIS SUITE EXISTS
 *
 * The context gauge in the composer footline used to teleport. A turn revises
 * the estimate in one step — a hundred-thousand-character tool result lands as
 * a single event — so the gauge went from `70% left` to `61% left` between two
 * frames and said only "it is 61 now". `MOTION.settle` had named this exact
 * case ("a value being nudged, e.g. a progress or context bar") since the
 * motion clock landed, and nothing in the product used it: it was vocabulary
 * with no speaker.
 *
 * The defect class this closes is wider than "the gauge does not animate": it
 * is TWO READERS OF ONE NUMBER DRIFTING APART. The bar, the percentage and the
 * usage hue are three renderings of one value; animate any one of them from its
 * own copy and the footline shows a bar at the new reading beside a number at
 * the old one. So the seam is single — `#settleContextPercent`, applied after
 * every source of the number has had its say — and the tests below check the
 * three readings against each other, frame by frame, rather than checking that
 * something moved.
 *
 * What it does NOT catch: a fourth reader added downstream of the segment
 * context (a new segment computing its own percentage from `contextTokens` and
 * `contextLimit` rather than reading `contextPercent`) would drift and no test
 * here would see it. The sweep over the shipped presets catches a new PRESET
 * that renders the gauge, not a new SEGMENT that recomputes it.
 *
 * Nor does it catch the wiring itself going away: these tests hand the gauge a
 * repaint of their own, so an `interactive-mode` that stops calling
 * `watchContextGauge` leaves every test here green and the shipped gauge static.
 * That one is held by the recorded before/after arm in `proof/`, not by a test.
 */

import { beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { MotionClock, SettleValue } from "@veyyon/tui";
import { Settings } from "../src/config/settings";
import { settings } from "../src/config/settings-instance";
import { StatusLineComponent } from "../src/modes/components/status-line/component";
import {
	getContextUsageLevel,
	getContextUsageThemeColor,
} from "../src/modes/components/status-line/context-thresholds";
import { STATUS_LINE_PRESETS } from "../src/modes/components/status-line/presets";
import { renderContextBar } from "../src/modes/components/status-line/segments";
import { getThemeByName, setThemeInstance, theme } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";

const WINDOW = 200_000;
const WIDTH = 140;
const FRAME_MS = 1000 / 60;
/** Long enough for any spring in MOTION to settle; short enough that a hang fails. */
const TRAVEL_BUDGET_FRAMES = 240;

interface FakeSession {
	session: AgentSession;
	/** Move the reading, the way a turn does: new usage plus a revision bump. */
	spend(tokens: number): void;
	/** Take the limit away, which is what makes the reading unknown. */
	forgetWindow(): void;
}

function makeSession(startTokens: number, startWindow: number = WINDOW): FakeSession {
	let tokens = startTokens;
	let window = startWindow;
	let revision = 0;
	const session = {
		messages: [],
		get model() {
			return { contextWindow: window };
		},
		get contextUsageRevision() {
			return revision;
		},
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		getContextUsage: () => (window > 0 ? { tokens, contextWindow: window } : undefined),
		get state() {
			return { messages: [], model: { contextWindow: window } };
		},
		sessionManager: {
			getUsageStatistics: () => ({
				input: 0,
				output: 0,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 0,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 0,
				cost: 0,
				tokensPerSecond: null,
			}),
			getSessionName: () => "gauge-session",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
	return {
		session,
		spend(next: number) {
			tokens = next;
			revision++;
		},
		forgetWindow() {
			window = 0;
			revision++;
		},
	};
}

function tokensFor(usedPercent: number): number {
	return Math.round((usedPercent / 100) * WINDOW);
}

/** What the footline says the gauge reads: the whole number in `NN% left`. */
function percentLeft(line: string | null): number {
	if (line === null) throw new Error("footline rendered nothing");
	const match = /(\d+)% left/.exec(line);
	if (!match) throw new Error(`no gauge in footline: ${JSON.stringify(line)}`);
	return Number(match[1]);
}

/** Filled cells in the eight-cell bar, which is the second reading of the value. */
function filledCells(line: string | null): number {
	if (line === null) throw new Error("footline rendered nothing");
	return (line.match(/▰/g) ?? []).length;
}

/**
 * Every reading in one frame, so a test can assert them against each other
 * rather than against a remembered number.
 */
function readGauge(statusLine: StatusLineComponent): { pctLeft: number; cells: number; line: string } {
	const line = statusLine.renderQuietLine(WIDTH);
	if (line === null) throw new Error("footline rendered nothing");
	return { pctLeft: percentLeft(line), cells: filledCells(line), line };
}

/**
 * The three readings agree when there is ONE value they could all have come
 * from. The displayed percentage is rounded, so the value is somewhere in a
 * one-point interval; the bar and the hue must be what that interval produces.
 */
function assertReadingsAgree(frame: { pctLeft: number; cells: number; line: string }): void {
	const candidates = [frame.pctLeft - 0.5, frame.pctLeft, frame.pctLeft + 0.5]
		.filter(left => left >= 0 && left <= 100)
		.map(left => 100 - left);
	const cells = candidates.map(used =>
		filledCells(renderContextBar(Math.max(0, 100 - used) / 100, "normal", 0, false)),
	);
	expect(cells).toContain(frame.cells);
	const hues = candidates.map(used => getContextUsageThemeColor(getContextUsageLevel(used)));
	const painted = hues.filter(hue => frame.line.includes(theme.fg(hue, `${frame.pctLeft}% left`)));
	expect(painted.length).toBeGreaterThan(0);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

beforeEach(() => {
	settings.set("display.transitions", "on");
});

describe("a context gauge travels to its new reading", () => {
	it("reports the raw reading, byte for byte, when no host wired a repaint into it", () => {
		const wired = makeSession(tokensFor(20));
		const bare = makeSession(tokensFor(20));
		const withGauge = new StatusLineComponent(wired.session);
		const withoutGauge = new StatusLineComponent(bare.session);
		const clock = new MotionClock();
		withGauge.watchContextGauge({ requestRender: () => {}, clock });

		expect(withGauge.renderQuietLine(WIDTH)).toBe(withoutGauge.renderQuietLine(WIDTH));

		wired.spend(tokensFor(60));
		bare.spend(tokensFor(60));
		// The wired one is mid-travel here; the bare one must be at the new
		// number on the very frame the spend landed.
		expect(percentLeft(withoutGauge.renderQuietLine(WIDTH))).toBe(40);
		expect(percentLeft(withGauge.renderQuietLine(WIDTH))).toBe(80);
	});

	it("lands the first reading instead of sweeping up to it", () => {
		const fake = makeSession(tokensFor(35));
		const statusLine = new StatusLineComponent(fake.session);
		const clock = new MotionClock();
		let frames = 0;
		statusLine.watchContextGauge({ requestRender: () => frames++, clock });

		expect(readGauge(statusLine).pctLeft).toBe(65);
		expect(clock.liveCount).toBe(0);
		expect(frames).toBe(0);
	});

	it("walks from the old reading to the new one and stops there", () => {
		const fake = makeSession(tokensFor(20));
		const statusLine = new StatusLineComponent(fake.session);
		const clock = new MotionClock();
		let frames = 0;
		statusLine.watchContextGauge({ requestRender: () => frames++, clock });
		expect(readGauge(statusLine).pctLeft).toBe(80);

		fake.spend(tokensFor(65));
		const walk: number[] = [readGauge(statusLine).pctLeft];
		let ticks = 0;
		while (clock.liveCount > 0 && ticks < TRAVEL_BUDGET_FRAMES) {
			clock.tick(++ticks * FRAME_MS);
			walk.push(readGauge(statusLine).pctLeft);
		}

		// It terminates, and inside the budget rather than creeping forever.
		expect(clock.liveCount).toBe(0);
		expect(ticks).toBeLessThan(TRAVEL_BUDGET_FRAMES);
		expect(frames).toBeGreaterThan(0);
		// It starts where it was, ends where it was sent, and never leaves the
		// interval between the two.
		expect(walk[0]).toBe(80);
		expect(walk.at(-1)).toBe(35);
		for (const reading of walk) {
			expect(reading).toBeLessThanOrEqual(80);
			expect(reading).toBeGreaterThanOrEqual(35);
		}
		// Monotone: a gauge that overshoots and comes back reads as a glitch.
		for (let i = 1; i < walk.length; i++) {
			expect(walk[i]!).toBeLessThanOrEqual(walk[i - 1]!);
		}
		// And it is a walk, not a jump with extra frames around it.
		expect(new Set(walk).size).toBeGreaterThan(4);
	});

	it("keeps the bar, the number and the hue on the same value in every frame of the travel", () => {
		const fake = makeSession(tokensFor(10));
		const statusLine = new StatusLineComponent(fake.session);
		const clock = new MotionClock();
		statusLine.watchContextGauge({ requestRender: () => {}, clock });
		readGauge(statusLine);

		// Across every threshold the hue has: 50, 70 and 90 percent used.
		fake.spend(tokensFor(95));
		const cellCounts = new Set<number>();
		const hues = new Set<string>();
		let ticks = 0;
		for (;;) {
			const frame = readGauge(statusLine);
			assertReadingsAgree(frame);
			cellCounts.add(frame.cells);
			hues.add(getContextUsageThemeColor(getContextUsageLevel(100 - frame.pctLeft)));
			if (clock.liveCount === 0 || ticks >= TRAVEL_BUDGET_FRAMES) break;
			clock.tick(++ticks * FRAME_MS);
		}

		expect(ticks).toBeLessThan(TRAVEL_BUDGET_FRAMES);
		// The bar emptied a cell at a time rather than in one step, and the heat
		// climbed with it — both read off the same travelling number.
		expect(cellCounts.size).toBeGreaterThan(4);
		expect(hues.size).toBeGreaterThan(2);
	});

	it("does not start a spring for a change no reading can show", () => {
		const fake = makeSession(tokensFor(40));
		const statusLine = new StatusLineComponent(fake.session);
		const clock = new MotionClock();
		let frames = 0;
		statusLine.watchContextGauge({ requestRender: () => frames++, clock });
		expect(readGauge(statusLine).pctLeft).toBe(60);

		// Two tenths of a point: neither the whole-number percentage nor an
		// eighth of the bar can move, so a frame spent on it is a frame wasted.
		fake.spend(tokensFor(40.2));
		expect(readGauge(statusLine).pctLeft).toBe(60);
		expect(clock.liveCount).toBe(0);
		expect(frames).toBe(0);
	});

	it("reports the raw reading while display.transitions is off, and picks motion back up when it returns", () => {
		const fake = makeSession(tokensFor(20));
		const statusLine = new StatusLineComponent(fake.session);
		const clock = new MotionClock();
		statusLine.watchContextGauge({ requestRender: () => {}, clock });
		readGauge(statusLine);

		settings.set("display.transitions", "off");
		fake.spend(tokensFor(70));
		expect(readGauge(statusLine).pctLeft).toBe(30);
		expect(clock.liveCount).toBe(0);

		// Back on: the next reading is a first sighting (the gauge forgot where
		// it was while motion was off), and the one after that travels.
		settings.set("display.transitions", "on");
		fake.spend(tokensFor(72));
		expect(readGauge(statusLine).pctLeft).toBe(28);
		expect(clock.liveCount).toBe(0);
		fake.spend(tokensFor(20));
		expect(readGauge(statusLine).pctLeft).toBe(28);
		expect(clock.liveCount).toBe(1);
	});

	it("lands rather than travels when the status line is re-pointed at another session", () => {
		const first = makeSession(tokensFor(20));
		const second = makeSession(tokensFor(85));
		const statusLine = new StatusLineComponent(first.session);
		const clock = new MotionClock();
		statusLine.watchContextGauge({ requestRender: () => {}, clock });
		expect(readGauge(statusLine).pctLeft).toBe(80);

		statusLine.setSession(second.session, "sub-1");
		// Another session's usage is not a change to this one's: sweeping 80 → 15
		// would animate a number that never moved.
		expect(readGauge(statusLine).pctLeft).toBe(15);
		expect(clock.liveCount).toBe(0);
	});

	it("has nothing to travel to when the reading is unknown", () => {
		const fake = makeSession(tokensFor(30));
		const statusLine = new StatusLineComponent(fake.session);
		const clock = new MotionClock();
		statusLine.watchContextGauge({ requestRender: () => {}, clock });
		expect(readGauge(statusLine).pctLeft).toBe(70);

		// The limit goes away under the same session — a model swap mid-session
		// leaves nothing to measure against, which is a null percentage rather
		// than a position on the gauge. Nothing about that is travelled to, and
		// the gauge must not answer with the last reading it happened to hold.
		fake.forgetWindow();
		const line = statusLine.renderQuietLine(WIDTH);
		expect(line).not.toBeNull();
		expect(line).toContain("? left");
		expect(clock.liveCount).toBe(0);

		// And when a limit comes back, that reading lands rather than sweeping
		// out of a value the gauge was never showing.
		fake.spend(tokensFor(45));
		statusLine.setSession(makeSession(tokensFor(45)).session, undefined);
		expect(readGauge(statusLine).pctLeft).toBe(55);
		expect(clock.liveCount).toBe(0);
	});

	it("travels on every shipped preset that renders the gauge", () => {
		const rendering = Object.keys(STATUS_LINE_PRESETS).filter(name => {
			const preset = STATUS_LINE_PRESETS[name as keyof typeof STATUS_LINE_PRESETS];
			return [...preset.leftSegments, ...preset.rightSegments].includes("context_pct");
		});
		// A preset that renders the gauge and is not covered here is a hole, so
		// the sweep is over what the table actually ships, not a list.
		expect(rendering.length).toBeGreaterThan(0);

		const travelled: string[] = [];
		for (const name of rendering) {
			const fake = makeSession(tokensFor(20));
			const statusLine = new StatusLineComponent(fake.session);
			statusLine.updateSettings({ preset: name as keyof typeof STATUS_LINE_PRESETS });
			const clock = new MotionClock();
			statusLine.watchContextGauge({ requestRender: () => {}, clock });
			expect(readGauge(statusLine).pctLeft).toBe(80);
			fake.spend(tokensFor(60));
			if (readGauge(statusLine).pctLeft === 80 && clock.liveCount === 1) travelled.push(name);
		}
		expect(travelled).toEqual(rendering);
	});

	it("stops asking for frames once the host is gone", () => {
		const fake = makeSession(tokensFor(20));
		const statusLine = new StatusLineComponent(fake.session);
		const clock = new MotionClock();
		let frames = 0;
		statusLine.watchContextGauge({ requestRender: () => frames++, clock });
		readGauge(statusLine);
		fake.spend(tokensFor(60));
		readGauge(statusLine);
		expect(clock.liveCount).toBe(1);

		statusLine.dispose();
		const after = frames;
		clock.tick(FRAME_MS);
		clock.tick(2 * FRAME_MS);
		expect(frames).toBe(after);
		// A disposed gauge is out of the way: the reading is the raw one again.
		expect(percentLeft(statusLine.renderQuietLine(WIDTH))).toBe(40);
	});
});

describe("the value underneath it", () => {
	it("keeps its velocity across a retarget instead of restarting the curve", () => {
		const clock = new MotionClock();
		const value = new SettleValue({ requestRender: () => {}, clock });
		value.set(0);
		value.set(100);
		for (let i = 1; i <= 5; i++) clock.tick(i * FRAME_MS);
		const beforeLastStep = value.value ?? 0;
		clock.tick(6 * FRAME_MS);
		const movingAt = value.value ?? 0;
		const speedBefore = movingAt - beforeLastStep;
		expect(speedBefore).toBeGreaterThan(0);

		// Retarget mid-flight, the way a streaming turn revises the estimate.
		value.set(50);
		clock.tick(7 * FRAME_MS);
		const speedAfter = (value.value ?? 0) - movingAt;
		// It carries its speed across the retarget. A spring restarted from rest
		// would have to accelerate from zero, so the frame after the revision
		// would crawl; a jump would already be at 50.
		expect(speedAfter).toBeGreaterThan(speedBefore * 0.5);
		expect(value.value).toBeLessThan(50);

		let ticks = 7;
		while (value.live && ticks < TRAVEL_BUDGET_FRAMES) clock.tick(++ticks * FRAME_MS);
		expect(value.value).toBe(50);
		expect(clock.liveCount).toBe(0);
	});

	it("lands every target immediately when motion is disabled", () => {
		const clock = new MotionClock();
		let frames = 0;
		const value = new SettleValue({ requestRender: () => frames++, enabled: false, clock });
		value.set(10);
		value.set(90);
		expect(value.value).toBe(90);
		expect(value.live).toBe(false);
		expect(clock.liveCount).toBe(0);
		expect(frames).toBe(0);
	});
});
