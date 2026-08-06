/**
 * What survives the composer footline's width shed at the widths terminals are.
 *
 * WHY THIS SUITE EXISTS. Three separate defects, all of the same shape: code that runs, produces
 * a segment, and then throws it away before anything reaches the screen.
 *
 *  1. THE GAUGE DIED FIRST. `#gatherQuietSegments` appends the context gauge AFTER the right
 *     group on purpose, with a comment calling it "the footline's one LIVE value" and wanting it
 *     to be the line's last word. The shed walks from the END of the right group. So the two
 *     rules together guaranteed that the first thing dropped on any width that did not fit was
 *     the gauge, and the thing kept in its place was `session_name`, a fixed string. On the
 *     DEFAULT preset at 80 columns there was no gauge at all; on `full` at 160 you got a
 *     cache-hit percentage and no idea how much room was left.
 *
 *  2. THE APPROVAL RUNG DIED SECOND, and the rule that would have saved it existed only in dead
 *     code. `StatusLineComponent.#buildStatusLine` refused to shed `mode` ahead of the model name
 *     or the profile chip, because `mode` carries the approval rung and is the one place that
 *     says whether the next command will ask before it runs. That method had ZERO production
 *     callers — it fed `getTopBorder`, which nothing called either. The footline, which is what
 *     actually renders, had no such rule.
 *
 *  3. THE PRESET'S PATH BUDGET WAS OVERRIDDEN. `#gatherQuietSegments` pinned
 *     `path.maxLength` to 30, discarding both the preset's own budget (40 on `default`, 60 on
 *     `nerd`) and any `statusLine.segmentOptions.path.maxLength` the operator set. Choosing
 *     `nerd` for its long paths changed nothing on screen.
 *
 * These are asserted at 80, 100 and 120 columns because a proof at one width proves one width,
 * and the shed only bites at some of them. The width handed to `renderQuietLine` is the terminal
 * width minus `COMPOSER_INSET_COLS`; the footline then keeps one cell of right margin, so the
 * budget a segment competes for is `columns - 3`. Rendering at `columns` would over-report the
 * room by three cells and hide a shed exactly at the boundary.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { COMPOSER_INSET_COLS } from "@veyyon/coding-agent/modes/components/composer-chrome";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/components/status-line/presets";
import type { StatusLinePreset } from "@veyyon/coding-agent/modes/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { visibleWidth } from "@veyyon/tui";

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
});

/** Terminal widths people actually run. */
const COLUMNS = [80, 100, 120] as const;
const PRESETS = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];

/**
 * The width `renderQuietLine` is handed for a terminal of `columns`: the composer insets by
 * `COMPOSER_INSET_COLS`, and the footline itself keeps one more cell of right margin, so the
 * budget segments compete for is one less again.
 */
function given(columns: number): number {
	return columns - COMPOSER_INSET_COLS;
}
/**
 * A session with a value for every segment the presets can ask for, all fixed. Real values would
 * make two runs differ because the clock advanced, and the shed is a width question.
 */
function stubSession(cwd = "/home/you/code/veyyon"): AgentSession {
	return {
		state: { messages: [{ role: "user", content: "hi" }], model: { contextWindow: 200_000 } },
		messages: [{ role: "user", content: "hi" }],
		model: { id: "gpt-5", name: "gpt-5", contextWindow: 200_000 },
		contextUsageRevision: 0,
		systemPrompt: ["You are helpful."],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isAdvisorActive: () => false,
		isFastModeActive: () => false,
		isFastModeEnabled: () => false,
		isApprovalBypassed: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getCurrentModel: () => undefined,
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000, percent: 42 }),
		modelRegistry: { isUsingOAuth: () => false },
		settings: { getGroup: () => ({ enabled: false, strategy: "off", threshold: "85%" }) },
		sessionManager: {
			getSessionName: () => "parser-rewrite",
			getCwd: () => cwd,
			getUsageStatistics: () => ({
				input: 12_000,
				output: 5_000,
				cacheRead: 40_000,
				cacheWrite: 1_000,
				totalTokens: 17_000,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 2,
				cost: 0.42,
			}),
		},
	} as unknown as AgentSession;
}

