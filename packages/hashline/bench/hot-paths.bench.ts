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
process.exit(failed ? 1 : 0);
