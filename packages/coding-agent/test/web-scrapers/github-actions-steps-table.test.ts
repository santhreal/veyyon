import { describe, expect, it } from "bun:test";
import { type GitHubActionsStep, renderActionsSteps } from "@veyyon/coding-agent/web/scrapers/github";

/**
 * Locks the github half of FINDING-SCRAPER-TABLE-CELL-ESCAPE-DIVERGENT. The
 * GitHub Actions renderer had its own local `escapeCell` that only replaced `|`
 * and never collapsed newlines, so a step name carrying a newline (a workflow
 * `name:` written as a multi-line YAML scalar) still ended the table row early
 * and shifted every following column against the header. It was also a divergent
 * duplicate of the canonical escapeMarkdownTableCell. The renderer now routes
 * step names through that single owner. These assert the exact row bytes and the
 * column count so a revert to raw interpolation, or to a pipe-only escaper, fails
 * loudly.
 */
describe("renderActionsSteps table-cell escaping", () => {
	const step = (over: Partial<GitHubActionsStep>): GitHubActionsStep => ({
		name: "build",
		status: "completed",
		conclusion: "success",
		number: 1,
		started_at: null,
		completed_at: null,
		...over,
	});

	// Rendered layout is always header, separator, then one line per step, so the
	// single data row under test is line index 2.
	const dataRow = (md: string): string => md.split("\n").filter(Boolean)[2];

	it("escapes a pipe in a step name so the row keeps its five columns", () => {
		const line = dataRow(renderActionsSteps([step({ name: "lint | typecheck", number: 3 })]));
		expect(line).toBe("| 3 | lint \\| typecheck | completed | success | - |");
		// Splitting on unescaped pipes yields the 6 delimiters of a 5-column row
		// (7 segments: a leading and trailing empty plus five cells). A raw pipe in
		// the name would split into 8 and shift every later column against the header.
		expect(line.split(/(?<!\\)\|/).length).toBe(7);
	});

	it("collapses a newline in a step name so it cannot end the row early", () => {
		const line = dataRow(renderActionsSteps([step({ name: "run\ntests", number: 2 })]));
		// The newline becomes a single space; the row stays on one line.
		expect(line).toBe("| 2 | run tests | completed | success | - |");
		expect(line).not.toContain("\n");
	});

	it("collapses a tab in a step name the pipe-only escaper would have missed", () => {
		const line = dataRow(renderActionsSteps([step({ name: "a\tb", number: 4 })]));
		expect(line).toBe("| 4 | a b | completed | success | - |");
	});

	it("renders a null conclusion as a dash and keeps the header intact", () => {
		const lines = renderActionsSteps([step({ name: "deploy", conclusion: null, number: 5 })])
			.split("\n")
			.filter(Boolean);
		expect(lines[0]).toBe("| # | Step | Status | Conclusion | Duration |");
		expect(lines[2]).toBe("| 5 | deploy | completed | - | - |");
	});

	it("returns the empty string when there are no steps", () => {
		expect(renderActionsSteps([])).toBe("");
		expect(renderActionsSteps(undefined)).toBe("");
	});
});
