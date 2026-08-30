/**
 * Does the addon's parallel grep scale with `VEYYON_WALK_WORKERS`, or does it queue
 * behind the one lock that collects results?
 *
 * Run it: `bun bench/grep-workers.ts` from `packages/natives`.
 *
 *   GREP_WORKERS_FILES=50000        corpus files per arm
 *   GREP_WORKERS_BYTES=1024         bytes per corpus file
 *   GREP_WORKERS_COUNTS=1,2,4,8     worker counts to measure
 *   GREP_WORKERS_SAMPLES=5          timed passes per worker count
 *   GREP_WORKERS_ROOTS=disk,tmpfs   which media to measure (tmpfs uses /dev/shm)
 *   GREP_WORKERS_SEED=0x5eed1       corpus seed
 *
 * `veyyon_walker::walk_workers` reads the variable once per process through a
 * `LazyLock`, so a worker count cannot be changed inside a run. Every arm is therefore
 * its own child process: this file is both the parent that generates the corpora and
 * compares the arms, and the child that measures one of them (`--arm`).
 *
 * The accumulator under test is `PassState::results`, a `Mutex<Vec<FileSearchResult>>`
 * in `natives/bridge/addon/src/grep.rs`, taken once per matching file. Poor scaling on
 * its own does not name the lock as the cause, because a denser corpus also collects
 * more matches, so the arms are built to separate the two:
 *
 *   all-match    50,000 files x 1 match  = 50,000 matches, 50,000 lock acquisitions
 *   dense-files   2,500 files x 20 match = 50,000 matches,  2,500 lock acquisitions
 *   5-percent    the row's control, 1-4 matches in one file per twenty
 *
 * The first two walk the same file count and collect the same number of matches, and
 * differ only by a factor of twenty in how often the accumulator is locked. If
 * `dense-files` scales and `all-match` does not, the lock is the limiter; if both
 * behave alike, the limiter is the per-match work and the lock is exonerated.
 *
 * `strace -c -e trace=futex` was tried here and rejected: it slows the run about ten
 * times, and its futex total is dominated by bun's own idle parked threads (160 s of
 * futex time inside a 3 s process), so it cannot see this lock at all.
 *
 * What it measured, on a 32-cpu Ryzen 9 9950X, 50,000 files of 1 KiB, five samples per
 * arm, at four workers: 2.37x one worker on `all-match`, 2.70x on `dense-files`, 3.22x
 * on `5-percent`; on tmpfs 2.49x / 2.38x / 2.80x. Cutting lock acquisitions twentyfold
 * at a fixed match volume moved four-worker scaling by 0.33x on disk and by nothing at
 * all on tmpfs, while cutting match volume eightfold at a fixed lock count moved it by
 * 0.52x and 0.42x. Scaling therefore tracks how many matches are collected, not how
 * often the accumulator is locked.
 *
 * A temporary build that timed every acquisition confirmed it directly and was reverted:
 * summed across workers on the all-match arm, wait was 1.0ms of a 213ms pass at one
 * worker, 3.3ms of 99ms at four (0.9% of aggregate cpu wall), and 26ms of 79ms at eight
 * (4.1%); hold was 4-12ms and the path sort 3.5-4ms throughout. The ceiling on this arm
 * is the per-file result the pass builds and hands to N-API, not the mutex, so sharding
 * the accumulator would buy nothing at the worker counts the product ships with.
 */

import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import * as os from "node:os";
import * as path from "node:path";
import { grep } from "../native/index.js";
import { CORPUS_GLOB, CORPUS_PATTERN, DEFAULT_SEED, generateCorpus } from "./grep-corpus.js";
import { readings } from "./grep-parity.js";

const FILES = Number(process.env.GREP_WORKERS_FILES ?? "50000");
const FILE_BYTES = Number(process.env.GREP_WORKERS_BYTES ?? "1024");
const COUNTS = (process.env.GREP_WORKERS_COUNTS ?? "1,2,4,8").split(",").map(Number);
const SAMPLES = Number(process.env.GREP_WORKERS_SAMPLES ?? "5");
const MEDIA = (process.env.GREP_WORKERS_ROOTS ?? "disk,tmpfs").split(",");
const SEED = Number(process.env.GREP_WORKERS_SEED ?? DEFAULT_SEED);

