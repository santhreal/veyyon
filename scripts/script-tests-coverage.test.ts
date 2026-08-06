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
 * is therefore "covered by SOMETHING", and the workflows are read for their `bun test`
 * arguments rather than duplicated as a second hand-kept list. WHICH workflows to read
 * was itself a hand-kept list of two files here, which is the same drift one level up:
 * `check-test-memory.test.ts` is run by `leak-sweep.yml` and read as run by nothing,
 * for months. `runner-references.ts` now owns the question and walks the directory, so
 * a new workflow counts the day it lands.
 */
import { describe, expect, it } from "bun:test";
import { readdirSync, statSync } from "node:fs";
import * as path from "node:path";
import { repoScriptTests } from "./ci-test-ts";
import { commandText, workflowFiles, workflowTestPaths } from "./runner-references";

const REPO_ROOT = path.resolve(import.meta.dir, "..");

/** The trees `repoScriptTests` draws from. Anything else is another bucket's job. */
const ROOTS = ["scripts", "website/tools"] as const;

/**
 * Directories that hold vendored or generated trees, never our own suites.
 *
 * `session-stats` was in here and is not one of those: it is a local analysis tool with a
 * hand-written suite, and skipping the directory is precisely how `audit.test.ts` came to be
 * tracked, green, and run by nothing. A skip entry has to name a tree with no suites of ours in
 * it, or it manufactures the gap this file exists to close.
 */
const SKIP_DIRS = new Set(["node_modules", "dist", "install-tests", "repo-cache"]);

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

	/**
	 * EVERY workflow is read, not a chosen few.
	 *
	 * The bug this replaced: the two workflows named here were a hand-kept list, so
	 * `check-test-memory.test.ts` counted as unrun while `leak-sweep.yml` ran it on
	 * every sweep. Both halves are asserted, the file being found and the suite it
	 * runs being covered, because finding the file is worthless if the extraction
	 * misses what it names.
	 */
	it("reads suites out of every workflow, not a chosen few", () => {
		expect(workflowFiles()).toContain(".github/workflows/leak-sweep.yml");
		expect(workflowTestPaths()).toContain("scripts/check-test-memory.test.ts");
		expect(covered.has("scripts/check-test-memory.test.ts")).toBe(true);
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

/**
 * A path in a comment is not a path in a command.
 *
 * The extraction used to read each workflow as raw bytes, so a `.test.ts` named in
 * a YAML comment counted as a runner reference. ci.yml's `release_train_alert` job
 * carries exactly such a comment, and
 * `scripts/release-train-alert-watches-the-train.test.ts` was therefore reported as
 * run by this suite and by `workspace-typecheck-coverage.test.ts` while no runner
 * named it. The lock on the release monitor executed nowhere, and the two gates whose
 * job is to notice that agreed it was fine.
 *
 * Checked against fixtures rather than against the checked-in workflows, so the
 * contract holds whatever anyone later does to that particular comment.
 */
describe("what counts as a runner reference", () => {
	it("does not credit a suite named only in a comment", () => {
		const commands = commandText(
			[
				"jobs:",
				"  gate:",
				"    steps:",
				"      # bun test scripts/commented-out.test.ts",
				"      - run: bun test scripts/really-run.test.ts",
				"",
			].join("\n"),
		);

		expect(commands).toContain("scripts/really-run.test.ts");
		expect(commands).not.toContain("scripts/commented-out.test.ts");
	});

	/**
	 * The other direction, so the fix cannot overshoot. A path reaches a runner as a
	 * `run:` argument, a matrix entry, an env value or a `with:` input, and narrowing
	 * the read to any one of those would quietly uncover the rest.
	 */
	it("credits every shape a runner takes its paths from", () => {
		const commands = commandText(
			[
				"jobs:",
				"  gate:",
				"    strategy:",
				"      matrix:",
				"        suite: [scripts/from-matrix.test.ts]",
				"    env:",
				"      SUITE: scripts/from-env.test.ts",
				"    steps:",
				"      - uses: ./.github/actions/run-suite",
				"        with:",
				"          files: scripts/from-input.test.ts",
				"      - run: bun test scripts/from-run.test.ts",
				"",
			].join("\n"),
		);
		const found = [...commands.matchAll(/[\w./-]+\.test\.ts/g)].map(match => match[0]);

		expect(found.sort()).toEqual([
			"scripts/from-env.test.ts",
			"scripts/from-input.test.ts",
			"scripts/from-matrix.test.ts",
			"scripts/from-run.test.ts",
		]);
	});
});
