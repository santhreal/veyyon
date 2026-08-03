#!/usr/bin/env bun
/**
 * Find which earlier test file makes a later one fail.
 *
 * An order-dependent test is worse than a failing one: it passes in isolation, so the developer
 * who runs it alone believes the code is fine, and the full suite's red is written off as "the
 * usual flake" until nobody reads the failures at all. Something in an earlier file leaked --
 * a global singleton left initialized or reset, an env var, a cwd, a monkeypatched module, a
 * timer -- and the only cheap way to learn WHICH is to bisect the file list.
 *
 * Usage:
 *   bun scripts/find-order-polluter.ts <target.test.ts> [--dir packages/x/test] [--name "test name"]
 *                                      [--order <file listing the run order>] [--max-window 200]
 *
 * NEVER PASS `--parallel=1` HERE, however tempting it looks. It reads like the flag that makes the
 * premise true -- one process, files in the order given -- and it does the opposite. Measured
 * 2026-07-26: under `--parallel=1` bun gives every test file a FRESH module registry, so a
 * module-level counter incremented by the first file reads as zero in the second, and a global set
 * by the first is undefined in the second. Nothing leaks across files, so the search finds nothing
 * and reports every suite clean. Bun's DEFAULT is what shares state: files that land in the same
 * worker share its realm, which is exactly the condition a real order-dependent failure needs. The
 * same mechanism is why a serial run of the whole suite is SIGKILLed -- one realm per file, all of
 * them retained, about 76 MB each. See docs/internal/testing.md.
 *
 * The search also never runs the whole candidate list up front. It GROWS a window: the last 64
 * files before the target, then 128, then 256, until the failure reproduces. A leak usually comes
 * from nearby, so the window that reproduces is normally small and the answer arrives in seconds
 * instead of after a run of every file in the package. `--max-window` caps it, and hitting the cap
 * is reported as a refusal, never as a clean "no polluter found".
 *
 * ORDER matters as much as the set: the candidate list defaults to name order, and the failing
 * run's order came from the directory walk. When the search refuses, it prints the three commands
 * that capture the real order from a junit report and feed it back through `--order`.
 */

import * as path from "node:path";
import { $ } from "bun";

export interface Options {
	target: string;
	dir: string;
	name?: string;
	order?: string;
	maxWindow: number;
}

/** Where the growing window starts. Small enough to answer in seconds for a nearby polluter. */
export const FIRST_WINDOW = 64;

/**
 * How many candidates the search will put in front of the target before refusing.
 *
 * A cap on TIME, not on correctness: every attempt runs its whole window, so an uncapped search on
 * a 1,887-file package would run the package several times over before admitting it found nothing.
 * 200 keeps a fruitless search to a few minutes. Raise it with `--max-window` when the polluter is
 * genuinely far back; the refusal says so rather than reporting the suite clean.
 */
export const DEFAULT_MAX_WINDOW = 200;

export function parseArgs(argv: string[]): Options {
	const positional: string[] = [];
	let dir: string | undefined;
	let name: string | undefined;
	let order: string | undefined;
	let maxWindow: number | undefined;
	for (let index = 0; index < argv.length; index++) {
		const arg = argv[index]!;
		if (arg === "--dir") dir = argv[++index];
		else if (arg === "--name") name = argv[++index];
		else if (arg === "--order") order = argv[++index];
		else if (arg === "--max-window") maxWindow = Number(argv[++index]);
		else positional.push(arg);
	}
	const target = positional[0];
	if (!target) {
		console.error(
			"usage: bun scripts/find-order-polluter.ts <target.test.ts> [--dir <test dir>] [--name <test name>]\n" +
				"                                        [--order <file listing the run order, one path per line>]\n" +
				"                                        [--max-window <how many candidates to put in front of the target>]",
		);
		process.exit(2);
	}
	if (maxWindow !== undefined && (!Number.isInteger(maxWindow) || maxWindow < 1)) {
		console.error(
			`--max-window must be a positive whole number of files, got ${JSON.stringify(argv[argv.indexOf("--max-window") + 1])}`,
		);
		process.exit(2);
	}
	return {
		target,
		dir: dir ?? target.slice(0, target.lastIndexOf("/")),
		name,
		order,
		maxWindow: maxWindow ?? DEFAULT_MAX_WINDOW,
	};
}

