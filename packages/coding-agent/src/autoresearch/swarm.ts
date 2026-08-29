/**
 * Breadth for an autoresearch segment: several candidate implementations of one
 * goal, measured against canonical and certified against each other.
 *
 * At breadth 1 none of this runs. The serial loop keeps its existing path, and
 * `certifierFor(1)` reports `director`, which is what a single candidate has
 * always effectively had.
 *
 * Decision logic only. Worktree creation, agent invocation and harness
 * execution belong to the caller, so every rule here is a pure function that a
 * test can drive without a repository, a model or a benchmark.
 */
import type { MetricDirection } from "./types";

/** How a segment's candidates get reviewed, chosen by how many survived. */
export type CertifierMode = "void" | "director" | "ring";

/** Why a candidate never reached measurement. */
export type RejectionReason = "empty" | "scope" | "opaque" | "duplicate";

export interface Candidate {
	/** Arm identity within the segment, e.g. `a0`. */
	arm: string;
	hypothesis: string;
	diff: string;
	/** Paths the arm modified, relative to the repository root. */
	modifiedPaths: string[];
}

export interface Rejected {
	arm: string;
	reason: RejectionReason;
	/** A specific, checkable statement of what was wrong. */
	detail: string;
}

export interface Measured extends Candidate {
	metric: number;
	/** Every metric the harness reported, including secondaries. */
	metrics: Record<string, number>;
}

export interface Verdict {
	arm: string;
	certifiedBy: string;
	flagged: boolean;
	reason: string | null;
}

export interface Triage {
	survivors: Candidate[];
	rejected: Rejected[];
}

/**
 * A run of base64-ish characters long enough that no hand-written source line
 * would contain it. 512 is far above a long import list, a inlined lookup table
 * or a minified regex, and far below any useful compiled artifact.
 */
const OPAQUE_RUN = /[A-Za-z0-9+/=]{512,}/;

/**
 * Find a non-source payload hidden in a diff.
 *
 * An arm can compile a binary while implementing and embed it as a base64
 * literal, which produces a small, fast, plausible-looking change that no
 * reviewer can read and no import-time measurement can see: the build already
 * happened, elsewhere. Observed in a live run as a 22,864-byte ELF inside a
 * 26-line file, certified clean, and wrong on every non-ASCII input.
 *
 * Legibility is therefore a precondition for certification, checked before
 * measurement rather than asked of a reviewer.
 */
export function opaquePayload(diff: string): string | null {
	if (diff.includes("GIT binary patch")) return "git binary patch";
	for (const line of diff.split("\n")) {
		if (!line.startsWith("+")) continue;
		const match = OPAQUE_RUN.exec(line);
		if (match) return `${match[0].length}-char opaque literal`;
	}
	return null;
}

/** Paths the arm touched that the session declared off limits. */
export function scopeDeviations(modifiedPaths: readonly string[], offLimits: readonly string[]): string[] {
	if (offLimits.length === 0) return [];
	const forbidden = new Set(offLimits);
	return modifiedPaths.filter(candidate => forbidden.has(candidate)).sort();
}

/**
 * Reduce a segment's arms to the ones worth measuring.
 *
 * Order matters: an out-of-scope edit is reported as a scope deviation even
 * when the diff is also unreadable, because that is the more specific finding
 * and the session already models it.
 */
export function triage(candidates: readonly Candidate[], offLimits: readonly string[]): Triage {
	const survivors: Candidate[] = [];
	const rejected: Rejected[] = [];
	const seen = new Map<string, string>();
	for (const candidate of candidates) {
		if (candidate.diff.trim().length === 0) {
			rejected.push({ arm: candidate.arm, reason: "empty", detail: "no change" });
			continue;
		}
		const deviations = scopeDeviations(candidate.modifiedPaths, offLimits);
		if (deviations.length > 0) {
			rejected.push({ arm: candidate.arm, reason: "scope", detail: deviations.join(", ") });
			continue;
		}
		const opaque = opaquePayload(candidate.diff);
		if (opaque !== null) {
			rejected.push({ arm: candidate.arm, reason: "opaque", detail: opaque });
			continue;
		}
		const twin = seen.get(candidate.diff);
		if (twin !== undefined) {
			rejected.push({ arm: candidate.arm, reason: "duplicate", detail: `identical to ${twin}` });
			continue;
		}
		seen.set(candidate.diff, candidate.arm);
		survivors.push(candidate);
	}
	return { survivors, rejected };
}

