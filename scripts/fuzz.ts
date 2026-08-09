#!/usr/bin/env bun

/**
 * Driver for the fuzzing suite in `fuzz/`.
 *
 * `cargo fuzz` runs one target at a time in the foreground until you stop it,
 * which is the wrong shape for a machine with thirty-two cores and six targets.
 * This wraps it so a single command builds everything, runs every target in
 * parallel for a bounded time, and reports which ones crashed.
 *
 * See `docs/internal/fuzzing.md` for what each target covers and what to do with
 * a finding.
 */

import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";

export const repoRoot = path.join(import.meta.dir, "..");
export const fuzzDir = path.join(repoRoot, "fuzz");

/**
 * Where cargo writes build artifacts.
 *
 * Kept out of the repo tree on purpose: a sanitizer build writes tens of
 * gigabytes of object files, and the checkout may well sit on a network share.
 * Honours an existing `CARGO_TARGET_DIR`, so CI and any machine with a fast
 * local disk can point it wherever they like.
 */
export const DEFAULT_TARGET_DIR = path.join(os.homedir(), ".cache", "veyyon", "fuzz-target");

/** Default seconds per target. One minute is a smoke test, not a campaign. */
export const DEFAULT_SECONDS = 60;

/**
 * Memory ceiling per target process, in MB.
 *
 * libFuzzer's default is 2048MB and it treats the limit as a finding ("ERROR:
 * libFuzzer: out-of-memory"). Running six targets at once on a machine that is
 * also building means the default fires on load rather than on a leak, so this
 * is raised and the real leak signal comes from the sanitizer instead.
 */
export const DEFAULT_RSS_LIMIT_MB = 4096;

export const COMMANDS = ["build", "run", "list", "cmin", "coverage"] as const;
export type Command = (typeof COMMANDS)[number];

export const USAGE = `Usage: bun scripts/fuzz.ts <command> [options]

Commands:
  build [target...]     Build targets. Defaults to every target.
  run [target...]       Run targets in parallel. Defaults to every target.
  list                  Print the target names.
  cmin [target...]      Minimize the corpus of each target.
  coverage <target>     Produce a coverage report for one target.

Options:
  --seconds=<n>         Seconds per target for 'run'. Default ${DEFAULT_SECONDS}.
  --jobs=<n>            Parallel targets. Default min(targets, cores / 2).
  --rss-limit-mb=<n>    Per-process memory ceiling. Default ${DEFAULT_RSS_LIMIT_MB}.
  --build-jobs=<n>      Parallel cargo build jobs. Default max(1, cores / 2).
`;

/**
 * A bad invocation, distinguished from a genuine failure of the thing invoked.
 *
 * Thrown rather than exiting in place so the pure helpers below stay callable
 * from a test. `main` is the only thing that ends the process.
 */
export class UsageError extends Error {}

export function isCommand(value: string | undefined): value is Command {
	return value != null && (COMMANDS as readonly string[]).includes(value);
}

/**
 * Read the target names out of a `fuzz/Cargo.toml`.
 *
 * WHY NOT A LIST IN THIS FILE. `cargo fuzz` requires a `[[bin]]` entry per
 * target, so the manifest is already the definitional home for the set. A second
 * copy here would drift the first time somebody adds a target, and the failure
 * mode is silent: the new target simply never runs and nobody notices it was
 * never fuzzed.
 *
 * Parsed line by line rather than with a TOML library because the shape being
 * read is one key in one repeated table, and the parse has to keep working if
 * the manifest grows a section this script has never heard of.
 */
export function parseTargetNames(manifest: string): string[] {
	const names: string[] = [];
	let inBinSection = false;
	for (const rawLine of manifest.split("\n")) {
		const line = rawLine.trim();
		// A comment can contain anything, including a `[[bin]]` in prose or a
		// `name = "..."` in an example, so it never changes the section state.
		if (line.startsWith("#")) continue;
		if (line.startsWith("[")) {
			inBinSection = line === "[[bin]]";
			continue;
		}
		if (!inBinSection) continue;
		const match = /^name\s*=\s*"([^"]+)"/.exec(line);
		if (match?.[1] != null) names.push(match[1]);
	}
	if (names.length === 0) {
		throw new UsageError("No [[bin]] targets found in fuzz/Cargo.toml.");
	}
	return names;
}

export function readTargetNames(manifestPath = path.join(fuzzDir, "Cargo.toml")): string[] {
	return parseTargetNames(fs.readFileSync(manifestPath, "utf-8"));
}

/**
 * Resolve requested names against the manifest, refusing unknown ones.
 *
 * Refusing rather than ignoring: a typo'd target name that silently runs the
 * other five looks exactly like a successful campaign, and the target you
 * actually wanted covered never ran.
 */
export function selectTargets(requested: readonly string[], known: readonly string[]): string[] {
	if (requested.length === 0) return [...known];
	const unknown = requested.filter(name => !known.includes(name));
	if (unknown.length > 0) {
		throw new UsageError(`Unknown fuzz target(s): ${unknown.join(", ")}\nKnown targets: ${known.join(", ")}`);
	}
	return [...requested];
}

