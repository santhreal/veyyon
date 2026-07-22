import { describe, expect, it } from "bun:test";
import {
	generateFallbackAnalysis,
	generateFallbackProposal,
	generateFallbackSummary,
} from "../../src/commit/agentic/fallback";
import type { CommitType, NumstatEntry } from "../../src/commit/types";

/**
 * The fallback commit generator is what runs when the agentic commit path fails:
 * it must always produce a coherent, human-readable proposal from just the
 * numstat, with no model call. It had no tests. This suite pins:
 *   - inferTypeFromFiles' precedence (via generateFallbackAnalysis): a changeset
 *     is `test`/`docs`/`style`/`chore` only when it is PURELY that category; any
 *     source file present demotes the whole thing to `refactor`.
 *   - the summary phrasing per type and, critically, its file-count grammar:
 *     one file -> bare verb+file, two -> "and 1 other", three -> "and 2 others".
 *   - the empty-changeset guard: an empty numstat must NOT render "and -1 others"
 *     (the bug this locks out); it degrades to "<verb> files".
 *   - generateFallbackProposal always attaches the fallback warning.
 */

const entry = (path: string): NumstatEntry => ({ path, additions: 1, deletions: 0 });

describe("generateFallbackAnalysis type inference", () => {
	it("classifies a docs-only changeset as docs", () => {
		expect(generateFallbackAnalysis([entry("README.md"), entry("docs/guide.md")]).type).toBe("docs");
	});

	it("classifies a test-only changeset as test", () => {
		expect(generateFallbackAnalysis([entry("tests/a.go"), entry("b_test.go")]).type).toBe("test");
	});

	it("recognizes a TOP-LEVEL test directory as a test-only changeset", () => {
		// Guards the test-path fix: `tests/a.go` alone must infer `test`, not `refactor`.
		expect(generateFallbackAnalysis([entry("tests/a.go")]).type).toBe("test");
	});

	it("classifies a style-only changeset as style", () => {
		expect(generateFallbackAnalysis([entry("theme.css"), entry("main.scss")]).type).toBe("style");
	});

	it("classifies a config-only changeset as chore", () => {
		expect(generateFallbackAnalysis([entry("tsconfig.json"), entry("app.yaml")]).type).toBe("chore");
	});

	it("demotes any changeset containing source to refactor", () => {
		// Source presence overrides tests/docs/style/config.
		expect(generateFallbackAnalysis([entry("src/a.ts"), entry("a.test.ts")]).type).toBe("refactor");
		expect(generateFallbackAnalysis([entry("src/a.ts"), entry("README.md")]).type).toBe("refactor");
	});

	it("defaults an empty changeset to chore with no details", () => {
		const analysis = generateFallbackAnalysis([]);
		expect(analysis.type).toBe("chore");
		expect(analysis.details).toEqual([]);
	});

	it("caps details at the first three files, marked non-user-visible", () => {
		const analysis = generateFallbackAnalysis([entry("a.ts"), entry("b.ts"), entry("c.ts"), entry("d.ts")]);
		expect(analysis.details).toEqual([
			{ text: "Updated a.ts", userVisible: false },
			{ text: "Updated b.ts", userVisible: false },
			{ text: "Updated c.ts", userVisible: false },
		]);
		expect(analysis.scope).toBeNull();
		expect(analysis.issueRefs).toEqual([]);
	});
});

describe("generateFallbackSummary", () => {
	it("uses the type-specific verb and the first file's basename", () => {
		expect(generateFallbackSummary("test", [entry("pkg/a_test.go")])).toBe("updated tests for a_test.go");
		expect(generateFallbackSummary("docs", [entry("docs/x.md")])).toBe("updated documentation for x.md");
		expect(generateFallbackSummary("style", [entry("a.css")])).toBe("formatted a.css");
		expect(generateFallbackSummary("revert", [entry("a.ts")])).toBe("reverted changes in a.ts");
	});

	it("falls back to 'updated' for an unmapped commit type", () => {
		expect(generateFallbackSummary("unknown" as CommitType, [entry("a.ts")])).toBe("updated a.ts");
	});

	it("uses singular 'other' for exactly two files", () => {
		expect(generateFallbackSummary("refactor", [entry("a.ts"), entry("b.ts")])).toBe("refactored a.ts and 1 other");
	});

	it("uses plural 'others' for three or more files", () => {
		expect(generateFallbackSummary("refactor", [entry("a.ts"), entry("b.ts"), entry("c.ts")])).toBe(
			"refactored a.ts and 2 others",
		);
	});

	it("degrades an empty changeset to '<verb> files' instead of 'and -1 others'", () => {
		// Regression for BUG-FALLBACK-SUMMARY-EMPTY-NEGATIVE-COUNT: length 0 used to
		// hit the plural branch and render "updated files and -1 others".
		expect(generateFallbackSummary("chore", [])).toBe("updated files");
	});
});

describe("generateFallbackProposal", () => {
	it("combines analysis and summary and always attaches the fallback warning", () => {
		const proposal = generateFallbackProposal([entry("src/a.ts")]);
		expect(proposal.analysis.type).toBe("refactor");
		expect(proposal.summary).toBe("refactored a.ts");
		expect(proposal.warnings).toEqual(["Commit generated using fallback due to agent failure"]);
	});

	it("produces a coherent proposal even for an empty changeset", () => {
		const proposal = generateFallbackProposal([]);
		expect(proposal.analysis.type).toBe("chore");
		expect(proposal.summary).toBe("updated files");
		expect(proposal.warnings).toEqual(["Commit generated using fallback due to agent failure"]);
	});
});
