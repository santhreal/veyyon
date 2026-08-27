/**
 * Addon grep against `rg`, on a corpus this script generated.
 *
 * Run it: `bun run bench` from `packages/natives`, or `bun bench/grep.ts`.
 *
 *   GREP_BENCH_ITERATIONS=25        samples per arm, per engine
 *   GREP_BENCH_PASSES_PER_SAMPLE=5  passes averaged into one sample
 *   GREP_BENCH_WARMUP=10            untimed passes before the first sample
 *   GREP_BENCH_SEED=0x5eed1         corpus seed; another seed is another corpus
 *   GREP_BENCH_FILES=10000          corpus files under src/
 *   GREP_BENCH_CORPUS_DIR=...       where the corpus lives (default: XDG cache)
 *   GREP_BENCH_REGENERATE=1         rewrite the corpus even if the manifest matches
 *   GREP_BENCH_DROP_CACHES=1        drop the page cache before each cold pass (root)
 *
 * What changed, and why. The old version searched this repository and the local
 * Cargo registry, compared a total match count, printed `Nx faster` unconditionally,
 * and ran `rg` with stderr discarded and the exit code unread; an `rg` that failed
 * to start read as a very fast search of nothing. So: the corpus is generated from a
 * version and a seed, the arms are compared row for row, the run records what it ran
 * on, and the ratio sentence is refused unless all of that held.
 *
 * The old two-at-a-time arm is gone. Running the same query twice concurrently says
 * nothing about how the walker scales; worker scaling is measured against
 * `VEYYON_WALK_WORKERS` instead, which is a separate instrument.
 */

import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { type GrepOptions, GrepOutputMode, type GrepResult, grep } from "../native/index.js";
import {
	CORPUS_GLOB,
	CORPUS_PATTERN,
	type CorpusFacts,
	DEFAULT_FILE_COUNT,
	DEFAULT_SEED,
	defaultCorpusDir,
	generateCorpus,
	HIDDEN_DIR,
	IGNORED_DIR,
	NODE_MODULES_DIR,
} from "./grep-corpus.js";
import {
	type ContentRow,
	type CountRow,
	compareContent,
	compareCounts,
	compareFiles,
	missingProvenance,
	PARITY_SCOPE,
	type Provenance,
	parseRgContent,
	parseRgCounts,
	parseRgFiles,
	readings,
	rgFailure,
	runRipgrep,
	speedClaim,
	stability,
} from "./grep-parity.js";

function fail(message: string): never {
	console.error(`GUARD FAILED: ${message}`);
	process.exit(1);
}

const ITERATIONS = Number(process.env.GREP_BENCH_ITERATIONS ?? "25");
/**
 * Passes averaged into one sample. A single pass over the corpus is ~10ms, which is
 * small enough that scheduler noise on a busy machine moves the median further than
 * a real regression would. Averaging a few passes per sample is what makes two runs
 * comparable within a few percent; it does not change what is being measured.
 */
const PASSES_PER_SAMPLE = Number(process.env.GREP_BENCH_PASSES_PER_SAMPLE ?? "5");
/** Untimed passes before the first sample, so thread-pool and allocator warm-up is not in it. */
const WARMUP = Number(process.env.GREP_BENCH_WARMUP ?? "10");
const SEED = Number(process.env.GREP_BENCH_SEED ?? DEFAULT_SEED);
const FILES = Number(process.env.GREP_BENCH_FILES ?? DEFAULT_FILE_COUNT);

interface Arm {
	readonly name: string;
	readonly mode: GrepOutputMode;
	readonly rgModeArgs: readonly string[];
}

const ARMS: readonly Arm[] = [
	{ name: "content", mode: GrepOutputMode.Content, rgModeArgs: ["--json"] },
	{ name: "filesWithMatches", mode: GrepOutputMode.FilesWithMatches, rgModeArgs: ["--files-with-matches"] },
	{ name: "count", mode: GrepOutputMode.Count, rgModeArgs: ["--count"] },
];

/**
 * The option subset both engines are held to on the timed arms: hidden files in,
 * ignore rules off, `node_modules` pruned. The addon prunes `node_modules` unless the
 * glob names it, and `rg` does not, so `rg` is told to; stating the divergence here
 * is what keeps it from surfacing later as a parity failure nobody can explain.
 */
const RG_SHARED = ["--hidden", "--no-ignore", "-g", CORPUS_GLOB, "-g", `!**/${NODE_MODULES_DIR}/**`];

