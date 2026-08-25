/**
 * The model name survives a wide location zone on the composer footline.
 *
 * THE DEFECT. `RIGHT_PART_SHED_RANK` in the status line ranked `context_pct`,
 * `mode`, `location_right` and `subagents`, and left `model` unlisted. Unlisted
 * ranks 0, and rank 0 is shed BEFORE the location zone is shortened, so a wide
 * working directory plus a long git branch dropped the active model name off the
 * footline while an untruncated path still occupied the whole left side. Nothing
 * on screen said which model was answering until the terminal was widened.
 *
 * THE CLASS. Priority inversion in footline degradation: a right-group part with
 * no rank is destroyed before truncatable location chrome is touched. Any part
 * added to the right group without a rank decision reproduces it.
 *
 * HOW THIS SUITE CLOSES THE CLASS.
 *   - Location pressure is REAL, not asserted into existence: the session's cwd is
 *     a fixture directory whose `.git/HEAD` names a 63-column branch, so `path`
 *     and `git` together fill most of the row on any machine. `git.head.resolveSync`
 *     reads that file, so the branch needs no git process and no network.
 *   - The shed order is observed as an INVARIANT over a full width sweep rather
 *     than pinned at the three widths in the report: the set of right-group parts
 *     on screen must always be a suffix of the documented ranking, and a part that
 *     has been shed must never come back at a narrower width.
 *   - The inventory of segment ids any preset can place in the right group is
 *     pinned by exact equality, derived from `STATUS_LINE_PRESETS` at run time.
 *     Adding a segment to any preset turns this suite red until someone gives the
 *     new id a rank or records it as deliberately unranked.
 *   - The members of `mode` -- the base modes and the approval rungs -- are pinned
 *     the same way, because the capture matrix in `proof/scenes/statusline-widths.sh`
 *     carries one frame per member and nothing else notices a new one. A sixth base
 *     mode or rung lands with no frame and no failure otherwise.
 *
 * WHAT IT DOES NOT CATCH. `subagents` (rank 5, the last part standing) renders
 * empty text in a session with no subagents, so it has no slot to observe here;
 * `status-line-running-subagents.test.ts` owns that contract. Nothing here checks
 * the text inside a segment -- colour, provider icon, or thinking-level suffix.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import * as path from "node:path";
import { Settings } from "@veyyon/coding-agent/config/settings";
import type { QuietSegmentBounds } from "@veyyon/coding-agent/modes/components/status-line/component";
import { FLOOR_SPENDABLE, StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line/component";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/components/status-line/presets";
import { BASE_MODE_STATES } from "@veyyon/coding-agent/modes/components/status-line/segments";
import type { StatusLinePreset } from "@veyyon/coding-agent/modes/components/status-line/types";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AUTONOMY_LABEL } from "@veyyon/coding-agent/tools/approval-modes";
import { useTrackedTempDirs } from "../../../helpers/tracked-temp-dir";

/**
 * A branch name wide enough that the location zone cannot share the row with the
 * right group at any ordinary terminal width. 63 columns.
 */
const WIDE_BRANCH = "feature/statusline-keeps-the-model-under-a-very-long-branch-name";

/** `path`, `git` and `pr` are the location zone; everything else is right group. */
const LOCATION_SEGMENT_IDS = ["git", "path", "pr"] as const;

/**
 * The documented ranking, weakest first: an unranked part (rank 0), then ranks 1
 * through 4. `subagents` (rank 5) is excluded because it renders no text without
 * a running subagent — see the header. `session_name` stands in for rank 0: the
 * fixture session has a name, so the segment renders and can be observed being
 * shed first.
 */
const SHED_ORDER_WEAKEST_FIRST = ["session_name", "context_pct", "model", "mode", "location_right"] as const;

/**
 * Every segment id any preset can place OUTSIDE the location zone, and therefore
 * every id the shed ranking has to have an answer for. Pinned by equality so a
 * new preset member fails this suite rather than silently ranking 0.
 */
const RIGHT_GROUP_CAPABLE_SEGMENT_IDS = [
	"account",
	"cache_hit",
	"cache_read",
	"cache_write",
	"context_pct",
	"context_total",
	"cost",
	"hostname",
	"mode",
	"model",
	"pi",
	"profile",
	"secrets",
	"session",
	"session_name",
	"subagents",
	"time",
	"time_spent",
	"token_in",
	"token_out",
	"token_rate",
	"token_total",
] as const;

/** The presets whose segment lists declare `model`. `minimal` deliberately does not. */
const PRESETS_DECLARING_MODEL: StatusLinePreset[] = ["ascii", "compact", "custom", "default", "full", "nerd"];

const makeTempDir = useTrackedTempDirs("veyyon-statusline-wide-location-");

