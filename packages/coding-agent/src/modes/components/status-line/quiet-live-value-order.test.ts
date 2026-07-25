/**
 * The footline's live value comes last.
 *
 * Everything in the footline's right group is standing state you set once (the session
 * name, the model, the mode) except one thing: the context gauge, which moves every
 * turn. Reading the line is much easier when the value that changes is the last word,
 * and much harder when it is wedged between two that do not.
 *
 * The default preset read `model · gauge · session-name`, and nobody chose that: the
 * gauge is configured in the preset's LEFT list, the assembly pushes a left-configured
 * gauge into the right group, and that happened in the first of two loops, so it landed
 * ahead of every right-configured segment. An ordering that falls out of loop order is
 * exactly the kind of thing no test notices, because each preset's config still reads
 * correctly in isolation. It was found by rendering all seven presets at one width and
 * looking at the image (`scripts/demos/render-status-footline.ts`), which is also the
 * only way to see that `default` and `minimal` disagreed while claiming the same shape.
 *
 * So the assertions here are about ORDER in the rendered line, by index, not about the
 * config: the config was never wrong. A gauge the user puts on the right explicitly
 * keeps the place they gave it, which is the one case where loop order was not an
 * accident, and that is pinned too.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import { Settings } from "../../../config/settings";
import type { AgentSession } from "../../../session/agent-session";
import { getThemeByName, setThemeInstance } from "../../theme/theme";
import { StatusLineComponent } from "./component";

/** A session with a session name, a cost, and a context reading, all fixed. */
function makeSession(): AgentSession {
	return {
		messages: [],
		model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 84_000, contextWindow: 200_000 }),
		state: { messages: [], model: { contextWindow: 200_000, id: "gpt-5", name: "gpt-5" } },
		sessionManager: {
			getUsageStatistics: () => ({
				input: 12_000,
				output: 3_400,
				cacheRead: 48_000,
				cacheWrite: 1_200,
				totalTokens: 64_600,
				orchestrationInput: 0,
				orchestrationOutput: 0,
				orchestrationCacheRead: 0,
				premiumRequests: 2,
				cost: 0.42,
				tokensPerSecond: 58.4,
			}),
			getSessionName: () => "parser-rewrite",
			getCwd: () => "/tmp",
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

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

/** The footline as plain text, styling removed. */
function footline(settings: Record<string, unknown>, width = 120): string {
	const statusLine = new StatusLineComponent(makeSession());
	statusLine.updateSettings(settings as never);
	const line = statusLine.renderQuietLine(width);
	if (!line) throw new Error("no footline rendered");
	return line.replace(/\x1b\[[0-9;]*m/g, "");
}

/** The gauge's own glyph: the one part of the line that is unmistakably the gauge. */
const GAUGE = "▰";

describe("a gauge configured on the left", () => {
	/** THE regression: `default` is the preset almost everyone runs, and its gauge sat
	 * before the session name. */
	it("renders after the session name in the default preset", () => {
		const line = footline({ preset: "default" });

		expect(line).toContain(GAUGE);
		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf(GAUGE));
	});

	it("renders after every standing segment, not just the session name", () => {
		const line = footline({ preset: "default" });

		for (const standing of ["gpt-5", "parser-rewrite"]) {
			expect(line.indexOf(standing), standing).toBeLessThan(line.indexOf(GAUGE));
		}
	});

	/** Nothing follows it. A trailing standing segment would put the moving number back
	 * in the middle of the line, which is the whole complaint. */
	it("is the last segment on the line", () => {
		const line = footline({ preset: "default" }).trimEnd();
		const afterGauge = line.slice(line.indexOf(GAUGE));

		expect(afterGauge).not.toContain("·");
	});

	/** The same rule with an explicitly built config, so the claim is about the
	 * assembly rather than about one preset's segment list. */
	it("holds for any left-configured gauge, whatever else is on the right", () => {
		const line = footline({
			preset: "custom",
			leftSegments: ["model", "context_pct"],
			rightSegments: ["session_name"],
		});

		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf(GAUGE));
	});
});

describe("a gauge configured on the right", () => {
	/** Explicit placement is a choice, and it is kept: a user who writes the gauge
	 * first in `rightSegments` gets it first. The bug was never that the gauge must be
	 * last, it was that its position was decided by loop order. */
	it("keeps the position it was given, even before the session name", () => {
		const line = footline({
			preset: "custom",
			leftSegments: ["model"],
			rightSegments: ["context_pct", "session_name"],
		});

		expect(line.indexOf(GAUGE)).toBeLessThan(line.indexOf("parser-rewrite"));
	});
});

describe("the presets that already read correctly", () => {
	/** `minimal` puts the gauge last in `rightSegments` and must be untouched by the
	 * change: this is the control that proves the fix moved only the accidental case. */
	it("minimal still ends with the gauge", () => {
		const line = footline({ preset: "minimal" }).trimEnd();

		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf(GAUGE));
		expect(line.slice(line.indexOf(GAUGE))).not.toContain("·");
	});

	/** `compact` carries a live cost as well. Standing first, then the live pair, with
	 * the gauge last of all. */
	it("compact keeps cost before the gauge and the session name before both", () => {
		const line = footline({ preset: "compact" });

		expect(line.indexOf("parser-rewrite")).toBeLessThan(line.indexOf("$0.42"));
		expect(line.indexOf("$0.42")).toBeLessThan(line.indexOf(GAUGE));
	});

	/** Two presets that claim the same shape must not disagree about it. Reading them
	 * side by side is how the default preset's order was noticed at all. */
	it("default and minimal agree on where the gauge goes", () => {
		const isLast = (line: string) => !line.trimEnd().slice(line.indexOf(GAUGE)).includes("·");

		expect(isLast(footline({ preset: "default" }))).toBe(true);
		expect(isLast(footline({ preset: "minimal" }))).toBe(true);
	});
});
