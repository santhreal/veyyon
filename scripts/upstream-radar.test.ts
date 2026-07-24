import { describe, expect, it } from "bun:test";
import {
	divergedMatches,
	divergenceWarning,
	isPortWorthy,
	loadPolicy,
	type PortPolicy,
	titleType,
} from "./upstream-radar.ts";

/**
 * The port policy is what keeps the pipeline fixes-only: veyyon deliberately
 * diverged from upstream on direction (model catalog/IDs/roles, branding), so
 * mirroring feature PRs would queue work that fights the product. A regression
 * here either floods the queue with direction-conflicting ports (burning the
 * whole Jules budget on work that gets rejected) or silently drops real bug
 * fixes (the recall loss the radar exists to prevent).
 */

const policy: PortPolicy = {
	allowedTypes: ["fix", "perf"],
	titleAllowRegexes: ["^fix\\b"],
	divergedSurfaces: [
		{ name: "model catalog", paths: ["packages/catalog/"], note: "veyyon owns its model IDs, types, and roles." },
		{ name: "branding", paths: ["website/", "docs/"], note: "veyyon owns its brand." },
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

describe("isPortWorthy", () => {
	it("admits fix and perf, the bug-fix types veyyon ports", () => {
		expect(isPortWorthy("fix(agent): commit plan-reference flag", policy)).toBe(true);
		expect(isPortWorthy("perf(tui): cheaper frame diff", policy)).toBe(true);
	});

	it("rejects direction types: features, refactors, docs, chores", () => {
		for (const t of [
			"feat(openai): add explicit prompt cache policy",
			"refactor(core): split loop",
			"docs: document /vibe mode",
			"chore(deps): bump things",
		]) {
			expect(isPortWorthy(t, policy)).toBe(false);
		}
	});

	it("admits unprefixed titles that are clearly fixes, case-insensitively", () => {
		expect(isPortWorthy("Fix ST-terminated OSC 8 links in Markdown tables", policy)).toBe(true);
	});

	it("rejects unprefixed feature titles", () => {
		expect(isPortWorthy("Add dynamic multi-root workspace context", policy)).toBe(false);
		expect(isPortWorthy("Support light, dark, and system themes in HTML exports", policy)).toBe(false);
	});

	it("never lets a typed title sneak in through the unprefixed regexes ('feat: fix the fixer')", () => {
		expect(isPortWorthy("feat: fix the fixer", policy)).toBe(false);
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
		const surfaces = divergedMatches(["packages/catalog/src/hosts.ts", "website/sun.js"], policy);
		expect(surfaces.map(s => s.name)).toEqual(["model catalog", "branding"]);
	});
});

/**
 * The shipped policy file is data the radar trusts blindly; this pins its
 * shape and its two load-bearing guarantees (fixes-only types, the model
 * catalog named as diverged) so an edit cannot silently disable the gate.
 */
describe("shipped upstream-port-policy.json", () => {
	it("parses, allows only bug-fix types, and names the model catalog as diverged", () => {
		const shipped = loadPolicy();
		expect(shipped.allowedTypes).toEqual(["fix", "perf"]);
		expect(shipped.titleAllowRegexes.length).toBeGreaterThan(0);
		const catalog = shipped.divergedSurfaces.find(s => s.paths.includes("packages/catalog/"));
		expect(catalog).toBeDefined();
		expect(catalog?.note).toContain("model");
	});
});