let wideCwd = "";

function makeSession(modelId: string): AgentSession {
	return {
		messages: [],
		model: { id: modelId, name: modelId, contextWindow: 128000 },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 16000, contextWindow: 128000 }),
		state: { messages: [], model: { id: modelId, name: modelId, contextWindow: 128000 } },
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

/** The right edge of the location zone on the line just rendered, in columns. */
function locationEnd(bounds: readonly QuietSegmentBounds[]): number {
	let end = 0;
	for (const slot of bounds) {
		if ((LOCATION_SEGMENT_IDS as readonly string[]).includes(slot.id)) end = Math.max(end, slot.end);
	}
	return end;
}

function renderedIds(bounds: readonly QuietSegmentBounds[]): Set<string> {
	const ids = new Set<string>();
	for (const slot of bounds) {
		if (slot.end > slot.start) ids.add(slot.id);
	}
	return ids;
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);

	// A cwd deep enough to fill the path budget, in a repo whose HEAD names the
	// wide branch. `git.head.resolveSync` reads `.git/HEAD` directly, so this is
	// the whole fixture: no `git init`, no subprocess, identical on every host.
	wideCwd = path.join(makeTempDir(), "platform-services", "ingest-pipeline", "normalizer");
	mkdirSync(path.join(wideCwd, ".git"), { recursive: true });
	writeFileSync(path.join(wideCwd, ".git", "HEAD"), `ref: refs/heads/${WIDE_BRANCH}\n`);
});

