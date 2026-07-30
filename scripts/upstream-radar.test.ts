import { describe, expect, it } from "bun:test";
import {
	cleanFeatureBlockers,
	divergedMatches,
	divergenceWarning,
	isPortWorthy,
	loadPolicy,
	type PortPolicy,
	portCandidateKind,
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
			"packages/coding-agent/src/tools/",
			"packages/coding-agent/src/modes/",
			"crates/",
			".github/",
		]) {
			const surface = shipped.divergedSurfaces.find(candidate => candidate.paths.includes(path));
			expect(surface, `${path} must remain a declared divergence`).toBeDefined();
			expect(surface?.blocksCleanFeatures, `${path} must block automatic feature candidates`).toBe(true);
		}
	});
});
