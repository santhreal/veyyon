/**
 * Every package that ships tests is actually executed by the test runner.
 *
 * WHY THIS SUITE EXISTS. `scripts/ci-test-ts.ts` used to fan out with
 * `bun run --workspaces test`, which reaches a package by existing. It was
 * replaced by three hand-kept lists of package paths — `fastWorkspacePackages`,
 * `nativeAndIntegrationPackages`, `localOnlyWorkspacePackages` — and a list is
 * reached by somebody remembering to add to it.
 *
 * Seven packages were never added: argot (27 test files), stats (19),
 * deepswe-bench (13), metaharness (9), collab-web (9), tool-render (3) and
 * swarm-extension (2). 78 files, 1274 tests, executed by nothing — not by CI's
 * `all` mode, not by the local `local-ts` mode. Nothing anywhere reported a gap,
 * because every signal said covered: each package declares a working `test`
 * script, the files are ordinary test files in ordinary places, and the runner's
 * own comment claimed the lists covered "every package the old `--workspaces`
 * fan-out covered". They all passed when finally run, which is the part that
 * makes this worth locking: a suite that runs nowhere gives exactly the same
 * green as a suite that runs and passes, right up until it does not.
 *
 * The same defect had already been found one level down, at repo-script scope
 * (CI-SCRIPT-TESTS-UNRUN, where 13 suites including all seven installer-parity
 * ones were referenced by no runner, and a hand-copied SEVEN-entry duplicate of
 * a 32-entry list made one of them look covered). Fixing the instance without
 * checking the list against the tree is what let it recur one level up.
 *
 * Both directions are asserted. A package with tests and no list entry fails, so
 * a new package cannot join the tree already exempt. A list entry naming a
 * package that has no tests fails too, so a deleted or renamed package cannot rot
 * in the list and quietly shrink the run.
 *
 * THE MEMBERS ARE DERIVED, NOT NAMED. This suite enumerated `packages/` literally, which made it blind
 * the moment a member moved out of that directory. `contracts/wire` ships eight test files, and after
 * the move neither direction saw it: the missing-entry sweep never enumerated it, and the stale-entry
 * sweep filtered its bucket row out as "not a package path". Literal members like `natives/bridge/bindings`
 * and `python/veybot/web` were likewise invisible to root globs. The members now come from
 * `scripts/workspace-layout.ts`, so a member at any depth is covered.
 */