/**
 * The window sizes the search tries, smallest first, each the last N candidates before the target.
 *
 * Doubling rather than stepping, because the cost of a run is linear in the window and the polluter
 * could be anywhere: doubling reaches a far polluter in log steps while a near one still answers on
 * the first try. The last size is exactly the cap or exactly the candidate count, never past
 * either, so the caller never runs more files than it was allowed to.
 */
export function windowSizes(candidateCount: number, maxWindow: number, first = FIRST_WINDOW): number[] {
	const limit = Math.min(candidateCount, maxWindow);
	const sizes: number[] = [];
	for (let size = Math.min(first, limit); size < limit; size *= 2) sizes.push(size);
	sizes.push(limit);
	return sizes;
}

/** Runs `files` in one process, in order, and returns the run's combined output. */
export type RunFiles = (files: string[]) => Promise<string>;

/**
 * The `(fail)` lines bun reported for `target`, and only for it.
 *
 * Read from the target's own section rather than from the exit code: a candidate that is itself
 * broken would otherwise be mistaken for a reproduction, and the bisect would converge on it.
 * Bun prints a `path/to/file.test.ts:` header before each file's output, so the section boundaries
 * are in the text.
 *
 * THE HEADER IS SPELLED RELATIVE TO THE RUN'S CWD, whatever spelling the caller used for `target`.
 * Hand the script an absolute path (which is what tab completion and an editor's "copy path" both
 * give you) and bun answers with `../../../tmp/x/z.test.ts:`, so comparing the two as strings
 * compares two spellings of one file. It only ever agreed by luck: a relative spelling that
 * happens to climb out with `../` still ends with `/tmp/x/z.test.ts`, and the luck runs out the
 * moment the target sits UNDER the cwd, which is what `TMPDIR` inside the repo does. The parser
 * then finds no section for the target, reports zero failures for every run the search makes, and
 * the tool announces that the ordering does not reproduce the failure -- a clean bill of health
 * for a suite whose polluter is sitting right there. So both sides are resolved to one absolute
 * path and compared as paths.
 *
 * Resolving also ends the suffix match, which was wrong in the other direction: `z.test.ts` is a
 * suffix of `my-z.test.ts`, so a bare filename would have read a DIFFERENT file's failures as the
 * target's and sent the reader to an innocent file.
 *
 * `--test-name-pattern` is deliberately NOT used to narrow this. A candidate whose own tests are
 * all filtered out may never have its module body executed, and module-level state is exactly
 * where leaks live -- filtering the run would hide the very thing being searched for. The name
 * narrows the PARSED result instead, so every candidate runs exactly as it does in the real suite.
 *
 * `from` is the directory the run's paths are relative to, which is the cwd the run happened in.
 */
export function parseTargetFailures(
	text: string,
	target: string,
	name?: string,
	from: string = process.cwd(),
): string[] {
	const targetPath = path.resolve(from, target);
	let inTarget = false;
	const failures: string[] = [];
	for (const line of text.split("\n")) {
		const header = line.trim();
		if (header.endsWith(".test.ts:")) {
			inTarget = path.resolve(from, header.slice(0, -1)) === targetPath;
			continue;
		}
		if (!inTarget) continue;
		const index = line.indexOf("(fail)");
		if (index === -1) continue;
		const failed = line.slice(index + "(fail)".length).trim();
		if (name && !failed.includes(name)) continue;
		failures.push(failed);
	}
	return failures;
}

/**
 * Every run the search makes goes through here, at bun's default parallelism.
 *
 * The flag that is NOT here is the point: see the header. `--parallel=1` isolates each file in its
 * own module registry, so no candidate's leak can reach the target and the search would answer
 * "nothing reproduces" no matter what is wrong.
 */
export const runFiles: RunFiles = async files => {
	const result = await $`bun test ${files}`.nothrow().quiet();
	return `${result.stdout.toString()}\n${result.stderr.toString()}`;
};

/** Whether the target's tests (or the `--name` one) all passed with `files` run in this order. */
export async function targetPasses(run: RunFiles, files: string[], options: Options): Promise<boolean> {
	return parseTargetFailures(await run(files), options.target, options.name).length === 0;
}

export interface WindowSearch {
	/** The smallest tried window that reproduced the failure, or null if none did. */
	window: string[] | null;
	/** Window sizes tried, in order, so the caller can report what was covered. */
	tried: number[];
}

