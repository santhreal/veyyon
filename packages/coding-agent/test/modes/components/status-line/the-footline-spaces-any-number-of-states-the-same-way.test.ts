/**
 * The composer footline reads the same however many states are on it.
 *
 * THE DEFECT. The `mode` segment glued its independent states together with a
 * bare space, so with three of them live the row read
 * `! YOLO Goal 12K/50K 25%`: the boundary between the approval bypass and the
 * goal was spelled exactly like the space between the goal and its own token
 * count, and the operator could not tell three facts from one phrase. It was
 * invisible in every single-state screenshot, which is why it shipped.
 *
 * THE CLASS. Not "one join used the wrong string" — "spacing is decided at
 * each call site". Four surfaces each picked their own separator (the footline
 * hardcoded `"  ·  "` twice, the badge slot `" · "`, the mode segment `" "`),
 * so the grammar was right by coincidence at whatever state count the author
 * happened to look at. The fix is one owner with two strengths
 * (`./state-grammar`), and this suite pins the grammar over the WHOLE state
 * space rather than over the reported combination:
 *
 *   - every base mode is enumerated from `BASE_MODE_STATES` at run time, so a
 *     mode added later is swept the day it lands, and a mode this suite cannot
 *     activate fails it rather than being skipped;
 *   - every approval rung is enumerated from `AUTONOMY_LABEL`;
 *   - every symbol preset is enumerated from `SYMBOL_PRESETS`, because the
 *     separator glyph is the preset's and a hardcoded `·` is invisible while
 *     the default preset also spells it `·`.
 *
 * WHAT IT DOES NOT CATCH. It judges the mode segment and the footline's
 * segment joins. It says nothing about whether a segment's INTERNAL readout is
 * well spaced (`▰▰▰▱ 58% left ∞` is one state's own values by declaration), and
 * nothing about color, order, or shedding under width pressure — those have
 * their own suites.
 */
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { BASE_MODE_STATES, SEGMENTS } from "@veyyon/coding-agent/modes/components/status-line/segments";
import {
	joinStates,
	segmentSeparator,
	stateSeparator,
} from "@veyyon/coding-agent/modes/components/status-line/state-grammar";
import type { SegmentContext } from "@veyyon/coding-agent/modes/components/status-line/types";
import { SYMBOL_PRESETS } from "@veyyon/coding-agent/modes/theme/symbols";
import {
	createTheme,
	getBuiltinThemes,
	getThemeByName,
	setThemeInstance,
	type Theme,
	theme,
} from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AUTONOMY_LABEL } from "@veyyon/coding-agent/tools/approval-modes";
import { visibleWidth } from "@veyyon/tui";
import { stripAnsi } from "@veyyon/utils/strip-ansi";

/** The context patch that turns one base mode on, keyed by its id in the table. */
const ACTIVATORS: Record<string, Partial<SegmentContext>> = {
	plan: { planMode: { enabled: true, paused: false } },
	prewalk: { prewalk: { enabled: true } },
	goal: { goalMode: { enabled: true, paused: false } },
	vibe: { vibeMode: { enabled: true } },
	loop: { loopMode: { enabled: true } },
};

interface Load {
	/** Base mode id from the table, or null for "no mode active". */
	readonly mode: string | null;
	readonly bypassed: boolean;
	readonly rung: string;
	/** A goal with a budget, so the goal state carries its own multi-word readout. */
	readonly withBudget?: boolean;
}

function makeContext(load: Load): SegmentContext {
	const goalState = load.withBudget
		? { goal: { tokensUsed: 12_345, tokenBudget: 50_000, status: "active" } }
		: undefined;
	const session = {
		settings: {
			get: (path: string) => (path === "goal.modelBudgetsEnabled" ? true : undefined),
			getGroup: () => ({ enabled: false }),
		},
		effectiveApprovalMode: () => load.rung,
		isApprovalBypassed: () => load.bypassed,
		getGoalModeState: () => goalState,
		isStreaming: false,
	} as unknown as AgentSession;

	return {
		session,
		activeRepo: null,
		width: 160,
		options: {},
		compactThinkingLevel: false,
		planMode: null,
		prewalk: null,
		loopMode: null,
		goalMode: null,
		vibeMode: null,
		collab: null,
		activeMs: 0,
		...(load.mode ? ACTIVATORS[load.mode] : {}),
	} as unknown as SegmentContext;
}

/** Every load the segment can be under: mode × bypass × rung, plus the budgeted goal. */
function everyLoad(): Load[] {
	const modes: (string | null)[] = [null, ...BASE_MODE_STATES.map(state => state.id)];
	const rungs = Object.keys(AUTONOMY_LABEL);
	const loads: Load[] = [];
	for (const mode of modes) {
		for (const bypassed of [false, true]) {
			for (const rung of rungs) {
				loads.push({ mode, bypassed, rung });
				if (mode === "goal") loads.push({ mode, bypassed, rung, withBudget: true });
			}
		}
	}
	return loads;
}

/** How many INDEPENDENT states this load puts on the segment, counted from the load alone. */
function expectedStateCount(load: Load): number {
	const bypass = load.bypassed ? 1 : 0;
	const base = load.mode === null ? 0 : 1;
	// The bypass replaces the rung (naming a rung that is not enforced would be a
	// lie), and an open plan session already says "Plan" in the base label.
	const rung = !load.bypassed && load.mode !== "plan" ? 1 : 0;
	return bypass + base + rung;
}

function renderMode(load: Load): string {
	return SEGMENTS.mode.render(makeContext(load)).content;
}

let priorTheme: Theme | undefined;

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	priorTheme = await getThemeByName("dark");
	if (!priorTheme) throw new Error("theme unavailable");
	setThemeInstance(priorTheme);
});

