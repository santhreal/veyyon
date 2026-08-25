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
 * NOTHING IS DROPPED. Cutting the front of the JOINED location is a second form of the same
 * mistake, because the tail of `path · branch` is the branch: it kept the branch and dropped
 * the directory entirely, which is the one thing a front cut is for. Shedding the later parts
 * whole was the third form: the branch left the row at widths where the release before it
 * still showed the branch clipped. So each part is clipped from its OWN front, the widest
 * clippable one pays first, a part short enough to read whole (`main`) is never clipped at
 * all, and no part is ever taken off the row.
 *
 * WHAT SURVIVES A CUT INSIDE A PART. The identifying end, and the icon. The path's glyph is
 * the only thing on the row that says whether it names a linked worktree, a scratch directory
 * or an ordinary folder -- a worktree paints as `project/worktree`, which reads as any
 * two-segment path -- so the clip steps over the pinned cells and takes them out of the path.
 *
 * THE CLASS. Two clippers on one string, disagreeing about which end is expendable, and a cut
 * that spans parts rather than choosing between them. Any further clipper added to the
 * location zone reproduces it, in the same shape, on the same row.
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
 * THE TRAVEL. The trade is a motion, not a switch: the chip retracts by width while the path
 * grows into the room, both from one progress value, so the row can never be half widened with
 * the chip already gone. It is driven by a hand-ticked clock, so the frames are read one at a
 * time and the LANDING is asserted byte-for-byte against the component that never moved. A
 * component given no repaint hook -- every caller in this file bar that one describe -- has no
 * travel at all and lands on the click, which is what keeps the rest of these assertions about
 * layout rather than timing.
 *
 * WHAT IT DOES NOT CATCH. Nothing here drives a real mouse press: `capabilityLine.onClick`
 * maps a column to a segment id through `quietSegmentAt`, which `quiet-bounds.test.ts` owns,
 * and this suite starts one call later at `togglePathExpanded`. The two together cover the
 * path from a click to a repaint; neither alone does. Colour is read at one place only, the
 * cell the mark sits in, and by handing the fitter pre-coloured parts: a theme that painted the
 * whole zone in one colour would satisfy that assertion without the mark inheriting anything.
 * The icon is read only as the pinned cells the clip must not eat. The first surviving part is
 * checked only for opening no LATER than its text, since it owns the clip mark and any
 * separator the cut stranded in
 * front of it, so a mark handed to it by mistake at a width where it should be the second part
 * would not be seen. Nothing here reads the real motion clock: a curve whose duration was set
 * to an hour would land on the same frames under a hand-ticked one.
 */
