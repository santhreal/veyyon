import { clampLow } from "./math";

export interface BenchOptions {
	readonly warmup?: number;
}

export function defaultWarmup(iterations: number): number {
	return clampLow(Math.floor(iterations / 10), 1, 1000);
}

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

export interface BenchStats {
	readonly p50: number;
	readonly p95: number;
	readonly mean: number;
}

function benchStats(samplesMs: readonly number[]): BenchStats {
	const sorted = samplesMs.slice().sort((a, b) => a - b);
	const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
	const mean = sorted.reduce((total, sample) => total + sample, 0) / Math.max(1, sorted.length);
	return { p50: at(0.5), p95: at(0.95), mean };
}

export function benchFail(message: string): never {
	console.error(`GUARD FAILED: ${message}`);
	process.exit(1);
}
