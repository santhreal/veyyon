/**
 * The composer's quiet footline keeps the directory and the branch when a draft's token readout
 * is sharing the row, and the right group stays on the right edge when they are gone.
 *
 * THE DEFECT. Two, from one frame: a 78-column terminal with plan mode, an approval rung and a
 * draft's `~21 tok` estimate pinned to the location line's right edge.
 *
 *   1. The location zone was painted EMPTY beside 21 columns of slack. The zone was fitted once,
 *      against the budget left by the widest right group, and a `locationShortened` latch then
 *      stopped it being fitted again. Two parts of that group were shed afterwards -- the session
 *      name and the context gauge -- and the cells they freed went nowhere. The row showed a
 *      model, a mode and a subagent count, and nothing at all about where the session was.
 *   2. What was left rendered against the LEFT margin. The right group was placed at
 *      `budget - width(right)` only when a location survived to be placed beside; with the zone
 *      empty the offset was zero and the state chips sat in the far left corner of a wide row.
 *
 * THE CLASS. Fit decisions that latch. Any budget computed once, before the loop that changes the
 * quantity it was computed from, prices the row at a width it no longer has -- and the failure is
 * silent, because a zone that renders nothing raises nothing. Its sibling is the layout constant
 * that is only correct for the case the author had on screen: an offset derived from a neighbour
 * is wrong the moment the neighbour is absent, which is exactly when nobody looks.
 *
 * HOW THIS SUITE CLOSES THE CLASS.
 *   - The reported frame is one case, not the contract. The row is swept from 130 columns down to
 *     6, and a zone left blank has to justify itself three ways: nothing the floor may spend is
 *     still on the row, the cells standing in front of the right group are fewer than the
 *     narrowest zone this same sweep painted, and the blanking is the narrow END of the row
 *     rather than a band in the middle of it. A latch anywhere in either ladder leaves cells in
 *     front of the group and fails all three.
 *   - The running-subagent count is NOT among what the floor may spend -- it is the part the row
 *     sheds last of everything -- so at six and seven columns the whole row is the count and no
 *     zone is possible there. That band is the only place a blank zone is right, and the three
 *     bounds above are what confine it to it.
 *   - What the floor may spend is read from `FLOOR_SPENDABLE` at run time rather than listed, so
 *     a part added to that set is covered on the first run. Removing one is the ranking suite's
 *     job: it pins the set by equality, which is what a run-time read cannot see.
 *   - The empty middle is swept too, over three presets whose right groups end on different
 *     parts, so a zone left at a width the row has since outgrown is caught whether or not the
 *     floor ladder had anything to sell.
 *   - The right edge is asserted on the row where the defect showed: no location zone at all,
 *     which is the `compact` preset outside a repository. The fixture asserts that no width in
 *     that sweep painted a zone, since an alignment claim about a case that never occurred is
 *     worth nothing.
 *
 * WHAT IT DOES NOT CATCH. The ORDER the floor spends in is the ranking suite's contract, not this
 * one -- here a spend is only ever observed as an absence. Nothing here looks inside a segment:
 * the clip mark's colour and the cut's boundary belong to the clip suite. And the fixture is one
 * cwd and one branch, so it pins the shape of the ladder rather than every path it can hold.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { QuietSegmentBounds } from "@veyyon/coding-agent/modes/components/status-line/component";
import {
	FLOOR_SPENDABLE,
	MIN_LOCATION_PART,
	StatusLineComponent,
} from "@veyyon/coding-agent/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { stripAnsi } from "@veyyon/utils";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

/** The branch the reported frame was recorded on. */
const BRANCH = "fix/statusline-model-retention-long-path";

/** The two location parts, and the third id the zone can hold. */
const LOCATION_SEGMENT_IDS = ["git", "path", "pr"];

/** The estimate the composer pins to the location line while a draft is being typed. */
const DRAFT_READOUT = "~21 tok";

/** The width of the reported frame: 960 device pixels of the recorded terminal. */
const REPORTED_WIDTH = 78;

const makeTempDir = useTrackedTempDirs("veyyon-statusline-draft-floor-");

let deepCwd = "";
/** A directory that is not a repository, so `compact` -- which has no `path` -- shows no zone. */
let plainCwd = "";

