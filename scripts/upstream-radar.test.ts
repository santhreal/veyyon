import { describe, expect, it } from "bun:test";
import {
	cleanFeatureBlockers,
	collectPages,
	completePullFiles,
	divergedMatches,
	divergenceWarning,
	isDocumentationOnly,
	isPortWorthy,
	loadPolicy,
	type PortPolicy,
	planIssueCreation,
	portCandidateKind,
	renderPortIssue,
	titleType,
} from "./upstream-radar.ts";

/**
 * This representative policy proves the intake split: fixes always receive
 * semantic triage, while feature additions become candidates only outside
 * architecture-owned surfaces. A path screen is intentionally not a merge
 * decision; every resulting PR still receives CI and human review.
 */
const policy: PortPolicy = {
	allowedTypes: ["fix", "perf"],
	cleanFeatureTypes: ["feat"],
	titleAllowRegexes: ["^fix\\b"],
	cleanFeatureTitleAllowRegexes: ["^(?:add|support)\\b"],
	documentationPaths: ["docs/"],
	documentationExtensions: [".md", ".mdx", ".rst", ".txt"],
	divergedSurfaces: [
		{
			name: "model catalog",
			paths: ["packages/catalog/"],
			note: "veyyon owns its model IDs, types, and roles.",
			blocksCleanFeatures: true,
		},
		{
			name: "interactive TUI",
			paths: ["packages/coding-agent/src/modes/"],
			note: "veyyon owns its TUI composition.",
			blocksCleanFeatures: true,
		},
		{
			name: "documentation",
			paths: ["docs/"],
			note: "rewrite docs for veyyon.",
			blocksCleanFeatures: false,
		},
	],
};

describe("titleType", () => {
	it("reads the conventional-commit type through scope and breaking markers", () => {
		expect(titleType("fix(tui): reset cursor mode")).toBe("fix");
		expect(titleType("feat!: breaking thing")).toBe("feat");
		expect(titleType("perf(ai): faster stream decode")).toBe("perf");
	});
	it("is null for unprefixed titles (upstream does merge those)", () => {
		expect(titleType("Fix ST-terminated OSC 8 links in Markdown tables")).toBeNull();
		expect(titleType("Add firecrawl keyless mode support")).toBeNull();
	});
});

