/**
 * The footline path is clipped from ONE end, and a click on it trades the model chip for room.
 *
 * THE DEFECT. Two independent mechanisms shortened the path from opposite ends. The
 * per-segment clamp (`clampPathLength`, at the preset's `maxLength`) prefixed an ellipsis and
 * kept the tail; the width-driven shortening in the shed loop appended one and kept the head.
 * A path wide enough to hit both came out clipped at both ends —
 * `…orm-services/ingest-pipeline/norm…` — which keeps neither the project the directory is
 * under nor the directory itself, and leaves a middle that names nothing a reader can place.
 *
 * WHICH END SURVIVES. The tail. A location reads from its right: the directory the session is
 * in, the branch checked out. The head is the project root every session under one project
 * shares, so it is the expendable end, and both clippers now cut it.
 *
 * THE CLASS. Two clippers on one string, disagreeing about which end is expendable. Any
 * further clipper added to the location zone reproduces it, in the same shape, on the same row.
 *
 * HOW THIS SUITE CLOSES THE CLASS. It does not assert on either clipper. It sweeps the width
 * and asserts the INVARIANT that survives any number of them: the rendered path slot never
 * ENDS with an ellipsis, and carries exactly one, at the front. A third clipper cutting from
 * the right fails this at whatever width it engages, without the suite knowing it exists. The
 * slot is read out of the recorded bounds, so what is checked is the columns actually painted
 * rather than a string built beside the renderer.
 *
 * Every row the component paints is swept, not just the one the default preset produces: the
 * one-line row, the row whose right group is only the subagent badge, and the two-line layout,
 * which has a clip callsite of its own. And because a front cut moves the surviving parts left,
 * a slot that did not move with its text sends a click to the wrong segment: each location slot
 * is pinned to the exact columns its text occupies. The path slot alone cannot see that -- it
 * is first, so it opens at column 0 either way -- which is why the BRANCH slot is read too.
 *
 * The click is asserted as a round trip and by its cost, not by a spy: the model chip is on the
 * line, gone after one toggle with the location strictly wider, and back after the second with
 * the location back where it started. A toggle that widened nothing, or that dropped a segment
 * it was not paying with, fails.
 *
 * WHAT IT DOES NOT CATCH. Nothing here drives a real mouse press: `capabilityLine.onClick`
 * maps a column to a segment id through `quietSegmentAt`, which `quiet-bounds.test.ts` owns,
 * and this suite starts one call later at `togglePathExpanded`. The two together cover the
 * path from a click to a repaint; neither alone does. Colour and icon are not read. The first
 * surviving part is checked only for opening no LATER than its text, since it owns the clip
 * mark and any separator the cut stranded in front of it, so a mark handed to it by mistake at
 * a width where it should be the second part would not be seen.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { QuietSegmentBounds } from "@veyyon/coding-agent/modes/components/status-line/component";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { stripAnsi } from "@veyyon/utils";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

const ELLIPSIS = "…";

/** Wide enough that the location zone cannot share the row with the right group. */
const WIDE_BRANCH = "feature/statusline-clips-the-path-from-a-single-end-only";

const LOCATION_SEGMENT_IDS = ["git", "path", "pr"] as const;

const makeTempDir = useTrackedTempDirs("veyyon-statusline-path-clip-");

/**
 * The path body, with the leading icon glyph dropped.
 *
 * The segment renders `<icon> <path>`, so the icon sits AHEAD of a front-clipped path's
 * ellipsis and every assertion about which end carries the mark has to see past it. The body
 * starts at the first character that can open a path or its clip mark; an icon glyph is none
 * of them.
 */
function pathBody(text: string): string {
	const at = text.search(/[…~/\w]/u);
	return at < 0 ? text : text.slice(at);
}

let wideCwd = "";