/**
 * Grow a suffix window until the failure reproduces.
 *
 * The window is the LAST N candidates before the target because that is where a leak usually comes
 * from and because it is the only sub-list that preserves the real ordering next to the target.
 */
export async function findReproducingWindow(
	run: RunFiles,
	candidates: string[],
	options: Options,
	onAttempt?: (size: number, reproduced: boolean) => void,
): Promise<WindowSearch> {
	const tried: number[] = [];
	for (const size of windowSizes(candidates.length, options.maxWindow)) {
		const window = candidates.slice(candidates.length - size);
		tried.push(size);
		const reproduced = !(await targetPasses(run, [...window, options.target], options));
		onAttempt?.(size, reproduced);
		if (reproduced) return { window, tried };
	}
	return { window: null, tried };
}

/**
 * Halve the window, keeping whichever half still reproduces.
 *
 * When neither half alone reproduces, the cause needs files from both, so the search stops and
 * hands back the smallest reproducing set it has rather than picking one arbitrarily.
 */
export async function bisect(
	run: RunFiles,
	window: string[],
	options: Options,
	onStep?: (from: number, to: number, which: "first" | "second") => void,
): Promise<{ files: string[]; combination: boolean }> {
	let current = window;
	while (current.length > 1) {
		const middle = Math.floor(current.length / 2);
		const first = current.slice(0, middle);
		const second = current.slice(middle);
		if (!(await targetPasses(run, [...first, options.target], options))) {
			onStep?.(current.length, first.length, "first");
			current = first;
			continue;
		}
		if (!(await targetPasses(run, [...second, options.target], options))) {
			onStep?.(current.length, second.length, "second");
			current = second;
			continue;
		}
		return { files: current, combination: true };
	}
	return { files: current, combination: false };
}

const ORDER_ADVICE =
	"Capture the real order and pass it:\n" +
	"  bun test <dir> --reporter=junit --reporter-outfile=/tmp/order.xml\n" +
	"  rg -o 'name=\"[^\"]+\\.test\\.ts' /tmp/order.xml | sed 's/name=\"//' > /tmp/order.txt\n" +
	"  bun scripts/find-order-polluter.ts <target> --order /tmp/order.txt";

if (import.meta.main) {
	const options = parseArgs(process.argv.slice(2));
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

	if (!(await targetPasses(runFiles, [options.target], options))) {
		console.error("\nThe target FAILS on its own. This is not an ordering problem -- fix the test or the code.");
		process.exit(1);
	}
	console.log("premise 1 ok: the target passes alone");

	const search = await findReproducingWindow(runFiles, candidates, options, (size, reproduced) => {
		console.log(`  last ${size} candidates: ${reproduced ? "REPRODUCES" : "target still passes"}`);
	});
	if (!search.window) {
		const reached = search.tried.at(-1) ?? 0;
		const covered = reached >= candidates.length;
		console.error(
			`\nThe target PASSES with the last ${reached} candidates in front of it.\n` +
				(covered
					? "That is every candidate, so this explicit ordering does not reproduce the failure. Order is\n" +
						"the likely reason: bun runs the files in the order given, and a sort is only a guess at the\n" +
						`order the failing run used.\n${ORDER_ADVICE}`
					: `The search stopped at the --max-window cap of ${options.maxWindow} of ${candidates.length} candidates,\n` +
						"so a polluter further back has NOT been ruled out. Raise the cap to look further:\n" +
						`  bun scripts/find-order-polluter.ts ${options.target} --max-window ${Math.min(candidates.length, options.maxWindow * 4)}\n` +
						`If the order is what is wrong instead, ${ORDER_ADVICE}`),
		);
		process.exit(1);
	}
	console.log(`premise 2 ok: the target fails with the last ${search.window.length} candidates\n`);

	const result = await bisect(runFiles, search.window, options, (from, to, which) => {
		console.log(`  ${from} -> ${to} (${which} half reproduces)`);
	});
	if (result.combination) {
		console.log(
			`\nNeither half of ${result.files.length} files reproduces it alone, so the failure needs a combination.\n` +
				"Smallest reproducing set found:",
		);
		for (const file of result.files) console.log("   ", file);
		process.exit(0);
	}

	console.log(`\nPolluter: ${result.files[0]}`);
	console.log(`Reproduce with:\n  bun test ${result.files[0]} ${options.target}`);
}