/**
 * Which topology reviews a segment, given how many arms survived triage.
 *
 * Two arms cannot form a ring: A reviewing B while B reviews A is the
 * reciprocal pair the ring exists to avoid, since it invites mutual approval
 * and mutual destruction. Below three survivors the director reviews instead.
 */
export function certifierFor(survivors: number): CertifierMode {
	if (survivors <= 0) return "void";
	if (survivors <= 2) return "director";
	return "ring";
}

/**
 * True when a segment reviewed through a weaker topology than its breadth was
 * configured for, which happens whenever arms dead-end. Worth reporting once:
 * a run that silently degrades has had less review than its settings claim.
 */
export function certificationDegraded(configuredArms: number, survivors: number): boolean {
	return certifierFor(survivors) !== certifierFor(configuredArms);
}

/**
 * Reviewer assignments for a segment. In a ring, arm *i* reviews arm *i+1*, so
 * every arm is reviewed exactly once by an author who did not write it and no
 * pair reviews each other. Under the director every arm is reviewed by the
 * director.
 */
export function certificationPairs(survivors: readonly Candidate[]): { reviewer: string; target: string }[] {
	const mode = certifierFor(survivors.length);
	if (mode === "void") return [];
	if (mode === "director") {
		return survivors.map(candidate => ({ reviewer: "director", target: candidate.arm }));
	}
	return survivors.map((candidate, index) => ({
		reviewer: candidate.arm,
		target: survivors[(index + 1) % survivors.length].arm,
	}));
}

/** Order candidates best-first for the session's metric direction. */
export function rank<T extends { metric: number }>(measured: readonly T[], direction: MetricDirection): T[] {
	const sorted = [...measured];
	sorted.sort((left, right) => (direction === "higher" ? right.metric - left.metric : left.metric - right.metric));
	return sorted;
}

/** True when `candidate` beats `baseline` in the session's direction. */
export function improves(candidate: number, baseline: number, direction: MetricDirection): boolean {
	return direction === "higher" ? candidate > baseline : candidate < baseline;
}

/**
 * The arm to keep: the best-ranked candidate that beats the baseline and was
 * not flagged. A flagged arm is skipped however good its number is, because a
 * metric obtained by gaming the benchmark is not a result.
 *
 * Null means a null round. That is an ordinary outcome, not a failure.
 */
export function selectWinner<T extends { arm: string; metric: number }>(
	measured: readonly T[],
	baseline: number,
	direction: MetricDirection,
	verdicts: ReadonlyMap<string, Verdict>,
): T | null {
	for (const candidate of rank(measured, direction)) {
		if (!improves(candidate.metric, baseline, direction)) continue;
		if (verdicts.get(candidate.arm)?.flagged === true) continue;
		return candidate;
	}
	return null;
}

/**
 * Extra cost a candidate moved outside the timed region, against the baseline's
 * own figure. A benchmark that reports no such metric returns 0 and is
 * unaffected.
 *
 * Timing only the measured call invites moving work out of it: compiling an
 * extension, downloading a table, or warming a cache at import improves the
 * metric while the work merely happens somewhere the clock does not look. A
 * benchmark that reports the cost a fresh checkout pays lets that show up as a
 * number instead of relying on a reviewer to notice.
 */
export function relocatedCost(
	candidateMetrics: Readonly<Record<string, number>>,
	baselineMetrics: Readonly<Record<string, number>>,
	metricName = "cold_ms",
): number {
	const candidate = candidateMetrics[metricName];
	const baseline = baselineMetrics[metricName];
	if (candidate === undefined || baseline === undefined) return 0;
	return candidate - baseline;
}

/** Cost relocation worth stating to a reviewer, in the harness's own unit. */
export const RELOCATION_THRESHOLD = 25;