describe("port candidate policy", () => {
	/** Fixes and performance corrections must keep entering semantic triage even on diverged paths. */
	it("admits fix and perf changes without treating path divergence as an automatic rejection", () => {
		expect(isPortWorthy("fix(catalog): correct token limit", ["packages/catalog/src/model-manager.ts"], policy)).toBe(
			true,
		);
		expect(isPortWorthy("perf(tui): cheaper frame diff", ["packages/tui/src/tui.ts"], policy)).toBe(true);
	});

	/** A small additive feature on an inherited leaf surface should produce a manually reviewed PR candidate. */
	it("admits conventional and unprefixed feature additions on clean surfaces", () => {
		const files = ["packages/ai/src/providers/anthropic.ts", "packages/ai/test/anthropic.test.ts"];
		expect(isPortWorthy("feat(ai): expose retry delay", files, policy)).toBe(true);
		expect(isPortWorthy("Add retry delay reporting", files, policy)).toBe(true);
		expect(isPortWorthy("Support retry delay reporting", files, policy)).toBe(true);
	});

	/** A feature crossing a locally owned architecture must never consume an implementation lane automatically. */
	it("rejects feature additions that touch a blocking diverged surface", () => {
		expect(isPortWorthy("feat(catalog): add a model role", ["packages/catalog/src/model-thinking.ts"], policy)).toBe(
			false,
		);
		expect(
			isPortWorthy(
				"feat(tui): replace plan review",
				["packages/coding-agent/src/modes/components/plan-review-overlay.ts"],
				policy,
			),
		).toBe(false);
	});

	/** Documentation is rewritten locally, so accompanying prose alone must not disqualify clean source changes. */
	it("allows a clean feature to carry upstream documentation paths that do not block candidates", () => {
		expect(
			isPortWorthy(
				"feat(ai): expose retry delay",
				["packages/ai/src/providers/anthropic.ts", "docs/providers.md"],
				policy,
			),
		).toBe(true);
		expect(cleanFeatureBlockers(["docs/providers.md"], policy)).toEqual([]);
	});

	/** Features whose entire diff is prose must not consume a Jules implementation lane. */
	it("rejects typed and unprefixed documentation-only features by file surface", () => {
		expect(isPortWorthy("feat(docs): add deployment guide", ["docs/deployment.md"], policy)).toBe(false);
		expect(isPortWorthy("Add deployment documentation", ["README.md", "docs/deployment.md"], policy)).toBe(false);
		expect(isDocumentationOnly(["README.md", "docs/deployment.md"], policy)).toBe(true);
	});

	/** A feature with no returned files is incomplete evidence, not a clean implementation surface. */
	it("rejects an empty feature file list", () => {
		expect(isPortWorthy("feat(ai): expose retry delay", [], policy)).toBe(false);
	});

	/** Non-feature direction changes remain excluded so the radar cannot become a wholesale sync queue. */
	it("rejects refactors, docs-only commits, and chores", () => {
		for (const title of ["refactor(core): split loop", "docs: document /vibe mode", "chore(deps): bump things"]) {
			expect(isPortWorthy(title, [], policy)).toBe(false);
		}
	});

	/** Typed titles must use their declared type instead of sneaking through an unprefixed-title regex. */
	it("does not classify a typed title through the unprefixed regexes", () => {
		expect(portCandidateKind("refactor: add a retry delay", policy)).toBeNull();
		expect(portCandidateKind("feat: fix the fixer", policy)).toBe("clean-feature");
	});
});

describe("GitHub pagination and file completeness", () => {
	/** Full 100-item pages require another request; stopping at an arbitrary cap silently loses candidates. */
	it("collects every page through the first short response", async () => {
		const requested: number[] = [];
		const values = await collectPages(async page => {
			requested.push(page);
			if (page < 3) return Array.from({ length: 100 }, (_, index) => (page - 1) * 100 + index);
			return [200, 201];
		});
		expect(requested).toEqual([1, 2, 3]);
		expect(values).toEqual(Array.from({ length: 202 }, (_, index) => index));
	});

	/** GitHub's 3,000-file endpoint ceiling must abort a 3,001-file PR instead of screening a partial diff. */
	it("refuses a truncated pull-file response", () => {
		const records = Array.from({ length: 3000 }, (_, index) => ({
			filename: `src/file-${index}.ts`,
			additions: 1,
			deletions: 0,
		}));
		expect(() => completePullFiles(7007, 3001, records)).toThrow(
			"PR #7007 reports 3001 changed files, but GitHub returned 3000; refusing partial triage",
		);
	});

	/** Validated records preserve exact filenames and line counts used in issue evidence. */
	it("returns complete typed pull-file evidence", () => {
		expect(
			completePullFiles(7008, 1, [{ filename: "packages/ai/src/provider.ts", additions: 12, deletions: 2 }]),
		).toEqual([{ filename: "packages/ai/src/provider.ts", additions: 12, deletions: 2 }]);
	});
});

describe("issue creation batching", () => {
	/** A burst above the advisory threshold must still create every issue before candidates age out. */
	it("keeps every eligible candidate in the current run", () => {
		const candidates = Array.from({ length: 11 }, (_, index) => ({ number: index + 1 }));

		const plan = planIssueCreation(candidates, 10);

		expect(plan.batch).toEqual(candidates);
		expect(plan.aboveAdvisoryLimit).toBe(1);
	});

	/** An invalid operational threshold must fail loud instead of accidentally producing an empty batch. */
	it("refuses zero, fractional, and non-numeric thresholds", () => {
		for (const value of [0, 1.5, Number.NaN]) {
			expect(() => planIssueCreation([1], value)).toThrow(/RADAR_MAX_ISSUES must be a positive integer/);
		}
	});
});