function makeSession(): AgentSession {
	return {
		messages: [],
		model: { id: "claude-3-7-sonnet", name: "claude-3-7-sonnet", contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 16000, contextWindow: 128000 }),
		state: {
			messages: [],
			model: { id: "claude-3-7-sonnet", name: "claude-3-7-sonnet", contextWindow: 128000 },
		},
		sessionManager: {
			getCwd: () => wideCwd,
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
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

/** A slot's painted text, sliced out of the line by the columns it recorded. */
function slotText(line: string, bounds: readonly QuietSegmentBounds[], id: string): string | null {
	const slot = bounds.find(entry => entry.id === id);
	if (!slot) return null;
	return stripAnsi(line).slice(slot.start, slot.end);
}

/** The right edge of the location zone, in columns. */
function locationEnd(bounds: readonly QuietSegmentBounds[]): number {
	let end = 0;
	for (const slot of bounds) {
		if ((LOCATION_SEGMENT_IDS as readonly string[]).includes(slot.id)) end = Math.max(end, slot.end);
	}
	return end;
}

function renderedIds(bounds: readonly QuietSegmentBounds[]): Set<string> {
	const ids = new Set<string>();
	for (const slot of bounds) ids.add(slot.id);
	return ids;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);

	wideCwd = path.join(makeTempDir(), "platform-services", "ingest-pipeline", "normalizer");
	mkdirSync(path.join(wideCwd, ".git"), { recursive: true });
	writeFileSync(path.join(wideCwd, ".git", "HEAD"), `ref: refs/heads/${WIDE_BRANCH}\n`);
});

