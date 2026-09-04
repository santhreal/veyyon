/**
 * Parity, provenance and the rule for when a speed claim may be printed.
 *
 * The benchmark used to compare a total match count, print `Nx faster` no matter what
 * that comparison said, and run `rg` with its stderr discarded and its exit code
 * unread. An `rg` that failed to start therefore looked like a very fast search of
 * zero files. Everything here exists to make that impossible: `rg` must exit 0, the
 * two engines must agree row for row, the run must record what it ran on, and the
 * samples must be stable across the run. A claim missing any of those is refused in
 * text rather than printed with a caveat.
 *
 * One documented limit: the addon's `GrepMatch` exposes no column, so parity covers
 * path, line number and line text. Column drift is invisible to this comparison and
 * `PARITY_SCOPE` says so wherever the run reports parity.
 */

import { spawn } from "node:child_process";

/** What the row-for-row comparison does and does not cover. */
export const PARITY_SCOPE = "path, line number and line text (the addon exposes no column)";

/** A finished `rg` invocation, including the parts the old bench threw away. */
export interface RgRun {
	readonly argv: readonly string[];
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly ms: number;
}

/** One content match, from either engine, in the form the comparison uses. */
export interface ContentRow {
	readonly path: string;
	readonly lineNumber: number;
	readonly line: string;
}

/** One per-file count, from either engine. */
export interface CountRow {
	readonly path: string;
	readonly count: number;
}

/**
 * The `rg` to run. `GREP_BENCH_RG` names one that is installed somewhere other than
 * `PATH`, which is also how a test points the runner at a binary that is not there.
 */
export function ripgrepBinary(): string {
	return process.env.GREP_BENCH_RG || "rg";
}

/** Run `rg`, keeping its stderr and its exit code. */
export function runRipgrep(args: readonly string[], cwd: string, binary = ripgrepBinary()): Promise<RgRun> {
	const started = process.hrtime.bigint();
	const child = spawn(binary, [...args], { cwd, stdio: ["ignore", "pipe", "pipe"] });
	const out: Buffer[] = [];
	const err: Buffer[] = [];
	child.stdout.on("data", chunk => out.push(chunk));
	child.stderr.on("data", chunk => err.push(chunk));
	const { promise, resolve } = Promise.withResolvers<RgRun>();
	const finish = (exitCode: number) => {
		resolve({
			argv: [binary, ...args],
			stdout: Buffer.concat(out).toString("utf8"),
			stderr: Buffer.concat(err).toString("utf8"),
			exitCode,
			ms: Number(process.hrtime.bigint() - started) / 1e6,
		});
	};
	child.on("error", error => {
		err.push(Buffer.from(`${error.message}\n`));
		finish(-1);
	});
	child.on("close", code => finish(code ?? -1));
	return promise;
}

/**
 * Why an `rg` run cannot be compared, or null when it can.
 *
 * Exit 1 means `rg` found nothing. Against this corpus that is drift, not an empty
 * result: every arm searches files that are known to match. Exit -1 means `rg` never
 * ran at all, which is the case the old bench timed and published as a fast search.
 */
export function rgFailure(run: RgRun): string | null {
	if (run.exitCode === 0) return null;
	const reason =
		run.exitCode === -1
			? "rg could not be started"
			: run.exitCode === 1
				? "rg found no matches, which this corpus rules out"
				: `rg exited ${run.exitCode}`;
	const stderr = run.stderr.trim();
	return stderr ? `${reason}: ${stderr}` : reason;
}

function stripLeadingDot(value: string): string {
	return value.startsWith("./") ? value.slice(2) : value;
}

