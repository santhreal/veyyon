#!/usr/bin/env bun
/**
 * Micro-benchmark guard for the hashline hot paths (TS-SUITE-8): the
 * per-function baselines a Rust port must meet-or-beat, and the local
 * regression tripwire for TS changes.
 *
 * Baselines are MACHINE-RELATIVE (same rule as coding-agent's boot
 * bench-guard): capture and compare on the same machine, and treat the
 * committed baseline as this repo's reference box, not a universal number.
 *
 *   bun bench/hot-paths.bench.ts --update   # capture/refresh the baseline
 *   bun bench/hot-paths.bench.ts            # measure + compare; exit 1 on regression
 *
 * The guard is statistical, not a raw threshold: a case fails only when the
 * new min-of-samples exceeds baseline min + max(NOISE_BAND x baseline, the
 * baseline's own observed spread). That keeps one noisy run from flapping
 * while a real 2x regression cannot hide.
 */
import * as fs from "node:fs";
import * as path from "node:path";
import { applyEdits, parsePatch } from "../src/index";
import { detectLineEnding, normalizeToLF, restoreLineEndings, stripBom } from "../src/normalize";
import { parseLid, splitHashlineLines } from "../src/tokenizer";

const BASELINE_PATH = path.join(import.meta.dir, "baseline.json");
const NOISE_BAND = 0.25; // 25% band: micro-bench medians on a busy box wobble
const SAMPLES = 20;
const INNER_ITERS = 50;

// --- fixtures ---------------------------------------------------------------
const LINES_10K = Array.from({ length: 10_000 }, (_, i) => `line ${i + 1} const value = ${i};`);
const LF_10K = LINES_10K.join("\n");
const CRLF_10K = LINES_10K.join("\r\n");
const MIXED_10K = LINES_10K.map((l, i) => l + (i % 3 === 0 ? "\r\n" : "\n")).join("");
const DEL_PATCH = parsePatch("DEL 5000").edits;

interface BenchCase {
	name: string;
	run: () => unknown;
}

const CASES: BenchCase[] = [
	{ name: "splitHashlineLines/10k-lf", run: () => splitHashlineLines(LF_10K) },
	{ name: "splitHashlineLines/10k-crlf", run: () => splitHashlineLines(CRLF_10K) },
	{ name: "parseLid/padded", run: () => parseLid("  123456  ", 1) },
	{ name: "detectLineEnding/10k", run: () => detectLineEnding(MIXED_10K) },
	{ name: "normalizeToLF/10k-mixed", run: () => normalizeToLF(MIXED_10K) },
	{ name: "restoreLineEndings/10k-to-crlf", run: () => restoreLineEndings(LF_10K, "\r\n") },
	{ name: "stripBom/10k", run: () => stripBom(`﻿${LF_10K}`) },
	{ name: "applyEdits/del-mid-10k", run: () => applyEdits(LF_10K, DEL_PATCH) },
];

// --- measurement ------------------------------------------------------------
/**
 * Min-of-samples in ns/op. The MINIMUM is the noise-robust micro-bench
 * statistic: scheduler preemption and co-running work only ever ADD time, so
 * the fastest batch approximates the true cost, while a median regresses
 * 30%+ whenever the box is busy (observed on first run of this guard). The
 * spread (median minus min) is kept for the budget so inherently jittery
 * cases get proportionally more headroom.
 */
function measure(bench: BenchCase): { minNs: number; spreadNs: number } {
	// Warmup.
	for (let i = 0; i < INNER_ITERS; i++) bench.run();
	const samples: number[] = [];
	for (let s = 0; s < SAMPLES; s++) {
		const start = Bun.nanoseconds();
		for (let i = 0; i < INNER_ITERS; i++) bench.run();
		samples.push((Bun.nanoseconds() - start) / INNER_ITERS);
	}
	samples.sort((a, b) => a - b);
	const minNs = samples[0] ?? 0;
	const medianNs = samples[Math.floor(samples.length / 2)] ?? 0;
	return { minNs, spreadNs: Math.max(0, medianNs - minNs) };
}

interface Baseline {
	capturedWith: { samples: number; innerIters: number };
	cases: Record<string, { minNs: number; spreadNs: number }>;
}

function fmt(ns: number): string {
	return ns >= 1e6 ? `${(ns / 1e6).toFixed(2)}ms` : ns >= 1e3 ? `${(ns / 1e3).toFixed(1)}us` : `${ns.toFixed(0)}ns`;
}

const update = process.argv.includes("--update");
const results = new Map(CASES.map(benchCase => [benchCase.name, measure(benchCase)] as const));

