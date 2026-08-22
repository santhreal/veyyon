/**
 * The decisions the boot guard makes, with no process or filesystem in them.
 *
 * Boot wall-clock is machine-relative, so a baseline is only a baseline for the
 * host, runtime and command that produced it. The guard used to compare a
 * median against whatever number was in the file, which reads a baseline
 * captured on a laptop as a 40% regression on a workstation and a slower CPU as
 * a fix. Every fact a comparison depends on travels with the baseline and is
 * checked before the numbers are.
 */

/** Baseline shape version. A stale file is refused, not read leniently. */
export const BASELINE_VERSION = 2;

/** Runs the median has to be taken over, on both arms. */
export const MIN_RUNS = 20;

/** 5% median regression budget. */
export const THRESHOLD = 1.05;

export interface BenchFingerprint {
	/** `process.platform`. */
	platform: string;
	/** `process.arch`. */
	arch: string;
	/** First CPU model string, which is what sets the boot's clock. */
	cpu: string;
	/** Host, because two machines with the same CPU model still differ. */
	host: string;
	/** Bun version: the runtime being measured. */
	runtime: string;
	/** The exact command hyperfine ran. */
	command: string;
	/** Whether each launch got its own isolated HOME. */
	isolatedHome: boolean;
	/** Measured launches behind the median. */
	runs: number;
}

/**
 * Fields whose disagreement makes two medians incomparable. Read at run time by
 * the suite, so a field added to the fingerprint is checked or the pin below
 * fails.
 */
export const COMPARED_FIELDS = [
	"platform",
	"arch",
	"cpu",
	"host",
	"runtime",
	"command",
	"isolatedHome",
] as const satisfies readonly (keyof BenchFingerprint)[];

/**
 * Fields carried for the record and deliberately not compared: the revision is
 * expected to differ (that is the point of the candidate arm), and the run
 * count is checked against [`MIN_RUNS`] rather than for equality.
 */
export const RECORDED_ONLY_FIELDS = ["revision", "dirty", "runs"] as const;

export interface BaselineFile {
	version: number;
	/** Median seconds. */
	median: number;
	fingerprint: BenchFingerprint;
	/** `git rev-parse HEAD` when it could be read. */
	revision: string | null;
	/** Whether the tree had uncommitted changes when the baseline was taken. */
	dirty: boolean;
	/** ISO timestamp of capture. */
	capturedAt: string;
	/** Raw hyperfine export, kept so a median can be recomputed. */
	hyperfine: unknown;
}

export type Decision =
	| { kind: "ok"; ratio: number }
	| { kind: "regression"; ratio: number }
	| { kind: "refused"; reasons: string[] };

function describe(value: string | number | boolean): string {
	return typeof value === "string" ? value : String(value);
}

/**
 * Why a baseline cannot be compared against this run, or an empty list when it
 * can. Every mismatch is named: a refusal that says only "incompatible" sends
 * the reader back to the file to diff it by hand.
 */
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

/** Compare a candidate median against a baseline, or refuse to. */
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

/** Median seconds and the number of runs behind it, from a hyperfine export. */
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
