/**
 * The status line's two right-hand badges must never count the same work twice.
 *
 * A `task` spawn is BOTH a running subagent and a registered async job (`type: "task"`, written by
 * `task/index.ts`). The job badge used to count `snapshot.running.length` outright, so three
 * subagents rendered as `3 · 3`: two adjacent numbers that moved together and neither of which
 * named what it counted. These tests pin the rule that fixed it: the subagent badge owns subagent
 * work, the job badge owns everything else, and a `task` job is never counted by both.
 */
import { afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import { stripAnsi } from "@veyyon/utils/strip-ansi";
import { Settings } from "../src/config/settings";
import { StatusLineComponent } from "../src/modes/components/status-line/component";
import { getThemeByName, setThemeInstance } from "../src/modes/theme/theme";
import type { AgentSession } from "../src/session/agent-session";

interface FakeJob {
	id: string;
	type: string;
	status: "running";
	label: string;
	startTime: number;
}

function makeSession(runningJobs: FakeJob[]) {
	return {
		messages: [],
		model: { contextWindow: 128000, id: "test-model", provider: "test" },
		contextUsageRevision: 0,
		systemPrompt: [],
		agent: { state: { tools: [] } },
		skills: [],
		getContextUsage: () => ({ tokens: 42, contextWindow: 128000 }),
		state: { messages: [], model: { contextWindow: 128000 } },
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
			getSessionName: () => "test-session",
		},
		getPrewalkState: () => undefined,
		getAsyncJobSnapshot: () => ({
			running: runningJobs,
			recent: [],
			delivery: { pending: [] },
		}),
		settings: { getGroup: () => ({ enabled: false }) },
		isAdvisorActive: () => false,
		isApprovalBypassed: () => false,
		isFastModeActive: () => false,
		configuredThinkingLevel: () => undefined,
		modelRegistry: { isUsingOAuth: () => false },
	} as unknown as AgentSession;
}

function job(id: string, type: string): FakeJob {
	return { id, type, status: "running", label: id, startTime: 0 };
}

/**
 * Every bare integer the SETTLED footline shows, in order.
 *
 * Two details make this the only honest reading. `renderQuietLine` is the composer footline the
 * transcript showed; `render` only ever emits hook statuses, so asserting against it would pass
 * no matter what the badges did. And the job badge slot EASES open over 240ms off `Date.now`,
 * so the first render legitimately shows a zero-width slot: the clock is moved past the
 * animation rather than slept through, so the assertion reads the state the user sees without
 * tying the suite to wall time.
 */
function settledNumbersOnBar(statusLine: StatusLineComponent, width = 200): number[] {
	const clock = vi.spyOn(Date, "now").mockReturnValue(0);
	statusLine.renderQuietLine(width);
	clock.mockReturnValue(1_000);
	const rendered = stripAnsi(statusLine.renderQuietLine(width) ?? "");
	return [...rendered.matchAll(/(?<![\w.%/#-])(\d+)(?![\w.%/])/g)].map(match => Number(match[1]));
}

beforeAll(async () => {
	await Settings.init({ inMemory: true });
	const loaded = await getThemeByName("dark");
	if (!loaded) throw new Error("theme unavailable");
	setThemeInstance(loaded);
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("status line badges count each unit of work once", () => {
	/**
	 * The reported bug, verbatim: three `task` subagents rendered `3 · 3`. The subagent badge is
	 * the one that owns them, so the count must appear exactly ONCE on the bar. Reverting the job
	 * badge to `running.length` makes this fail with two 3s.
	 */
	it("shows three task subagents as one count, not two", () => {
		const statusLine = new StatusLineComponent(
			makeSession([job("job_a", "task"), job("job_b", "task"), job("job_c", "task")]),
		);
		statusLine.setSubagentCount(3);

		const threes = settledNumbersOnBar(statusLine).filter(value => value === 3);
		expect(threes).toEqual([3]);
	});

	/**
	 * A `task` job must not reach the job badge even when it is the ONLY running job. Without the
	 * filter the bar carries a job badge with no non-subagent work behind it, which is a badge
	 * that means nothing.
	 */
	it("renders no job badge when every running job is a task subagent", () => {
		const statusLine = new StatusLineComponent(makeSession([job("job_a", "task")]));
		statusLine.setSubagentCount(1);

		expect(settledNumbersOnBar(statusLine).filter(value => value === 1)).toEqual([1]);
	});

	/**
	 * The opposite failure mode: over-filtering. Async bash, debug and launch jobs have no
	 * subagent standing for them, so the job badge is the only thing that reports them and it MUST
	 * still count them. A fix that dropped every job would pass the test above and hide real work.
	 */
	it("still counts background jobs that are not subagents", () => {
		const statusLine = new StatusLineComponent(makeSession([job("job_a", "bash"), job("job_b", "debug")]));
		statusLine.setSubagentCount(0);

		expect(settledNumbersOnBar(statusLine)).toContain(2);
	});

	/**
	 * Mixed load is the case the two badges exist to tell apart: two subagents and one async bash
	 * must read as 2 and 1, never as 2 and 3 (double-counting) and never as 2 alone (over-filtering).
	 */
	it("reports subagents and non-subagent jobs as separate counts", () => {
		const statusLine = new StatusLineComponent(
			makeSession([job("job_a", "task"), job("job_b", "task"), job("job_c", "bash")]),
		);
		statusLine.setSubagentCount(2);

		const numbers = settledNumbersOnBar(statusLine);
		expect(numbers).toContain(2);
		expect(numbers).toContain(1);
		expect(numbers).not.toContain(3);
	});
});