import { afterEach, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { settings } from "@veyyon/coding-agent/config/settings-instance";
import type { QuietPart, QuietSegmentBounds } from "@veyyon/coding-agent/modes/components/status-line/component";
import {
	fitLocation,
	MIN_LOCATION_PART,
	StatusLineComponent,
} from "@veyyon/coding-agent/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { MotionClock, visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

const ELLIPSIS = "…";

/** Wide enough that the location zone cannot share the row with the right group. */
const WIDE_BRANCH = "feature/statusline-clips-the-path-from-a-single-end-only";

/**
 * Short enough to read whole, and the branch nearly every session is on. A row that clips this
 * has spent cells on a mark to save four, and taken the branch's identity to do it.
 */
const SHORT_BRANCH = "main";

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
/** The same deep path on a branch short enough that clipping it is never the right trade. */
let shortBranchCwd = "";

/**
 * Every spelling the path segment may choose before clamping, since which it picks is the
 * fixture's business and not this contract's: absolute, the home dir collapsed to `~`, or --
 * as here, the temp-dir helper builds under `os.tmpdir()` and `SCRATCH_ROOTS` names it --
 * relative to the scratch root. A clipped path has to be a suffix of one of them.
 */
function pathSpellings(): string[] {
	return [wideCwd, wideCwd.replace(os.homedir(), "~"), path.relative(os.tmpdir(), wideCwd)];
}

function makeSession(cwd: () => string = () => wideCwd): AgentSession {
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

	shortBranchCwd = path.join(makeTempDir(), "platform-services", "ingest-pipeline", "normalizer");
	mkdirSync(path.join(shortBranchCwd, ".git"), { recursive: true });
	writeFileSync(path.join(shortBranchCwd, ".git", "HEAD"), `ref: refs/heads/${SHORT_BRANCH}\n`);
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
	it("clips with exactly one ellipsis at the front, and to a suffix of the real path, at every width", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const offenders: { width: number; text: string; why: string }[] = [];
		const spellings = pathSpellings();
		let sawClipped = false;

		// Down to 8 columns: the sweep has to pass through every width where a clipper
		// engages, including the ones where the path is the only thing left on the row.
		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const bounds = statusLine.getQuietSegmentBounds();
			const ids = renderedIds(bounds);
			// THE RULE ITSELF: the directory is the last thing the location zone gives up.
			// A row still showing the branch and no longer showing the directory has cut the
			// wrong end of the join -- the tail of a `path · branch` join is the BRANCH, so a
			// front cut on the joined string eats the directory first, which is the opposite
			// of what a front cut is for.
			if (LOCATION_SEGMENT_IDS.some(id => ids.has(id)) && !ids.has("path")) {
				offenders.push({ width, text: stripAnsi(line), why: "location on the row without the directory" });
				continue;
			}
			const text = slotText(line, bounds, "path");
			if (text === null) continue;
			const trimmed = pathBody(text.trim());
			if (trimmed.length === 0 || trimmed === ELLIPSIS) continue;

			const count = [...trimmed].filter(ch => ch === ELLIPSIS).length;
			sawClipped = sawClipped || count > 0;
			if (count > 1) offenders.push({ width, text: trimmed, why: `${count} ellipses` });
			else if (count === 0) offenders.push({ width, text: trimmed, why: "no mark in the slot" });
			else if (!trimmed.startsWith(ELLIPSIS)) offenders.push({ width, text: trimmed, why: "not at the front" });
			else if (!spellings.some(full => full.endsWith(trimmed.slice(ELLIPSIS.length)))) {
				offenders.push({ width, text: trimmed, why: "not a suffix of the real path" });
			}
		}

		expect(offenders).toEqual([]);
		// A sweep that never clipped would satisfy the assertion above vacuously.
		expect(sawClipped).toBe(true);
	});

	// THE BRANCH STAYS. Shedding it was legal in the version before this one, and the row it
	// produced -- one long directory and no branch -- is worse than two clipped names, because
	// the branch is half of what a location is for. This sweeps for a row that still shows the
	// directory and has silently lost the branch beside it.
	//
	// Read as an implication rather than a presence check: at the narrowest widths the location
	// zone is cut down to its tail, which IS the branch, and a row showing the branch alone is
	// the clip working, not a part being dropped.
	it("never drops the branch off a row that is still showing the directory", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const offenders: { width: number; text: string }[] = [];
		let sawBothClipped = false;

		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const bounds = statusLine.getQuietSegmentBounds();
			const ids = renderedIds(bounds);
			if (ids.has("path") && !ids.has("git")) {
				offenders.push({ width, text: stripAnsi(line) });
				continue;
			}
			const pathText = slotText(line, bounds, "path");
			const gitText = slotText(line, bounds, "git");
			if (pathText?.includes(ELLIPSIS) && gitText?.includes(ELLIPSIS)) sawBothClipped = true;
		}

		expect(offenders).toEqual([]);
		// The fixture's path and branch cannot share this row whole at any width in the sweep,
		// so a run where they were never both clipped means the row found room that is not
		// there -- or that one of them was quietly given up after all.
		expect(sawBothClipped).toBe(true);
	});

	// A branch is not clipped to save four cells. `main`, `dev`, `master` -- the branch most
	// sessions are on -- reads whole or not at all, and a mark in front of a four-letter name
	// costs a cell to destroy the name. The cells come out of the path, which has an
	// expendable head; the branch does not.
	it("never clips a branch short enough to read whole, however narrow the row", () => {
		const statusLine = new StatusLineComponent(makeSession(() => shortBranchCwd));
		const offenders: { width: number; text: string }[] = [];
		let sawPathPay = false;

		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const bounds = statusLine.getQuietSegmentBounds();
			const branch = slotText(line, bounds, "git")?.trim();
			if (branch === undefined || branch === "") continue;
			if (branch.includes(ELLIPSIS) || !branch.endsWith(SHORT_BRANCH)) {
				offenders.push({ width, text: branch });
				continue;
			}
			const pathText = pathBody((slotText(line, bounds, "path") ?? "").trim());
			if (pathText.startsWith(ELLIPSIS) && pathText.length < 20) sawPathPay = true;
		}

		expect(offenders).toEqual([]);
		// Vacuous if the row never got tight enough to make the trade: the point is not that
		// `main` survived a wide row, it is that a narrow row took the cells from the path.
		expect(sawPathPay).toBe(true);
	});

	// WHO PAYS THE FIRST CELL. The longer part. Taking it from the head instead spends the
	// directory to keep a branch name whole that nobody is asking to read in full, and the
	// widest-first fill is what stops one part being emptied while the other is untouched.
	it("takes the first cells off the longer part, leaving the shorter one whole", () => {
		const statusLine = new StatusLineComponent(makeSession());
		// What each part paints with room to spare. The path is clamped even here (the clamp is
		// a budget, not a width — see above), so "unclipped" means "as the widest row had it".
		expect(statusLine.renderQuietLine(400)).not.toBeNull();
		const wide = statusLine.renderQuietLine(400) ?? "";
		const wideBounds = statusLine.getQuietSegmentBounds();
		const referencePath = (slotText(wide, wideBounds, "path") ?? "").trim();
		const referenceGit = (slotText(wide, wideBounds, "git") ?? "").trim();
		// The fixture only proves this if the branch is the longer of the two.
		expect(referenceGit.length).toBeGreaterThan(referencePath.length);

		// The widest row where the fitter has to take anything at all.
		let firstCut: { width: number; pathText: string; gitText: string } | null = null;
		for (let width = 200; width >= 8 && firstCut === null; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const bounds = statusLine.getQuietSegmentBounds();
			const pathText = (slotText(line, bounds, "path") ?? "").trim();
			const gitText = (slotText(line, bounds, "git") ?? "").trim();
			if (pathText !== referencePath || gitText !== referenceGit) firstCut = { width, pathText, gitText };
		}

		expect(firstCut).not.toBeNull();
		expect(firstCut?.gitText).not.toBe(referenceGit);
		expect(firstCut?.pathText).toBe(referencePath);
	});

	// The path's icon is the only thing on the row that says WHICH KIND of location this is: a
	// linked worktree, a scratch directory, a plain folder. The front cut reaches it first, and
	// eating it left the same directory reading as a worktree at one width and a folder two
	// columns narrower. It is pinned, so the mark lands after it and the cells come out of the
	// path text.
	it("keeps the path's icon in front of the clip mark at every width", () => {
		const statusLine = new StatusLineComponent(makeSession());
		expect(statusLine.renderQuietLine(400)).not.toBeNull();
		const icon = (slotText(statusLine.renderQuietLine(400) ?? "", statusLine.getQuietSegmentBounds(), "path") ?? "")
			.trim()
			.charAt(0);
		// A symbol preset with an empty path icon has nothing to pin and nothing to assert.
		expect(icon).not.toBe("");
		expect(ELLIPSIS.startsWith(icon)).toBe(false);

		const offenders: { width: number; text: string }[] = [];
		let sawClippedWithIcon = false;
		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const text = (slotText(line, statusLine.getQuietSegmentBounds(), "path") ?? "").trim();
			// Under the icon plus a mark there is no room for both, and the icon is what goes:
			// a glyph with nothing after it names a kind of location and no location.
			if (text.length <= 2) continue;
			if (!text.startsWith(icon)) {
				offenders.push({ width, text });
				continue;
			}
			if (text.includes(ELLIPSIS)) sawClippedWithIcon = true;
		}

		expect(offenders).toEqual([]);
		expect(sawClippedWithIcon).toBe(true);
	});

	// The floor is not a suggestion: when the zone cannot hold both parts above it, the BUDGET
	// is what moves. The context gauge goes and the zone is asked again, because a percentage
	// re-reads on the next frame while the directory and the branch are what the row is for.
	// The ladder stops one rung later: the model chip is never spent on the location, since
	// keeping that chip beside a long path is the reason this row was changed at all.
	//
	// THE MUTATION THIS EXISTS FOR: deleting the re-fit loop leaves the gauge on the row and
	// the location under its floor, and every other assertion in this file stays green.
	it("gives up the context gauge, and never the model, before letting the location go under its floor", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const offenders: { width: number; text: string; why: string }[] = [];
		let sawGauge = false;
		let sawClip = false;

		for (let width = 200; width >= 70; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const bounds = statusLine.getQuietSegmentBounds();
			const ids = renderedIds(bounds);
			const parts = LOCATION_SEGMENT_IDS.map(id => slotText(line, bounds, id) ?? "")
				.map(text => text.trim())
				.filter(text => text.length > 0);
			if (parts.some(text => text.startsWith(ELLIPSIS))) sawClip = true;
			if (!ids.has("model")) {
				offenders.push({ width, text: stripAnsi(line), why: "the model chip paid for the location" });
				continue;
			}
			if (!ids.has("context_pct")) continue;
			sawGauge = true;
			const under = parts.filter(text => text.length < MIN_LOCATION_PART);
			if (under.length > 0)
				offenders.push({ width, text: stripAnsi(line), why: `under the floor: ${under.join(" | ")}` });
		}

		expect(offenders).toEqual([]);
		// A sweep that saw no gauge, or no clip, proves nothing about which of them gives way.
		expect(sawGauge).toBe(true);
		expect(sawClip).toBe(true);
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
		const core = trimmed.slice(ELLIPSIS.length);

		expect(core.length).toBeGreaterThan(10);
		expect(pathSpellings().some(full => full.endsWith(core))).toBe(true);
	});

	// Both location parts can carry their own mark now, so a row-wide "exactly one ellipsis"
	// count is dead. What still holds per part: a mark OPENS a part. It sits at column 0, or
	// straight after the space that ends a separator, or after the pinned icon's space. A cut
	// taken off the end of a name puts a mark after a name character, and that is what these
	// two sweeps look for. Both rows below are free of the session-name segment, which
	// truncates from the END by design and would read as an offender here.
	const marksInsideAName = (plain: string): number[] => {
		const bad: number[] = [];
		for (let index = 0; index < plain.length; index++) {
			if (plain[index] !== ELLIPSIS) continue;
			if (index > 0 && plain[index - 1] !== " ") bad.push(index);
		}
		return bad;
	};

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
			const trimmed = plain.trim();
			if (trimmed.length === 0 || trimmed === ELLIPSIS) continue;

			const inside = marksInsideAName(trimmed);
			if (inside.length > 0) offenders.push({ width, text: trimmed, why: `mark inside a name at ${inside.join()}` });
			else if (trimmed.endsWith(ELLIPSIS)) offenders.push({ width, text: trimmed, why: "the row ends on a mark" });
		}

		expect(offenders).toEqual([]);
	});

	it("clips the location line from the front in the two-line layout as well", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const offenders: { width: number; text: string; why: string }[] = [];

		for (let width = 200; width >= 8; width--) {
			const { locationLine } = statusLine.renderQuietLines(width);
			if (locationLine === null) continue;
			const trimmed = stripAnsi(locationLine).trim();
			if (trimmed.length === 0 || trimmed === ELLIPSIS) continue;

			const inside = marksInsideAName(trimmed);
			if (inside.length > 0) offenders.push({ width, text: trimmed, why: `mark inside a name at ${inside.join()}` });
			else if (trimmed.endsWith(ELLIPSIS)) offenders.push({ width, text: trimmed, why: "the row ends on a mark" });
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

/**
 * The fitter is the choke point: every row, one line or two, hands it the parts and a budget.
 * Rows can only reach the budgets their own shed ladder leaves it, and the ladder drops the
 * zone entirely well before the tightest budgets, so the rules that decide who pays down
 * there are unreachable through `renderQuietLine` and are pinned here instead.
 */
describe("the location fitter decides who pays", () => {
	const SEP = "  ·  ";
	// A path with an icon pinned in front of it, and the branch nearly every session is on.
	const PATH: QuietPart = { id: "path", content: "▫ platform-services/ingest-pipeline/normalizer", pin: 2 };
	const BRANCH: QuietPart = { id: "git", content: "⎇ main" };

	it("never clips a part short enough to read whole, at any budget at all", () => {
		const offenders: { budget: number; why: string }[] = [];
		let sawThePathPay = false;

		for (let budget = 0; budget <= 80; budget++) {
			const { text, slots, cramped } = fitLocation([PATH, BRANCH], SEP, budget);
			if (visibleWidth(text) > budget) offenders.push({ budget, why: `${visibleWidth(text)} cells wide` });
			const branch = slots.find(slot => slot.id === "git");
			if (branch === undefined) {
				// Dropped, which is allowed and is the honest answer at a budget this tight:
				// a mark and one letter of a branch name is not the branch.
				if (!cramped) offenders.push({ budget, why: "dropped the branch without saying it was cramped" });
				continue;
			}
			// It survived, so it survived WHOLE: the branch is last, so the row ends with it.
			if (!text.endsWith(BRANCH.content)) offenders.push({ budget, why: `branch reads ${JSON.stringify(text)}` });
			const path = slots.find(slot => slot.id === "path");
			if (path !== undefined && text.slice(0, path.end).includes(ELLIPSIS)) sawThePathPay = true;
		}

		expect(offenders).toEqual([]);
		// Vacuous unless the sweep saw the trade happen: the path clipped, the branch whole.
		expect(sawThePathPay).toBe(true);
	});

	it("keeps the directory when only one part can stay, because a branch alone says nothing about where you are", () => {
		const survivors: string[] = [];
		for (let budget = 1; budget <= 12; budget++) {
			const { slots } = fitLocation([PATH, BRANCH], SEP, budget);
			survivors.push(slots.map(slot => slot.id).join("+"));
		}

		// Whatever the fitter can afford down here, it is never the branch on its own.
		expect(survivors.filter(row => row === "git")).toEqual([]);
		expect(survivors).toContain("path");
	});
});

/**
 * A clip mark is part of the name it cut, not part of the gap in front of it.
 *
 * THE DEFECT. The mark was written ahead of the escape run `sliceWithWidth` replays at the cut,
 * so it painted in whatever colour the row was in BEFORE the part: the separator's grey in
 * front of a green branch, the icon's colour in front of a path. One glyph, in the wrong
 * colour, is enough to read as belonging to the gap rather than to the name -- which is the
 * opposite of what it is there to say.
 *
 * THE SECOND DEFECT. A cut placed by arithmetic alone lands wherever the budget runs out:
 * `…-model-retention-long-path` opens on punctuation belonging to a word the row no longer
 * shows, and `…eline/normalizer` opens on the tail of a name that reads as a name in its own
 * right. The cut is allowed to walk forward a few cells to the next boundary, keeping a `/`
 * (a mark in front of a slash is how a shortened path has always read) and dropping a word
 * separator, which has nothing left to join.
 *
 * WHY THE FITTER AND NOT A ROW. Both are properties of one clipped part, and the fitter is
 * where a part is clipped. A row reaches these budgets only through its shed ladder, which
 * drops the whole zone before the tightest of them, and a row's parts come coloured by the
 * theme, which the sandbox renders colourless -- so the colour contract is unobservable there.
 *
 * WHAT IT DOES NOT CATCH. Nothing here proves the theme gives the two location parts different
 * colours in the first place; if it painted both in the separator's grey the defect would be
 * invisible and these assertions would still pass. The snap is asserted on narrow cells only,
 * which is the only case the source attempts.
 */
describe("a clip mark belongs to the name it cut", () => {
	const SEP = "  ·  ";
	const BRANCH_COLOUR = "\u001b[38;5;72m";
	const ICON_COLOUR = "\u001b[38;5;250m";
	const PATH_COLOUR = "\u001b[38;5;254m";
	const OFF = "\u001b[39m";
	const BRANCH_NAME = "feature/statusline-model-retention-long-path";
	const PATH_NAME = "platform-services/ingest-pipeline/normalizer";

	/** The escape run immediately in front of the first mark: what the mark is painted in. */
	function runBeforeMark(text: string): string {
		const at = text.indexOf(ELLIPSIS);
		return at < 0 ? "" : (/(?:\u001b\[[0-9;:]*m)+$/u.exec(text.slice(0, at))?.[0] ?? "");
	}

	it("paints the mark in the colour of the name it kept, not the colour of the gap in front of it", () => {
		const branch: QuietPart = { id: "git", content: `${BRANCH_COLOUR}${BRANCH_NAME}${OFF}` };
		const offenders: { budget: number; run: string }[] = [];
		let sawMark = false;

		for (let budget = 4; budget < visibleWidth(BRANCH_NAME); budget++) {
			const { text } = fitLocation([branch], SEP, budget);
			if (!stripAnsi(text).includes(ELLIPSIS)) continue;
			sawMark = true;
			// Adjacent escapes run together, so the state may be several sequences long; what
			// matters is that the LAST thing set before the mark is the branch's own colour.
			const run = runBeforeMark(text);
			if (!run.endsWith(BRANCH_COLOUR)) offenders.push({ budget, run: JSON.stringify(run) });
		}

		expect(offenders).toEqual([]);
		expect(sawMark).toBe(true);
	});

	it("takes the colour of the cell the mark stands in front of, not one an earlier run set", () => {
		// The shape the defect had, and the general case of it: a part painted in more than one
		// colour, with the cut landing inside the LAST of them. A theme highlighting the leaf
		// directory paints exactly this, and the icon is one more run in front of it. Both the
		// escapes the pin steps over and the ones the dropped head opened end on a colour that
		// is not the one at the cut, so a mark taking its colour from either is visibly wrong.
		const LEAF_COLOUR = "\u001b[38;5;117m";
		const parent = "platform-services/ingest-pipeline/";
		const leaf = "normalizer-service";
		const withIcon: QuietPart = {
			id: "path",
			content: `${ICON_COLOUR}▫ ${OFF}${PATH_COLOUR}${parent}${LEAF_COLOUR}${leaf}${OFF}`,
			pin: 2,
		};

		// 20 cells: the pin, the mark, and seventeen of the leaf, so the cut is inside the leaf
		// and no boundary is within reach of it.
		const { text } = fitLocation([withIcon], SEP, 20);

		expect(stripAnsi(text)).toBe(`▫ ${ELLIPSIS}ormalizer-service`);
		expect(runBeforeMark(text).endsWith(LEAF_COLOUR)).toBe(true);
	});

	it("opens a clipped name on a boundary, keeping a slash and dropping a word separator", () => {
		// Pinned here rather than imported from the source: a test that reads the source's own
		// allowance moves with it, and an allowance widened until it ate whole names is exactly
		// the regression this bound exists to catch.
		const MOST_CELLS_A_TIDY_CUT_MAY_COST = 4;
		const SEPARATORS = "-_.@:";
		const name: QuietPart = { id: "path", content: PATH_NAME };
		const offenders: { budget: number; why: string }[] = [];
		let sawSlashKept = false;
		let sawClip = false;

		for (let budget = 4; budget < visibleWidth(PATH_NAME); budget++) {
			const plain = stripAnsi(fitLocation([name], SEP, budget).text);
			if (!plain.startsWith(ELLIPSIS)) continue;
			sawClip = true;
			const tail = plain.slice(ELLIPSIS.length);
			const opens = tail[0] ?? "";
			if (SEPARATORS.includes(opens)) offenders.push({ budget, why: `opens on ${opens}: ${plain}` });
			if (opens === "/") sawSlashKept = true;
			if (!PATH_NAME.endsWith(tail)) offenders.push({ budget, why: `${JSON.stringify(tail)} is not a suffix` });
			const givenUp = budget - visibleWidth(plain);
			if (givenUp > MOST_CELLS_A_TIDY_CUT_MAY_COST) offenders.push({ budget, why: `gave up ${givenUp} cells` });
		}

		expect(offenders).toEqual([]);
		expect(sawClip).toBe(true);
		// Vacuous unless the sweep passed a cut that landed on a slash and kept it.
		expect(sawSlashKept).toBe(true);
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

describe("the trade travels instead of switching", () => {
	const WIDTH = 118;
	/** Past `MOTION.expand`, so the value has landed however the curve got there. */
	const LANDED_MS = 600;

	afterEach(() => {
		settings.set("display.transitions", "on");
	});

	/** A component with a hand-ticked clock, plus the frames it asked to paint. */
	function animated(cwd?: () => string): { line: StatusLineComponent; clock: MotionClock; frames: () => number } {
		let frames = 0;
		const clock = new MotionClock({ autoTick: false });
		const line = new StatusLineComponent(makeSession(cwd ?? (() => wideCwd)), {
			requestRender: () => {
				frames++;
			},
			clock,
		});
		return { line, clock, frames: () => frames };
	}

	/**
	 * The clock's first tick advances one frame whatever time it names, because it has no
	 * previous tick to measure from. Prime it, then jump past the curve.
	 */
	function settle(clock: MotionClock): void {
		clock.tick(0);
		clock.tick(LANDED_MS);
	}

	it("lands on exactly the row the same click paints with no motion at all", () => {
		const still = new StatusLineComponent(makeSession());
		still.togglePathExpanded();
		const target = still.renderQuietLine(WIDTH);

		const { line, clock } = animated();
		line.renderQuietLine(WIDTH);
		line.togglePathExpanded();
		settle(clock);

		// Byte-for-byte: the travel is how the row gets there, not what it arrives at. A curve
		// that stopped short would paint a row nobody chose, at a width nobody asked for.
		expect(line.renderQuietLine(WIDTH)).toBe(target);
	});

	// THE OTHER HALF OF THE TRADE, and the one row that can show it. Where the location is
	// clipped the path is bounded by the room the retracting chip has freed, so its own budget
	// is never the binding constraint and a budget that jumped straight to the landed width
	// paints the same bytes. A short branch on a wide row leaves the zone unclipped, and there
	// the budget IS the path's width: a jump shows the directory arriving before the chip has
	// finished leaving.
	it("grows the path itself in steps on a row wide enough to hold the location whole", () => {
		// Wide enough that the whole location, the model chip and every state fit together, so
		// no clip is involved and the path's own budget is the only thing setting its width.
		const ROOMY = 180;
		const { line, clock } = animated(() => shortBranchCwd);
		const pathWidth = (): number => {
			expect(line.renderQuietLine(ROOMY)).not.toBeNull();
			const slot = line.getQuietSegmentBounds().find(entry => entry.id === "path");
			return slot === undefined ? 0 : slot.end - slot.start;
		};

		// Primed before the click: the curve is fastest at its start, so a first advance a
		// whole frame long is already past the width the path itself runs out at, and every
		// sample after that reads the same landed number whatever the budget did.
		clock.tick(0);
		const collapsed = pathWidth();
		line.togglePathExpanded();
		const seen = [4, 8, 14].map(ms => {
			clock.tick(ms);
			return pathWidth();
		});
		clock.tick(LANDED_MS);
		const landed = pathWidth();

		expect(landed).toBeGreaterThan(collapsed);
		// The first sample is ON THE WAY: past where the row was, short of where it is going.
		// A hard budget switch puts it at `landed`, because the path's own length is all that
		// bounds it once the budget is the full row.
		expect(seen[0] ?? 0).toBeGreaterThan(collapsed);
		expect(seen[0] ?? 0).toBeLessThan(landed);
		for (let i = 1; i < seen.length; i++) expect(seen[i] ?? 0).toBeGreaterThanOrEqual(seen[i - 1] ?? 0);
		expect(seen.at(-1) ?? 0).toBeLessThanOrEqual(landed);
	});

	it("paints frames between the two rows, widening the location and retracting the chip together", () => {
		const { line, clock, frames } = animated();
		expect(line.renderQuietLine(WIDTH)).not.toBeNull();
		const collapsedEnd = locationEnd(line.getQuietSegmentBounds());

		line.togglePathExpanded();
		const seen: { locationEnd: number; chip: number }[] = [];
		for (let frame = 1; frame <= 12; frame++) {
			clock.tick(frame * 16);
			expect(line.renderQuietLine(WIDTH)).not.toBeNull();
			const bounds = line.getQuietSegmentBounds();
			const model = bounds.find(slot => slot.id === "model");
			seen.push({ locationEnd: locationEnd(bounds), chip: model ? model.end - model.start : 0 });
		}

		// The clock asked for repaints; a travel nobody paints is a value moving in private.
		expect(frames()).toBeGreaterThan(0);
		// At least one frame is neither end state: the chip is still on the row and the
		// location is already wider than it was. That frame is the whole feature.
		const midway = seen.filter(frame => frame.chip > 0 && frame.locationEnd > collapsedEnd);
		expect(midway.length).toBeGreaterThan(0);
		// One value drives both ends of the trade, so the room only ever moves one way: the
		// location never gives a cell back and the chip never grows on the way out.
		for (let i = 1; i < seen.length; i++) {
			expect(seen[i]?.locationEnd ?? 0).toBeGreaterThanOrEqual(seen[i - 1]?.locationEnd ?? 0);
			expect(seen[i]?.chip ?? 0).toBeLessThanOrEqual(seen[i - 1]?.chip ?? 0);
		}
		// And it finishes: a curve that never settles is a repaint loop for as long as the
		// process lives.
		expect(seen.at(-1)?.chip).toBe(0);
	});

	it("turns a click mid-travel around from where the row had got to", () => {
		const { line, clock } = animated();
		expect(line.renderQuietLine(WIDTH)).not.toBeNull();
		const collapsedEnd = locationEnd(line.getQuietSegmentBounds());

		line.togglePathExpanded();
		clock.tick(32);
		expect(line.renderQuietLine(WIDTH)).not.toBeNull();
		const midEnd = locationEnd(line.getQuietSegmentBounds());
		expect(midEnd).toBeGreaterThan(collapsedEnd);

		// Back again before it landed. The row must come back from `midEnd`, not snap out to
		// the expanded width first and ease in from there, which is what restarting the curve
		// instead of retargeting it looks like.
		line.togglePathExpanded();
		clock.tick(40);
		expect(line.renderQuietLine(WIDTH)).not.toBeNull();
		expect(locationEnd(line.getQuietSegmentBounds())).toBeLessThanOrEqual(midEnd);

		clock.tick(LANDED_MS);
		expect(line.renderQuietLine(WIDTH)).not.toBeNull();
		expect(locationEnd(line.getQuietSegmentBounds())).toBe(collapsedEnd);
	});

	it("lands on the click with transitions off, so reduced motion sees the hard cut", () => {
		settings.set("display.transitions", "off");
		const still = new StatusLineComponent(makeSession());
		still.togglePathExpanded();
		const target = still.renderQuietLine(WIDTH);

		const { line, clock, frames } = animated();
		line.renderQuietLine(WIDTH);
		line.togglePathExpanded();

		// No tick: the row is already there on the frame of the click.
		expect(line.renderQuietLine(WIDTH)).toBe(target);
		clock.tick(16);
		expect(frames()).toBe(0);
	});
});