/**
 * Render `preset` for a terminal of `columns` and report which segments survived and how wide
 * each landed. Widths come from the recorded layout rather than from splitting the styled line:
 * the separator carries SGR bytes, so a text split measures the escape sequences too.
 */
function survivors(
	preset: StatusLinePreset,
	columns: number,
	extra?: { cwd?: string; segmentOptions?: Record<string, unknown> },
): { line: string; ids: string[]; widthOf: (id: string) => number } {
	const component = new StatusLineComponent(stubSession(extra?.cwd));
	component.updateSettings({ preset, ...(extra?.segmentOptions ? { segmentOptions: extra.segmentOptions } : {}) });
	const line = component.renderQuietLine(given(columns)) ?? "";
	const slots = component
		.getQuietSegmentBounds()
		.slice()
		.sort((a, b) => a.start - b.start);
	return {
		line,
		ids: slots.map(slot => slot.id),
		widthOf: id => {
			const slot = slots.find(entry => entry.id === id);
			return slot ? slot.end - slot.start : 0;
		},
	};
}

describe("the footline's width shed keeps the values that decide what you do next", () => {
	/**
	 * DEFECT 1. Before the fix this failed on `default` at 80 and on `full`/`nerd` at 80, 100 and
	 * 120 — every preset that could not fit its whole right group dropped the gauge first, because
	 * the gauge is deliberately appended last and the shed walks from the end.
	 */
	it("never sheds the context gauge, on any preset, at any realistic width", () => {
		for (const columns of COLUMNS) {
			for (const preset of PRESETS) {
				const { ids } = survivors(preset, columns);
				expect(`${preset}@${columns}: ${ids.includes("context_pct")}`).toBe(`${preset}@${columns}: true`);
			}
		}
	});

	/**
	 * DEFECT 2. `mode` carries the approval rung. The rule protecting it lived in
	 * `#buildStatusLine`, which had no production callers; the footline shed it ahead of the model
	 * name and the profile chip. Before the fix this failed on `default` at 80.
	 */
	it("never sheds the approval rung, on any preset, at any realistic width", () => {
		for (const columns of COLUMNS) {
			for (const preset of PRESETS) {
				const { ids } = survivors(preset, columns);
				expect(`${preset}@${columns}: ${ids.includes("mode")}`).toBe(`${preset}@${columns}: true`);
			}
		}
	});

	/**
	 * NON-VACUITY. If nothing were ever shed the two tests above would pass on a footline that
	 * simply always fits, which would prove nothing about the shed's priorities. `full` configures
	 * twenty segments; at 80 columns most of them must be gone.
	 */
	it("does shed, so the two tests above are about priority and not about slack", () => {
		const { ids } = survivors("full", 80);
		const configured = STATUS_LINE_PRESETS.full.leftSegments.length + STATUS_LINE_PRESETS.full.rightSegments.length;

		expect(configured).toBeGreaterThanOrEqual(18);
		expect(ids.length).toBeLessThan(configured / 2);
		expect(ids).not.toContain("cost");
	});

	/**
	 * THE FIX FOR THE FIX. Protecting the gauge and the rung was first written as a boolean, and a
	 * boolean cannot be right: below the realistic widths above there is a point where every
	 * remaining part is protected, the shed has nothing legal to drop, and it fell through to
	 * truncating the whole joined right group. At a one-cell budget that rendered a bare `…` and
	 * destroyed all four at once, including the persistent subagent count that
	 * `status-line-running-subagents.test.ts` has always required to be the last thing standing.
	 *
	 * So the degradation below 80 columns is ORDERED, weakest first: the gauge goes, then the
	 * approval rung, then the owner zone, and the count is alone on the line before anything
	 * clips it. These widths are not ones anybody runs; they are the pressure that proves the
	 * ranking resolves instead of collapsing.
	 */
	it("degrades the protected parts in rank order instead of destroying them together", () => {
		const seen: string[][] = [];
		for (const columns of [40, 24, 16, 10, 6]) {
			seen.push(survivors("default", columns).ids);
		}

		// The gauge is the first of the ranked parts to go and the count the last.
		const gaugeGone = seen.findIndex(ids => !ids.includes("context_pct"));
		const rungGone = seen.findIndex(ids => !ids.includes("mode"));
		const countGone = seen.findIndex(ids => !ids.includes("subagents"));
		expect(gaugeGone).toBeGreaterThan(-1);
		expect(rungGone).toBeGreaterThan(gaugeGone);
		expect(countGone === -1 || countGone > rungGone).toBe(true);

		// And the count itself is never clipped away. The collapse rendered the whole
		// right group as a bare `…`; a truncated PATH may still legitimately carry one,
		// so this asserts the chip's own text survived rather than the line's.
		for (const columns of [40, 24, 16, 10, 6]) {
			const { line, ids, widthOf } = survivors("default", columns);
			if (!ids.includes("subagents")) continue;
			const plain = line.replaceAll(/\x1b\[[0-9;]*m/g, "");
			expect(`${columns}: ${plain.includes("0")}`).toBe(`${columns}: true`);
			expect(`${columns}: ${widthOf("subagents")}`).toBe(`${columns}: 1`);
		}
	});

	/** The whole point of the shed: the line has to fit the budget it was given. */
	it("never renders wider than the budget, on any preset, at any realistic width", () => {
		for (const columns of COLUMNS) {
			for (const preset of PRESETS) {
				const { line } = survivors(preset, columns);
				expect(`${preset}@${columns}: ${visibleWidth(line) <= given(columns) - 1}`).toBe(
					`${preset}@${columns}: true`,
				);
			}
		}
	});
});

describe("the preset's path budget reaches the footline", () => {
	/** Long enough that a 30-cell budget must ellipsize it and a 60-cell one need not. */
	const LONG_CWD = "/srv/workspaces/acme-platform/services/ingestion-pipeline/worker";

	/**
	 * DEFECT 3. `path.maxLength` was pinned to 30 in `#gatherQuietSegments`, so `nerd` (60) and
	 * `minimal` (30) rendered the same path and the difference the operator selected a preset FOR
	 * did not exist. 120 columns, so the shed is not what makes them differ.
	 */
	it("renders a longer path on nerd than on minimal, because their budgets differ", () => {
		expect(STATUS_LINE_PRESETS.nerd.segmentOptions?.path?.maxLength).toBe(60);
		expect(STATUS_LINE_PRESETS.minimal.segmentOptions?.path?.maxLength).toBe(30);

		const nerd = survivors("nerd", 120, { cwd: LONG_CWD });
		const minimal = survivors("minimal", 120, { cwd: LONG_CWD });

		expect(minimal.widthOf("path")).toBeLessThanOrEqual(30);
		expect(nerd.widthOf("path")).toBeGreaterThan(minimal.widthOf("path"));
		expect(nerd.widthOf("path")).toBeLessThanOrEqual(60);
	});

	/**
	 * The operator's own `statusLine.segmentOptions.path.maxLength` was discarded by the same
	 * pin. A user override beats the preset, and 30 survives only as the fallback for a preset
	 * that names no budget at all.
	 */
	it("lets the operator's segment option beat the preset's budget", () => {
		const pinned = survivors("nerd", 120, { cwd: LONG_CWD, segmentOptions: { path: { maxLength: 8 } } });

		expect(pinned.widthOf("path")).toBeLessThanOrEqual(8);
		expect(pinned.widthOf("path")).toBeGreaterThan(0);
	});
});