export function parseFlags(args: readonly string[]): Map<string, string> {
	const parsed = new Map<string, string>();
	for (const argument of args) {
		if (!argument.startsWith("--")) continue;
		const separator = argument.indexOf("=");
		const name = separator === -1 ? argument.slice(2) : argument.slice(2, separator);
		const value = separator === -1 ? "true" : argument.slice(separator + 1);
		if (name !== "") parsed.set(name, value);
	}
	return parsed;
}

/**
 * Read a positive-number flag, refusing anything else.
 *
 * A typo in `--seconds=6O` quietly running for one minute instead of six hours
 * is the kind of silent substitution that makes an overnight campaign worthless
 * and leaves no trace that it happened. So a malformed value is an error, never
 * a fallback to the default.
 */
export function numericFlag(flags: ReadonlyMap<string, string>, name: string, fallback: number): number {
	const raw = flags.get(name);
	if (raw == null) return fallback;
	const parsed = Number(raw);
	if (!Number.isFinite(parsed) || parsed <= 0) {
		throw new UsageError(`--${name} needs a positive number, got ${JSON.stringify(raw)}.`);
	}
	return parsed;
}

/**
 * How many targets to run at once.
 *
 * Half the cores, because each libFuzzer process is single-threaded but the
 * sanitizer runtime and the allocator are not, and oversubscription makes every
 * target slower rather than the set finish sooner. Never more than the number of
 * targets, and never zero on a single-core machine.
 */
export function resolveJobs(requested: number | undefined, targetCount: number, cores: number): number {
	const wanted = requested ?? Math.floor(cores / 2);
	return Math.max(1, Math.min(targetCount, wanted));
}

/** The libFuzzer arguments the runner appends after `--`. */
export function libfuzzerArgs(seconds: number, rssLimitMb: number): string[] {
	return [
		`-max_total_time=${seconds}`,
		`-rss_limit_mb=${rssLimitMb}`,
		// Print the slowest inputs. A target that spends its whole run on one
		// pathological input is not exploring, and that is invisible otherwise.
		"-print_final_stats=1",
	];
}

function cargoEnv(buildJobs?: number): Record<string, string> {
	return {
		...(process.env as Record<string, string>),
		CARGO_TARGET_DIR: process.env.CARGO_TARGET_DIR ?? DEFAULT_TARGET_DIR,
		...(buildJobs == null ? {} : { CARGO_BUILD_JOBS: String(buildJobs) }),
	};
}

/**
 * How many cargo jobs a sanitizer build may run at once.
 *
 * Half the cores, and deliberately not the same number as `--jobs`. A fuzzer
 * process is CPU-bound and small; a sanitizer build at `codegen-units=1` is
 * memory-bound and large, so the number that keeps every core busy during a run
 * is the number that gets rustc killed during a build. Never zero on a
 * single-core machine.
 */
export function resolveBuildJobs(requested: number | undefined, cores: number): number {
	return Math.max(1, requested ?? Math.floor(cores / 2));
}

async function runCargoFuzz(args: string[], buildJobs?: number): Promise<number> {
	const proc = Bun.spawn(["cargo", "+nightly", "fuzz", ...args], {
		cwd: repoRoot,
		env: cargoEnv(buildJobs),
		stdin: "inherit",
		stdout: "inherit",
		stderr: "inherit",
	});
	return proc.exited;
}

async function pipeTo(stream: ReadableStream<Uint8Array>, writer: Bun.FileSink): Promise<void> {
	for await (const chunk of stream) writer.write(chunk);
}

async function runOneTarget(target: string, seconds: number, rssLimitMb: number): Promise<number> {
	const logPath = path.join(fuzzDir, "logs", `${target}.log`);
	fs.mkdirSync(path.dirname(logPath), { recursive: true });
	const log = Bun.file(logPath).writer();

	const proc = Bun.spawn(["cargo", "+nightly", "fuzz", "run", target, "--", ...libfuzzerArgs(seconds, rssLimitMb)], {
		cwd: repoRoot,
		env: cargoEnv(),
		stdin: "ignore",
		stdout: "pipe",
		stderr: "pipe",
	});

	// libFuzzer writes progress to stderr and the crash report to stderr too, so
	// both streams go to the log and only the verdict goes to the console.
	await Promise.all([pipeTo(proc.stdout, log), pipeTo(proc.stderr, log)]);
	const code = await proc.exited;
	await log.end();

	console.log(`  ${code === 0 ? "ok  " : "FAIL"} ${target}  (log: fuzz/logs/${target}.log)`);
	return code;
}

/**
 * Run each target for a bounded time, several at once, and report the failures.
 */