function nativeContent(result: GrepResult): ContentRow[] {
	return result.matches.map(match => ({ path: match.path, lineNumber: match.lineNumber, line: match.line }));
}

function nativeFiles(result: GrepResult): string[] {
	return result.matches.map(match => match.path);
}

function nativeCounts(result: GrepResult): CountRow[] {
	return result.matches.map(match => ({ path: match.path, count: match.matchCount ?? 0 }));
}

async function rgOnce(args: readonly string[], cwd: string): Promise<string> {
	const run = await runRipgrep(args, cwd);
	const failure = rgFailure(run);
	if (failure) fail(`${failure}\n  argv: ${run.argv.join(" ")}`);
	return run.stdout;
}

async function timedRg(args: readonly string[], cwd: string, passes = PASSES_PER_SAMPLE): Promise<number> {
	let total = 0;
	for (let pass = 0; pass < passes; pass++) {
		const run = await runRipgrep(args, cwd);
		const failure = rgFailure(run);
		if (failure) fail(`${failure}\n  argv: ${run.argv.join(" ")}`);
		total += run.ms;
	}
	return total / passes;
}

async function timedNative(options: GrepOptions, passes = PASSES_PER_SAMPLE): Promise<number> {
	const started = process.hrtime.bigint();
	for (let pass = 0; pass < passes; pass++) await grep(options);
	return Number(process.hrtime.bigint() - started) / 1e6 / passes;
}

async function dropPageCache(): Promise<boolean> {
	if (process.env.GREP_BENCH_DROP_CACHES !== "1") return false;
	try {
		await fs.writeFile("/proc/sys/vm/drop_caches", "3");
		return true;
	} catch {
		return false;
	}
}

async function addonVersion(): Promise<string> {
	try {
		const parsed: unknown = JSON.parse(
			await fs.readFile(path.resolve(import.meta.dirname, "../package.json"), "utf8"),
		);
		if (parsed && typeof parsed === "object") {
			const version = (parsed as { version?: unknown }).version;
			if (typeof version === "string") return version;
		}
	} catch {
		// Reported as missing provenance below, which refuses the ratio.
	}
	return "";
}

async function rgVersion(): Promise<string> {
	const run = await runRipgrep(["--version"], process.cwd());
	if (run.exitCode !== 0) fail(`rg --version exited ${run.exitCode}: ${run.stderr.trim()}`);
	return run.stdout.split("\n")[0]?.trim() ?? "";
}

/**
 * Both engines with hidden files excluded, and both with ignore rules honored.
 *
 * These are not timed. They exist so the corpus controls do work: a run that quietly
 * lost the `.hidden` files, or quietly searched the gitignored ones, would otherwise
 * still show a clean parity on the timed arms, because both engines would be reading
 * the same subset.
 */
async function checkControlArms(facts: CorpusFacts): Promise<string[]> {
	const differences: string[] = [];

	const hiddenOff = await grep({
		pattern: CORPUS_PATTERN,
		path: facts.root,
		glob: CORPUS_GLOB,
		gitignore: false,
		hidden: false,
		mode: GrepOutputMode.FilesWithMatches,
	});
	const rgHiddenOff = parseRgFiles(
		await rgOnce(
			[
				"--files-with-matches",
				"--no-ignore",
				"-g",
				CORPUS_GLOB,
				"-g",
				`!**/${NODE_MODULES_DIR}/**`,
				"--regexp",
				CORPUS_PATTERN,
				".",
			],
			facts.root,
		),
	);
	const nativeHiddenOff = nativeFiles(hiddenOff);
	const df = compareFiles("control hidden-off", nativeHiddenOff.sort(), [...rgHiddenOff].sort());
	for (let di = 0; di < df.length; di++) differences.push(df[di]!);
	for (const found of nativeHiddenOff) {
		if (found.startsWith(`${HIDDEN_DIR}/`)) differences.push(`control hidden-off: addon returned ${found}`);
	}

	const ignoreOn = await grep({
		pattern: CORPUS_PATTERN,
		path: facts.root,
		glob: CORPUS_GLOB,
		gitignore: true,
		mode: GrepOutputMode.FilesWithMatches,
	});
	const rgIgnoreOn = parseRgFiles(
		await rgOnce(
			[
				"--files-with-matches",
				"--hidden",
				"--no-require-git",
				"-g",
				CORPUS_GLOB,
				"-g",
				`!**/${NODE_MODULES_DIR}/**`,
				"--regexp",
				CORPUS_PATTERN,
				".",
			],
			facts.root,
		),
	);
	const nativeIgnoreOn = nativeFiles(ignoreOn);
	const df2 = compareFiles("control ignore-on", nativeIgnoreOn.sort(), [...rgIgnoreOn].sort());
	for (let di = 0; di < df2.length; di++) differences.push(df2[di]!);
	for (const found of nativeIgnoreOn) {
		if (found.startsWith(`${IGNORED_DIR}/`)) differences.push(`control ignore-on: addon returned ${found}`);
	}

	return differences;
}

