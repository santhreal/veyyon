/**
 * The small, shared pieces of GitHub view rendering and argument shaping. Two modules deep, and that
 * is the whole point: everything here is a pure function over strings and small records.
 *
 * WHY THESE LIVE TOGETHER AND WHY HERE. `tools/gh.ts` is the `github` tool, and `tools/gh-fetch.ts` is
 * the cache-aware issue/PR/diff fetcher that both the tool and the `issue://` and `pr://` protocol
 * handlers call. Both sides normalise the same text, name the same `--repo` flag and print the same
 * author and label lines, so these helpers had to end up in exactly one of three places: duplicated
 * (banned), in the tool (which would put the tool's 352-module graph on the protocol handlers' path), or
 * here. This module already owned `formatShortSha` for the same reason.
 *
 * `ToolError` is the one import, for `requireNonEmpty`: an empty `--repo` or issue identifier is a
 * caller mistake and has to surface as the same error class every other tool argument failure uses.
 * `tools/tool-errors.ts` is itself a leaf, so this module reaches two, and a single import here is paid
 * by every GitHub surface. Keep it that way.
 */

import { ToolError } from "./tool-errors";

/**
 * Return the first 12 hex characters of a commit SHA, or undefined when the
 * input is missing. Shared between GitHub tool argument normalization and the
 * run-watch renderer.
 */
export function formatShortSha(value: string | undefined): string | undefined {
	if (!value) {
		return undefined;
	}

	return value.slice(0, 12);
}

export interface GhUser {
	login?: string;
	name?: string | null;
}

export interface GhLabel {
	name?: string;
}

export function normalizeText(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trim();
}

export function normalizeBlock(value: string | null | undefined): string {
	return (value ?? "").replaceAll("\r\n", "\n").replaceAll("\r", "\n").replaceAll("\t", "    ").trimEnd();
}

export function normalizeOptionalString(value: string | null | undefined): string | undefined {
	const normalized = value?.trim();
	return normalized ? normalized : undefined;
}

export function requireNonEmpty(value: string | null | undefined, label: string): string {
	const normalized = normalizeOptionalString(value);
	if (!normalized) {
		throw new ToolError(`${label} must not be empty`);
	}
	return normalized;
}

export function appendRepoFlag(args: string[], repo: string | undefined, identifier?: string): void {
	if (!repo || looksLikeGitHubUrl(identifier)) {
		return;
	}

	args.push("--repo", repo);
}

export function formatAuthor(author: GhUser | null | undefined): string | undefined {
	if (!author) return undefined;
	if (author.login) return `@${author.login}`;
	if (author.name) return author.name;
	return undefined;
}

export function formatLabels(labels: GhLabel[] | undefined): string | undefined {
	const names = labels?.map(label => label.name).filter((value): value is string => Boolean(value)) ?? [];
	if (names.length === 0) return undefined;
	return names.join(", ");
}

export function pushLine(lines: string[], label: string, value: string | number | boolean | undefined): void {
	if (value === undefined || value === "") return;
	lines.push(`${label}: ${value}`);
}

/**
 * Parse a digit-only decimal positive integer or return undefined. Rejects
 * `1e2`, `0x10`, `12.0`, leading +/-, or any other shape `Number()` would
 * accept — those would otherwise key the cache against the wrong row.
 */
export function parsePositiveDecimalInt(value: string | undefined): number | undefined {
	if (!value || !/^\d+$/.test(value)) return undefined;
	const num = Number(value);
	if (!Number.isSafeInteger(num) || num <= 0) return undefined;
	return num;
}

export function looksLikeGitHubUrl(value: string | undefined): boolean {
	return value?.startsWith("https://github.com/") ?? false;
}
