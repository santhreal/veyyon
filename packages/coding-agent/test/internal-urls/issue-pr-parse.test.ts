import { describe, expect, it } from "bun:test";
import { IssueProtocolHandler, PrProtocolHandler } from "@veyyon/coding-agent/internal-urls/issue-pr-protocol";
import { parseInternalUrl } from "@veyyon/coding-agent/internal-urls/parse";

/**
 * The issue:// and pr:// handlers parse a family of URL shapes (list / single item /
 * pr diff, short and fully-qualified) before any GitHub call. That parser is not
 * exported, but every one of its rejection paths throws synchronously inside resolve()
 * BEFORE the network is touched, so these drive the real handlers with malformed URLs
 * and assert no network request is reached (the throw is the proof) and the exact
 * operator message.
 *
 * The list-state and list-limit validation is the important contract: the parser
 * REJECTS an unknown state or a non-positive limit rather than silently falling back to
 * the "open" list or a default limit (a silent fallback would return the open list
 * indistinguishably from "no matches for the requested state" -- the bug the code
 * comment calls out, and a Law-10 violation). It also enforces that issues never have a
 * diff and that pr:// diff sub-paths are `all` or a 1-indexed file number.
 */

const issue = new IssueProtocolHandler();
const pr = new PrProtocolHandler();

const rejects = async (handler: IssueProtocolHandler | PrProtocolHandler, url: string): Promise<string> => {
	try {
		await handler.resolve(parseInternalUrl(url));
		throw new Error("__reached_network__: parse did not reject");
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.startsWith("__reached_network__")) throw new Error(message);
		return message.split("\n")[0]!;
	}
};

describe("issue:// parse rejections", () => {
	it("rejects any diff or trailing path on an issue (issues have no diff)", async () => {
		const expected =
			"Invalid issue:// URL. Issue views do not have a diff; use pr://<owner>/<repo>/<n>/diff for pull requests.";
		expect(await rejects(issue, "issue://o/r/1/diff")).toBe(expected);
		expect(await rejects(issue, "issue://o/r/1/foo")).toBe(expected);
	});

	it("rejects an empty path segment", async () => {
		expect(await rejects(issue, "issue://o//7")).toBe("Invalid issue:// URL: empty or unsafe path segment");
	});

	it("rejects a non-numeric item number", async () => {
		expect(await rejects(issue, "issue://o/r/abc")).toBe("Invalid issue:// number: abc");
	});

	it("rejects an unknown list state instead of falling back to open", async () => {
		// merged is a PR-only state, so it is invalid for issues.
		expect(await rejects(issue, "issue://o/r?state=bogus")).toBe(
			"Invalid issue:// list state 'bogus'. Expected one of: open, closed, all.",
		);
		expect(await rejects(issue, "issue://o/r?state=merged")).toBe(
			"Invalid issue:// list state 'merged'. Expected one of: open, closed, all.",
		);
	});

	it("rejects a non-positive or non-numeric list limit", async () => {
		const expected = "Invalid issue:// list limit '{v}'. Expected a positive integer (max 100).";
		expect(await rejects(issue, "issue://o/r?limit=abc")).toBe(expected.replace("{v}", "abc"));
		expect(await rejects(issue, "issue://o/r?limit=0")).toBe(expected.replace("{v}", "0"));
		expect(await rejects(issue, "issue://o/r?limit=-5")).toBe(expected.replace("{v}", "-5"));
	});
});

describe("pr:// parse rejections", () => {
	it("allows merged in the state set but still rejects an unknown state", async () => {
		expect(await rejects(pr, "pr://o/r?state=bogus")).toBe(
			"Invalid pr:// list state 'bogus'. Expected one of: open, closed, merged, all.",
		);
	});

	it("rejects a diff sub-path that is neither all nor a 1-indexed number", async () => {
		expect(await rejects(pr, "pr://1/diff/xyz")).toBe(
			"Invalid pr:// diff sub-path 'xyz'. Use 'all' or a 1-indexed file number.",
		);
	});

	it("rejects an over-deep or non-diff trailing path", async () => {
		const expected = "Invalid pr:// URL. Expected pr://<n>, pr://<n>/diff, pr://<n>/diff/all, or pr://<n>/diff/<i>";
		expect(await rejects(pr, "pr://o/r/1/diff/all/x")).toBe(expected);
		expect(await rejects(pr, "pr://o/r/1/notdiff")).toBe(expected);
	});

	it("rejects an empty segment and a non-positive number", async () => {
		expect(await rejects(pr, "pr://o//1")).toBe("Invalid pr:// URL: empty or unsafe path segment");
		expect(await rejects(pr, "pr://o/r/0")).toBe("Invalid pr:// number: 0");
	});
});

describe("issue/pr abort", () => {
	it("throws before parsing when the signal is already aborted", async () => {
		let message = "";
		try {
			await issue.resolve(parseInternalUrl("issue://o/r/1"), { signal: AbortSignal.abort() });
		} catch (err) {
			message = err instanceof Error ? err.message : String(err);
		}
		expect(message).toBe("aborted");
	});
});
