#!/usr/bin/env bun
/**
 * Find which earlier test file makes a later one fail.
 *
 * An order-dependent test is worse than a failing one: it passes in isolation, so the developer
 * who runs it alone believes the code is fine, and the full suite's red is written off as "the
 * usual flake" until nobody reads the failures at all. Something in an earlier file leaked —
 * a global singleton left initialized or reset, an env var, a cwd, a monkeypatched module, a
 * timer — and the only cheap way to learn WHICH is to bisect the file list.
 *
 * Usage:
 *   bun scripts/find-order-polluter.ts <target.test.ts> [--dir packages/x/test] [--name "test name"]
 *                                      [--order <file listing the run order>]
 *
 * It first proves the two premises the search depends on — the target passes alone, and it fails
 * with the whole candidate list in front of it — and refuses to guess if either does not hold.
 * Then it bisects, keeping the half that still reproduces the failure, and prints the minimal
 * prefix it found. Bun runs every file passed in one process, in the order given, so the
 * reproduction here is an explicit ordering rather than whatever the directory walk produced.
 *
 * Which is why ORDER is the first thing to get right when the search refuses at premise 2: the
 * candidate list defaults to name order, and the failing run's order came from the directory walk.
 * The refusal prints the three commands that capture the real order from a junit report and feed it
 * back through `--order`.
 */

import { $ } from "bun";

interface Options {
	target: string;
	dir: string;
	name?: string;
	order?: string;
}

function parseArgs(argv: string[]): Options {
	const positional: string[] = [];
	let dir: string | undefined;
	let name: string | undefined;
	let order: string | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--dir") dir = argv[++index];
		else if (arg === "--name") name = argv[++index];
		else if (arg === "--order") order = argv[++index];
		else positional.push(arg);
	}
	const target = positional[0];
	if (!target) {
		console.error(
			"usage: bun scripts/find-order-polluter.ts <target.test.ts> [--dir <test dir>] [--name <test name>]\n" +
				"                                        [--order <file listing the run order, one path per line>]",
		);
		process.exit(2);
	}
	return { target, dir: dir ?? target.slice(0, target.lastIndexOf("/")), name, order };
}

/**
 * The `(fail)` lines bun reported for `target`, and only for it.
 *
 * Read from the target's own section rather than from the exit code: a candidate that is itself
 * broken would otherwise be mistaken for a reproduction, and the bisect would converge on it.
 * Bun prints a `path/to/file.test.ts:` header before each file's output, so the section boundaries
 * are in the text.
 *
 * `--test-name-pattern` is deliberately NOT used to narrow this. A candidate whose own tests are
 * all filtered out may never have its module body executed, and module-level state is exactly
 * where leaks live — filtering the run would hide the very thing being searched for. The name
 * narrows the PARSED result instead, so every candidate runs exactly as it does in the real suite.
 */
async function targetFailures(files: string[], options: Options): Promise<string[]> {
	const result = await $`bun test ${files}`.nothrow().quiet();
	const text = `${result.stdout.toString()}\n${result.stderr.toString()}`;
	const targetSuffix = options.target.replace(/^\.\//, "");
	let inTarget = false;
	const failures: string[] = [];
	for (const line of text.split("\n")) {
		const header = line.trim();
		if (header.endsWith(".test.ts:")) {
			inTarget = header.slice(0, -1).endsWith(targetSuffix);
			continue;
		}
		if (!inTarget) continue;
		const index = line.indexOf("(fail)");
		if (index === -1) continue;
		const name = line.slice(index + "(fail)".length).trim();
		if (options.name && !name.includes(options.name)) continue;
		failures.push(name);
	}
	return failures;
}

/** Whether the target's tests (or the `--name` one) all passed with `files` run in this order. */
async function targetPasses(files: string[], options: Options): Promise<boolean> {
	return (await targetFailures(files, options)).length === 0;
}

const options = parseArgs(process.argv.slice(2));
/**
 * The candidate order matters as much as the candidate set: bun runs the files given on the
 * command line in that order, and a leak only reaches the target from a file that ran before it.
 * A sort is a guess at the order the real run used. `--order` takes the real one — extract it from
 * a junit report of the failing run (`--reporter=junit`), whose testsuite entries are in execution
 * order — for the case where the sorted guess does not reproduce the failure.
 */
const all = options.order
	? (await Bun.file(options.order).text())
			.split("\n")
			.map(line => line.trim())
			.filter(line => line.endsWith(".test.ts"))
	: (await $`rg --files -g '*.test.ts' ${options.dir}`.text()).trim().split("\n").filter(Boolean).sort();
const candidates = all.filter(file => file !== options.target);
if (candidates.length === 0) {
	console.error(`no other test files found in ${options.dir}`);
	process.exit(2);
}

console.log(`target:     ${options.target}`);
console.log(
	`candidates: ${candidates.length} files, ordered by ${options.order ? `the run order in ${options.order}` : "name"}`,
);

if (!(await targetPasses([options.target], options))) {
	console.error("\nThe target FAILS on its own. This is not an ordering problem — fix the test or the code.");
	process.exit(1);
}
console.log("premise 1 ok: the target passes alone");

if (await targetPasses([...candidates, options.target], options)) {
	console.error(
		"\nThe target PASSES with every candidate in front of it, so this explicit ordering does not\n" +
			"reproduce the failure. Order is the likely reason: bun runs the files in the order given, and\n" +
			"a sort is only a guess at the order the failing run used. Capture the real one and pass it:\n" +
			"  bun test <dir> --reporter=junit --reporter-outfile=/tmp/order.xml\n" +
			"  rg -o 'name=\"[^\"]+\\.test\\.ts' /tmp/order.xml | sed 's/name=\"//' > /tmp/order.txt\n" +
			"  bun scripts/find-order-polluter.ts <target> --order /tmp/order.txt",
	);
	process.exit(1);
}
console.log("premise 2 ok: the target fails with the full candidate list\n");

// Bisect: keep the half that still reproduces. When neither half alone reproduces, the cause
// needs files from both, so the search stops and reports the smallest reproducing set it has.
let window = candidates;
while (window.length > 1) {
	const middle = Math.floor(window.length / 2);
	const first = window.slice(0, middle);
	const second = window.slice(middle);
	if (!(await targetPasses([...first, options.target], options))) {
		console.log(`  ${window.length} -> ${first.length} (first half reproduces)`);
		window = first;
		continue;
	}
	if (!(await targetPasses([...second, options.target], options))) {
		console.log(`  ${window.length} -> ${second.length} (second half reproduces)`);
		window = second;
		continue;
	}
	console.log(
		`\nNeither half of ${window.length} files reproduces it alone, so the failure needs a combination.\n` +
			"Smallest reproducing set found:",
	);
	for (const file of window) console.log("   ", file);
	process.exit(0);
}

console.log(`\nPolluter: ${window[0]}`);
console.log(`Reproduce with:\n  bun test ${window[0]} ${options.target}`);
