/**
 * Per-project-tagged mental-model ids are `seedId-sanitizedProjectLabel`.
 *
 * WHY THIS SUITE EXISTS. `resolveSeedsForScope` already has tests for the
 * happy `project:veyyon` label. The sanitizer (`[^A-Za-z0-9._-]+` → `-`,
 * trim leading/trailing dashes, empty → `"project"`) is the only thing that
 * keeps a cwd like `/tmp/My Project (v2)` or a worktree path containing `/`
 * from minting an id Hindsight will reject, or worse, colliding two projects
 * onto one model. Untested, it silently maps both `/a/b` and `/a_b` after
 * slash folding — pin the actual folding, and pin that an all-punctuation
 * label does not produce an empty id.
 */
import { describe, expect, it } from "bun:test";
import type { BankScope } from "@veyyon/coding-agent/hindsight/bank";
import { resolveSeedsForScope as resolveSeeds } from "@veyyon/coding-agent/hindsight/mental-models";

function tagged(label: string): BankScope {
	const tag = `project:${label}`;
	return {
		bankId: "veyyon",
		retainTags: [tag],
		recallTags: [tag],
		recallTagsMatch: "any",
	};
}

describe("per-project-tagged seed ids fold the project label to [A-Za-z0-9._-]", () => {
	it("replaces spaces and parentheses with dashes and strips edge dashes", () => {
		const seeds = resolveSeeds(tagged("My Project (v2)"), "per-project-tagged");
		const conventions = seeds.find(s => s.legacyIds?.includes("project-conventions"));
		expect(conventions?.id).toBe("project-conventions-My-Project-v2");
		expect(conventions?.tags).toEqual(["project:My Project (v2)"]);
	});

	it("folds slashes so a path-shaped label cannot mint a nested id", () => {
		const seeds = resolveSeeds(tagged("/tmp/worktrees/foo"), "per-project-tagged");
		const conventions = seeds.find(s => s.legacyIds?.includes("project-conventions"));
		expect(conventions?.id).toBe("project-conventions-tmp-worktrees-foo");
		expect(conventions?.id.includes("/")).toBe(false);
	});

	it("collapses runs of punctuation to a single dash", () => {
		const seeds = resolveSeeds(tagged("foo---bar___baz"), "per-project-tagged");
		const conventions = seeds.find(s => s.legacyIds?.includes("project-conventions"));
		// underscores are allowed; only non [A-Za-z0-9._-] fold.
		expect(conventions?.id).toBe("project-conventions-foo---bar___baz");
	});

	it("folds mixed punctuation runs (`foo@#$bar`) to one dash", () => {
		const seeds = resolveSeeds(tagged("foo@#$bar"), "per-project-tagged");
		const conventions = seeds.find(s => s.legacyIds?.includes("project-conventions"));
		expect(conventions?.id).toBe("project-conventions-foo-bar");
	});

	it("uses the fallback `project` when the label sanitizes to empty", () => {
		const seeds = resolveSeeds(tagged("@@@"), "per-project-tagged");
		const conventions = seeds.find(s => s.legacyIds?.includes("project-conventions"));
		expect(conventions?.id).toBe("project-conventions-project");
	});

	it("does not suffix untagged seeds even when retainTags are present", () => {
		const seeds = resolveSeeds(tagged("My Project (v2)"), "per-project-tagged");
		const prefs = seeds.find(s => s.id === "user-preferences");
		expect(prefs?.id).toBe("user-preferences");
		expect(prefs?.legacyIds).toBeUndefined();
		expect(prefs?.tags).toEqual([]);
	});

	it("keeps dots in a label (they are in the allowed set)", () => {
		const seeds = resolveSeeds(tagged("veyyon.io"), "per-project-tagged");
		const conventions = seeds.find(s => s.legacyIds?.includes("project-conventions"));
		expect(conventions?.id).toBe("project-conventions-veyyon.io");
	});
});

describe("computeBankScope still writes the raw project: label, not the sanitized id suffix", () => {
	it("retainTags keep spaces that the seed id folded", () => {
		// Bank tags are a filter, not an id. Folding them would hide memories
		// retained under the raw cwd basename.
		const scope = tagged("My Project (v2)");
		expect(scope.retainTags).toEqual(["project:My Project (v2)"]);
	});
});