/** Parse `rg --json` output into content rows. */
export function parseRgContent(stdout: string): ContentRow[] {
	const rows: ContentRow[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		const event: unknown = JSON.parse(line);
		if (!event || typeof event !== "object") continue;
		const record = event as { type?: string; data?: Record<string, unknown> };
		if (record.type !== "match" || !record.data) continue;
		const pathField = record.data.path as { text?: string } | undefined;
		const linesField = record.data.lines as { text?: string } | undefined;
		const lineNumber = record.data.line_number;
		if (!pathField?.text || typeof lineNumber !== "number") continue;
		rows.push({
			path: stripLeadingDot(pathField.text),
			lineNumber,
			line: (linesField?.text ?? "").replace(/\r?\n$/, ""),
		});
	}
	return rows;
}

/** Parse `rg --files-with-matches` output into a path list. */
export function parseRgFiles(stdout: string): string[] {
	return stdout
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(stripLeadingDot);
}

/** Parse `rg --count` output into per-file counts. */
export function parseRgCounts(stdout: string): CountRow[] {
	const rows: CountRow[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.trim()) continue;
		const cut = line.lastIndexOf(":");
		if (cut < 0) continue;
		const count = Number(line.slice(cut + 1));
		if (!Number.isFinite(count)) continue;
		rows.push({ path: stripLeadingDot(line.slice(0, cut)), count });
	}
	return rows;
}

function contentKey(row: ContentRow): string {
	return `${row.path}\u0000${row.lineNumber}\u0000${row.line}`;
}

function countKey(row: CountRow): string {
	return `${row.path}\u0000${row.count}`;
}

function differences(label: string, native: readonly string[], rg: readonly string[], limit = 5): string[] {
	const nativeSet = new Set(native);
	const rgSet = new Set(rg);
	const onlyNative = native.filter(key => !rgSet.has(key));
	const onlyRg = rg.filter(key => !nativeSet.has(key));
	const report: string[] = [];
	if (native.length !== rg.length) {
		report.push(`${label}: addon has ${native.length} rows, rg has ${rg.length}`);
	}
	for (const key of onlyNative.slice(0, limit))
		report.push(`${label}: only the addon has ${key.replaceAll("\u0000", " | ")}`);
	for (const key of onlyRg.slice(0, limit)) report.push(`${label}: only rg has ${key.replaceAll("\u0000", " | ")}`);
	return report;
}

/** Row-for-row comparison of content matches. Empty result means the arms agree. */
export function compareContent(label: string, native: readonly ContentRow[], rg: readonly ContentRow[]): string[] {
	return differences(label, native.map(contentKey), rg.map(contentKey));
}

/** Comparison of the matched-file sets. */
export function compareFiles(label: string, native: readonly string[], rg: readonly string[]): string[] {
	return differences(label, native, rg);
}

/** Comparison of per-file counts. */
export function compareCounts(label: string, native: readonly CountRow[], rg: readonly CountRow[]): string[] {
	return differences(label, native.map(countKey), rg.map(countKey));
}

/** The readings a sample set is judged on. Local, because this package has no workspace deps. */
export interface Readings {
	readonly p50: number;
	readonly p95: number;
	readonly mean: number;
	readonly min: number;
	readonly max: number;
	readonly samples: number;
}

/** Median-first statistics. A mean alone hid the variance the old bench published. */
export function readings(samplesMs: readonly number[]): Readings {
	const sorted = [...samplesMs].sort((a, b) => a - b);
	const at = (quantile: number) => sorted[Math.min(sorted.length - 1, Math.floor(quantile * sorted.length))] ?? 0;
	const total = sorted.reduce((sum, sample) => sum + sample, 0);
	return {
		p50: at(0.5),
		p95: at(0.95),
		mean: total / Math.max(1, sorted.length),
		min: sorted[0] ?? 0,
		max: sorted[sorted.length - 1] ?? 0,
		samples: sorted.length,
	};
}

/** Whether the first and second half of a run agree, which is what makes a ratio reproducible. */
export interface Stability {
	readonly firstHalf: number;
	readonly secondHalf: number;
	/** Relative gap between the halves, against the smaller median. */
	readonly drift: number;
	readonly tolerance: number;
	readonly stable: boolean;
}