describe("the model segment survives long paths and branch names", () => {
	it("keeps the model on the footline at 80, 100 and 120 columns by shortening the location instead", () => {
		const statusLine = new StatusLineComponent(makeSession("claude-3-7-sonnet"));

		// The unpressured line first: this is the width the location zone WANTS,
		// and it is what makes the assertions below non-vacuous.
		expect(statusLine.renderQuietLine(400)).not.toBeNull();
		const relaxedLocationEnd = locationEnd(statusLine.getQuietSegmentBounds());
		expect(relaxedLocationEnd).toBeGreaterThan(50);

		for (const width of [80, 100, 120]) {
			const line = statusLine.renderQuietLine(width);
			expect(line).not.toBeNull();
			const bounds = statusLine.getQuietSegmentBounds();

			// The fix: the model is still on the line...
			expect([...renderedIds(bounds)]).toContain("model");
			// ...and the reason it fits is that the location gave up columns.
			expect(locationEnd(bounds)).toBeLessThan(relaxedLocationEnd);
		}
	});

	// The row has two ladders and they answer different questions. The FIT ladder decides what
	// the row gives up to fit at all, and it runs strictly weakest-first, so what is on screen
	// is a suffix of the ranking. The FLOOR ladder runs after that, only while the location zone
	// is still under the width at which a directory and a branch read as themselves, and it pays
	// with parts that are re-readable rather than with the next part in rank order -- a token
	// estimate goes before the model chip, whatever their ranks say.
	//
	// So an out-of-rank absence is not free: the part must be one the floor is allowed to spend,
	// and the spend must have bought something, meaning the location is on the row. A part that
	// vanished while the location zone is empty was not spent, it was lost.
	const SPENDABLE_ON_THE_FLOOR = ["badges", "context_pct", "context_total", "location_right", "subagents"];

	it("sheds the right group as a suffix of the ranking, except for what the location's floor may spend", () => {
		// Pinned by equality rather than read from source into the assertion: a new spendable
		// part widens the exemption below, and that is a decision, not a detail.
		expect(Object.keys(FLOOR_SPENDABLE).sort()).toEqual(SPENDABLE_ON_THE_FLOOR);

		const statusLine = new StatusLineComponent(makeSession("gpt-4o"));

		const shed = new Set<string>();
		let sawTheFloorSpendSomething = false;
		for (let width = 130; width >= 8; width--) {
			expect(statusLine.renderQuietLine(width, { locationRight: "mcp 3/3" })).not.toBeNull();
			const bounds = statusLine.getQuietSegmentBounds();
			const present = renderedIds(bounds);

			// Ranked parts on screen must form a SUFFIX of the ranking: a part may
			// only be missing when every weaker part is missing too. `model` ranked 0
			// (the defect) breaks this the moment `context_pct` outlives it.
			const firstPresent = SHED_ORDER_WEAKEST_FIRST.findIndex(id => present.has(id));
			if (firstPresent >= 0) {
				const missing = SHED_ORDER_WEAKEST_FIRST.slice(firstPresent).filter(id => !present.has(id));
				const locationOnScreen = locationEnd(bounds) > 0;
				const spent = missing.filter(id => SPENDABLE_ON_THE_FLOOR.includes(id) && locationOnScreen);
				if (spent.length > 0) sawTheFloorSpendSomething = true;
				expect({ width, missing: missing.filter(id => !spent.includes(id)) }).toEqual({ width, missing: [] });
			}

			// The model chip and the mode rungs are never what the floor spends, at any width.
			// This is the assertion the exemption above must not be able to loosen.
			const weakerThanTheModel = SHED_ORDER_WEAKEST_FIRST.slice(0, SHED_ORDER_WEAKEST_FIRST.indexOf("model")).filter(
				id => present.has(id),
			);
			if (weakerThanTheModel.length > 0) expect([...present]).toContain("model");

			// Shedding is monotone: narrowing the terminal never restores a part.
			for (const id of SHED_ORDER_WEAKEST_FIRST) {
				if (present.has(id)) expect(shed.has(id)).toBe(false);
				else shed.add(id);
			}
		}

		// The exemption has to have been exercised, or it is excusing nothing and the sweep
		// proved the unqualified rule instead of this one.
		expect(sawTheFloorSpendSomething).toBe(true);

		// The sweep has to have actually degraded something, or the invariant above
		// was checked against a line that never lost a part.
		expect([...shed].sort()).toEqual(["context_pct", "location_right", "mode", "model", "session_name"]);
	});

	it("keeps the model when the owner pins content to the location line's right edge", () => {
		const statusLine = new StatusLineComponent(makeSession("deepseek-r1"));

		// `location_right` (rank 4) outranks the model, so it is the model that has
		// to survive alongside it rather than instead of it.
		expect(statusLine.renderQuietLine(100, { locationRight: "mcp 3/3" })).not.toBeNull();
		const present = [...renderedIds(statusLine.getQuietSegmentBounds())];
		expect(present).toContain("model");
		expect(present).toContain("location_right");
	});

	it("never overlaps two slots or runs one past the terminal edge while the location is truncated", () => {
		const statusLine = new StatusLineComponent(makeSession("claude-3-5-haiku"));

		for (let width = 130; width >= 8; width--) {
			expect(statusLine.renderQuietLine(width, { locationRight: "mcp 3/3" })).not.toBeNull();
			const sorted = [...statusLine.getQuietSegmentBounds()].sort((a, b) => a.start - b.start);
			for (const slot of sorted) {
				expect(slot.end).toBeLessThanOrEqual(width);
			}
			for (let i = 1; i < sorted.length; i++) {
				expect(sorted[i]!.start).toBeGreaterThanOrEqual(sorted[i - 1]!.end);
			}
		}
	});

	it("retains the model in every preset that declares it, under the same location pressure", () => {
		const declaring = (Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[])
			.filter(name => {
				const def = STATUS_LINE_PRESETS[name];
				return def.leftSegments.includes("model") || def.rightSegments.includes("model");
			})
			.sort();
		expect(declaring).toEqual(PRESETS_DECLARING_MODEL);

		for (const preset of declaring) {
			const statusLine = new StatusLineComponent(makeSession("claude-3-7-sonnet"));
			statusLine.updateSettings({ preset } as never);
			expect(statusLine.renderQuietLine(80)).not.toBeNull();
			expect([...renderedIds(statusLine.getQuietSegmentBounds())]).toContain("model");
		}
	});

	it("names every segment a preset can put in the right group, so a new one needs a rank decision", () => {
		const ids = new Set<string>();
		for (const def of Object.values(STATUS_LINE_PRESETS)) {
			for (const id of [...def.leftSegments, ...def.rightSegments]) {
				if (!(LOCATION_SEGMENT_IDS as readonly string[]).includes(id)) ids.add(id);
			}
		}
		expect([...ids].sort()).toEqual([...RIGHT_GROUP_CAPABLE_SEGMENT_IDS]);
	});

	// The `mode` segment is the widest thing in the right group and the only one whose
	// content is a composition: a bypass marker, one base mode, one approval rung. The
	// capture matrix carries a frame per member, so a member added without a frame is a
	// hole in the evidence rather than in the code, and no other suite reads either table.
	// Pinned by equality, not by count, and derived from the exported tables at run time.
	//
	// `prewalk` has no frame on purpose: arming it needs a fast model distinct from the
	// session's own, which the capture host does not serve. It stays in this list because
	// the list is the render order, and losing it here would hide a reordering.
	it("names every base mode and approval rung, so a new one needs a frame", () => {
		expect(BASE_MODE_STATES.map(state => state.id)).toEqual(["plan", "prewalk", "goal", "vibe", "loop"]);
		expect(Object.keys(AUTONOMY_LABEL).sort()).toEqual(["ask", "ask-command", "auto", "plan", "yolo"]);
	});
});
