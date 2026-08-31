/**
 * Regression: StatusLineComponent#lookupPr previously called `gh pr view`
 * through Bun's raw `$` with no signal or non-interactive env. A stalled
 * `gh` (keychain prompt, network hang, auth deadlock) wedged the child
 * forever — `#prLookupInFlight` was set before the await and never reset,
 * so the PR segment stayed permanently in-flight and the child process
 * leaked. See #4234.
 *
 * Contract: `#lookupPr` MUST delegate to `git.github.run(cwd, args, signal)`
 * with an `AbortSignal` (regressing to raw `$` drops the signal entirely),
 * and the finally-block MUST clear `#prLookupInFlight` on both success and
 * rejection so the segment never wedges after a single failure.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import type { StatusLineSettings } from "@veyyon/coding-agent/modes/terminal/components/status-line/index";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { initTheme } from "@veyyon/coding-agent/theme/theme";
import type { GitRefHead } from "@veyyon/coding-agent/utils/git";
import * as git from "@veyyon/coding-agent/utils/git";
import { getProjectDir, setProjectDir } from "@veyyon/utils";
import { StatusLineComponent } from "../src/modes/terminal/components/status-line/component";
import { makeStatusLineSession } from "./helpers/status-line-session";

const originalProjectDir = getProjectDir();

// HEAD on a feature branch so `#isDefaultBranch("feature/x")` returns false
// (the sync seed is "main"), letting `#lookupPr` reach the gh call.
const fakeRefHead: GitRefHead = {
	kind: "ref",
	branchName: "feature/x",
	ref: "refs/heads/feature/x",
	commit: null,
	commonDir: "/fake/.git",
	gitDir: "/fake/.git",
	gitEntryPath: "/fake/.git",
	headPath: "/fake/.git/HEAD",
	repoRoot: "/fake",
	headContent: "ref: refs/heads/feature/x\n",
};

const gitSegmentSettings: StatusLineSettings = {
	preset: "custom",
	leftSegments: ["pr"],
	rightSegments: ["session_name"],
	separator: "powerline-thin",
	sessionAccent: false,
	transparent: false,
};

function makeSession(): AgentSession {
	// No model resolved yet: these cases are about the PR lookup's abort plumbing,
	// which runs whatever the model segment can print.
	return makeStatusLineSession({ contextUsage: undefined, sessionName: "pr-lookup-timeout test" });
}

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
	vi.spyOn(git.head, "resolveSync").mockReturnValue(fakeRefHead);
	// Bypass the delayed default-branch resolver used by `#isDefaultBranch`;
	// synchronous seed of "main" is enough to make the check return false.
	vi.spyOn(git.branch, "default").mockResolvedValue("main");
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("StatusLineComponent PR lookup timeout guard", () => {
	it("routes gh pr view through git.github.run with a bounded abort signal", async () => {
		const { promise: ghCalled, resolve: markGhCalled } = Promise.withResolvers<{
			args: readonly string[];
			signal: AbortSignal | undefined;
		}>();
		const { promise: ghUnblock, resolve: releaseGh } = Promise.withResolvers<void>();

		vi.spyOn(git.github, "run").mockImplementation(async (_cwd, args, signal) => {
			markGhCalled({ args, signal });
			await ghUnblock;
			return { exitCode: 1, stdout: "", stderr: "" };
		});

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegmentSettings);
		try {
			// Render triggers `#lookupPr` → git.github.run.
			component.renderQuietLine(80);

			const call = await ghCalled;
			expect(call.args).toEqual(["pr", "view", "--json", "number,url"]);

			// The regression fires when no signal is threaded through: the child
			// runs forever and cannot be aborted. A signal that hasn't fired at
			// call time is enough — `AbortSignal.timeout(GIT_COMMAND_TIMEOUT_MS)`
			// is the shape produced by the fix, and any regression to raw `$`
			// drops the signal entirely.
			expect(call.signal).toBeInstanceOf(AbortSignal);
			expect(call.signal?.aborted).toBe(false);
		} finally {
			releaseGh();
			await Promise.resolve();
			component.dispose();
		}
	});

	it("clears #prLookupInFlight when git.github.run rejects (e.g. timeout abort)", async () => {
		// If the abort/timeout path leaves `#prLookupInFlight = true`, every
		// subsequent render skips the lookup and the PR segment freezes.
		// The finally-block must reset it whether the helper resolves or
		// throws.
		vi.spyOn(git.github, "run").mockRejectedValue(new Error("simulated timeout"));

		const component = new StatusLineComponent(makeSession());
		component.updateSettings(gitSegmentSettings);
		try {
			// First render fires the (rejecting) lookup.
			component.renderQuietLine(80);
			// Drain the microtask queue so the catch/finally chain runs.
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();

			// Second render must be free to attempt another lookup, proving
			// the in-flight flag was released.
			const secondCallSpy = vi.spyOn(git.github, "run");
			// Replace the mock to succeed cheaply on the retry.
			secondCallSpy.mockResolvedValue({
				exitCode: 0,
				stdout: JSON.stringify({ number: 42, url: "https://github.com/x/y/pull/42" }),
				stderr: "",
			});
			component.renderQuietLine(80);
			await Promise.resolve();
			await Promise.resolve();
			await Promise.resolve();
			expect(secondCallSpy).toHaveBeenCalled();
		} finally {
			component.dispose();
		}
	});
});
