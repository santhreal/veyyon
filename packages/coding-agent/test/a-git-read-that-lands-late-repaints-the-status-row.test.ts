/**
 * WHY: the status row is painted from git reads that cannot answer on the
 * frame that asked. Three of them are subprocesses — the default branch, the
 * pull request, and `git status` — and each leaves a row on screen that no
 * longer matches what the component would render. A resting session has no
 * other reason to repaint, so a read that lands without asking for one shows
 * a stale row until the next keystroke. Two of the three asked; `git status`
 * did not, which is why the dirty marker never appeared on an idle session.
 *
 * The mirror defect is the same callback firing after `dispose()`: the host
 * re-renders, the re-render reads `settings`, and a test that has already run
 * `resetSettingsForTest()` gets "Settings not initialized" out of a component
 * that is supposed to be gone.
 *
 * Class closed: the suite enumerates the async git entry points a render
 * actually reaches, rather than naming them, so a fourth one added to the
 * component turns it red until somebody decides whether it repaints. Each of
 * the three is then driven to its landing and asserted to repaint exactly
 * once, and asserted silent after `dispose()`.
 *
 * Not caught: an async read that is not an `async function` (a plain function
 * returning a promise) is invisible to the sweep, and so is a top-level
 * `git.<fn>()` — a module namespace cannot be spied on, so only members of
 * the `git.*` objects are instrumented.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { StatusLineSettings } from "@veyyon/coding-agent/modes/terminal/components/status-line";
import { StatusLineComponent } from "@veyyon/coding-agent/modes/terminal/components/status-line";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { GitRefHead, GitStatusSummary } from "@veyyon/coding-agent/utils/git";
import * as git from "@veyyon/coding-agent/utils/git";
import { getProjectDir, setProjectDir } from "@veyyon/utils";

const originalProjectDir = getProjectDir();

beforeAll(async () => {
	resetSettingsForTest();
	await Settings.init({ inMemory: true });
	await initTheme();
});

afterAll(() => {
	resetSettingsForTest();
	setProjectDir(originalProjectDir);
});

beforeEach(() => {
	vi.spyOn(git.head, "resolveSync").mockReturnValue(featureHead);
});

afterEach(() => {
	vi.restoreAllMocks();
});

/**
 * HEAD on a branch that is not the default one, so the pull-request lookup
 * runs instead of short-circuiting.
 */
const featureHead: GitRefHead = {
	kind: "ref",
	branchName: "feature",
	ref: "refs/heads/feature",
	commit: null,
	commonDir: "/repo/.git",
	gitDir: "/repo/.git",
	gitEntryPath: "/repo/.git",
	headPath: "/repo/.git/HEAD",
	repoRoot: "/repo",
	headContent: "ref: refs/heads/feature\n",
};

const CLEAN: GitStatusSummary = { staged: 0, unstaged: 0, untracked: 0, truncated: false };
const DIRTY: GitStatusSummary = { staged: 1, unstaged: 0, untracked: 0, truncated: false };