/**
 * Split the samples in half and compare medians. A run whose own halves disagree
 * by more than `tolerance` cannot produce a ratio another run would reproduce.
 */
export function stability(samplesMs: readonly number[], tolerance = 0.05): Stability {
	const half = Math.floor(samplesMs.length / 2);
	const first = readings(samplesMs.slice(0, half)).p50;
	const second = readings(samplesMs.slice(half)).p50;
	const smaller = Math.min(first, second);
	const drift = smaller > 0 ? Math.abs(first - second) / smaller : Number.POSITIVE_INFINITY;
	return {
		firstHalf: first,
		secondHalf: second,
		drift,
		tolerance,
		stable: samplesMs.length >= 4 && drift <= tolerance,
	};
}

/** What the run recorded about the machine, the binaries and the corpus. */
export interface Provenance {
	readonly rgVersion: string;
	readonly addonVersion: string;
	readonly bunVersion: string;
	readonly cpu: string;
	readonly platform: string;
	readonly corpusVersion: number;
	readonly corpusSeed: number;
	readonly corpusFiles: number;
	readonly corpusBytes: number;
	readonly pageCacheState: string;
}

/** Provenance fields that are missing or empty. A claim needs all of them. */
export function missingProvenance(provenance: Provenance): string[] {
	const missing: string[] = [];
	const strings: Array<[string, string]> = [
		["rgVersion", provenance.rgVersion],
		["addonVersion", provenance.addonVersion],
		["bunVersion", provenance.bunVersion],
		["cpu", provenance.cpu],
		["platform", provenance.platform],
		["pageCacheState", provenance.pageCacheState],
	];
	for (const [name, value] of strings) if (!value.trim()) missing.push(name);
	const numbers: Array<[string, number]> = [
		["corpusVersion", provenance.corpusVersion],
		["corpusFiles", provenance.corpusFiles],
		["corpusBytes", provenance.corpusBytes],
	];
	for (const [name, value] of numbers) if (!Number.isFinite(value) || value <= 0) missing.push(name);
	if (!Number.isFinite(provenance.corpusSeed)) missing.push("corpusSeed");
	return missing;
}

/** Everything the ratio sentence is allowed to depend on. */
export interface ClaimInput {
	readonly nativeMs: number;
	readonly rgMs: number;
	readonly parityDifferences: readonly string[];
	readonly missingProvenance: readonly string[];
	readonly stability: Stability;
}

/**
 * The one place a speed claim is worded.
 *
 * A ratio is printed only when the arms agreed row for row, the run recorded its
 * provenance, and the run's own halves agreed. Otherwise the sentence says which of
 * those failed and contains no comparison, because a comparison nobody can reproduce
 * is the defect this file exists to remove.
 */
export function speedClaim(input: ClaimInput): string {
	if (input.parityDifferences.length > 0) {
		return `no speed claim: the arms disagree (${input.parityDifferences.length} difference(s))`;
	}
	if (input.missingProvenance.length > 0) {
		return `no speed claim: provenance incomplete (${input.missingProvenance.join(", ")})`;
	}
	if (!input.stability.stable) {
		const drift = (input.stability.drift * 100).toFixed(1);
		return `no speed claim: the run's halves drifted ${drift}% (tolerance ${(input.stability.tolerance * 100).toFixed(0)}%)`;
	}
	if (!(input.nativeMs > 0) || !(input.rgMs > 0)) {
		return "no speed claim: a measured median was zero";
	}
	const ratio = input.rgMs / input.nativeMs;
	return ratio >= 1
		? `addon grep is ${ratio.toFixed(2)}x faster than rg (median, parity on ${PARITY_SCOPE})`
		: `addon grep is ${(1 / ratio).toFixed(2)}x slower than rg (median, parity on ${PARITY_SCOPE})`;
}