describe("the footline path is clipped from one end", () => {
	// THE INVARIANT, and it is one sentence: a path that is clipped at all carries exactly
	// one ellipsis, at the front. That holds however many clippers the location zone grows,
	// because it is a property of the painted slot rather than of any one of them. A clipper
	// added later that cuts from the right fails this at whatever width it engages.
	//
	// A body with NO mark is an offender too, not a pass. This fixture's path is longer than
	// the preset budget, so `clampPathLength` clips it at every width in the sweep and a
	// painted body can never be the whole path. An unmarked one means the mark was painted
	// outside the slot the click resolver reads — which is how a mark owned by nobody hid
	// from an earlier version of this sweep, offering it a body that merely looked whole.
	//
	// The fully-collapsed slot is excluded and is not a right-clip: at the narrowest widths
	// the zone is squeezed to a bare `…`, which reports that the path has no room rather
	// than showing a clipped one. It has no end to put an ellipsis at.
	it("clips with exactly one ellipsis and puts it at the front, at every width", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const offenders: { width: number; text: string; why: string }[] = [];
		let sawClipped = false;

		// Down to 8 columns: the sweep has to pass through every width where a clipper
		// engages, including the ones where the path is the only thing left on the row.
		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const text = slotText(line, statusLine.getQuietSegmentBounds(), "path");
			if (text === null) continue;
			const trimmed = pathBody(text.trim());
			if (trimmed.length === 0 || trimmed === ELLIPSIS) continue;

			const count = [...trimmed].filter(ch => ch === ELLIPSIS).length;
			sawClipped = sawClipped || count > 0;
			if (count > 1) offenders.push({ width, text: trimmed, why: `${count} ellipses` });
			else if (count === 0) offenders.push({ width, text: trimmed, why: "no mark in the slot" });
			else if (!trimmed.startsWith(ELLIPSIS)) offenders.push({ width, text: trimmed, why: "not at the front" });
		}

		expect(offenders).toEqual([]);
		// A sweep that never clipped would satisfy the assertion above vacuously.
		expect(sawClipped).toBe(true);
	});

	it("clips the path even on a terminal wide enough for all of it, because the clamp is a budget not a width", () => {
		// `clampPathLength` runs at the preset's `maxLength` regardless of the row, so a
		// path longer than the budget is clipped at 400 columns exactly as at 100. This is
		// pinned because it is the reason the sweep above cannot use a wide render as its
		// "unclipped" baseline, and a future change that made the clamp width-aware would
		// silently turn that sweep vacuous.
		const statusLine = new StatusLineComponent(makeSession());
		expect(statusLine.renderQuietLine(400)).not.toBeNull();
		const wide = slotText(statusLine.renderQuietLine(400) ?? "", statusLine.getQuietSegmentBounds(), "path");
		const trimmed = pathBody((wide ?? "").trim());

		expect(trimmed.startsWith(ELLIPSIS)).toBe(true);
		expect([...trimmed].filter(ch => ch === ELLIPSIS)).toHaveLength(1);

		// WHAT "ONE END" BUYS: the surviving text is a genuine SUFFIX of the path, so it can
		// be read as one -- and it is the end that identifies the directory. The right-clipping
		// clamp could not satisfy this at any width.
		//
		// Three spellings are accepted because the segment chooses one before clamping and
		// which it chooses is the fixture's business, not this contract's: absolute, the
		// home dir collapsed to `~`, or -- as here, since the temp-dir helper builds under
		// `os.tmpdir()` and `SCRATCH_ROOTS` names it -- relative to the scratch root.
		const core = trimmed.slice(ELLIPSIS.length);
		const spellings = [wideCwd, wideCwd.replace(os.homedir(), "~"), path.relative(os.tmpdir(), wideCwd)];

		expect(core.length).toBeGreaterThan(10);
		expect(spellings.some(full => full.endsWith(core))).toBe(true);
	});

	// EVERY ROW THE COMPONENT CAN PAINT, not just the one the presets happen to produce. The
	// clip has two live callsites -- the shed loop and the two-line layout -- and a mutation
	// that turned either back into a tail cut stayed green while only the first was swept.
	it("clips a row whose right group is only the subagent badge, and clips it to the row", () => {
		const statusLine = new StatusLineComponent(makeSession());
		// A preset naming no right segments still gets the subagent badge, which is appended
		// outside the segment config. This is the narrowest right group a row can have, and
		// the one that leaves the location the most room to be cut wrong in.
		statusLine.updateSettings({ preset: "custom", leftSegments: ["path", "git"], rightSegments: [] });
		const offenders: { width: number; text: string; why: string }[] = [];

		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const plain = stripAnsi(line);
			// The row is read whole, not through the path slot: a cut taken off the END of
			// this join, or not taken at all, leaves the path itself untouched and only the
			// row's own width and last cell report it.
			if (plain.length > Math.max(1, width - 1)) {
				offenders.push({ width, text: plain, why: `${plain.length} cells over the budget` });
				continue;
			}
			const trimmed = pathBody(plain.trim());
			if (trimmed.length === 0 || trimmed === ELLIPSIS) continue;

			const count = [...trimmed].filter(ch => ch === ELLIPSIS).length;
			if (count !== 1) offenders.push({ width, text: trimmed, why: `${count} ellipses` });
			else if (!trimmed.startsWith(ELLIPSIS)) offenders.push({ width, text: trimmed, why: "not at the front" });
		}

		expect(offenders).toEqual([]);
	});

	it("clips the location line from the front in the two-line layout as well", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const offenders: { width: number; text: string; why: string }[] = [];

		for (let width = 200; width >= 8; width--) {
			const { locationLine } = statusLine.renderQuietLines(width);
			if (locationLine === null) continue;
			const trimmed = pathBody(stripAnsi(locationLine).trim());
			if (trimmed.length === 0 || trimmed === ELLIPSIS) continue;

			const count = [...trimmed].filter(ch => ch === ELLIPSIS).length;
			if (count !== 1) offenders.push({ width, text: trimmed, why: `${count} ellipses` });
			else if (!trimmed.startsWith(ELLIPSIS)) offenders.push({ width, text: trimmed, why: "not at the front" });
		}

		expect(offenders).toEqual([]);
	});

	// A front cut moves every surviving part left, and a slot that did not move with its text
	// sends a click to the wrong segment. The path slot cannot see this -- it is first, so it
	// starts at column 0 either way -- and a mutation that dropped the shift entirely stayed
	// green until the BRANCH slot was read.
	it("leaves every location slot on the columns its own text was painted in", () => {
		const statusLine = new StatusLineComponent(makeSession());

		// The unclipped reference: what each location segment paints with room to spare.
		expect(statusLine.renderQuietLine(400)).not.toBeNull();
		const wideLine = statusLine.renderQuietLine(400) ?? "";
		const wideBounds = statusLine.getQuietSegmentBounds();
		const reference: Record<string, string> = {};
		for (const id of LOCATION_SEGMENT_IDS) {
			const text = slotText(wideLine, wideBounds, id);
			if (text !== null) reference[id] = text.trim();
		}
		// Without a second location segment this test cannot see the shift at all.
		expect(Object.keys(reference)).toContain("git");

		const offenders: { width: number; id: string; why: string }[] = [];
		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const plain = stripAnsi(line);
			const bounds = statusLine.getQuietSegmentBounds();
			for (const id of LOCATION_SEGMENT_IDS) {
				const whole = reference[id];
				if (whole === undefined) continue;
				// Only a part the cut never reached is checked, and it is checked EXACTLY:
				// its text is on the row in full, so its slot has to be the columns holding
				// it and nothing else. Containment is too weak here -- a slot shifted by a
				// few cells still lands inside a long branch name and reads as a substring
				// of it, which is how an unshifted slot survived an earlier version.
				const at = plain.indexOf(whole);
				if (at < 0) continue;
				const slot = bounds.find(entry => entry.id === id);
				if (slot === undefined) {
					offenders.push({ width, id, why: "painted in full but has no slot" });
					continue;
				}
				// The FIRST surviving part opens earlier than its own text, and is meant to:
				// the clip mark is its clipped front, and once the cut has eaten a whole part
				// the separator left stranded in front of it has no other owner. Every part
				// after it starts exactly where its text does, and all of them end there.
				const first = bounds.find(entry => (LOCATION_SEGMENT_IDS as readonly string[]).includes(entry.id));
				const owed = first?.id === id ? slot.start <= at : slot.start === at;
				if (!owed) offenders.push({ width, id, why: `slot opens at ${slot.start}, text at ${at}` });
				else if (slot.end !== at + whole.length) {
					offenders.push({ width, id, why: `slot ends at ${slot.end}, text at ${at + whole.length}` });
				}
			}
		}

		expect(offenders).toEqual([]);
	});
});