/** Both git-backed segments on the row, so one render reaches every lookup. */
const gitRow: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["git", "pr"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

function makeSession() {
	return {
		state: { messages: [], model: undefined },
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
		modelRegistry: { isUsingOAuth: () => false },
		sessionManager: {
			getSessionName: () => "late git read",
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

type Landing<T> = { land: (value: T) => Promise<void> };

/** A lookup held open until the test decides it has answered. */
function deferred<T>(): Landing<T> & { promise: Promise<T> } {
	const { promise, resolve } = Promise.withResolvers<T>();
	return {
		promise,
		land: async (value: T) => {
			resolve(value);
			// Three turns: the awaiting continuation, the `finally` block that
			// follows it, and the repaint the block asks for.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
		},
	};
}

/**
 * A lookup that never answers, for isolating one of the three.
 *
 * An unstubbed lookup answers `null` immediately, and the pull-request one
 * repaints on any answer including that, so a test watching a single landing
 * has to hold the other two open rather than leave them unstubbed.
 */
function neverAnswers(): () => Promise<never> {
	return () => Promise.withResolvers<never>().promise;
}

/**
 * Replace every async member of every `git.*` namespace, recording the ones a
 * render reaches.
 *
 * Derived from the module at run time rather than from a list, so a lookup
 * added to the component shows up here as an unexpected name instead of
 * silently joining the ones that never repaint. An unrecognised call answers
 * `null`, which the component treats as "no answer" and which keeps a stray
 * lookup from spawning git inside the sandbox.
 */
function instrumentAsyncGitReads(reached: Set<string>, answers: Map<string, () => Promise<unknown>>): void {
	for (const [namespaceName, namespace] of Object.entries(git)) {
		if (!namespace || (typeof namespace !== "object" && typeof namespace !== "function")) continue;
		for (const key of Object.keys(namespace)) {
			const member = (namespace as Record<string, unknown>)[key];
			if (typeof member !== "function" || member.constructor.name !== "AsyncFunction") continue;
			const name = `${namespaceName}.${key}`;
			vi.spyOn(namespace as never, key as never).mockImplementation(((): unknown => {
				reached.add(name);
				const answer = answers.get(name);
				return answer ? answer() : Promise.resolve(null);
			}) as never);
		}
	}
}

/** A component on the git row, rendered once, with every lookup in flight. */
function renderOnce(answers: Map<string, () => Promise<unknown>>) {
	const reached = new Set<string>();
	instrumentAsyncGitReads(reached, answers);
	const repaint = vi.fn();
	const component = new StatusLineComponent(makeSession());
	component.updateSettings(gitRow);
	component.watchGitState(repaint);
	component.renderQuietLine(120);
	return { component, repaint, reached };
}

describe("a git read that lands after the frame that asked for it", () => {
	it("reaches exactly the three subprocess lookups a painted row is made of", () => {
		const { component, reached } = renderOnce(new Map());
		component.dispose();

		// Red when a fourth async git read joins the render: decide whether it
		// repaints, then add it here and to the landing test below.
		expect([...reached].sort()).toEqual(["branch.default", "github.run", "status.summary"]);
	});

	it("repaints the row once for each of them, as each one lands", async () => {
		const defaultBranch = deferred<string | null>();
		const prView = deferred<{ exitCode: number; stdout: string; stderr: string }>();
		const status = deferred<GitStatusSummary | null>();
		const { component, repaint } = renderOnce(
			new Map<string, () => Promise<unknown>>([
				["branch.default", () => defaultBranch.promise],
				["github.run", () => prView.promise],
				["status.summary", () => status.promise],
			]),
		);

		expect(repaint).toHaveBeenCalledTimes(0);

		await defaultBranch.land("main");
		expect(repaint).toHaveBeenCalledTimes(1);

		await status.land(DIRTY);
		expect(repaint).toHaveBeenCalledTimes(2);

		await prView.land({ exitCode: 0, stdout: JSON.stringify({ number: 7, url: "https://forge/pr/7" }), stderr: "" });
		expect(repaint).toHaveBeenCalledTimes(3);

		component.dispose();
	});

	it("puts the dirty marker on the row the landing repainted, not the one before it", async () => {
		const status = deferred<GitStatusSummary | null>();
		const { component, repaint } = renderOnce(
			new Map<string, () => Promise<unknown>>([
				["branch.default", neverAnswers()],
				["github.run", neverAnswers()],
				["status.summary", () => status.promise],
			]),
		);

		const beforeTheAnswer = component.renderQuietLine(120);
		expect(beforeTheAnswer).not.toContain("*");

		await status.land(DIRTY);
		expect(repaint).toHaveBeenCalledTimes(1);
		expect(component.renderQuietLine(120)).toContain("*");

		component.dispose();
	});

	it("does not repaint for a `git status` that leaves the row saying the same thing", async () => {
		const status = deferred<GitStatusSummary | null>();
		const { component, repaint } = renderOnce(
			new Map<string, () => Promise<unknown>>([
				["branch.default", neverAnswers()],
				["github.run", neverAnswers()],
				["status.summary", () => status.promise],
			]),
		);

		// The row already renders clean while the lookup is out, so a clean
		// answer changes no byte. Repainting here would refetch on the next
		// render and repaint again.
		await status.land(CLEAN);
		expect(repaint).toHaveBeenCalledTimes(0);

		component.dispose();
	});

	it("asks for no repaint once the row it would paint is disposed", async () => {
		const defaultBranch = deferred<string | null>();
		const prView = deferred<{ exitCode: number; stdout: string; stderr: string }>();
		const status = deferred<GitStatusSummary | null>();
		const { component, repaint } = renderOnce(
			new Map<string, () => Promise<unknown>>([
				["branch.default", () => defaultBranch.promise],
				["github.run", () => prView.promise],
				["status.summary", () => status.promise],
			]),
		);

		component.dispose();

		await defaultBranch.land("main");
		await status.land(DIRTY);
		await prView.land({ exitCode: 0, stdout: JSON.stringify({ number: 7, url: "https://forge/pr/7" }), stderr: "" });

		expect(repaint).toHaveBeenCalledTimes(0);
	});

	it("asks for no repaint when the lookups had already answered before disposal", async () => {
		// The same guard, reached down the other path: the awaited promises are
		// settled before `dispose()`, so what has to be suppressed is a queued
		// microtask rather than a pending subprocess.
		const { component, repaint } = renderOnce(
			new Map<string, () => Promise<unknown>>([
				["branch.default", async () => "main"],
				["github.run", async () => ({ exitCode: 1, stdout: "", stderr: "no pr" })],
				["status.summary", async () => DIRTY],
			]),
		);

		component.dispose();

		await Promise.resolve();
		await Promise.resolve();
		await Promise.resolve();

		expect(repaint).toHaveBeenCalledTimes(0);
	});
});
