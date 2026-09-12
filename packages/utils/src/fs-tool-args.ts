/**
 * What a `read` or `write` tool call and its result state, parsed once for every host that draws
 * the card.
 *
 * The terminal view, the HTML export and the collab client each read the same argument and detail
 * shapes; this module is the one owner of that reading. It sits here rather than beside the React
 * renderers because the terminal evaluates it at startup, and a host that draws no React must not
 * evaluate the package that does.
 */
import { splitReadSelector } from "./read-selector";
import { finiteNumber, getStringProperty, isRecord } from "./type-guards";

/**
 * Allocation-free line counter for text.
 * Returns 0 for empty or non-string text.
 */
export function countLines(text: string | null | undefined): number {
	if (!text) return 0;
	let count = 1;
	for (let i = text.indexOf("\n"); i !== -1; i = text.indexOf("\n", i + 1)) {
		count++;
	}
	return count;
}

// ============================================================================
// Read Tool Semantics
// ============================================================================

export interface ParsedReadArgs {
	readonly rawPath: string;
	readonly path: string;
	readonly sel: string | null;
	/** Directory listings only: recursion depth. `null` when the call did not pass one. */
	readonly depth: number | null;
	/** Directory listings only: the entry cap. `null` when the call did not pass one. Not a line count. */
	readonly limit: number | null;
}

/**
 * The `read` schema has one path argument, which carries any line selector inline, plus `depth`
 * and `limit` for directory listings. Neither number is a line window, so no `:A-B` suffix is
 * derived from them: a card that printed `.:1-3` for `{ path: ".", limit: 3 }` described a range the
 * tool never read.
 */
export function parseReadArgs(args: unknown): ParsedReadArgs {
	if (!isRecord(args)) {
		return { rawPath: "", path: "", sel: null, depth: null, limit: null };
	}
	const rawPath = getStringProperty(args, "path") ?? getStringProperty(args, "file_path") ?? "";
	const split = splitReadSelector(rawPath);
	const sel = getStringProperty(args, "sel") ?? split.sel ?? null;
	return {
		rawPath,
		path: split.path || rawPath,
		sel,
		depth: finiteNumber(args.depth),
		limit: finiteNumber(args.limit),
	};
}

export interface ParsedReadDetails {
	readonly resolvedPath: string | null;
	readonly suffixTo: string | null;
	readonly suffixFrom: string | null;
	readonly elidedSpans: number | null;
	readonly conflictCount: number | null;
	readonly truncated: boolean;
	readonly totalLines: number | null;
}

export function parseReadDetails(details: unknown): ParsedReadDetails {
	if (!isRecord(details)) {
		return {
			resolvedPath: null,
			suffixTo: null,
			suffixFrom: null,
			elidedSpans: null,
			conflictCount: null,
			truncated: false,
			totalLines: null,
		};
	}
	const suffix = isRecord(details.suffixResolution) ? details.suffixResolution : null;
	const summary = isRecord(details.summary) ? details.summary : null;
	const trunc = isRecord(details.truncation) ? details.truncation : null;

	return {
		resolvedPath: getStringProperty(details, "resolvedPath") ?? null,
		suffixTo: suffix ? (getStringProperty(suffix, "to") ?? null) : null,
		suffixFrom: suffix ? (getStringProperty(suffix, "from") ?? null) : null,
		elidedSpans: summary ? finiteNumber(summary.elidedSpans) : null,
		conflictCount: finiteNumber(details.conflictCount),
		truncated: trunc !== null,
		totalLines: trunc ? finiteNumber(trunc.totalLines) : null,
	};
}

// ============================================================================
// Write Tool Semantics
// ============================================================================

export interface ParsedWriteArgs {
	readonly path: string | null;
	readonly content: string | null;
	readonly isValidContent: boolean;
}

export function parseWriteArgs(args: unknown): ParsedWriteArgs {
	if (!isRecord(args)) {
		return { path: null, content: null, isValidContent: false };
	}
	const path = getStringProperty(args, "path") ?? getStringProperty(args, "file_path") ?? null;
	const content = getStringProperty(args, "content") ?? null;
	return {
		path,
		content,
		isValidContent: content !== null,
	};
}

export interface WriteDiagnosticsSummary {
	readonly server: string | null;
	readonly messages: readonly string[];
	readonly summary: string | null;
	readonly errored: boolean;
}

export interface ParsedWriteDetails {
	readonly madeExecutable: boolean;
	readonly diagnostics: WriteDiagnosticsSummary | null;
}

export function parseWriteDetails(details: unknown): ParsedWriteDetails {
	if (!isRecord(details)) {
		return { madeExecutable: false, diagnostics: null };
	}
	const madeExecutable = details.madeExecutable === true;
	let diagnostics: WriteDiagnosticsSummary | null = null;

	if (isRecord(details.diagnostics)) {
		const d = details.diagnostics;
		const messages: string[] = [];
		if (Array.isArray(d.messages)) {
			for (const m of d.messages) {
				if (typeof m === "string") messages.push(m);
			}
		}
		const summary = getStringProperty(d, "summary") ?? null;
		if (messages.length > 0 || summary !== null) {
			diagnostics = {
				server: getStringProperty(d, "server") ?? null,
				messages,
				summary,
				errored: d.errored === true,
			};
		}
	}

	return {
		madeExecutable,
		diagnostics,
	};
}