/** How each arm's corpus is shaped. `matchesPerFile` 0 lets the generator cycle 1-4. */
interface Density {
	readonly name: string;
	readonly matchEvery: number;
	readonly matchesPerFile: number;
}

const DENSITIES: readonly Density[] = [
	{ name: "all-match", matchEvery: 1, matchesPerFile: 1 },
	{ name: "dense-files", matchEvery: 20, matchesPerFile: 20 },
	{ name: "5-percent", matchEvery: 20, matchesPerFile: 0 },
];

/** One arm's measurement, as the child prints it and the parent reads it. */
interface ArmResult {
	medium: string;
	density: string;
	workers: number;
	filesSearched: number;
	totalMatches: number;
	filesWithMatches: number;
	skippedOversized: number;
	/** Digest of the path-sorted result rows: identical across arms, or parity failed. */
	digest: string;
	msP50: number;
	msP95: number;
	msMin: number;
	cpuMs: number;
	samples: number;
}

function fail(message: string): never {
	console.error(`GUARD FAILED: ${message}`);
	process.exit(1);
}

function corpusRoot(medium: string, density: string): string {
	const base =
		medium === "tmpfs"
			? "/dev/shm/veyyon-grep-workers"
			: path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), ".cache"), "veyyon", "grep-workers");
	return path.join(base, `${density}-${FILES}x${FILE_BYTES}`);
}

function cpuMillis(): number {
	const usage = process.cpuUsage();
	return (usage.user + usage.system) / 1000;
}

async function measureArm(medium: string, density: string, workers: number): Promise<ArmResult> {
	const root = corpusRoot(medium, density);
	const options = { pattern: CORPUS_PATTERN, path: root, glob: CORPUS_GLOB, gitignore: false };
	// Warm the page cache and the walker's scan cache, so the samples measure search
	// and not the first stat of every file.
	await grep(options);

	const samples: number[] = [];
	const cpuBefore = cpuMillis();
	let last = await grep(options);
	for (let sample = 0; sample < SAMPLES; sample++) {
		const started = process.hrtime.bigint();
		last = await grep(options);
		samples.push(Number(process.hrtime.bigint() - started) / 1e6);
	}
	const cpuMs = (cpuMillis() - cpuBefore) / SAMPLES;

	const digest = createHash("sha256");
	for (const match of [...last.matches].sort((a, b) =>
		a.path === b.path ? a.lineNumber - b.lineNumber : a.path.localeCompare(b.path),
	)) {
		digest.update(`${match.path}\u0000${match.lineNumber}\u0000${match.line}\n`);
	}
	const stats = readings(samples);
	return {
		medium,
		density,
		workers,
		filesSearched: last.filesSearched,
		totalMatches: last.totalMatches,
		filesWithMatches: last.filesWithMatches,
		skippedOversized: last.skippedOversized ?? 0,
		digest: digest.digest("hex"),
		msP50: stats.p50,
		msP95: stats.p95,
		msMin: stats.min,
		cpuMs,
		samples: stats.samples,
	};
}

async function runChild(medium: string, density: string, workers: number): Promise<ArmResult> {
	const args = [
		path.join(import.meta.dirname, "grep-workers.ts"),
		"--arm",
		`--medium=${medium}`,
		`--density=${density}`,
		`--workers=${workers}`,
	];
	const child = spawn("bun", args, {
		env: { ...process.env, VEYYON_WALK_WORKERS: String(workers) },
		stdio: ["ignore", "pipe", "pipe"],
	});
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	child.stdout.on("data", chunk => out.push(chunk));
	child.stderr.on("data", chunk => err.push(chunk));
	const { promise, resolve } = Promise.withResolvers<{ code: number; stdout: string; stderr: string }>();
	child.on("error", error => resolve({ code: -1, stdout: "", stderr: error.message }));
	child.on("close", code =>
		resolve({
			code: code ?? -1,
			stdout: Buffer.concat(out).toString("utf8"),
			stderr: Buffer.concat(err).toString("utf8"),
		}),
	);
	const finished = await promise;
	if (finished.code !== 0) fail(`arm ${density}/${medium}/${workers} exited ${finished.code}: ${finished.stderr}`);
	const line = finished.stdout.split("\n").find(candidate => candidate.startsWith("{"));
	if (!line) fail(`arm ${density}/${medium}/${workers} printed no result: ${finished.stdout}${finished.stderr}`);
	return JSON.parse(line) as ArmResult;
}

