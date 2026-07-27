import { nonEmptyTrimmed, trimTrailingSlashes } from "@veyyon/utils";
import * as git from "../utils/git";
import type { ASIData, ASIValue, MetricDirection, NumericMetricMap } from "./types";

export const METRIC_LINE_PREFIX = "METRIC";
export const ASI_LINE_PREFIX = "ASI";
export const EXPERIMENT_MAX_LINES = 10;
export const EXPERIMENT_MAX_BYTES = 4 * 1024;

const DENIED_KEY_NAMES = new Set(["__proto__", "constructor", "prototype"]);

export function parseMetricLines(output: string): Map<string, number> {
	const metrics = new Map<string, number>();
	const regex = new RegExp(`^${METRIC_LINE_PREFIX}\\s+([\\w.µ-]+)=(\\S+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const name = match[1];
		if (!DENIED_KEY_NAMES.has(name)) {
			const value = Number(match[2]);
			if (Number.isFinite(value)) {
				metrics.set(name, value);
			}
		}
		match = regex.exec(output);
	}
	return metrics;
}

export function parseAsiLines(output: string): ASIData | null {
	const asi: ASIData = {};
	const regex = new RegExp(`^${ASI_LINE_PREFIX}\\s+([\\w.-]+)=(.+)\\s*$`, "gm");
	let match = regex.exec(output);
	while (match !== null) {
		const key = match[1];
		if (!DENIED_KEY_NAMES.has(key)) {
			asi[key] = parseAsiValue(match[2]);
		}
		match = regex.exec(output);
	}
	return Object.keys(asi).length > 0 ? asi : null;
}

function parseAsiValue(raw: string): ASIValue {
	const value = raw.trim();
	if (value === "true") return true;
	if (value === "false") return false;
	if (value === "null") return null;
	if (/^-?\d+(?:\.\d+)?$/.test(value)) {
		const numberValue = Number(value);
		if (Number.isFinite(numberValue)) return numberValue;
	}
	if (value.startsWith("{") || value.startsWith("[") || value.startsWith('"')) {
		try {
			const parsed = JSON.parse(value) as ASIValue;
			return parsed;
		} catch {
			return value;
		}
	}
	return value;
}

export function mergeAsi(base: ASIData | null, override: ASIData | undefined): ASIData | undefined {
	if (!base && !override) return undefined;
	return {
		...(base ?? {}),
		...(override ?? {}),
	};
}

export function commas(value: number): string {
	const sign = value < 0 ? "-" : "";
	const digits = String(Math.trunc(Math.abs(value)));
	const groups: string[] = [];
	for (let index = digits.length; index > 0; index -= 3) {
		groups.unshift(digits.slice(Math.max(0, index - 3), index));
	}
	return sign + groups.join(",");
}

export function fmtNum(value: number, decimals: number = 0): string {
	if (decimals <= 0) return commas(Math.round(value));
	// Round ONCE at the target precision so a fraction that carries (1.999 -> 2.00,
	// 99.999 -> 100.00) increments the whole part instead of being dropped. Flooring
	// the whole and rounding the fraction independently loses that carry.
	const rounded = Math.abs(value).toFixed(decimals);
	const dotIndex = rounded.indexOf(".");
	const whole = rounded.slice(0, dotIndex);
	const fraction = rounded.slice(dotIndex);
	return `${value < 0 ? "-" : ""}${commas(Number(whole))}${fraction}`;
}

export function formatNum(value: number | null, unit: string): string {
	if (value === null) return "-";
	if (Number.isInteger(value)) return `${fmtNum(value)}${unit}`;
	return `${fmtNum(value, 2)}${unit}`;
}

/**
 * Percent change against a baseline, signed: `+12.3%`, `-4.0%`. `undefined` when there is
 * nothing to compare against.
 *
 * The owner of that format, and of the three conditions under which a delta must NOT be
 * shown: no baseline, a zero baseline (the division has no meaning), and a value equal to
 * the baseline (`+0.0%` next to an unchanged number is noise). The computation and all
 * three guards were written out five times across the dashboard and the log-experiment
 * tool, which is how the run overlay and the tool's own report came to be two places to
 * change one format.
 *
 * Positive deltas carry an explicit `+` because the reader is comparing runs, and a bare
 * `12.3%` beside a metric reads as the metric's own percentage. Negative values already
 * carry their sign.
 */
export function formatPercentChange(value: number, baseline: number | null | undefined): string | undefined {
	if (baseline === null || baseline === undefined || baseline === 0 || value === baseline) return undefined;
	const delta = ((value - baseline) / baseline) * 100;
	return `${delta > 0 ? "+" : ""}${delta.toFixed(1)}%`;
}

export function formatElapsed(milliseconds: number): string {
	const totalSeconds = Math.floor(milliseconds / 1000);
	const minutes = Math.floor(totalSeconds / 60);
	const seconds = totalSeconds % 60;
	if (minutes > 0) {
		return `${minutes}m ${String(seconds).padStart(2, "0")}s`;
	}
	return `${seconds}s`;
}

export function killTree(pid: number, signal: NodeJS.Signals | number = "SIGTERM"): void {
	try {
		process.kill(-pid, signal);
	} catch {
		try {
			process.kill(pid, signal);
		} catch {
			// Process already exited.
		}
	}
}

export function isBetter(current: number, best: number, direction: MetricDirection): boolean {
	return direction === "lower" ? current < best : current > best;
}

export function inferMetricUnitFromName(name: string): string {
	if (name.endsWith("µs") || name.endsWith("_µs")) return "µs";
	if (name.endsWith("ms") || name.endsWith("_ms")) return "ms";
	if (name.endsWith("_s") || name.endsWith("_sec") || name.endsWith("_secs")) return "s";
	if (name.endsWith("_kb") || name.endsWith("kb")) return "kb";
	if (name.endsWith("_mb") || name.endsWith("mb")) return "mb";
	return "";
}

export function normalizePathSpec(value: string): string {
	const trimmed = value.trim().replaceAll("\\", "/");
	if (trimmed === "" || trimmed === "." || trimmed === "./") return ".";
	const collapsed = trimTrailingSlashes(trimmed.replace(/^\.\/+/, ""));
	return collapsed.length === 0 ? "." : collapsed;
}

export function pathMatchesSpec(pathValue: string, specValue: string): boolean {
	const normalizedPath = normalizePathSpec(pathValue);
	const normalizedSpec = normalizePathSpec(specValue);
	if (normalizedSpec === ".") return true;
	return normalizedPath === normalizedSpec || normalizedPath.startsWith(`${normalizedSpec}/`);
}

/**
 * The distinct non-blank values, trimmed, in first-seen order.
 *
 * Uniqueness is the only thing added here; what counts as blank comes from
 * `nonEmptyTrimmed`, so this cannot drift from the rest of the codebase on whether a
 * whitespace-only entry is a value.
 */
export function dedupeStrings(values: readonly string[]): string[] {
	return [...new Set(nonEmptyTrimmed(values))];
}

export function ensureNumericMetricMap(value: NumericMetricMap | undefined): NumericMetricMap {
	if (!value) return {};
	const out: NumericMetricMap = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		if (typeof entryValue === "number" && Number.isFinite(entryValue)) {
			out[key] = entryValue;
		}
	}
	return out;
}

export function sanitizeAsi(value: { [key: string]: unknown } | undefined): ASIData | undefined {
	if (!value) return undefined;
	const result: ASIData = {};
	for (const [key, entryValue] of Object.entries(value)) {
		if (DENIED_KEY_NAMES.has(key)) continue;
		const sanitized = sanitizeAsiValue(entryValue);
		if (sanitized !== undefined) {
			result[key] = sanitized;
		}
	}
	return Object.keys(result).length > 0 ? result : undefined;
}

function sanitizeAsiValue(value: unknown): ASIValue | undefined {
	if (value === null) return null;
	if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
	if (Array.isArray(value)) {
		const items = value
			.map(item => sanitizeAsiValue(item))
			.filter((item): item is NonNullable<typeof item> => item !== undefined);
		return items;
	}
	if (typeof value === "object") {
		const objectValue = value as { [key: string]: unknown };
		const result: ASIData = {};
		for (const [key, entryValue] of Object.entries(objectValue)) {
			if (DENIED_KEY_NAMES.has(key)) continue;
			const sanitized = sanitizeAsiValue(entryValue);
			if (sanitized !== undefined) {
				result[key] = sanitized;
			}
		}
		return result;
	}
	return undefined;
}

/**
 * The porcelain status autoresearch reads dirty paths out of.
 *
 * FAILURES PROPAGATE, and that is the whole point of this function existing separately. It used to answer
 * any git failure with `""`, which parses to "no paths are dirty" -- and every caller acts on that: the
 * revert reported "nothing to revert" while the experiment's changes sat in the tree, the scope-deviation
 * check passed vacuously because it had no modified paths to compare against `off_limits`, and the run
 * recorded an empty modified-path list as the experiment's result. Three false statements from one
 * swallow. Callers each have an error channel and now use it.
 *
 * A cwd that is NOT inside a repository is the one case answered here rather than raised: `""` is then
 * the true answer, since there are no tracked changes to report, and autoresearch is allowed to run
 * outside a repository. That case is decided by resolving the repository, a walk up the directory chain
 * with no subprocess, so it is never confused with a `git status` that failed for another reason.
 */
export async function gitStatusPorcelain(cwd: string): Promise<string> {
	if (!(await git.repo.resolve(cwd))) return "";
	return git.status(cwd, { porcelainV1: true, untrackedFiles: "all", z: true });
}

/**
 * The prefix from the repository root to `cwd`, used to make status paths relative to the work directory.
 *
 * Failures propagate for the same reason as {@link gitStatusPorcelain}: an empty prefix is a real value
 * (cwd IS the repository root), so a failed lookup that returned `""` silently claimed the work directory
 * was the root and every path was then resolved against the wrong directory. As above, a cwd outside a
 * repository is answered with `""` rather than raised, because there is no prefix for it to have.
 */
export async function gitWorkDirPrefix(cwd: string): Promise<string> {
	if (!(await git.repo.resolve(cwd))) return "";
	return git.show.prefix(cwd);
}
