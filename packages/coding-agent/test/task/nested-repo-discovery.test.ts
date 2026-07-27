/**
 * Finding nested git repositories must never answer "not a repository" because it could not look.
 *
 * WHY THIS SUITE EXISTS. `discoverNestedRepos` decides which directories under a project are their own
 * repositories, and an isolated task uses that list as a set of BOUNDARIES: a nested repo manages its own
 * tree, so the walk stops there and the task snapshot does not include it. The check was
 * `try { await fs.access(dir/.git) } catch {}` and the listing was `try { readdir } catch { return }` --
 * two bare swallows, so every failure produced the same answer as "no `.git` here".
 *
 * That is wrong in the dangerous direction, twice. A `.git` the process cannot stat (an unreadable parent,
 * a restricted mount, an I/O error) made the directory look like ordinary content, so the walk DESCENDED
 * into a repository it had failed to recognise and folded that repository's files into the parent's
 * snapshot. A directory that cannot be listed hid every nested repository beneath it, with nothing said.
 * Neither shows up as an error; both show up much later as a task that captured or restored files nobody
 * expected.
 *
 * So the two answers are now distinguished: ENOENT is a plain "no", and anything else is reported and
 * treated as a boundary -- the walk stops rather than reaching into a tree it cannot inspect. This suite
 * pins the ordinary answers first, because a guard that also fired on a normal directory would turn every
 * project into a pile of boundaries, and then pins the unreadable case that the bare catch hid.
 */

import { afterEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { discoverNestedRepos } from "@veyyon/coding-agent/task/worktree";
import { logger } from "@veyyon/utils";

const created: string[] = [];

/** A real git repository on disk, since the code under test asks git for the submodule list. */
function tempRepo(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-nested-repo-"));
	created.push(dir);
	Bun.spawnSync(["git", "init", "-q"], { cwd: dir });
	return dir;
}

/** A directory that looks like a repository to the scan: it has a `.git` entry. */
function nestedRepo(root: string, relative: string): string {
	const dir = path.join(root, relative);
	fs.mkdirSync(path.join(dir, ".git"), { recursive: true });
	return dir;
}

/** Mode bits do not restrict root, and Windows does not honour them. */
function canRestrictAccess(): boolean {
	return process.platform !== "win32" && process.getuid?.() !== 0;
}

/**
 * Directories this suite made unreadable, remembered so cleanup can put them back.
 *
 * Walking the tree to find them does not work: the walk needs exactly the permission that was taken
 * away, so the cleanup fails on the very directories it exists to restore.
 */
const restricted: string[] = [];

/** Take away a mode from `dir` and remember to restore it. */
function restrict(dir: string, mode: number): void {
	restricted.push(dir);
	fs.chmodSync(dir, mode);
}

afterEach(() => {
	for (const dir of restricted.splice(0)) fs.chmodSync(dir, 0o700);
	for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

function warningsFrom(run: () => Promise<string[]>): Promise<{ result: string[]; warnings: string[] }> {
	const warnings: string[] = [];
	const spy = spyOn(logger, "warn").mockImplementation((message: string) => {
		warnings.push(message);
	});
	return run()
		.then(result => ({ result, warnings }))
		.finally(() => spy.mockRestore());
}

describe("discovering nested repositories in an ordinary tree", () => {
	/** The baseline: a plain project with no nested repositories reports none, and says nothing. */
	it("finds nothing and reports nothing when there are none", async () => {
		const root = tempRepo();
		fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
		fs.writeFileSync(path.join(root, "src", "deep", "file.ts"), "export {};\n");

		const { result, warnings } = await warningsFrom(() => discoverNestedRepos(root));

		expect(result).toEqual([]);
		expect(warnings).toEqual([]);
	});

	/** The ordinary find, by exact relative path, with no warning: a missing `.git` is not a failure. */
	it("finds a nested repository by its path relative to the root", async () => {
		const root = tempRepo();
		nestedRepo(root, "vendor/library");

		const { result, warnings } = await warningsFrom(() => discoverNestedRepos(root));

		expect(result).toEqual([path.join("vendor", "library")]);
		expect(warnings).toEqual([]);
	});

	/**
	 * A nested repository is a boundary, so what is inside it is not the parent's business. Without this,
	 * a repo-inside-a-repo would be reported twice and the inner one snapshotted as the outer's content.
	 */
	it("does not descend into a nested repository", async () => {
		const root = tempRepo();
		nestedRepo(root, "vendor/library");
		nestedRepo(root, path.join("vendor", "library", "inner"));

		const { result } = await warningsFrom(() => discoverNestedRepos(root));

		expect(result).toEqual([path.join("vendor", "library")]);
	});

	/** `node_modules` and the root's own `.git` are skipped, so a dependency's repo is not a boundary. */
	it("skips node_modules and the root's own git directory", async () => {
		const root = tempRepo();
		nestedRepo(root, path.join("node_modules", "some-package"));

		const { result } = await warningsFrom(() => discoverNestedRepos(root));

		expect(result).toEqual([]);
	});
});

describe("discovering nested repositories when a directory cannot be inspected", () => {
	/**
	 * The regression. A directory whose `.git` cannot be stat'd must be REPORTED and treated as a
	 * boundary -- not silently reclassified as ordinary content and walked into. The nested repository
	 * hidden inside it is the evidence: under the bare `catch {}` the walk descended and found it, which
	 * is exactly the wrong answer, because the directory it descended through may itself be a repository.
	 */
	it("reports an unreadable directory and stops at it instead of descending", async () => {
		if (!canRestrictAccess()) return;
		const root = tempRepo();
		const opaque = path.join(root, "opaque");
		nestedRepo(root, path.join("opaque", "hidden-repo"));
		restrict(opaque, 0o000);

		const { result, warnings } = await warningsFrom(() => discoverNestedRepos(root));

		expect(result).toEqual([]);
		expect(warnings).toContain(
			"Could not tell whether a directory is a nested git repository; treating it as a boundary",
		);
	});

	/**
	 * And a directory that cannot be LISTED is reported too. It is a different failure from the one above
	 * -- the directory itself is readable enough to be a candidate, but its contents are not -- and it
	 * hides every nested repository beneath it, so silence there means a task snapshot quietly includes
	 * repositories nobody listed.
	 */
	it("reports a directory whose contents cannot be listed", async () => {
		if (!canRestrictAccess()) return;
		const root = tempRepo();
		const unlistable = path.join(root, "unlistable");
		fs.mkdirSync(path.join(unlistable, "child"), { recursive: true });
		// Executable but not readable: `fs.access` on `<dir>/.git` reports ENOENT (a plain "no"), while
		// `readdir` on the directory fails with EACCES. That is the listing failure, isolated.
		restrict(unlistable, 0o111);

		const { result, warnings } = await warningsFrom(() => discoverNestedRepos(root));

		expect(result).toEqual([]);
		expect(warnings).toContain("Could not list a directory while looking for nested git repositories");
	});

	/**
	 * The guard must not fire on the ordinary tree, which is the half that keeps it from being noise. A
	 * check written slightly too broadly (treating every `access` rejection as unanswerable) would warn
	 * once per directory in every repository on every isolated task.
	 */
	it("stays quiet for a directory that simply has no git entry", async () => {
		const root = tempRepo();
		fs.mkdirSync(path.join(root, "a", "b", "c"), { recursive: true });

		const { warnings } = await warningsFrom(() => discoverNestedRepos(root));

		expect(warnings).toEqual([]);
	});
});
