/**
 * Every repo-level test suite is actually run.
 *
 * `repoScriptTests` in `ci-test-ts.ts` is a hand-kept list of paths, and `bun test`
 * silently ignores a filter that matches nothing as long as one other filter matches.
 * Both halves of that fail quietly: a new suite under `scripts/` is simply never run
 * until somebody remembers to add it, and a renamed or deleted one leaves a dead entry
 * that looks like coverage. The comment in that file records a real instance — a
 * `ci-test-ts.test.ts` entry sat in the list for a while and the file never existed.
 *
 * A suite that exists and is not run is worse than no suite: it reports nothing while
 * looking like a gate. So this walks the directories the list is drawn from and checks
 * the two directions against each other. It is the same shape as
 * `workspace-typecheck-coverage.test.ts`, which does this for typechecking.
 *
 * `repoScriptTests` is not the only runner: the docs workflow runs the doc-gate suites
 * itself, on a path filter, so those are covered without being in the list. The check
 * is therefore "covered by SOMETHING named here", and the workflow files are read for
 * their `bun test` arguments rather than duplicated as a second hand-kept list, which
 * would have exactly the drift problem this file exists to catch.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import * as path from "node:path";
import { repoScriptTests } from "./ci-test-ts";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The trees `repoScriptTests` draws from. Anything else is another bucket's job. */
const ROOTS = ["scripts", "website/tools"] as const;

/** Directories that hold vendored or generated trees, never our own suites. */
const SKIP_DIRS = new Set(["node_modules", "dist", "install-tests", "session-stats", "repo-cache"]);

function findTestFiles(dir: string, acc: string[] = []): string[] {
	for (const entry of readdirSync(path.join(REPO_ROOT, dir))) {
		if (SKIP_DIRS.has(entry)) continue;
		const relative = path.join(dir, entry);
		const full = path.join(REPO_ROOT, relative);
		if (statSync(full).isDirectory()) findTestFiles(relative, acc);
		else if (entry.endsWith(".test.ts")) acc.push(relative);
	}
	return acc;
}

/** Workflows that run suites directly, outside `repoScriptTests`. */
const WORKFLOWS = [".github/workflows/docs.yml", ".github/workflows/hashline-soak.yml"] as const;

/** Every `*.test.ts` path a workflow passes to `bun test`. */
function workflowTestPaths(): string[] {
	const found: string[] = [];
	for (const workflow of WORKFLOWS) {
		const text = readFileSync(path.join(REPO_ROOT, workflow), "utf8");
		for (const match of text.matchAll(/[\w./-]+\.test\.ts/g)) found.push(match[0]);
	}
	return found;
}

const onDisk = ROOTS.flatMap(root => findTestFiles(root)).sort();
const listed = [...repoScriptTests].sort();
const covered = new Set([...listed, ...workflowTestPaths()]);

describe("the repo-level test list", () => {
	/** Proves the walk found something. Without this, an empty walk would make the
	 * "nothing missing" assertion below pass while checking nothing at all. */
	it("finds the suites that are known to exist", () => {
		expect(onDisk.length).toBeGreaterThan(30);
		expect(onDisk).toContain("scripts/sync-root-changelog.test.ts");
		expect(onDisk).toContain("website/tools/gen-changelog.test.ts");
	});

	/** The silent gap: a suite written and never wired in runs nowhere. */
	it("runs every suite that exists on disk", () => {
		const missing = onDisk.filter(file => !covered.has(file));

		expect(missing, `add these to repoScriptTests in scripts/ci-test-ts.ts: ${missing.join(", ")}`).toEqual([]);
	});

	/** The docs suites are covered by the docs workflow rather than by the list, and
	 * that has to keep being true: if that workflow stops naming them they fall out of
	 * coverage entirely, and the assertion above would still pass on the list alone. */
	it("still finds the doc-gate suites in the docs workflow", () => {
		const fromWorkflows = workflowTestPaths();

		expect(fromWorkflows).toContain("scripts/check-doc-links.test.ts");
		expect(fromWorkflows).toContain("scripts/check-doc-freshness.test.ts");
		expect(fromWorkflows).toContain("scripts/gen-settings-reference.test.ts");
	});

	/** The other direction: a dead entry looks like coverage and provides none, and
	 * `bun test` will not complain about it. */
	it("lists no suite that has been renamed or deleted", () => {
		const stale = listed.filter(file => !onDisk.includes(file));

		expect(stale, `remove these from repoScriptTests, they do not exist: ${stale.join(", ")}`).toEqual([]);
	});

	it("lists each suite exactly once", () => {
		const duplicates = listed.filter((file, index) => listed.indexOf(file) !== index);

		expect(duplicates).toEqual([]);
	});
});