describe("a click on the path trades the model chip for room", () => {
	it("hides the model and widens the location, and puts both back on the second click", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const width = 100;

		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const collapsed = statusLine.getQuietSegmentBounds();
		expect([...renderedIds(collapsed)]).toContain("model");
		const collapsedEnd = locationEnd(collapsed);

		expect(statusLine.togglePathExpanded()).toBe(true);
		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const expanded = statusLine.getQuietSegmentBounds();
		expect([...renderedIds(expanded)]).not.toContain("model");
		// The chip's slot went to the location zone rather than to padding. At this width the
		// ROW is the binding constraint, so this sees the chip drop only; the widened clamp is
		// what the next test is for.
		expect(locationEnd(expanded)).toBeGreaterThan(collapsedEnd);

		expect(statusLine.togglePathExpanded()).toBe(false);
		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const restored = statusLine.getQuietSegmentBounds();
		expect([...renderedIds(restored)]).toContain("model");
		expect(locationEnd(restored)).toBe(collapsedEnd);
	});

	it("shows more of the path than the clamp allows, once the row has room for it", () => {
		// THE MUTATION THIS EXISTS FOR: dropping the model chip widens the location zone all
		// on its own, so an assertion about the zone's extent stays green even if the click
		// never touches the path budget. The budget is only observable at a width where the
		// clamp -- not the row -- is what is cutting the path, and then only by reading the
		// path TEXT. Without this, `pathBudget` could be pinned back to the preset's
		// maxLength and the whole feature would degrade to hiding the model for nothing.
		const statusLine = new StatusLineComponent(makeSession());
		const width = 160;

		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const collapsed = pathBody(
			(slotText(statusLine.renderQuietLine(width) ?? "", statusLine.getQuietSegmentBounds(), "path") ?? "").trim(),
		);

		statusLine.togglePathExpanded();
		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const expanded = pathBody(
			(slotText(statusLine.renderQuietLine(width) ?? "", statusLine.getQuietSegmentBounds(), "path") ?? "").trim(),
		);

		expect(collapsed.startsWith(ELLIPSIS)).toBe(true);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
		expect(expanded.endsWith(collapsed.slice(ELLIPSIS.length))).toBe(true);
	});

	it("pays for the room with the model chip only, so the state beside it survives the click", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const width = 100;

		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const before = renderedIds(statusLine.getQuietSegmentBounds());

		statusLine.togglePathExpanded();
		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const after = renderedIds(statusLine.getQuietSegmentBounds());

		const dropped = [...before].filter(id => !after.has(id)).sort();
		expect(dropped).toEqual(["model"]);
	});

	it("re-truncates to the new width while expanded, rather than holding the width it expanded at", () => {
		const statusLine = new StatusLineComponent(makeSession());

		statusLine.togglePathExpanded();
		expect(statusLine.renderQuietLine(160)).not.toBeNull();
		const wide = slotText(statusLine.renderQuietLine(160) ?? "", statusLine.getQuietSegmentBounds(), "path");

		expect(statusLine.renderQuietLine(70)).not.toBeNull();
		const narrow = slotText(statusLine.renderQuietLine(70) ?? "", statusLine.getQuietSegmentBounds(), "path");

		expect((narrow ?? "").trim().length).toBeLessThan((wide ?? "").trim().length);
		expect((narrow ?? "").trimEnd().endsWith(ELLIPSIS)).toBe(false);
	});
});
