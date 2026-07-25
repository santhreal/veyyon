#!/usr/bin/env bun
// Reports which test files leave process-global state changed behind them.
//
// Usage:
//   bun scripts/find-test-leaks.ts packages/coding-agent/test        # a directory
//   bun scripts/find-test-leaks.ts packages/utils/test/profiles.test.ts
//   bun scripts/find-test-leaks.ts --json packages/tui/test
//
// Why this exists: a full `bun test` run showed roughly twenty failures that
// vanished when the same files ran alone, and the count moved between runs
// (twenty, then thirty-three). All the files share one process, so a suite that
// sets `VEYYON_CONFIG_DIR`, `HOME`, or the working directory and does not restore
// it hands its roots to every file scheduled after it. The failures land on the
// victims, so reading the failing files finds nothing.
//
// Each file is run in its own process with `packages/utils/test/helpers/
// global-state-leak-tracer.ts` preloaded, which compares the tracked globals
// before and after every test. A file that leaks against its own process baseline
// leaks wherever it is scheduled, so the answer does not depend on run order.
//
// Exit code is 1 when any file leaks, so this can be a gate once the tree is
// clean.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import * as path from "node:path";
import { LEAK_FILE_ENV, type LeakReport, parseLeaks } from "../packages/utils/test/helpers/global-state-leak-tracer";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const TRACER = "packages/utils/test/helpers/global-state-leak-preload.ts";
/** The tripwire preload every test process gets from `bunfig.toml`. */
const TRIPWIRE = "packages/utils/test/helpers/real-data-tripwire.ts";

/**
 * Directories never walked, whatever they contain. `fixtures` holds deliberately broken
 * files that are inputs to tests, not tests.
 */
const SKIP_DIRS = new Set(["node_modules", "fixtures"]);

/**
 * True when git ignores the path, so it is not ours to check.
 *
 * This matters at the top of a tree: `packages/deepswe-bench/repo-cache` is a gitignored
 * cache of CLONED EXTERNAL REPOSITORIES and it holds 3,332 `.test.ts` files — more than
 * twice the whole veyyon suite. Walking it would spend hours running other projects'
 * tests and report their leaks as ours. Asking git rather than growing a name list means
 * the next gitignored cache is excluded the day it appears.
 */
function isGitIgnored(repoRoot: string, absPath: string): boolean {
	const run = spawnSync("git", ["check-ignore", "-q", absPath], { cwd: repoRoot });
	// 0 = ignored, 1 = not ignored, 128 = not a git repo (then nothing is ignored).
	return run.status === 0;
}

/** Test files under a path, or the path itself when it is already a test file. */
export function testFilesUnder(repoRoot: string, target: string): string[] {
	const abs = path.resolve(repoRoot, target);
	if (!fs.existsSync(abs)) throw new Error(`no such path: ${target}`);
	// An explicitly named file is always checked, ignored or not: the caller asked for it.
	if (fs.statSync(abs).isFile()) return [path.relative(repoRoot, abs)];

	const found: string[] = [];
	const stack = [abs];
	while (stack.length > 0) {
		const dir = stack.pop() as string;
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (SKIP_DIRS.has(entry.name)) continue;
				if (isGitIgnored(repoRoot, full)) {
					// Loud, not silent: a skipped subtree is coverage this run does not have.
					console.error(`skipping gitignored directory: ${path.relative(repoRoot, full)}`);
					continue;
				}
				stack.push(full);
				continue;
			}
			if (entry.name.endsWith(".test.ts") || entry.name.endsWith(".test.tsx")) {
				found.push(path.relative(repoRoot, full));
			}
		}
	}
	return found.sort();
}

export interface FileResult {
	file: string;
	leaks: LeakReport[];
	/** True when the runner itself failed (a crash, not a leak). */
	runnerFailed: boolean;
}

/**
 * Runs one test file with the tracer preloaded and collects its leak lines.
 *
 * The target is passed as an ABSOLUTE path. A bare relative path is a FILTER to
 * `bun test`, matched against the names of the files it discovers, and discovery
 * only picks up names containing `.test`/`.spec` — so a file named
 * `leaky-suite.fixture.ts` matched nothing and the run reported "did not match
 * any test files" instead of tracing it. An absolute (or `./`-prefixed) path is
 * treated as a path and runs whatever its name is, which is what lets the
 * deliberate-leak fixtures live outside the `*.test.ts` glob where an ordinary
 * `bun test <dir>` cannot collect them.
 */
export function traceFile(repoRoot: string, file: string): FileResult {
	const run = spawnSync(
		"bun",
		// Absolute preload paths: bun resolves a bare relative path as a package
		// specifier and reports "preload not found".
		[
			"test",
			"--preload",
			path.join(repoRoot, TRIPWIRE),
			"--preload",
			path.join(repoRoot, TRACER),
			path.resolve(repoRoot, file),
		],
		// The tracer reads the file name from the environment because Bun exposes no
		// current-test path to a hook.
		{ cwd: repoRoot, encoding: "utf8", env: { ...process.env, [LEAK_FILE_ENV]: file } },
	);
	const output = `${run.stdout ?? ""}\n${run.stderr ?? ""}`;
	return {
		file,
		leaks: parseLeaks(output),
		// A non-zero exit with no leak lines means the file failed for its own
		// reasons. Reported rather than swallowed: a file whose tests do not run
		// tells this tool nothing about whether it leaks, and calling that "clean"
		// would be a silent skip.
		runnerFailed: run.status !== 0 && parseLeaks(output).length === 0,
	};
}

if (import.meta.main) {
	const args = process.argv.slice(2);
	const asJson = args.includes("--json");
	const targets = args.filter(arg => !arg.startsWith("--"));
	if (targets.length === 0) {
		console.error("usage: bun scripts/find-test-leaks.ts [--json] <file-or-directory>…");
		process.exit(2);
	}

	const files = targets.flatMap(target => testFilesUnder(REPO_ROOT, target));
	const results: FileResult[] = [];
	for (const [index, file] of files.entries()) {
		const result = traceFile(REPO_ROOT, file);
		results.push(result);
		const state = result.leaks.length > 0 ? `LEAKS (${result.leaks.length})` : result.runnerFailed ? "FAILED" : "ok";
		console.error(`[${index + 1}/${files.length}] ${state}  ${file}`);
	}

	const leaking = results.filter(result => result.leaks.length > 0);
	const failed = results.filter(result => result.runnerFailed);

	if (asJson) {
		console.log(JSON.stringify({ checked: files.length, leaking, failed: failed.map(f => f.file) }, null, 2));
	} else {
		console.log(`\nchecked ${files.length} file(s): ${leaking.length} leaking, ${failed.length} failed to run`);
		for (const result of leaking) {
			console.log(`\n${result.file}`);
			for (const leak of result.leaks) {
				for (const diff of leak.diffs) {
					console.log(`  left behind  ${diff.key}: ${diff.before ?? "(unset)"} -> ${diff.after ?? "(unset)"}`);
				}
				// The per-test trail, so the file's own tests can be read in the right
				// order rather than top to bottom looking for a mutation.
				for (const move of leak.moves) {
					for (const diff of move.diffs) {
						console.log(`    first changed by test #${move.testIndex}: ${diff.key}`);
					}
				}
			}
		}
		for (const result of failed) console.log(`\ncould not run (no leak verdict): ${result.file}`);
	}

	process.exit(leaking.length > 0 ? 1 : 0);
}