if (update) {
	const baseline: Baseline = {
		capturedWith: { samples: SAMPLES, innerIters: INNER_ITERS },
		cases: Object.fromEntries(results),
	};
	fs.writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, 1)}\n`);
	for (const [name, r] of results) console.log(`${name}: ${fmt(r.minNs)} (±${fmt(r.spreadNs)})`);
	console.log(`Baseline written to ${BASELINE_PATH}`);
	process.exit(0);
}

if (!fs.existsSync(BASELINE_PATH)) {
	console.error("No baseline. Run `bun bench/hot-paths.bench.ts --update` on this machine first.");
	process.exit(2);
}
const baseline = JSON.parse(fs.readFileSync(BASELINE_PATH, "utf8")) as Baseline;

let failed = false;
for (const [name, r] of results) {
	const base = baseline.cases[name];
	if (!base) {
		console.error(`${name}: no baseline entry — re-run with --update`);
		failed = true;
		continue;
	}
	const budget = base.minNs + Math.max(NOISE_BAND * base.minNs, base.spreadNs);
	const verdict = r.minNs <= budget ? "ok" : "REGRESSION";
	if (verdict !== "ok") failed = true;
	console.log(`${name}: ${fmt(r.minNs)} vs baseline ${fmt(base.minNs)} (budget ${fmt(budget)}) ${verdict}`);
}
for (const name of Object.keys(baseline.cases)) {
	if (!results.has(name)) {
		console.error(`${name}: in baseline but no longer benchmarked — silent coverage loss`);
		failed = true;
	}
}

// --- size scaling -----------------------------------------------------------
// The reproducible method behind the complexity the handbook states. Two arms,
// both measuring cost per input byte at 10k / 100k / 1M lines:
//
//   swap-mid   one one-line replacement, LF and CRLF. Applying a patch costs
//              O(file bytes + output + patch) — `applyEdits` splits the whole
//              body into lines and joins the whole result — so the per-byte
//              cost is flat and the wall time tracks the file, not the patch.
//   del-tenth  a range delete over a tenth of the file, which parses into one
//              single-line delete per line. Cost stays O(file bytes + output +
//              patch) in the number of edits too, which is what the forward
//              rebuild buys over the splice-per-edit pass it replaced.
//
// Each guard is a ratio, not an absolute time, so it holds on any machine: a
// regression to a per-edit splice, a per-line offset rescan, or anything else
// superlinear shows up as the per-byte cost climbing between 100k and 1M lines.
// The two arms fail independently, because a regression in per-edit work is
// invisible to a one-edit patch. On the reference box (Ryzen 9 9950X, Bun 1.4)
// the swap-mid LF arms read 0.3ms / 3.0ms / 29ms — about 1ns per byte at every
// size — the CRLF pipeline, which normalizes to LF and restores the endings
// around the same apply, 0.6ms / 6.1ms / 83ms, and del-tenth 0.9ms / 9ms / 96ms.
//
// The budget is 2x rather than something tight because the measured ratio wobbles
// between 0.78x and 1.40x across runs: allocating a million lines and, on the del
// arm, a hundred thousand edit objects puts the big arm at the mercy of a
// collection the small arm never pays for. A quadratic shape costs ~10x over the
// same 10x of input, so it cannot hide under this band.
//
// HASHLINE_SCALE_SIZES and HASHLINE_SCALE_SAMPLES drive the same curve at other
// sizes, and the guard always compares the two largest arms present. The
// mutation gate (.internal/mutate-hashline-scale.py) needs that: a genuinely
// quadratic applier does not finish a million lines this side of an hour, so it
// is measured over a smaller pair where the shape still shows.
const SCALE_SIZES = (process.env.HASHLINE_SCALE_SIZES ?? "10000,100000,1000000")
	.split(",")
	.map(size => Number.parseInt(size.trim(), 10))
	.filter(size => Number.isInteger(size) && size >= 1000)
	.sort((a, b) => a - b);
const SCALE_SAMPLES = Number.parseInt(process.env.HASHLINE_SCALE_SAMPLES ?? "5", 10);
const PER_BYTE_BUDGET = 2;
if (SCALE_SIZES.length < 2 || !Number.isInteger(SCALE_SAMPLES) || SCALE_SAMPLES < 1) {
	console.error("size scaling: need at least two sizes of >=1000 lines and one sample");
	process.exit(2);
}

function scaleBody(lines: number, ending: string): string {
	const rows = new Array<string>(lines);
	for (let i = 0; i < lines; i++) rows[i] = `line ${i + 1} const value = ${i};`;
	return rows.join(ending) + ending;
}

function minMs(run: () => void): number {
	let best = Number.POSITIVE_INFINITY;
	for (let sample = 0; sample < SCALE_SAMPLES; sample++) {
		const start = Bun.nanoseconds();
		run();
		best = Math.min(best, (Bun.nanoseconds() - start) / 1e6);
	}
	return best;
}

const swapPerByte = new Map<number, number>();
const delPerByte = new Map<number, number>();
for (const lines of SCALE_SIZES) {
	const label = `${(lines / 1000).toFixed(0)}k`;
	const middle = Math.floor(lines / 2);
	const swapPatch = parsePatch(`SWAP ${middle}.=${middle}:\n+replaced middle line\n`).edits;
	const delPatch = parsePatch(`DEL ${middle}.=${middle + Math.floor(lines / 10)}`).edits;
	const lf = scaleBody(lines, "\n");
	const crlf = scaleBody(lines, "\r\n");

	const swapMs = minMs(() => {
		applyEdits(lf, swapPatch);
	});
	const crlfMs = minMs(() => {
		const stripped = stripBom(crlf).text;
		const ending = detectLineEnding(stripped);
		restoreLineEndings(applyEdits(normalizeToLF(stripped), swapPatch).text, ending);
	});
	const delMs = minMs(() => {
		applyEdits(lf, delPatch);
	});

	swapPerByte.set(lines, (swapMs * 1e6) / lf.length);
	delPerByte.set(lines, (delMs * 1e6) / lf.length);
	console.log(
		`applyEdits/swap-mid-${label}: ${swapMs.toFixed(2)}ms lf, ${crlfMs.toFixed(2)}ms crlf-pipeline, ` +
			`${lf.length}B in, ${((swapMs * 1e6) / lf.length).toFixed(2)}ns/B`,
	);
	console.log(
		`applyEdits/del-tenth-${label}: ${delMs.toFixed(2)}ms lf, ${delPatch.length} edits, ` +
			`${((delMs * 1e6) / lf.length).toFixed(2)}ns/B`,
	);
}
const SMALL_ARM = SCALE_SIZES[SCALE_SIZES.length - 2] ?? 0;
const LARGE_ARM = SCALE_SIZES[SCALE_SIZES.length - 1] ?? 0;

function guardLinear(arm: string, perByte: Map<number, number>, complaint: string): void {
	const small = perByte.get(SMALL_ARM);
	const large = perByte.get(LARGE_ARM);
	if (small === undefined || large === undefined || small <= 0) {
		console.error(`size scaling/${arm}: missing arm`);
		failed = true;
		return;
	}
	const grew = large / small;
	const line =
		`size scaling/${arm}: per-byte cost ${grew.toFixed(2)}x from ${SMALL_ARM} to ${LARGE_ARM} lines ` +
		`(budget ${PER_BYTE_BUDGET}x)`;
	if (grew > PER_BYTE_BUDGET) {
		console.error(`${line} — ${complaint}`);
		failed = true;
		return;
	}
	console.log(`${line} ok`);
}

guardLinear("swap-mid", swapPerByte, "applying one edit is no longer linear in the file");
guardLinear("del-tenth", delPerByte, "applying many edits is no longer linear in the file");

// The ratio above defends the SHAPE, and only the shape: a mutant that is
// quadratic at every size measured looks flat in a ratio of two quadratic
// numbers. The ceiling below defends the CONSTANT, at every arm, against a
// reference measured in this same process on this same box.
//
// The reference is `splitHashlineLines/10k-lf`, one linear pass over a file of
// the same shape, and deliberately NOT an `applyEdits` case: a regression inside
// the applier inflates every apply case at once, so an apply-based reference
// rises with the thing it is supposed to measure and the ceiling reads green
// through a 500x blowup (observed while building this guard).
const REFERENCE = results.get("splitHashlineLines/10k-lf");
const REFERENCE_PER_BYTE = REFERENCE ? REFERENCE.minNs / LF_10K.length : 0;
const SWAP_CEILING = 8;
const DEL_CEILING = 25;

function guardCeiling(arm: string, perByte: Map<number, number>, ceiling: number, complaint: string): void {
	if (REFERENCE_PER_BYTE <= 0) {
		console.error(`per-byte ceiling/${arm}: no splitHashlineLines/10k-lf reference`);
		failed = true;
		return;
	}
	for (const lines of SCALE_SIZES) {
		const measured = perByte.get(lines);
		if (measured === undefined) continue;
		const over = measured / REFERENCE_PER_BYTE;
		const line =
			`per-byte ceiling/${arm}-${(lines / 1000).toFixed(0)}k: ${over.toFixed(1)}x the split reference ` +
			`(${REFERENCE_PER_BYTE.toFixed(2)}ns/B, ceiling ${ceiling}x)`;
		if (over > ceiling) {
			console.error(`${line} — ${complaint}`);
			failed = true;
			continue;
		}
		console.log(`${line} ok`);
	}
}

guardCeiling("swap-mid", swapPerByte, SWAP_CEILING, "one edit costs far more per byte than a linear apply");
guardCeiling("del-tenth", delPerByte, DEL_CEILING, "many edits cost far more per byte than a linear apply");
process.exit(failed ? 1 : 0);
