/**
 * Parity, provenance and the rule for when a speed claim may be printed.
 */

import { spawn } from "node:child_process";

export const PARITY_SCOPE = "path, line number and line text (the addon exposes no column)";

export interface RgRun {
	readonly argv: readonly string[];
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number;
	readonly ms: number;
}

export interface ContentRow {
	readonly path: string;
	readonly lineNumber: number;
	readonly line: string;
}

export interface CountRow {
	readonly path: string;
	readonly count: number;
}

export function ripgrepBinary(): string {
	return process.env.GREP_BENCH_RG || "rg";
}

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

export function parseRgContent(stdout: string): ContentRow[] {
	const rows: ContentRow[] = [];
	for (const line of stdout.split("\n")) {
		if (!line.startsWith("{")) continue;
		try {
			const record = JSON.parse(line) as {
				type?: string;
				data?: { path?: { text?: string }; line_number?: number; lines?: { text?: string } };
			};
			if (record.type !== "match" || !record.data?.path?.text || typeof record.data.line_number !== "number")
				continue;
			rows.push({
				path: stripLeadingDot(record.data.path.text),
				lineNumber: record.data.line_number,
				line: (record.data.lines?.text ?? "").replace(/\r?\n$/, ""),
			});
		} catch {}
	}
	return rows;
}

export function parseRgFiles(stdout: string): string[] {
	return stdout
		.split("\n")
		.filter(line => line.trim().length > 0)
		.map(stripLeadingDot);
}

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

function differences(label: string, native: readonly string[], rg: readonly string[], limit = 5): string[] {
	const nativeSet = new Set(native);
	const rgSet = new Set(rg);
	const onlyNative = native.filter(key => !rgSet.has(key));
	const onlyRg = rg.filter(key => !nativeSet.has(key));
	const report: string[] = [];
	if (native.length !== rg.length) {
		report.push(`${label}: addon has ${native.length} rows, rg has ${rg.length}`);
	}
	for (const key of onlyNative.slice(0, limit)) {
		report.push(`${label}: only the addon has ${key.replaceAll("\u0000", " | ")}`);
	}
	for (const key of onlyRg.slice(0, limit)) {
		report.push(`${label}: only rg has ${key.replaceAll("\u0000", " | ")}`);
	}
	return report;
}

export function compareContent(label: string, native: readonly ContentRow[], rg: readonly ContentRow[]): string[] {
	return differences(
		label,
		native.map(r => `${r.path}\u0000${r.lineNumber}\u0000${r.line}`),
		rg.map(r => `${r.path}\u0000${r.lineNumber}\u0000${r.line}`),
	);
}

export function compareFiles(label: string, native: readonly string[], rg: readonly string[]): string[] {
	return differences(label, native, rg);
}

export function compareCounts(label: string, native: readonly CountRow[], rg: readonly CountRow[]): string[] {
	return differences(
		label,
		native.map(r => `${r.path}\u0000${r.count}`),
		rg.map(r => `${r.path}\u0000${r.count}`),
	);
}

export interface Readings {
	readonly p50: number;
	readonly p95: number;
	readonly mean: number;
	readonly min: number;
	readonly max: number;
	readonly samples: number;
}

export function readings(samplesMs: readonly number[]): Readings {
	const sorted = [...samplesMs].sort((a, b) => a - b);
	const at = (q: number) => sorted[Math.min(sorted.length - 1, Math.floor(q * sorted.length))] ?? 0;
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

export interface Stability {
	readonly firstHalf: number;
	readonly secondHalf: number;
	readonly drift: number;
	readonly tolerance: number;
	readonly stable: boolean;
}

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

export interface ClaimInput {
	readonly nativeMs: number;
	readonly rgMs: number;
	readonly parityDifferences: readonly string[];
	readonly missingProvenance: readonly string[];
	readonly stability: Stability;
}

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
