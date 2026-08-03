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

/**
 * The part of a workflow a runner actually executes, with every comment gone.
 *
 * A YAML comment is documentation, not a command, and reading a workflow as raw
 * bytes cannot tell the two apart. That is not hypothetical: ci.yml's
 * `release_train_alert` job carries a comment naming
 * `scripts/release-train-alert-watches-the-train.test.ts`, and that one mention
 * was enough to make both coverage locks report the suite as run. It was run by
 * nothing, not `repoScriptTests` and not any `bun test` argument, so the test
 * that pins the release monitor's contract executed nowhere while two gates
 * agreed it was covered.
 *
 * Parsing keeps everything the raw-text approach was right about. Every shape a
 * path can appear in (`bun test a.test.ts b.test.ts`, a shell variable, a matrix
 * entry, a `with:` input) is a VALUE in the document, and serializing the parsed
 * document preserves all of them verbatim. Only the comments, the one thing no
 * runner executes, are dropped.
 *
 * Takes the text rather than a path so the lock on this contract can hand it a
 * fixture and watch a commented-out command stop counting.
 */
export function commandText(workflowYaml: string): string {
	return JSON.stringify(Bun.YAML.parse(workflowYaml));
}

/** Every workflow's commands, plus the root `package.json`. */
export function runnerSources(): string[] {
	const sources = [readFileSync(path.join(repoRoot, "package.json"), "utf8")];
	for (const workflow of workflowFiles()) {
		sources.push(commandText(readFileSync(path.join(repoRoot, workflow), "utf8")));
	}
	return sources;
}

/**
 * Every `*.test.ts` path any workflow passes to a test command.
 *
 * Matched by pattern over the commands rather than over the file, for the reason
 * `commandText` records: a path in a comment is not a path in a command.
 */
export function workflowTestPaths(): string[] {
	const found: string[] = [];
	for (const workflow of workflowFiles()) {
		const commands = commandText(readFileSync(path.join(repoRoot, workflow), "utf8"));
		for (const match of commands.matchAll(/[\w./-]+\.test\.ts/g)) found.push(match[0]);
	}
	return found;
}