afterAll(() => {
	// Leave the process on the theme every other suite expects; these cases swap
	// the symbol preset underneath the shared instance.
	if (priorTheme) setThemeInstance(priorTheme);
});

/** Run `body` with every symbol preset active, named so a failure says which one. */
function forEachSymbolPreset(body: (preset: string) => void): void {
	const dark = getBuiltinThemes().dark;
	if (!dark) throw new Error("builtin dark theme unavailable");
	for (const preset of Object.keys(SYMBOL_PRESETS)) {
		setThemeInstance(createTheme(dark, { symbolPresetOverride: preset as "unicode" }));
		body(preset);
	}
	if (priorTheme) setThemeInstance(priorTheme);
}

describe("the state grammar", () => {
	/**
	 * The two strengths have to be TELLABLE APART and have to come from the same
	 * glyph, or the reader learns two symbols and the ascii preset — which exists
	 * for terminals that cannot draw `·` — gets one anyway.
	 */
	it("separates segments more strongly than states, with the preset's own glyph", () => {
		forEachSymbolPreset(preset => {
			const state = stripAnsi(stateSeparator());
			const segment = stripAnsi(segmentSeparator());
			const glyph = theme.sep.dot.trim();

			expect(`${preset}:${state.trim()}`).toBe(`${preset}:${glyph}`);
			expect(`${preset}:${segment.trim()}`).toBe(`${preset}:${glyph}`);
			expect(visibleWidth(segment)).toBeGreaterThan(visibleWidth(state));
			expect(visibleWidth(state)).toBeGreaterThan(visibleWidth(glyph));
		});
	});

	/**
	 * The three failures a hand-written `[a, b, c].join(" ")` produces the moment
	 * one part is empty, which is the ordinary case here: most loads have one or
	 * two of the three states.
	 */
	it("never emits a leading, trailing, or doubled separator when a state is absent", () => {
		const sep = stripAnsi(stateSeparator());
		expect(stripAnsi(joinStates("", "a", ""))).toBe("a");
		expect(stripAnsi(joinStates("a", "", "b"))).toBe(`a${sep}b`);
		expect(stripAnsi(joinStates(null, undefined, false, "a"))).toBe("a");
		expect(stripAnsi(joinStates("", "", ""))).toBe("");
		expect(stripAnsi(joinStates("a", "b", "c"))).toBe(`a${sep}b${sep}c`);
	});
});

describe("the mode segment over its whole state space", () => {
	/**
	 * Rule 4 of the regression contract: a member this suite cannot construct is
	 * a HOLE, not a pass. If a base mode lands in the table with no activator
	 * here, this goes red instead of silently sweeping four modes out of five.
	 */
	it("can activate every base mode the table declares", () => {
		const unreachable = BASE_MODE_STATES.filter(state => {
			if (!ACTIVATORS[state.id]) return true;
			return renderMode({ mode: state.id, bypassed: false, rung: "auto" }) === "";
		}).map(state => state.id);

		expect(unreachable).toEqual([]);
	});

	/**
	 * THE INVARIANT. Whatever states are live, the content is exactly those
	 * states joined by the state separator: no other boundary spelling exists in
	 * it, none of them carries stray padding, and the rendered width is the sum
	 * of the parts plus the separators. This is the property the reported bug
	 * violated, stated once for every combination rather than for the one that
	 * was reported.
	 */
	it("joins any number of live states with exactly one state separator each", () => {
		forEachSymbolPreset(preset => {
			const sep = stripAnsi(stateSeparator());
			const segSep = stripAnsi(segmentSeparator());
			for (const load of everyLoad()) {
				const where = `${preset} mode=${load.mode} bypass=${load.bypassed} rung=${load.rung}`;
				const rendered = SEGMENTS.mode.render(makeContext(load));
				const plain = stripAnsi(rendered.content);
				const count = expectedStateCount(load);

				expect(`${where} visible=${rendered.visible}`).toBe(`${where} visible=${count > 0}`);
				if (count === 0) {
					expect(`${where}:${plain}`).toBe(`${where}:`);
					continue;
				}
				expect(`${where}:${plain.trim()}`).toBe(`${where}:${plain}`);
				// A segment-strength boundary inside a segment would be the same
				// mistake in the other direction: it reads as two segments.
				expect(`${where}:${plain.includes(segSep)}`).toBe(`${where}:false`);

				const states = plain.split(sep);
				expect(`${where}:${states.length}`).toBe(`${where}:${count}`);
				for (const state of states) {
					expect(`${where}:${state}`).not.toBe(`${where}:`);
					expect(`${where}:${state.trim()}`).toBe(`${where}:${state}`);
					// One state's own values are bound with single spaces; two spaces
					// anywhere means a boundary was spelled with padding instead.
					expect(`${where}:${state.includes("  ")}`).toBe(`${where}:false`);
				}
				expect(`${where}:${visibleWidth(plain)}`).toBe(
					`${where}:${states.reduce((sum, s) => sum + visibleWidth(s), 0) + (count - 1) * visibleWidth(sep)}`,
				);
			}
		});
	});

	/**
	 * The bypass is the state whose spacing bug was reported, and it is also the
	 * one that must never be swallowed: it stands BESIDE the mode label and
	 * REPLACES the rung.
	 */
	it("stands the bypass beside the mode label and in place of the rung", () => {
		for (const state of BASE_MODE_STATES) {
			const plain = stripAnsi(renderMode({ mode: state.id, bypassed: true, rung: "ask" }));
			const [first, ...rest] = plain.split(stripAnsi(stateSeparator()));

			expect(first?.endsWith("YOLO")).toBe(true);
			expect(rest.length).toBe(1);
			expect(rest[0]).not.toBe(AUTONOMY_LABEL.ask);
		}
	});
});
