import { describe, expect, it } from "bun:test";
import { formatCommitMessage } from "../../src/commit/message";
import type { ConventionalAnalysis, ConventionalDetail } from "../../src/commit/types";

/**
 * formatCommitMessage assembles the final conventional-commit text from an
 * analysis plus a summary line. It had no test. The shape it produces is what a
 * user's commit literally becomes, so the header format and the body layout are
 * pinned exactly here.
 *
 * Contracts:
 *   - header is `type(scope): summary`, and the `(scope)` is omitted entirely
 *     when scope is null (not rendered as `()`);
 *   - with no details the message is the header alone (no trailing blank lines);
 *   - details render as `- <text>` bullets after a single blank line, each text
 *     trimmed, joined by newlines;
 *   - ALL details are included regardless of their `userVisible` flag (the
 *     formatter does not filter them).
 */

const detail = (text: string, userVisible = true): ConventionalDetail => ({ text, userVisible });

const analysis = (type: string, scope: string | null, details: ConventionalDetail[]): ConventionalAnalysis => ({
	type: type as ConventionalAnalysis["type"],
	scope,
	details,
	issueRefs: [],
});

describe("formatCommitMessage", () => {
	it("renders a scoped header", () => {
		expect(formatCommitMessage(analysis("feat", "api", []), "add pagination")).toBe("feat(api): add pagination");
	});

	it("omits the scope parentheses entirely when scope is null", () => {
		expect(formatCommitMessage(analysis("fix", null, []), "handle empty input")).toBe("fix: handle empty input");
	});

	it("returns the header alone when there are no details", () => {
		expect(formatCommitMessage(analysis("chore", null, []), "bump deps")).toBe("chore: bump deps");
	});

	it("renders details as trimmed bullets after one blank line", () => {
		expect(
			formatCommitMessage(analysis("fix", null, [detail("  first thing  "), detail("second thing")]), "bug"),
		).toBe("fix: bug\n\n- first thing\n- second thing");
	});

	it("includes details regardless of their userVisible flag", () => {
		expect(formatCommitMessage(analysis("feat", "core", [detail("shown", true), detail("hidden", false)]), "x")).toBe(
			"feat(core): x\n\n- shown\n- hidden",
		);
	});
});