async function parent(): Promise<void> {
	for (const medium of MEDIA) {
		for (const density of DENSITIES) {
			const root = corpusRoot(medium, density.name);
			const facts = await generateCorpus({
				root,
				seed: SEED,
				files: FILES,
				matchEvery: density.matchEvery,
				matchesPerFile: density.matchesPerFile,
				fileBytes: FILE_BYTES,
			});
			console.log(
				`${density.name} on ${medium}: ${facts.files} files, ${(facts.bytes / 1024 / 1024).toFixed(1)}MiB, ` +
					`${facts.matchingFiles} matching, ${facts.srcMatches} matches, ${facts.reused ? "reused" : "generated"}`,
			);
			console.log(`  ${root}`);
		}
	}
	console.log(
		`\n${os.cpus()[0]?.model?.trim()} | ${os.cpus().length} cpus | bun ${process.versions.bun} | ` +
			`${SAMPLES} samples per arm\n`,
	);

	let failures = 0;
	for (const medium of MEDIA) {
		for (const density of DENSITIES) {
			const arms: ArmResult[] = [];
			for (const workers of COUNTS) arms.push(await runChild(medium, density.name, workers));

			const first = arms[0];
			if (!first) fail("no arms measured");
			console.log(`${density.name} on ${medium}:`);
			for (const arm of arms) {
				const throughput = arm.filesSearched / (arm.msP50 / 1000);
				const speedup = first.msP50 / arm.msP50;
				console.log(
					`  ${String(arm.workers).padStart(2)} workers  p50 ${arm.msP50.toFixed(1)}ms  ` +
						`p95 ${arm.msP95.toFixed(1)}ms  cpu ${arm.cpuMs.toFixed(0)}ms  ` +
						`${(throughput / 1000).toFixed(1)}k files/s  ${speedup.toFixed(2)}x vs 1 worker`,
				);
			}

			// Parity across worker counts: the same corpus must produce the same rows and
			// the same counters however many threads read it.
			for (const arm of arms.slice(1)) {
				const drift: string[] = [];
				if (arm.digest !== first.digest) drift.push("match rows differ");
				if (arm.totalMatches !== first.totalMatches) drift.push(`totalMatches ${arm.totalMatches}`);
				if (arm.filesWithMatches !== first.filesWithMatches) {
					drift.push(`filesWithMatches ${arm.filesWithMatches}`);
				}
				if (arm.filesSearched !== first.filesSearched) drift.push(`filesSearched ${arm.filesSearched}`);
				if (arm.skippedOversized !== first.skippedOversized) {
					drift.push(`skippedOversized ${arm.skippedOversized}`);
				}
				if (drift.length > 0) {
					failures++;
					console.log(`  parity: ${arm.workers} workers disagrees with 1 worker: ${drift.join(", ")}`);
				}
			}
			if (failures === 0) {
				console.log(`  parity: ${arms.length} worker counts agree, ${first.totalMatches} matches each`);
			}

			// The row's target, stated as the run can check it: four workers must not be
			// slower than one, and must reach twice the throughput.
			const four = arms.find(entry => entry.workers === 4);
			if (four) {
				const speedup = first.msP50 / four.msP50;
				const verdict =
					speedup >= 2
						? "meets the 2x target"
						: speedup >= 1
							? "scales, below the 2x target"
							: "SLOWER than one worker";
				console.log(`  => 4 workers: ${speedup.toFixed(2)}x one worker, ${verdict}\n`);
			} else {
				console.log("");
			}
		}
	}

	if (failures > 0) fail(`${failures} worker count(s) disagreed with the single-worker result`);
}

function argValue(name: string): string | undefined {
	return process.argv.find(arg => arg.startsWith(`--${name}=`))?.split("=")[1];
}

if (process.argv.includes("--arm")) {
	const medium = argValue("medium") ?? "disk";
	const density = argValue("density") ?? "all-match";
	const workers = Number(argValue("workers") ?? "1");
	console.log(JSON.stringify(await measureArm(medium, density, workers)));
} else {
	await parent();
}