function makeSession(cwd: () => string): AgentSession {
	const model = { id: "Qwen2.5 1.5B (local)", name: "Qwen2.5 1.5B (local)", contextWindow: 128000 };
	return {
		messages: [],
		model,
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 16000, contextWindow: 128000 }),
		state: { messages: [], model },
		sessionManager: {
			getCwd: cwd,
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
			getSessionName: () => "ingest-normalizer-session",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => undefined,
		getRunningNonTaskJobCount: () => 0,
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		// The rung in the frame: `! YOLO`, which widens the mode part to `! YOLO · Plan`.
		isApprovalBypassed: () => true,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

/** The component in the state the frame was recorded in: plan mode, a rung, a draft estimate. */
function draftFootline(): StatusLineComponent {
	const statusLine = new StatusLineComponent(makeSession(() => deepCwd));
	statusLine.setPlanModeStatus({ enabled: true, paused: false });
	return statusLine;
}

/**
 * A row that has no location zone at all, which is the `compact` preset outside a repository:
 * its location segments are `git` and `pr`, and neither renders. Nothing here is contrived --
 * this is what an operator on `compact` sees in any directory that is not checked out.
 */
function footlineWithNoLocation(): StatusLineComponent {
	const statusLine = new StatusLineComponent(makeSession(() => plainCwd));
	statusLine.updateSettings({ preset: "compact" } as never);
	statusLine.setPlanModeStatus({ enabled: true, paused: false });
	return statusLine;
}

/**
 * A row whose LAST surviving right-group part is one the floor may not spend. `minimal` puts
 * `session_name`, `mode` and `context_pct` on the right, and of those only the gauge is
 * spendable, so once it is gone the floor ladder has nothing and the fit loop's own re-fit is
 * the only thing standing between the zone and a stale width.
 */
function footlineEndingOnAMode(): StatusLineComponent {
	const statusLine = new StatusLineComponent(makeSession(() => deepCwd));
	statusLine.updateSettings({ preset: "minimal" } as never);
	statusLine.setPlanModeStatus({ enabled: true, paused: false });
	return statusLine;
}

/**
 * A row that runs out of spendable parts BEFORE the fit ladder is done shedding. `compact` puts
 * the model and the mode in the right group and has no subagent count, so by the time the
 * ranking gets to the model chip the gauge and the session name are already gone and the floor
 * ladder has nothing left to sell. The cells the chip frees reach the zone only if the fit
 * ladder hands them over itself, which is the case the reported defect was a symptom of: the
 * zone was fitted against a budget of zero and never asked again.
 */
function footlineWithoutASpendableTail(): StatusLineComponent {
	const statusLine = new StatusLineComponent(makeSession(() => deepCwd));
	statusLine.updateSettings({ preset: "compact" } as never);
	statusLine.setPlanModeStatus({ enabled: true, paused: false });
	return statusLine;
}

function renderedIds(bounds: readonly QuietSegmentBounds[]): Set<string> {
	const ids = new Set<string>();
	for (const slot of bounds) {
		if (slot.end > slot.start) ids.add(slot.id);
	}
	return ids;
}

/** The right edge of the location zone, in columns, or 0 when the zone painted nothing. */
function locationEnd(bounds: readonly QuietSegmentBounds[]): number {
	let end = 0;
	for (const slot of bounds) {
		if (slot.end > slot.start && LOCATION_SEGMENT_IDS.includes(slot.id)) end = Math.max(end, slot.end);
	}
	return end;
}

/** The right edge of the whole row: the last column any segment reaches. */
function rowEnd(bounds: readonly QuietSegmentBounds[]): number {
	let end = 0;
	for (const slot of bounds) {
		if (slot.end > slot.start) end = Math.max(end, slot.end);
	}
	return end;
}

/**
 * The cells a blank zone could have been painted in: the columns standing empty in front of the
 * right group, less the two-cell gap that would have separated the zone from it. The gap is what
 * makes six columns honestly blank -- four of them hold the count, and the two in front of it
 * are the gap, not room.
 */
function roomForTheZone(bounds: readonly QuietSegmentBounds[]): number {
	let start = Number.POSITIVE_INFINITY;
	for (const slot of bounds) {
		if (slot.end > slot.start && !LOCATION_SEGMENT_IDS.includes(slot.id)) start = Math.min(start, slot.start);
	}
	return start === Number.POSITIVE_INFINITY ? 0 : Math.max(0, start - 2);
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);

	// A path deep enough that the zone is under pressure at every width in the sweep, in a repo
	// whose HEAD names the branch from the frame. `git.head.resolveSync` reads `.git/HEAD`, so
	// this is the whole fixture: no `git init`, no subprocess.
	deepCwd = path.join(makeTempDir(), "platform-services", "ingest-pipeline", "normalizer");
	mkdirSync(path.join(deepCwd, ".git"), { recursive: true });
	writeFileSync(path.join(deepCwd, ".git", "HEAD"), `ref: refs/heads/${BRANCH}\n`);
	plainCwd = path.join(makeTempDir(), "not-a-repository");
	mkdirSync(plainCwd, { recursive: true });
});

