/**
 * Viewing an agent says whose session you are in and how to get out, on every preset.
 *
 * WHY THIS SUITE EXISTS. Opening an agent from `/agents` hands the entire main view to that
 * agent's session: the transcript becomes theirs, the composer stays live, and Esc quietly
 * changes meaning from "clear the line" to "go back". The only thing that ever said so was a
 * single status flash printed by `SessionFocusController.focusAgent`, and a flash is gone in a
 * second. After it the screen is indistinguishable from an ordinary session, so people ended up
 * inside a view whose edge they could not see.
 *
 * AND THE ONE PERSISTENT SIGNAL WAS A PRESET OPT-IN, which is the defect these tests were written
 * against. The focused agent's name was rendered by the `pi` status-line segment, and `pi` appears
 * only in the `full` and `nerd` presets. On `default`, `minimal`, `compact` and `ascii` the proxied
 * bar was the unproxied bar with a dim applied, so the entire announcement that you had left your
 * own session was a shade of grey. A render proof of the default preset in both states showed two
 * bars with identical text; nothing in the suite failed, because nothing asserted it.
 *
 * Focus is a mode of the whole view rather than something you configure on your status line, so
 * `getTopBorder` prefixes the badge itself and no preset can drop it. These tests assert that
 * across EVERY preset, not just the one that was broken, because "it works on default now" is how
 * the same bug comes back on `minimal`.
 */

import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/components/status-line";
import { STATUS_LINE_PRESETS } from "@veyyon/coding-agent/modes/components/status-line/presets";
import type { StatusLinePreset } from "@veyyon/coding-agent/modes/components/status-line/types";
import { initTheme } from "@veyyon/coding-agent/modes/theme/theme";
import { visibleWidth } from "@veyyon/tui";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../../helpers/settings-test-state";

let settingsState: SettingsTestState | undefined;

beforeAll(async () => {
	settingsState = beginSettingsTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	restoreSettingsTestState(settingsState);
	settingsState = undefined;
});

const AGENT = "designer-3";
const WIDTH = 100;

function makeSession() {
	return {
		// Fixed values throughout: every segment on the bar reads this stub, and a moving number
		// would make the width assertions below pass or fail on the clock.
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000 }),
		state: { messages: [], model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" } },
		messages: [],
		model: undefined,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		isStreaming: false,
		isAutoThinking: false,
		autoResolvedThinkingLevel: () => undefined,
		isFastModeActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeEnabled: () => false,
		getGoalModeState: () => null,
		getAsyncJobSnapshot: () => ({ running: [] }),
		getPrewalkState: () => undefined,
		isAdvisorActive: () => false,
		configuredThinkingLevel: () => "medium",
		settings: { getGroup: () => ({ enabled: false }) },
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "parser-rewrite",
			getCwd: () => "/home/you/code/veyyon",
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
			}),
		},
	} as unknown as ConstructorParameters<typeof StatusLineComponent>[0];
}

/** The top border for `preset`, focused on {@link AGENT} when `focused`. */
function topBorder(preset: StatusLinePreset, focused: boolean): string {
	const component = new StatusLineComponent(makeSession());
	component.updateSettings({ preset });
	if (focused) component.setSession(makeSession(), AGENT);
	return component.getTopBorder(WIDTH).content;
}

/** Rendered text with every SGR sequence removed, which is what a reader actually sees. */
function plain(content: string): string {
	return content.replaceAll(/\x1b\[[0-9;]*m/g, "");
}

const PRESETS = Object.keys(STATUS_LINE_PRESETS) as StatusLinePreset[];

describe("the status bar while the view is proxied onto an agent", () => {
	/**
	 * THE BUG, on the preset that had it. `default` has no `pi` segment, so before this the
	 * focused and unfocused bars carried the same text and differed only by a dim. Both halves are
	 * asserted in one test on purpose: the agent name without the exit hint is the state that
	 * shipped, and the exit hint without the name would not say which session you are in.
	 */
	it("names the agent and how to leave, on the default preset", () => {
		const focused = plain(topBorder("default", true));

		expect(focused).toContain(AGENT);
		expect(focused).toContain("esc to go back");
	});

	/**
	 * NON-VACUITY, and the direction that matters most: an unproxied bar must not claim you are
	 * inside anything. Without this every assertion above would pass on a badge rendered
	 * unconditionally, which would tell a user sitting in their own session to press Esc to go back
	 * to it.
	 */
	it("says neither of those things when you are on your own session", () => {
		const main = plain(topBorder("default", false));

		expect(main).not.toContain(AGENT);
		expect(main).not.toContain("esc to go back");
		expect(main).not.toContain("go back");
	});

	/**
	 * EVERY preset, because the bug was that this depended on a preset. `default` was broken and
	 * `full` was fine, so a fix verified only on `default` leaves the reader unable to tell whether
	 * the affordance is now unconditional or merely present in two more places. The preset list is
	 * read from the registry rather than typed out, so a new preset joins this test by existing.
	 */
	it("names the agent and how to leave on every preset there is", () => {
		expect(PRESETS.length).toBeGreaterThanOrEqual(6);

		for (const preset of PRESETS) {
			const focused = plain(topBorder(preset, true));

			expect(`${preset}: ${focused.includes(AGENT)}`).toBe(`${preset}: true`);
			expect(`${preset}: ${focused.includes("esc to go back")}`).toBe(`${preset}: true`);
		}
	});

	/**
	 * The badge is NOT dimmed, while the bar behind it is.
	 *
	 * The dim says "this is not your main session", and it is applied to the whole bar. Letting it
	 * cover the badge too would fade the one piece of text that explains the state and names the way
	 * out of it, which is precisely backwards. Asserted on the BYTES because that is where the
	 * distinction lives: the badge has to sit ahead of the `\x1b[2m` opener, and a future edit that
	 * moves the prefix inside the dim wrapper still renders the same characters.
	 */
	it("keeps the badge out of the dim that covers the rest of the bar", () => {
		const focused = topBorder("default", true);
		const dimOpener = focused.indexOf("\x1b[2m");
		const hint = focused.indexOf("esc");

		expect(dimOpener).toBeGreaterThan(-1);
		expect(hint).toBeGreaterThan(-1);
		expect(hint).toBeLessThan(dimOpener);
	});

	/**
	 * Prefixing the badge must not push the bar past the width it was given.
	 *
	 * `#buildStatusLine` fills whatever width it receives, so a prefix added without shrinking that
	 * width would produce a line wider than the terminal, and an over-long top border wraps and
	 * pushes the composer down a row on every render. Checked against the UNFOCUSED width rather
	 * than against `WIDTH` alone, so the bar is proved to have given ground to the badge instead of
	 * merely fitting by luck.
	 */
	it("fits the width it was given, badge included", () => {
		for (const preset of PRESETS) {
			const focusedWidth = visibleWidth(topBorder(preset, true));

			expect(`${preset}: ${focusedWidth <= WIDTH}`).toBe(`${preset}: true`);
		}
	});

	/**
	 * One owner, so the two surfaces cannot contradict each other. `pi` used to render the focused
	 * agent's name itself; with the badge unconditional that would print the name twice on `full`
	 * and `nerd`, which is how a "fix" for the default preset breaks the presets that worked.
	 */
	it("names the agent exactly once, including on the presets that carry the veyyon mark", () => {
		for (const preset of ["full", "nerd"] as const) {
			const focused = plain(topBorder(preset, true));
			const occurrences = focused.split(AGENT).length - 1;

			expect(`${preset}: ${occurrences}`).toBe(`${preset}: 1`);
		}
	});
});