import { describe, expect, it } from "bun:test";
import { type Dirent, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import {
	fastWorkspacePackages,
	localOnlyWorkspacePackages,
	nativeAndIntegrationPackages,
	workspaceTestPackages,
} from "./ci-test-ts";
import { REPO_ROOT, typeScriptMembers, typeScriptMemberTopLevels } from "./workspace-layout";

/**
 * Packages the runner reaches WITHOUT a list entry, with the mechanism that
 * reaches them. Anything not here has to be listed.
 */
const DISCOVERED_NOT_LISTED: Record<string, string> = {
	// `codingAgentTestCommands` walks `test/` and `src/` itself and buckets each
	// file by content, so listing it would double-run the largest suite in the repo.
	"packages/coding-agent": "discovered by walking the package in codingAgentTestCommands",
};

/** Whether a repo-relative directory is a workspace member, by carrying a manifest. */
function isPackageDir(dir: string): boolean {
	try {
		return statSync(join(REPO_ROOT, dir, "package.json")).isFile();
	} catch {
		return false;
	}
}

/** Count the test files under a directory, skipping trees that are not ours. */
function testFileCount(dir: string): number {
	const SKIP = new Set(["node_modules", ".git", "dist", "target", "repo-cache", "runs", "deep-swe", "assets"]);
	let found = 0;
	const walk = (abs: string): void => {
		let entries: Dirent[];
		try {
			entries = readdirSync(abs, { withFileTypes: true });
		} catch {
			return;
		}
		for (const entry of entries) {
			if (entry.isDirectory()) {
				if (SKIP.has(entry.name)) continue;
				walk(join(abs, entry.name));
				continue;
			}
			// `.test.tsx` counts: collab-web and metaharness ship component suites, and
			// counting only `.test.ts` is how those two looked smaller than they are.
			if (/\.test\.tsx?$/.test(entry.name)) found += 1;
		}
	};
	walk(join(REPO_ROOT, dir));
	return found;
}

/** The TypeScript member top levels whose members this runner is responsible for. */
const ROOTS = typeScriptMemberTopLevels();

/** Every workspace member under any declared root that ships at least one test file. */
function packagesWithTests(): string[] {
	const out: string[] = [];
	for (const member of typeScriptMembers()) {
		if (testFileCount(member) > 0) out.push(member);
	}
	return out.sort();
}

/** Whether a bucket entry names a member under a declared root, so the stale sweep can judge it. */
function isUnderADeclaredRoot(dir: string): boolean {
	return ROOTS.some(root => dir.startsWith(`${root}/`));
}

describe("the workspace test runner covers every package that ships tests", () => {
	it("finds packages and test files at all, so the comparisons are not two empty sets", () => {
		// Both assertions below compare sets. If the walk broke, both sets would go
		// empty and both would pass forever while proving nothing — the exact way a
		// coverage check rots into decoration.
		const withTests = packagesWithTests();

		expect(withTests.length).toBeGreaterThan(10);
		expect(withTests).toContain("packages/argot");
		expect(testFileCount("packages/argot")).toBeGreaterThan(20);
		// A member outside `packages/`, which is what the literal enumeration could not see. Naming it
		// means the sweep has to reach every declared root, not just the one that happens to be first.
		expect(withTests).toContain("contracts/wire");
		expect(ROOTS).toContain("contracts");
	});

	it("runs the tests of every package that has them", () => {
		// The direction that was broken: a package ships tests and no bucket names
		// it, so `bun run test` and CI both skip it in silence.
		const listed = new Set(workspaceTestPackages);
		const unrun = packagesWithTests().filter(dir => !listed.has(dir) && DISCOVERED_NOT_LISTED[dir] === undefined);

		// Listed rather than counted: the failure has to name the package to add.
		expect(unrun).toEqual([]);
	});

	it("names no package that has stopped shipping tests", () => {
		// The opposite drift. A renamed or deleted package left in a bucket makes the
		// run quietly smaller while the list still reads complete, and `bun test` in a
		// directory with no test files exits 0.
		const stale = workspaceTestPackages
			.filter(dir => isUnderADeclaredRoot(dir))
			.filter(dir => testFileCount(dir) === 0);

		expect(stale).toEqual([]);
	});

	it("puts each package in exactly one bucket", () => {
		// Two buckets naming one package runs its suite twice, at two different
		// concurrency settings, and the second run inherits whatever global state the
		// first left behind. It also makes `workspaceTestPackages` disagree with its
		// own length, which is the kind of drift that hides a missing entry.
		const seen = new Map<string, string[]>();
		for (const [bucket, dirs] of [
			["fast", fastWorkspacePackages],
			["nativeAndIntegration", nativeAndIntegrationPackages],
			["localOnly", localOnlyWorkspacePackages],
		] as const) {
			for (const dir of dirs) seen.set(dir, [...(seen.get(dir) ?? []), bucket]);
		}
		const duplicated = [...seen]
			.filter(([, buckets]) => buckets.length > 1)
			.map(([dir, b]) => `${dir}: ${b.join(", ")}`);

		expect(duplicated).toEqual([]);
		expect(workspaceTestPackages.length).toBe(seen.size);
	});

	it("gives every exemption a stated mechanism rather than a bare waiver", () => {
		// An exemption list with no reasons becomes the place packages are parked. Each
		// entry has to name how the runner reaches the package instead, and that claim
		// has to be checkable: coding-agent is reached by a walk, so it must still be a
		// real package that ships tests.
		for (const [dir, reason] of Object.entries(DISCOVERED_NOT_LISTED)) {
			expect(isPackageDir(dir), `${dir} is exempted but is not a package`).toBe(true);
			expect(testFileCount(dir), `${dir} is exempted but ships no tests`).toBeGreaterThan(0);
			expect(reason.length, `${dir}'s exemption gives no reason`).toBeGreaterThan(20);
		}
	});

	it("keeps every listed path pointing at a real package", () => {
		// A typo in a bucket entry is invisible: `bun test` in a directory that does
		// not exist is a silently skipped command, not an error.
		const missing = workspaceTestPackages.filter(dir => {
			try {
				return !statSync(join(REPO_ROOT, dir)).isDirectory();
			} catch {
				return true;
			}
		});

		expect(missing).toEqual([]);
		// `python/veybot/web` is deliberately outside `packages/`, so the guard must
		// not assume the prefix; this pins that it is still reached.
		expect(workspaceTestPackages.some(dir => relative(REPO_ROOT, dir).startsWith("python/"))).toBe(true);
	});
});
