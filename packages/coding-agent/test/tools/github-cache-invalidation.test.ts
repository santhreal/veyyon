/**
 * The github view cache is invalidated by a bash-side detector that watches for mutating `gh` commands
 * (`gh issue close`, `gh pr merge`, ...). Those commands frequently name no repo and no auth identity,
 * so the invalidators DELIBERATELY over-invalidate: dropping a stale row is cheap, serving a stale
 * closed-issue view is not. This suite pins that contract. A regression that narrowed any invalidator
 * by auth_key, kind, or include_comments would silently leave stale cache after a mutation, which is
 * the exact failure this behavior exists to prevent. Every test isolates the cache DB to a temp file
 * (VEYYON_GITHUB_CACHE_DB) and resets the connection singleton, so nothing leaks across tests.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	getCached,
	invalidate,
	invalidateAllForNumber,
	invalidateAllForRepo,
	putCached,
	resetForTests,
} from "@veyyon/coding-agent/tools/github-cache";
import { removeWithRetries } from "@veyyon/utils";

let tempDir: string;
let originalDbEnv: string | undefined;

beforeEach(async () => {
	tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "github-cache-invalidation-"));
	originalDbEnv = process.env.VEYYON_GITHUB_CACHE_DB;
	process.env.VEYYON_GITHUB_CACHE_DB = path.join(tempDir, "github-cache.db");
	resetForTests();
});

afterEach(async () => {
	resetForTests();
	if (originalDbEnv === undefined) delete process.env.VEYYON_GITHUB_CACHE_DB;
	else process.env.VEYYON_GITHUB_CACHE_DB = originalDbEnv;
	await removeWithRetries(tempDir);
});

function seed(
	repo: string,
	kind: "issue" | "pr" | "pr-diff",
	number: number,
	includeComments: boolean,
	authKey?: string,
): void {
	putCached({ repo, kind, number, includeComments, payload: { n: number }, rendered: "rendered", authKey });
}
function isCached(
	repo: string,
	kind: "issue" | "pr" | "pr-diff",
	number: number,
	includeComments: boolean,
	authKey?: string,
): boolean {
	return getCached(repo, kind, number, includeComments, authKey) !== null;
}

describe("invalidateAllForNumber", () => {
	it("drops every row for the number across repo, kind, auth key, and include_comments", () => {
		seed("Owner/Repo", "issue", 5, false);
		seed("Owner/Repo", "issue", 5, true);
		seed("Owner/Repo", "pr", 5, false);
		seed("other/repo", "issue", 5, false);
		seed("Owner/Repo", "issue", 5, false, "alt-auth");
		seed("Owner/Repo", "issue", 9, false); // a different number must survive

		invalidateAllForNumber(5);

		expect(isCached("Owner/Repo", "issue", 5, false)).toBe(false);
		expect(isCached("Owner/Repo", "issue", 5, true)).toBe(false);
		expect(isCached("Owner/Repo", "pr", 5, false)).toBe(false);
		expect(isCached("other/repo", "issue", 5, false)).toBe(false);
		expect(isCached("Owner/Repo", "issue", 5, false, "alt-auth")).toBe(false);
		expect(isCached("Owner/Repo", "issue", 9, false)).toBe(true);
	});

	it("narrows to a single repo when the repo is known", () => {
		seed("A/x", "issue", 7, false);
		seed("B/y", "issue", 7, false);

		invalidateAllForNumber(7, "A/x");

		expect(isCached("A/x", "issue", 7, false)).toBe(false);
		expect(isCached("B/y", "issue", 7, false)).toBe(true);
	});
});

describe("invalidate", () => {
	it("drops both include_comments variants when includeComments is omitted", () => {
		seed("A/x", "issue", 3, false);
		seed("A/x", "issue", 3, true);

		invalidate("A/x", "issue", 3);

		expect(isCached("A/x", "issue", 3, false)).toBe(false);
		expect(isCached("A/x", "issue", 3, true)).toBe(false);
	});

	it("narrows to one include_comments variant when it is specified", () => {
		seed("A/x", "issue", 4, false);
		seed("A/x", "issue", 4, true);

		invalidate("A/x", "issue", 4, true);

		expect(isCached("A/x", "issue", 4, false)).toBe(true); // the no-comments row survives
		expect(isCached("A/x", "issue", 4, true)).toBe(false); // the with-comments row is dropped
	});
});

describe("invalidateAllForRepo", () => {
	it("drops only the named repo's rows when the repo is known", () => {
		seed("A/x", "issue", 1, false);
		seed("B/y", "issue", 1, false);

		invalidateAllForRepo("A/x");

		expect(isCached("A/x", "issue", 1, false)).toBe(false);
		expect(isCached("B/y", "issue", 1, false)).toBe(true);
	});

	it("drops every row when the repo is unknown (whole-cache flush fallback)", () => {
		seed("A/x", "issue", 1, false);
		seed("B/y", "pr", 2, true);

		invalidateAllForRepo();

		expect(isCached("A/x", "issue", 1, false)).toBe(false);
		expect(isCached("B/y", "pr", 2, true)).toBe(false);
	});
});

describe("repo normalization", () => {
	it("matches a differently-cased repo, so an invalidation for owner/repo hits Owner/Repo", () => {
		// gh commands and cached rows can differ in case; normalizeRepo lower-cases both sides, so a
		// lower-cased invalidation must still drop a row stored under a mixed-case repo.
		seed("Owner/Repo", "issue", 2, false);

		invalidateAllForRepo("owner/repo");

		expect(isCached("Owner/Repo", "issue", 2, false)).toBe(false);
	});
});
