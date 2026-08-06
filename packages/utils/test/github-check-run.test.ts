import { describe, expect, it } from "bun:test";
import { classifyGithubCheckRun, githubIssueRefNumber } from "../src/github-check-run";

/**
 * The GitHub check-run vocabulary, in one place.
 *
 * WHY: the terminal renderer of the `github` tool and the React one each carried their own
 * conclusion tables, and they had already drifted. The terminal side knew a
 * `queued`/`requested`/`waiting`/`pending` group; the React side had no equivalent, so the same
 * queued job read as pending in the terminal and as the unknown-state fallback in the HTML and
 * collab views, with nothing reporting the disagreement. These cases pin the whole vocabulary
 * so a conclusion can no longer be taught to one view alone.
 */
describe("classifyGithubCheckRun", () => {
	it("classifies every conclusion GitHub reports for a finished run", () => {
		expect(classifyGithubCheckRun("completed", "success")).toBe("success");
		expect(classifyGithubCheckRun("completed", "neutral")).toBe("success");
		expect(classifyGithubCheckRun("completed", "skipped")).toBe("success");
		expect(classifyGithubCheckRun("completed", "failure")).toBe("failure");
		expect(classifyGithubCheckRun("completed", "timed_out")).toBe("failure");
		expect(classifyGithubCheckRun("completed", "cancelled")).toBe("failure");
		expect(classifyGithubCheckRun("completed", "action_required")).toBe("failure");
		expect(classifyGithubCheckRun("completed", "startup_failure")).toBe("failure");
	});

	it("classifies the in-flight and not-yet-started statuses", () => {
		expect(classifyGithubCheckRun("in_progress", null)).toBe("running");
		expect(classifyGithubCheckRun("queued", null)).toBe("pending");
		expect(classifyGithubCheckRun("requested", null)).toBe("pending");
		expect(classifyGithubCheckRun("waiting", null)).toBe("pending");
		expect(classifyGithubCheckRun("pending", null)).toBe("pending");
	});

	/**
	 * GitHub keeps reporting `status: "completed"` next to the conclusion, and a re-run reports
	 * the previous conclusion next to `status: "in_progress"`. A view that read the status first
	 * would call a finished failure "running".
	 */
	it("lets a conclusion win over a status that is still reported beside it", () => {
		expect(classifyGithubCheckRun("in_progress", "failure")).toBe("failure");
		expect(classifyGithubCheckRun("queued", "success")).toBe("success");
	});

	it("answers unknown for a state it does not recognise, rather than guessing", () => {
		expect(classifyGithubCheckRun(null, null)).toBe("unknown");
		expect(classifyGithubCheckRun("", "")).toBe("unknown");
		expect(classifyGithubCheckRun("stale", "not_a_conclusion")).toBe("unknown");
		expect(classifyGithubCheckRun(undefined, undefined)).toBe("unknown");
	});
});

describe("githubIssueRefNumber", () => {
	it("reads the number out of a bare number and out of both URL shapes", () => {
		expect(githubIssueRefNumber("123")).toBe("#123");
		expect(githubIssueRefNumber("  456 ")).toBe("#456");
		expect(githubIssueRefNumber("https://github.com/santhreal/veyyon/pull/2564")).toBe("#2564");
		expect(githubIssueRefNumber("https://github.com/santhreal/veyyon/issues/1011")).toBe("#1011");
	});

	it("declines anything that is not a reference, leaving the literal to the caller", () => {
		expect(githubIssueRefNumber("feature/my-branch")).toBeUndefined();
		expect(githubIssueRefNumber("")).toBeUndefined();
		expect(githubIssueRefNumber("   ")).toBeUndefined();
		expect(githubIssueRefNumber("https://github.com/santhreal/veyyon/commits/main")).toBeUndefined();
	});
});
