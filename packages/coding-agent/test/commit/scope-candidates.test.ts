import { describe, expect, it } from "bun:test";
import { extractScopeCandidates } from "@veyyon/coding-agent/commit/analysis/scope";
import type { NumstatEntry } from "@veyyon/coding-agent/commit/types";

/**
 * extractScopeCandidates turns a diff's numstat into a suggested conventional-commit
 * scope, and it drives what the commit agent proposes. It is pure but was untested, and
 * it carries a lot of behavior worth locking: placeholder directories (src, packages,
 * lib, ...) are stripped so the scope is the meaningful component, not "src"; a change
 * spread across three or more distinct roots (or whose top component holds under 60% of
 * the changed lines) is flagged wide; a wide change is classified into a cross-cutting
 * label with a fixed precedence (deps > docs > tests > error-handling > type-refactor >
 * config); files with zero changed lines and excluded files are ignored; and git rename
 * syntax (both `a => b` and `dir/{old => new}/f` brace form) is normalized to the new
 * path before analysis. A regression would suggest a misleading scope or mislabel a
 * cross-cutting change.
 */

const n = (path: string, additions: number, deletions = 0): NumstatEntry => ({ path, additions, deletions });
const SUFFIX = "\nPrefer 2-segment scopes marked 'high confidence'";

describe("extractScopeCandidates no measurable change", () => {
	it("reports none for an empty numstat", () => {
		expect(extractScopeCandidates([])).toEqual({ scopeCandidates: "(none - no measurable changes)", isWide: false });
	});

	it("reports none when every entry has zero changed lines", () => {
		expect(extractScopeCandidates([n("src/foo/bar.ts", 0, 0)])).toEqual({
			scopeCandidates: "(none - no measurable changes)",
			isWide: false,
		});
	});
});

describe("extractScopeCandidates focused change", () => {
	it("strips the placeholder src/ dir and suggests the real component at high confidence", () => {
		expect(extractScopeCandidates([n("src/advisor/watchdog.ts", 50), n("src/advisor/advise.ts", 50)])).toEqual({
			scopeCandidates: `advisor (100%, high confidence)${SUFFIX}`,
			isWide: false,
		});
	});

	it("ranks the two-segment scope ahead of its one-segment root", () => {
		expect(extractScopeCandidates([n("lsp/clients/a.ts", 80), n("lsp/clients/b.ts", 5)])).toEqual({
			scopeCandidates: `lsp/clients (100%, high confidence), lsp (100%, high confidence)${SUFFIX}`,
			isWide: false,
		});
	});

	it("does not flag two roots as wide when the top component holds exactly 60%", () => {
		expect(extractScopeCandidates([n("alpha/a.ts", 40), n("beta/b.ts", 60)])).toEqual({
			scopeCandidates: `beta (60%, high confidence), alpha (40%, high confidence)${SUFFIX}`,
			isWide: false,
		});
	});
});

describe("extractScopeCandidates wide change", () => {
	it("flags three or more distinct roots as wide with no matching pattern", () => {
		expect(extractScopeCandidates([n("alpha/a.ts", 10), n("beta/b.ts", 10), n("gamma/c.ts", 10)])).toEqual({
			scopeCandidates: "(none - multi-component change)",
			isWide: true,
		});
	});

	it.each([
		["docs", [n("a/x.md", 10), n("b/y.md", 10), n("c/z.md", 10)]],
		["deps", [n("Cargo.toml", 5), n("beta/b.ts", 5), n("gamma/c.ts", 5)]],
		["tests", [n("alpha/test/a.ts", 10), n("beta/test/b.ts", 10), n("gamma/keep.ts", 10)]],
		["error-handling", [n("alpha/error.ts", 10), n("beta/result.ts", 10), n("gamma/keep.ts", 10)]],
		["type-refactor", [n("alpha/types.ts", 10), n("beta/enum.ts", 10), n("gamma/keep.ts", 10)]],
		["config", [n("alpha/a.yaml", 10), n("beta/b.yml", 10), n("gamma/keep.ts", 10)]],
	])("classifies a wide change as cross-cutting: %s", (label, numstat) => {
		expect(extractScopeCandidates(numstat)).toEqual({
			scopeCandidates: `(cross-cutting: ${label})`,
			isWide: true,
		});
	});

	it("prefers deps over docs when both apply (package.json plus markdown)", () => {
		const result = extractScopeCandidates([n("package.json", 5), n("a/x.md", 5), n("b/y.md", 5)]);
		expect(result).toEqual({ scopeCandidates: "(cross-cutting: deps)", isWide: true });
	});
});

describe("extractScopeCandidates rename normalization", () => {
	it("normalizes brace rename syntax to the new path", () => {
		expect(extractScopeCandidates([n("mod/{old => new}/file.ts", 50), n("mod/new/other.ts", 50)])).toEqual({
			scopeCandidates: `mod/new (100%, high confidence), mod (100%, high confidence)${SUFFIX}`,
			isWide: false,
		});
	});

	it("normalizes arrow rename syntax to the new path", () => {
		expect(extractScopeCandidates([n("scope/old.ts => scope/new.ts", 30), n("scope/keep.ts", 70)])).toEqual({
			scopeCandidates: `scope (100%, high confidence)${SUFFIX}`,
			isWide: false,
		});
	});

	it("preserves the directory suffix of a top-level rename brace so the two-segment scope survives", () => {
		// Regression for FINDING-SCOPE-RENAME-NORMALIZER-DIVERGENT-DUPLICATE: the scope module
		// carried its own copy of the rename normalizer that dropped everything after `}`. For a
		// top-level rename `{oldpkg => newpkg}/handlers/route.ts` that collapsed the path to bare
		// `newpkg`, so the `newpkg/handlers` two-segment scope disappeared entirely. Routing scope
		// through the canonical extractPathFromRename keeps the suffix, and both scopes appear. The
		// earlier brace test used a file suffix (`file.ts`), which component extraction discards
		// anyway, so it could not catch the drop; this one uses a real directory suffix.
		expect(extractScopeCandidates([n("{oldpkg => newpkg}/handlers/route.ts", 100)])).toEqual({
			scopeCandidates: `newpkg/handlers (100%, high confidence), newpkg (100%, high confidence)${SUFFIX}`,
			isWide: false,
		});
	});
});
