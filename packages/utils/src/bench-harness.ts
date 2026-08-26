/**
 * A micro-benchmark loop and the two readings its callers always need.
 *
 * Every bench script in the repository wants the same three things: run a function N times and
 * print a per-operation cost, summarise a set of samples without pretending a mean is the whole
 * story, and fail the process loudly when a guard is missed. Four scripts across two packages had
 * written their own copy of each, which is how one of them came to report a speedup at all: a
 * benchmark's own arithmetic is the last place a difference should be allowed to hide.
 *
 * This is deliberately small and deliberately printing. It is not a statistics package: it reports
 * p50, p95 and the mean because a p95 that is far from the mean is itself the finding, and it says
 * nothing about confidence intervals it has not earned.
 */

import { clampLow } from "./math";

/** Warmup iterations to run, and exclude, before the timed loop. */
export interface BenchOptions {
	/**
	 * How many untimed iterations to run first.
	 *
	 * Defaults to a tenth of `iterations`, clamped to at least 1 and at most 1000: enough for the JIT to
	 * tier up a small function, and bounded so a million-iteration bench does not spend most of its time
	 * warming up.
	 */
	readonly warmup?: number;
}

/** The default warmup for `iterations`, exported so a script can report or override it deliberately. */
export function defaultWarmup(iterations: number): number {
	return clampLow(Math.floor(iterations / 10), 1, 1000);
}

/**
 * Build a benchmark runner printing `<name>: <total>ms (<perOp>ms/op, <warmup> warmup)` and returning total elapsed ms.
 * Untimed warmup prevents JIT tier-up distortion on sub-microsecond operations.
 */
export function makeBench(iterations: number, options: BenchOptions = {}): (name: string, fn: () => void) => number {
	const warmup = Math.max(0, Math.floor(options.warmup ?? defaultWarmup(iterations)));
	return function bench(name: string, fn: () => void): number {
		for (let i = 0; i < warmup; i++) {
			fn();
		}
		const start = Bun.nanoseconds();
		for (let i = 0; i < iterations; i++) {
			fn();
		}
		const elapsed = (Bun.nanoseconds() - start) / 1e6;
		const perOp = (elapsed / iterations).toFixed(6);
		console.log(`${name}: ${elapsed.toFixed(2)}ms total (${perOp}ms/op, ${warmup} warmup)`);
		return elapsed;
	};
}

/** The three readings a frame-time or latency sample set is judged on. */
export interface BenchStats {
	readonly p50: number;
	readonly p95: number;
	readonly mean: number;
}

/**
 * Summarise timing samples.
 *
 * The percentile is a nearest-rank pick from the sorted samples rather than an interpolation, which
 * keeps every reported number one that was actually measured. An empty set reports zeros rather
 * than `NaN`, because a bench that measured nothing should print a zero row and let the caller's
 * guard fail, not poison every arithmetic downstream of it.
 */
export function benchStats(samplesMs: readonly number[]): BenchStats {
	const sorted = [...samplesMs].sort((a, b) => a - b);
	const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
	const mean = sorted.reduce((total, sample) => total + sample, 0) / Math.max(1, sorted.length);
	return { p50: at(0.5), p95: at(0.95), mean };
}

/**
 * Report a missed guard and exit non-zero.
 *
 * A bench that prints a failure and exits 0 is a bench nothing can gate on, which is exactly how a
 * broken benchmark stays broken: the output scrolls past and the exit code says everything is fine.
 */
export function benchFail(message: string): never {
	console.error(`GUARD FAILED: ${message}`);
	process.exit(1);
}