describe("divergedMatches + divergenceWarning", () => {
	it("flags a PR touching a diverged surface by path prefix and names it in the warning", () => {
		const surfaces = divergedMatches(["packages/catalog/src/model-manager.ts", "packages/ai/src/stream.ts"], policy);
		expect(surfaces.map(s => s.name)).toEqual(["model catalog"]);
		const warning = divergenceWarning(surfaces);
		expect(warning).toContain("Diverged surface warning");
		expect(warning).toContain("veyyon owns its model IDs, types, and roles.");
	});

	it("emits NO warning block for a PR outside every diverged surface", () => {
		expect(divergenceWarning(divergedMatches(["packages/ai/src/stream.ts"], policy))).toBe("");
	});

	it("flags multiple touched surfaces at once", () => {
		const surfaces = divergedMatches(
			["packages/catalog/src/hosts.ts", "packages/coding-agent/src/modes/interactive-mode.ts"],
			policy,
		);
		expect(surfaces.map(s => s.name)).toEqual(["model catalog", "interactive TUI"]);
	});
});

describe("port issue evidence", () => {
	/**
	 * The tracking issue must supply evidence without competing with the manager's
	 * single outcome protocol, or Jules receives contradictory close/PR commands.
	 */
	it("renders a feature brief without instructing Jules to close the issue or open a PR", () => {
		const body = renderPortIssue({
			marker: "<!-- upstream-pr: 7007 -->",
			kind: "clean-feature",
			url: "https://github.com/can1357/oh-my-pi/pull/7007",
			mergedAt: "2026-07-29T12:00:00Z",
			additions: 12,
			deletions: 2,
			changedFiles: 2,
			warning: "",
			fileList: "- `packages/ai/src/provider.ts` (+10/-2)",
			bodyExcerpt: "Adds provider behavior.",
		});
		expect(body).toContain("<!-- upstream-port-kind: clean-feature -->");
		expect(body).toContain("manager's static Jules prompt owns applicability");
		expect(body).toContain("Do not close this tracking issue directly");
		expect(body).not.toContain("Open a PR");
		expect(body).not.toContain("close the issue");
	});
});

/**
 * The shipped policy file is data the radar trusts at runtime. These checks pin
 * the candidate types and architecture blockers so a data edit cannot silently
 * turn candidate generation into wholesale feature synchronization.
 */
describe("shipped upstream-port-policy.json", () => {
	/** Shipped policy must admit feature candidates while retaining every high-risk architecture boundary. */
	it("loads clean feature types and the required blocking divergence surfaces", () => {
		const shipped = loadPolicy();
		expect(shipped.allowedTypes).toEqual(["fix", "perf"]);
		expect(shipped.cleanFeatureTypes).toEqual(["feat"]);
		expect(shipped.titleAllowRegexes.length).toBeGreaterThan(0);
		expect(shipped.cleanFeatureTitleAllowRegexes.length).toBeGreaterThan(0);
		for (const path of [
			"packages/catalog/",
			"packages/ai/src/auth-broker/",
			"packages/coding-agent/src/session/",
			"packages/ai/src/instrumentation.ts",
			"packages/coding-agent/src/tools/",
			"packages/coding-agent/src/modes/",
			"crates/",
			".github/",
		]) {
			const surface = shipped.divergedSurfaces.find(candidate => candidate.paths.includes(path));
			expect(surface, `${path} must remain a declared divergence`).toBeDefined();
			expect(surface?.blocksCleanFeatures, `${path} must block automatic feature candidates`).toBe(true);
		}
		const instrumentation = divergedMatches(["packages/ai/src/instrumentation.ts"], shipped);
		expect(instrumentation.map(surface => surface.name)).toContain(
			"session, model-control, and instrumentation lifecycle",
		);
	});
});
