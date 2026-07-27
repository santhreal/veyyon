/**
 * Where a test suite can be run from, in one place.
 *
 * Two coverage locks ask the same question and used to answer it differently.
 * `scripts/script-tests-coverage.test.ts` read a HAND-KEPT list of two workflow
 * files, which is the drift its own doc comment says it exists to catch: a suite
 * run by `.github/workflows/leak-sweep.yml` read as run by nothing, because that
 * workflow was not on the list. `scripts/workspace-typecheck-coverage.test.ts`
 * already walked the workflow directory, so the two locks disagreed about the
 * same file and only one of them was right.
 *
 * So the question has one owner. A suite is covered when `repoScriptTests` names
 * it, when any workflow passes it to `bun test`, or when a root `package.json`
 * script runs it. Nothing here decides what a lock does with that; it only reads
 * the tree.
 */
import { readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

/** The repository root, found from this file rather than the process cwd. */
export const repoRoot = path.resolve(import.meta.dir, "..");

/**
 * Every workflow file, read from disk rather than listed.
 *
 * A new workflow that runs a suite counts the day it lands, which a hand-kept
 * list cannot promise. Returns an empty array in a checkout without CI config so
 * a lock can still run there.
 */
export function workflowFiles(): string[] {
	const dir = path.join(repoRoot, ".github", "workflows");
	try {
		return readdirSync(dir)
			.filter(name => name.endsWith(".yml") || name.endsWith(".yaml"))
			.sort()
			.map(name => path.join(".github", "workflows", name));
	} catch {
		return [];
	}
}

/** The text of every workflow, plus the root `package.json`. */
export function runnerSources(): string[] {
	const sources = [readFileSync(path.join(repoRoot, "package.json"), "utf8")];
	for (const workflow of workflowFiles()) {
		sources.push(readFileSync(path.join(repoRoot, workflow), "utf8"));
	}
	return sources;
}

/**
 * Every `*.test.ts` path any workflow passes to a test command.
 *
 * Extracted by pattern rather than by parsing the YAML, because what matters is
 * that the path appears in a command a runner executes, and the shapes it can
 * appear in (`bun test a.test.ts b.test.ts`, a shell variable, a matrix entry)
 * all put the literal path in the file.
 */
export function workflowTestPaths(): string[] {
	const found: string[] = [];
	for (const workflow of workflowFiles()) {
		const text = readFileSync(path.join(repoRoot, workflow), "utf8");
		for (const match of text.matchAll(/[\w./-]+\.test\.ts/g)) found.push(match[0]);
	}
	return found;
}
