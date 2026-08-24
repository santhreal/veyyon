/**
 * The footline path is clipped from ONE end, and a click on it trades the model chip for room.
 *
 * THE DEFECT. Two independent mechanisms shortened the path from opposite ends. The
 * per-segment clamp (`clampPathLength`, at the preset's `maxLength`) prefixed an ellipsis and
 * kept the tail; the width-driven shortening in the shed loop (`truncateToWidth` on the joined
 * location) appended one and kept the head. A path wide enough to hit both came out clipped at
 * both ends — `…orm-services/ingest-pipeline/norm…` — which keeps neither the project the
 * directory is under nor the directory itself, and leaves a middle that names nothing a reader
 * can place.
 *
 * THE CLASS. Two clippers on one string, disagreeing about which end is expendable. Any
 * further clipper added to the location zone reproduces it, in the same shape, on the same row.
 *
 * HOW THIS SUITE CLOSES THE CLASS. It does not assert on either clipper. It sweeps the width
 * and asserts the INVARIANT that survives any number of them: the rendered path slot never
 * begins with an ellipsis, and whenever it is narrower than the path it is naming it ends with
 * one. A third clipper cutting from the left fails this at whatever width it engages, without
 * the suite knowing it exists. The slot is read out of the recorded bounds, so what is checked
 * is the columns actually painted rather than a string built beside the renderer.
 *
 * The click is asserted as a round trip and by its cost, not by a spy: the model chip is on the
 * line, gone after one toggle with the location strictly wider, and back after the second with
 * the location back where it started. A toggle that widened nothing, or that dropped a segment
 * it was not paying with, fails.
 *
 * WHAT IT DOES NOT CATCH. Nothing here drives a real mouse press: `capabilityLine.onClick`
 * maps a column to a segment id through `quietSegmentAt`, which `quiet-bounds.test.ts` owns,
 * and this suite starts one call later at `togglePathExpanded`. The two together cover the
 * path from a click to a repaint; neither alone does. Colour and icon are not read.
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

/** The path slot's painted text, sliced out of the line by its recorded columns. */
function pathText(line: string, bounds: readonly QuietSegmentBounds[]): string | null {
	const slot = bounds.find(entry => entry.id === "path");
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
	// one ellipsis, at the end. That holds however many clippers the location zone grows,
	// because it is a property of the painted slot rather than of any one of them. A clipper
	// added later that cuts from the left fails this at whatever width it engages.
	//
	// The fully-collapsed slot is excluded and is not a left-clip: at the narrowest widths
	// the zone is squeezed to a bare `…`, which reports that the path has no room rather
	// than showing a clipped one. It has no end to put an ellipsis at.
	it("clips with exactly one ellipsis and puts it at the end, at every width", () => {
		const statusLine = new StatusLineComponent(makeSession());
		const offenders: { width: number; text: string; why: string }[] = [];
		let sawClipped = false;

		// Down to 8 columns: the sweep has to pass through every width where a clipper
		// engages, including the ones where the path is the only thing left on the row.
		for (let width = 200; width >= 8; width--) {
			const line = statusLine.renderQuietLine(width);
			if (line === null) continue;
			const text = pathText(line, statusLine.getQuietSegmentBounds());
			if (text === null) continue;
			const trimmed = text.trim();
			if (trimmed.length === 0 || trimmed === ELLIPSIS) continue;

			const count = [...trimmed].filter(ch => ch === ELLIPSIS).length;
			if (count === 0) continue;
			sawClipped = true;
			if (count > 1) offenders.push({ width, text: trimmed, why: `${count} ellipses` });
			else if (!trimmed.endsWith(ELLIPSIS)) offenders.push({ width, text: trimmed, why: "not at the end" });
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
		const wide = pathText(statusLine.renderQuietLine(400) ?? "", statusLine.getQuietSegmentBounds());
		const trimmed = (wide ?? "").trim();

		expect(trimmed.endsWith(ELLIPSIS)).toBe(true);
		expect([...trimmed].filter(ch => ch === ELLIPSIS)).toHaveLength(1);

		// WHAT "ONE END" BUYS: the surviving text is a genuine PREFIX of the path, so it can
		// be read as one. The left-clipping clamp could not satisfy this at any width.
		//
		// Three spellings are accepted because the segment chooses one before clamping and
		// which it chooses is the fixture's business, not this contract's: absolute, the
		// home dir collapsed to `~`, or -- as here, since the temp-dir helper builds under
		// `os.tmpdir()` and `SCRATCH_ROOTS` names it -- relative to the scratch root. The
		// leading folder icon is dropped first; it is chrome, not path.
		const shown = trimmed.slice(0, -ELLIPSIS.length);
		const core = shown.slice(Math.max(0, shown.search(/[\w~/]/)));
		const spellings = [wideCwd, wideCwd.replace(os.homedir(), "~"), path.relative(os.tmpdir(), wideCwd)];

		expect(core.length).toBeGreaterThan(10);
		expect(spellings.some(full => full.startsWith(core))).toBe(true);
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
		const collapsed = (
			pathText(statusLine.renderQuietLine(width) ?? "", statusLine.getQuietSegmentBounds()) ?? ""
		).trim();

		statusLine.togglePathExpanded();
		expect(statusLine.renderQuietLine(width)).not.toBeNull();
		const expanded = (
			pathText(statusLine.renderQuietLine(width) ?? "", statusLine.getQuietSegmentBounds()) ?? ""
		).trim();

		expect(collapsed.endsWith(ELLIPSIS)).toBe(true);
		expect(expanded.length).toBeGreaterThan(collapsed.length);
		expect(expanded.startsWith(collapsed.slice(0, -ELLIPSIS.length))).toBe(true);
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
		const wide = pathText(statusLine.renderQuietLine(160) ?? "", statusLine.getQuietSegmentBounds());

		expect(statusLine.renderQuietLine(70)).not.toBeNull();
		const narrow = pathText(statusLine.renderQuietLine(70) ?? "", statusLine.getQuietSegmentBounds());

		expect((narrow ?? "").trim().length).toBeLessThan((wide ?? "").trim().length);
		expect((narrow ?? "").trimStart().startsWith(ELLIPSIS)).toBe(false);
	});
});