async function main(): Promise<void> {
	const root = process.env.GREP_BENCH_CORPUS_DIR ?? defaultCorpusDir(SEED);
	const generateStarted = process.hrtime.bigint();
	const facts = await generateCorpus({
		root,
		seed: SEED,
		files: FILES,
		regenerate: process.env.GREP_BENCH_REGENERATE === "1",
	});
	const generateMs = Number(process.hrtime.bigint() - generateStarted) / 1e6;

	const cacheDropped = await dropPageCache();
	const provenance: Provenance = {
		rgVersion: await rgVersion(),
		addonVersion: await addonVersion(),
		bunVersion: process.versions.bun ?? "",
		cpu: os.cpus()[0]?.model?.trim() ?? "",
		platform: `${process.platform}-${process.arch} ${os.release()}`,
		corpusVersion: facts.version,
		corpusSeed: facts.seed,
		corpusFiles: facts.files,
		corpusBytes: facts.bytes,
		pageCacheState: cacheDropped ? "dropped before each cold pass" : "warm (page cache not dropped)",
	};
	const provenanceGaps = missingProvenance(provenance);

	console.log(`Corpus v${facts.version} seed 0x${facts.seed.toString(16)} at ${facts.root}`);
	console.log(
		`  ${facts.files} files, ${(facts.bytes / 1024 / 1024).toFixed(1)}MiB, every src path ${facts.pathLength} chars, ` +
			`${facts.matchingFiles} matching files (${((facts.matchingFiles / facts.files) * 100).toFixed(1)}%), ` +
			`${facts.reused ? "reused" : `generated in ${(generateMs / 1000).toFixed(1)}s`}`,
	);
	console.log(`  pattern /${CORPUS_PATTERN}/ glob ${CORPUS_GLOB}`);
	console.log(`  ${provenance.rgVersion} | addon ${provenance.addonVersion} | bun ${provenance.bunVersion}`);
	console.log(`  ${provenance.cpu} | ${provenance.platform} | ${provenance.pageCacheState}`);
	console.log(`  parity covers ${PARITY_SCOPE}\n`);

	// The manifest is a claim about the corpus. Check it against what is on disk
	// before either engine is timed, so a generator bug cannot pass as a fast search.
	const expectedMatches = facts.srcMatches + facts.hiddenMatches + facts.ignoredMatches;
	const audit = await grep({ pattern: CORPUS_PATTERN, path: facts.root, glob: CORPUS_GLOB, gitignore: false });
	if (audit.totalMatches !== expectedMatches) {
		fail(`corpus holds ${audit.totalMatches} matches, manifest claims ${expectedMatches}`);
	}
	if (audit.matches.some(match => match.path.startsWith(`${NODE_MODULES_DIR}/`))) {
		fail(`the addon returned a ${NODE_MODULES_DIR}/ match, which it is documented to prune`);
	}

	const controlDifferences = await checkControlArms(facts);
	if (controlDifferences.length > 0) {
		for (const difference of controlDifferences) console.error(`  ${difference}`);
		fail(`${controlDifferences.length} control-arm difference(s): the shared option subset does not hold`);
	}
	console.log("Control arms agree: hidden-off drops the hidden files, ignore-on drops the ignored ones\n");

	let failures = 0;
	for (const arm of ARMS) {
		const nativeOptions = {
			pattern: CORPUS_PATTERN,
			path: facts.root,
			glob: CORPUS_GLOB,
			gitignore: false,
			mode: arm.mode,
		};
		const rgArgs = [...arm.rgModeArgs, ...RG_SHARED, "--regexp", CORPUS_PATTERN, "."];

		const nativeResult = await grep(nativeOptions);
		const rgStdout = await rgOnce(rgArgs, facts.root);
		const parity =
			arm.mode === GrepOutputMode.Content
				? compareContent(
						arm.name,
						nativeContent(nativeResult).sort((a, b) => contentOrder(a, b)),
						parseRgContent(rgStdout).sort((a, b) => contentOrder(a, b)),
					)
				: arm.mode === GrepOutputMode.FilesWithMatches
					? compareFiles(arm.name, nativeFiles(nativeResult).sort(), parseRgFiles(rgStdout).sort())
					: compareCounts(
							arm.name,
							nativeCounts(nativeResult).sort((a, b) => a.path.localeCompare(b.path)),
							parseRgCounts(rgStdout).sort((a, b) => a.path.localeCompare(b.path)),
						);

		const coldNative: number[] = [];
		const coldRg: number[] = [];
		if (cacheDropped) {
			coldNative.push(await timedNative(nativeOptions, 1));
			await dropPageCache();
			coldRg.push(await timedRg(rgArgs, facts.root, 1));
			await dropPageCache();
		}

		for (let i = 0; i < WARMUP; i++) {
			await grep(nativeOptions);
			await rgOnce(rgArgs, facts.root);
		}

		const nativeSamples: number[] = [];
		const rgSamples: number[] = [];
		for (let i = 0; i < ITERATIONS; i++) {
			// Alternate which engine goes first, so neither arm always pays for the
			// other's cache effects.
			if (i % 2 === 0) {
				nativeSamples.push(await timedNative(nativeOptions));
				rgSamples.push(await timedRg(rgArgs, facts.root));
			} else {
				rgSamples.push(await timedRg(rgArgs, facts.root));
				nativeSamples.push(await timedNative(nativeOptions));
			}
		}

		const nativeWarm = readings(nativeSamples);
		const rgWarm = readings(rgSamples);
		const nativeStability = stability(nativeSamples);
		const rgStability = stability(rgSamples);
		const claim = speedClaim({
			nativeMs: nativeWarm.p50,
			rgMs: rgWarm.p50,
			parityDifferences: parity,
			missingProvenance: provenanceGaps,
			stability: nativeStability.stable ? rgStability : nativeStability,
		});

		console.log(`${arm.name}:`);
		console.log(
			`  addon warm  p50 ${nativeWarm.p50.toFixed(1)}ms  p95 ${nativeWarm.p95.toFixed(1)}ms  ` +
				`mean ${nativeWarm.mean.toFixed(1)}ms  n=${nativeWarm.samples}`,
		);
		console.log(
			`  rg warm     p50 ${rgWarm.p50.toFixed(1)}ms  p95 ${rgWarm.p95.toFixed(1)}ms  ` +
				`mean ${rgWarm.mean.toFixed(1)}ms  n=${rgWarm.samples}`,
		);
		if (cacheDropped) {
			console.log(`  cold        addon ${(coldNative[0] ?? 0).toFixed(1)}ms  rg ${(coldRg[0] ?? 0).toFixed(1)}ms`);
		} else {
			console.log("  cold        not measured (needs GREP_BENCH_DROP_CACHES=1 and root)");
		}
		console.log(
			`  halves      addon ${nativeStability.firstHalf.toFixed(1)}/${nativeStability.secondHalf.toFixed(1)}ms ` +
				`(${(nativeStability.drift * 100).toFixed(1)}%), rg ${rgStability.firstHalf.toFixed(1)}/` +
				`${rgStability.secondHalf.toFixed(1)}ms (${(rgStability.drift * 100).toFixed(1)}%)`,
		);
		if (parity.length === 0) {
			const rows =
				arm.mode === GrepOutputMode.FilesWithMatches ? nativeResult.filesWithMatches : nativeResult.totalMatches;
			console.log(`  parity      identical, ${rows} rows`);
		} else {
			failures++;
			console.log(`  parity      ${parity.length} difference(s):`);
			for (const difference of parity) console.log(`    ${difference}`);
		}
		console.log(`  => ${claim}\n`);
	}

	if (failures > 0) fail(`${failures} arm(s) disagreed with rg`);
}

function contentOrder(a: ContentRow, b: ContentRow): number {
	if (a.path !== b.path) return a.path.localeCompare(b.path);
	if (a.lineNumber !== b.lineNumber) return a.lineNumber - b.lineNumber;
	return a.line.localeCompare(b.line);
}

await main();
