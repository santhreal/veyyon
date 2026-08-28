export const BASELINE_VERSION = 2;

export const MIN_RUNS = 20;

export const THRESHOLD = 1.05;

export interface BenchFingerprint {
	platform: string;
	arch: string;
	cpu: string;
	host: string;
	runtime: string;
	command: string;
	isolatedHome: boolean;
	runs: number;
}

export const COMPARED_FIELDS = [
	"platform",
	"arch",
	"cpu",
	"host",
	"runtime",
	"command",
	"isolatedHome",
] as const satisfies readonly (keyof BenchFingerprint)[];

export const RECORDED_ONLY_FIELDS = ["revision", "dirty", "runs"] as const;

export interface BaselineFile {
	version: number;
	median: number;
	fingerprint: BenchFingerprint;
	revision: string | null;
	dirty: boolean;
	capturedAt: string;
	hyperfine: unknown;
}

export type Decision =
	| { kind: "ok"; ratio: number }
	| { kind: "regression"; ratio: number }
	| { kind: "refused"; reasons: string[] };

function describe(value: string | number | boolean): string {
	return typeof value === "string" ? value : String(value);
}

export function refusals(baseline: BaselineFile | null, candidate: BenchFingerprint): string[] {
	if (baseline === null) {
		return ["no baseline on this machine (run with --update first)"];
	}
	if (baseline.version !== BASELINE_VERSION) {
		return [`baseline is version ${baseline.version}, this guard writes version ${BASELINE_VERSION} — recapture it`];
	}
	const reasons: string[] = [];
	for (const field of COMPARED_FIELDS) {
		const was = baseline.fingerprint[field];
		const now = candidate[field];
		if (was !== now) {
			reasons.push(`${field}: baseline ${describe(was)}, this run ${describe(now)}`);
		}
	}
	if (baseline.fingerprint.runs < MIN_RUNS) {
		reasons.push(`baseline median is over ${baseline.fingerprint.runs} runs, ${MIN_RUNS} required`);
	}
	if (candidate.runs < MIN_RUNS) {
		reasons.push(`this run's median is over ${candidate.runs} runs, ${MIN_RUNS} required`);
	}
	return reasons;
}

export function decide(baseline: BaselineFile | null, candidate: BenchFingerprint, median: number): Decision {
	const reasons = refusals(baseline, candidate);
	if (reasons.length > 0 || baseline === null) {
		return { kind: "refused", reasons };
	}
	if (!(baseline.median > 0)) {
		return { kind: "refused", reasons: [`baseline median is ${baseline.median}s`] };
	}
	const ratio = median / baseline.median;
	return ratio > THRESHOLD ? { kind: "regression", ratio } : { kind: "ok", ratio };
}

export function medianOf(hyperfineJson: string): { median: number; runs: number } {
	const parsed = JSON.parse(hyperfineJson) as {
		results?: Array<{ mean?: number; median?: number; times?: number[] }>;
	};
	const result = parsed.results?.[0];
	if (!result) throw new Error("hyperfine produced no result");
	const median = result.median ?? result.mean;
	if (typeof median !== "number" || !(median > 0)) {
		throw new Error("hyperfine result carries no usable median");
	}
	return { median, runs: result.times?.length ?? 0 };
}