async function runTargets(targets: string[], flags: ReadonlyMap<string, string>): Promise<number> {
	const seconds = numericFlag(flags, "seconds", DEFAULT_SECONDS);
	const rssLimitMb = numericFlag(flags, "rss-limit-mb", DEFAULT_RSS_LIMIT_MB);
	const jobs = resolveJobs(
		flags.has("jobs") ? numericFlag(flags, "jobs", 1) : undefined,
		targets.length,
		os.cpus().length,
	);
	const buildJobs = resolveBuildJobs(
		flags.has("build-jobs") ? numericFlag(flags, "build-jobs", 1) : undefined,
		os.cpus().length,
	);

	// Build ONLY the targets about to run, and build them one at a time.
	//
	// `cargo fuzz build` with no target name compiles every target, which drags
	// the vendored uutils tree through a sanitizer build at one codegen unit
	// because some targets link `veyyon-shell`. Asking for a single 200-line text
	// function then costs the entire workspace, and on a workstation that is not
	// a slow run but no run at all: rustc gets killed for memory and the runner
	// reports a build failure. Naming the target is what keeps the cost
	// proportional to the request.
	//
	// Sequential rather than parallel because cargo takes a file lock on the
	// shared target directory, so concurrent builds do not overlap anyway; they
	// queue, with the added memory of several rustc processes alive at once.
	for (const target of targets) {
		const buildCode = await runCargoFuzz(["build", target], buildJobs);
		if (buildCode !== 0) {
			console.error(`Build failed for ${target}; not running any targets.`);
			return buildCode;
		}
	}

	console.log(`Running ${targets.length} target(s), ${jobs} at a time, ${seconds}s each.`);

	const failures: { target: string; code: number }[] = [];
	const queue = [...targets];
	const workers = Array.from({ length: jobs }, async () => {
		for (let target = queue.shift(); target != null; target = queue.shift()) {
			const code = await runOneTarget(target, seconds, rssLimitMb);
			if (code !== 0) failures.push({ target, code });
		}
	});
	await Promise.all(workers);

	if (failures.length === 0) {
		console.log(`\nAll ${targets.length} target(s) finished ${seconds}s with no findings.`);
		return 0;
	}
	console.error(`\n${failures.length} target(s) reported findings:`);
	for (const { target, code } of failures) {
		console.error(`  ${target} (exit ${code}) -- reproducer in fuzz/artifacts/${target}/`);
	}
	// Point at triage rather than at the artifacts alone. Several artifacts are
	// usually one bug, and some of them no longer reproduce at all, so reading the
	// directory is the slowest way to find out what was actually found.
	console.error(`\nTriage them with: bun scripts/fuzz-triage.ts report`);
	return 1;
}

export async function main(argv: readonly string[]): Promise<number> {
	const command = argv[0];
	if (!isCommand(command)) {
		console.error(USAGE);
		return command == null ? 1 : 2;
	}

	const rest = argv.slice(1);
	const flags = parseFlags(rest);
	const positional = rest.filter(argument => !argument.startsWith("--"));

	switch (command) {
		case "list":
			for (const target of readTargetNames()) console.log(target);
			return 0;
		case "build": {
			// Naming targets builds only those, for the same reason `run` does: an
			// unqualified build is the whole workspace under a sanitizer.
			const buildJobs = resolveBuildJobs(
				flags.has("build-jobs") ? numericFlag(flags, "build-jobs", 1) : undefined,
				os.cpus().length,
			);
			if (positional.length === 0) return runCargoFuzz(["build"], buildJobs);
			for (const target of selectTargets(positional, readTargetNames())) {
				const code = await runCargoFuzz(["build", target], buildJobs);
				if (code !== 0) return code;
			}
			return 0;
		}
		case "run":
			return runTargets(selectTargets(positional, readTargetNames()), flags);
		case "cmin": {
			for (const target of selectTargets(positional, readTargetNames())) {
				const code = await runCargoFuzz(["cmin", target]);
				if (code !== 0) return code;
			}
			return 0;
		}
		case "coverage": {
			const [target] = selectTargets(positional, readTargetNames());
			if (positional.length !== 1 || target == null) {
				throw new UsageError("coverage needs exactly one target name.");
			}
			// The same job cap `build` and `run` use, for a build that needs it MORE than either.
			// A coverage build adds `-Cinstrument-coverage` on top of the sanitizer flags and still
			// compiles at `codegen-units=1`, and without the cap it took every core: rustc was killed
			// by signal 9 partway through the dependency graph, which reads as a broken toolchain
			// rather than as "the machine ran out of memory".
			const buildJobs = resolveBuildJobs(
				flags.has("build-jobs") ? numericFlag(flags, "build-jobs", 1) : undefined,
				os.cpus().length,
			);
			return runCargoFuzz(["coverage", target], buildJobs);
		}
	}
}

if (import.meta.main) {
	try {
		process.exit(await main(process.argv.slice(2)));
	} catch (error) {
		if (error instanceof UsageError) {
			console.error(error.message);
			process.exit(2);
		}
		throw error;
	}
}