describe("a narrow footline spends a readout before it blanks the location", () => {
	it("still names the directory and the branch at the width the defect was reported at", () => {
		const statusLine = draftFootline();
		const line = statusLine.renderQuietLine(REPORTED_WIDTH, { locationRight: DRAFT_READOUT });
		expect(line).not.toBeNull();
		const ids = renderedIds(statusLine.getQuietSegmentBounds());

		// Both halves of the location, which is what the frame was missing.
		expect([...ids].sort()).toEqual(expect.arrayContaining(["git", "path"]));
		// The model chip is what the row exists to retain, and the rungs say what the next
		// keystroke does; neither is what a wider directory is paid for.
		expect([...ids]).toContain("model");
		expect([...ids]).toContain("mode");
		// The estimate is re-derived on the next keystroke, so it is what the floor spent.
		expect([...ids]).not.toContain("location_right");
		// And the readout's cells went to the zone rather than to slack in the middle.
		expect(stripAnsi(line ?? "")).toContain("normalizer");
	});

	it("keeps a directory on the row wherever the row has room for one", () => {
		const statusLine = draftFootline();
		const spendable = new Set(Object.keys(FLOOR_SPENDABLE));
		const blanked: { width: number; text: string; room: number; unspent: string[] }[] = [];
		const painted: number[] = [];
		let narrowestZone = Number.POSITIVE_INFINITY;
		let sawTheFloorSpend = false;

		for (let width = 130; width >= 6; width--) {
			const line = statusLine.renderQuietLine(width, { locationRight: DRAFT_READOUT });
			if (line === null) continue;
			const bounds = statusLine.getQuietSegmentBounds();
			const ids = renderedIds(bounds);
			if (!ids.has("location_right")) sawTheFloorSpend = true;
			const zone = locationEnd(bounds);
			if (zone > 0) {
				painted.push(width);
				narrowestZone = Math.min(narrowestZone, zone);
				// The cells a clipped zone leaves in front of the group are the empty middle, and
				// the sweep over three presets below owns that bound.
				continue;
			}
			blanked.push({
				width,
				text: stripAnsi(line),
				room: roomForTheZone(bounds),
				unspent: [...ids].filter(id => spendable.has(id)).sort(),
			});
		}

		// Anything re-readable still on the row is a cell the zone was owed and did not get.
		expect(blanked.filter(row => row.unspent.length > 0)).toEqual([]);
		// The sweep has to have painted a zone somewhere, or the bound below means nothing and a
		// row that blanked the zone at every width would pass.
		expect(narrowestZone).toBeLessThan(Number.POSITIVE_INFINITY);
		// The room left standing in front of the group is the reported defect's signature: it
		// blanked the zone with twenty-one cells of it and a token estimate still on the row. A
		// blank is honest only where less of it is left than the narrowest zone this row painted.
		expect(blanked.filter(row => row.room >= narrowestZone)).toEqual([]);
		// And it is the narrow end of the row, not a band with painted zones below it.
		const widestBlank = blanked.reduce((widest, row) => Math.max(widest, row.width), 0);
		expect(painted.filter(width => width < widestBlank)).toEqual([]);
		// And the zone was bought, not merely never squeezed.
		expect(sawTheFloorSpend).toBe(true);
	});

	it("ends the row on the right edge when the location zone is empty", () => {
		const statusLine = footlineWithNoLocation();
		const offenders: { width: number; end: number; text: string }[] = [];
		let sawAZone = false;

		for (let width = 130; width >= 6; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const bounds = statusLine.getQuietSegmentBounds();
			if (locationEnd(bounds) > 0) sawAZone = true;
			// One column is reserved at the right, so the last segment ends there and nowhere
			// short of it. A row whose offset was derived from a location that is not there is
			// placed at column zero, which is where the state chips were found.
			const end = rowEnd(bounds);
			if (end !== width - 1) offenders.push({ width, end, text: stripAnsi(line) });
		}

		expect(offenders).toEqual([]);
		// The fixture has to actually be the case it claims: a preset with no `path`, outside a
		// repository, so no width in the sweep painted a zone.
		expect(sawAZone).toBe(false);
	});

	it("never leaves a location part under its readable width while a readout is still on the row", () => {
		const statusLine = draftFootline();
		const spendable = new Set(Object.keys(FLOOR_SPENDABLE));
		const offenders: { width: number; text: string; thin: string[]; unspent: string[] }[] = [];
		let sawAThinPart = false;

		for (let width = 130; width >= 6; width--) {
			const line = statusLine.renderQuietLine(width, { locationRight: DRAFT_READOUT });
			if (line === null) continue;
			const live = statusLine.getQuietSegmentBounds().filter(slot => slot.end > slot.start);
			const thin = live
				.filter(slot => LOCATION_SEGMENT_IDS.includes(slot.id) && slot.end - slot.start < MIN_LOCATION_PART)
				.map(slot => slot.id);
			if (thin.length === 0) continue;
			sawAThinPart = true;
			// `…izer  ·  …g-path` is two fragments that each read as a name in their own right and
			// name neither the directory nor the branch. It is the answer of last resort, so it is
			// only allowed once the row has nothing re-readable left to pay with.
			const unspent = live
				.map(slot => slot.id)
				.filter(id => spendable.has(id))
				.sort();
			if (unspent.length > 0) offenders.push({ width, text: stripAnsi(line), thin, unspent });
		}

		expect(offenders).toEqual([]);
		// The sweep has to reach the floor, or the implication above was never evaluated.
		expect(sawAThinPart).toBe(true);
	});

	// Two cells is the smallest gap the assembly puts between the zones. A clip that snapped to a
	// name boundary gives up cells on top of that -- at most four per part, and the zone holds
	// two -- so this is the widest empty middle a clipped row can honestly have. The defect
	// showed twenty-one.
	const WIDEST_HONEST_MIDDLE = 2 + 4 + 4;

	it("gives the cells a shed frees to the location instead of leaving them in the middle", () => {
		const offenders: { preset: string; width: number; gap: number; text: string }[] = [];
		const clipped: string[] = [];

		for (const [preset, statusLine] of [
			["compact", footlineWithoutASpendableTail()],
			["default", draftFootline()],
			["minimal", footlineEndingOnAMode()],
		] as const) {
			for (let width = 130; width >= 6; width--) {
				const line = statusLine.renderQuietLine(width, { locationRight: DRAFT_READOUT });
				if (line === null) continue;
				const live = statusLine.getQuietSegmentBounds().filter(slot => slot.end > slot.start);
				const zone = live.filter(slot => LOCATION_SEGMENT_IDS.includes(slot.id));
				const group = live.filter(slot => !LOCATION_SEGMENT_IDS.includes(slot.id));
				if (zone.length === 0 || group.length === 0) continue;
				const plain = stripAnsi(line);
				// A zone that is whole has no claim on the middle; only a clipped one does.
				if (!plain.includes("…")) continue;
				if (!clipped.includes(preset)) clipped.push(preset);
				const gap = Math.min(...group.map(slot => slot.start)) - Math.max(...zone.map(slot => slot.end));
				if (gap > WIDEST_HONEST_MIDDLE) offenders.push({ preset, width, gap, text: plain });
			}
		}

		expect(offenders).toEqual([]);
		// Every row has to have been under the clip, or it proved nothing. The three presets put
		// different tails on the right group -- `compact` ends on the model chip and a mode,
		// `minimal` on a mode, `default` on a subagent count -- so between them the sweep covers
		// a row the floor ladder can pay for and rows where it has nothing to sell.
		expect(clipped.sort()).toEqual(["compact", "default", "minimal"]);
	});
});
