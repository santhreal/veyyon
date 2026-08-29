import * as path from "node:path";
import { hasUrlScheme } from "@veyyon/utils";
import { InternalUrlRouter } from "../../internal-urls";
import { parseLineRanges, selectorLineRanges, splitPathAndSel } from "../../tools/path-utils";
import type { ReadRenderArgs } from "../../tools/read";
import { PREVIEW_LIMITS } from "../../tools/render-utils";
import { tryResolveInternalUrlSync } from "../../tui";

export function readArgsTarget(args: unknown): string | undefined {
	if (!args || typeof args !== "object" || Array.isArray(args)) return undefined;
	const record = args as Record<string, unknown>;
	return typeof record.path === "string"
		? record.path
		: typeof record.file_path === "string"
			? record.file_path
			: undefined;
}

export function readArgsHaveTarget(args: unknown): args is ReadRenderArgs {
	return readArgsTarget(args) !== undefined;
}

export function readArgsTargetInternalUrl(args: unknown): boolean {
	const target = readArgsTarget(args);
	if (!target) return false;
	return InternalUrlRouter.instance().canHandle(target);
}

export type ReadToolSuffixResolution = {
	from: string;
	to: string;
};

export type ReadToolResultDetails = {
	resolvedPath?: string;
	suffixResolution?: {
		from?: string;
		to?: string;
	};
	conflictCount?: number;
	displayReadTargets?: unknown;
	displayContent?: {
		text?: string;
		startLine?: number;
		lineNumbers?: Array<number | null>;
	};
	meta?: {
		source?: {
			type?: string;
			value?: string;
		};
	};
};

export type ReadToolGroupOptions = {
	showContentPreview?: boolean;
};

export function getSuffixResolution(details: ReadToolResultDetails | undefined): ReadToolSuffixResolution | undefined {
	if (typeof details?.suffixResolution?.from !== "string" || typeof details.suffixResolution.to !== "string") {
		return undefined;
	}
	return { from: details.suffixResolution.from, to: details.suffixResolution.to };
}

export type ReadEntry = {
	toolCallId: string;
	path: string;
	displayPaths?: string[];
	linkPath?: string;
	status: "pending" | "success" | "warning" | "notExecuted" | "error";
	correctedFrom?: string;
	contentText?: string;
	conflictCount?: number;
	codeStartLine?: number;
	codeLineNumbers?: Array<number | null>;
};

export const COLLAPSED_PREVIEW_LINES = PREVIEW_LIMITS.OUTPUT_COLLAPSED;

export type ReadDisplayTarget = {
	entry: ReadEntry;
	targetPath: string;
	basePath: string;
	linkPath?: string;
	selector?: string;
};

export type ReadSummaryRow = {
	targetPath: string;
	basePath: string;
	targets: ReadDisplayTarget[];
};

export const READ_STATUS_RANK: Record<ReadEntry["status"], number> = {
	success: 0,
	pending: 1,
	notExecuted: 2,
	warning: 3,
	error: 4,
};

export function getDisplayReadTargets(details: ReadToolResultDetails | undefined): string[] | undefined {
	if (!Array.isArray(details?.displayReadTargets)) return undefined;
	const targets: string[] = [];
	for (let i = 0; i < details.displayReadTargets.length; i++) {
		const target = details.displayReadTargets[i];
		if (typeof target === "string") {
			const trimmed = target.trim();
			if (trimmed.length > 0) targets.push(trimmed);
		}
	}
	return targets.length > 0 ? targets : undefined;
}

export function displayPathWithSuffixResolution(
	currentPath: string,
	suffixResolution: ReadToolSuffixResolution,
): string {
	const currentSelector = splitPathAndSel(currentPath).sel;
	if (!currentSelector || splitPathAndSel(suffixResolution.to).sel) return suffixResolution.to;
	return `${suffixResolution.to}:${currentSelector}`;
}

export function readSourceFsPath(details: ReadToolResultDetails | undefined): string | undefined {
	const source = details?.meta?.source;
	return source?.type === "path" && typeof source.value === "string" ? source.value : undefined;
}

export function readResultLinkPath(details: ReadToolResultDetails | undefined): string | undefined {
	return typeof details?.resolvedPath === "string" ? details.resolvedPath : readSourceFsPath(details);
}

export function readTargetLinkPath(basePath: string, entryLinkPath: string | undefined): string | undefined {
	if (entryLinkPath) return entryLinkPath;
	const resolvedInternalPath = tryResolveInternalUrlSync(basePath);
	if (resolvedInternalPath) return resolvedInternalPath;
	return path.isAbsolute(basePath) ? basePath : undefined;
}

export function firstSelectorLine(selector: string | undefined): number | undefined {
	try {
		return selectorLineRanges(selector)?.[0].startLine;
	} catch {
		return undefined;
	}
}

export function firstSelectorLineForTargets(targets: ReadDisplayTarget[]): number | undefined {
	let line: number | undefined;
	for (let ti = 0; ti < targets.length; ti++) {
		const targetLine = firstSelectorLine(targets[ti]!.selector);
		if (targetLine === undefined) continue;
		if (line === undefined || targetLine < line) line = targetLine;
	}
	return line;
}

export function linkPathForTargets(targets: ReadDisplayTarget[]): string | undefined {
	for (let ti = 0; ti < targets.length; ti++) {
		if (targets[ti]!.linkPath) return targets[ti]!.linkPath;
	}
	return undefined;
}

function selectorChunkIsLineRangeList(chunk: string): boolean {
	const trimmed = chunk.trim();
	if (!trimmed) return false;
	try {
		return parseLineRanges(trimmed) !== null;
	} catch {
		return false;
	}
}

function nextTopLevelToken(input: string, start: number): string {
	let braceDepth = 0;
	for (let i = start; i < input.length; i++) {
		const ch = input[i];
		if (ch === "\\" && i + 1 < input.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth === 0 && (ch === "," || ch === ";")) {
			return input.slice(start, i);
		}
	}
	return input.slice(start);
}

function commaContinuesLineRangeSelector(input: string, partStart: number, commaIndex: number): boolean {
	const currentPart = input.slice(partStart, commaIndex).trim();
	if (!splitPathAndSel(currentPart).sel) return false;
	return selectorChunkIsLineRangeList(nextTopLevelToken(input, commaIndex + 1));
}

export function splitReadDisplayPathSpecs(rawPath: string): string[] {
	const normalized = rawPath.trim();
	if (!normalized || hasUrlScheme(normalized)) return [rawPath];

	const parts: string[] = [];
	let braceDepth = 0;
	let partStart = 0;
	for (let i = 0; i < normalized.length; i++) {
		const ch = normalized[i];
		if (ch === "\\" && i + 1 < normalized.length) {
			i++;
			continue;
		}
		if (ch === "{") {
			braceDepth++;
			continue;
		}
		if (ch === "}") {
			if (braceDepth > 0) braceDepth--;
			continue;
		}
		if (braceDepth !== 0 || (ch !== "," && ch !== ";")) continue;
		if (ch === "," && commaContinuesLineRangeSelector(normalized, partStart, i)) continue;
		parts.push(normalized.slice(partStart, i).trim());
		partStart = i + 1;
	}
	parts.push(normalized.slice(partStart).trim());

	const cleanParts: string[] = [];
	for (let pi = 0; pi < parts.length; pi++) {
		if (parts[pi]!.length > 0) cleanParts.push(parts[pi]!);
	}
	if (cleanParts.length <= 1) return [rawPath];
	for (let pi = 0; pi < cleanParts.length; pi++) {
		if (splitPathAndSel(cleanParts[pi]!).sel === undefined) return [rawPath];
	}
	return cleanParts;
}

export function splitSelectorDisplayParts(sel: string | undefined): Array<string | undefined> {
	if (!sel) return [undefined];
	const chunks = sel.split(":");
	if (chunks.length === 1) {
		if (!selectorChunkIsLineRangeList(sel) || !sel.includes(",")) return [sel];
		const rawChunks = sel.split(",");
		const out: string[] = [];
		for (let ci = 0; ci < rawChunks.length; ci++) {
			const trimmed = rawChunks[ci]!.trim();
			if (trimmed.length > 0) out.push(trimmed);
		}
		return out;
	}
	if (chunks.length === 2) {
		const [left, right] = chunks as [string, string];
		const leftIsRange = selectorChunkIsLineRangeList(left);
		const rightIsRange = selectorChunkIsLineRangeList(right);
		if (leftIsRange && left.includes(",")) {
			const rawLeft = left.split(",");
			const leftOut: string[] = [];
			for (let ci = 0; ci < rawLeft.length; ci++) {
				const trimmed = rawLeft[ci]!.trim();
				if (trimmed.length > 0) leftOut.push(`${trimmed}:${right}`);
			}
			return leftOut;
		}
		if (rightIsRange && right.includes(",")) {
			const rawRight = right.split(",");
			const rightOut: string[] = [];
			for (let ci = 0; ci < rawRight.length; ci++) {
				const trimmed = rawRight[ci]!.trim();
				if (trimmed.length > 0) rightOut.push(`${left}:${trimmed}`);
			}
			return rightOut;
		}
	}
	return [sel];
}

export function formatMergedSelectorParts(selectors: string[]): string {
	if (selectors.length <= 3) return selectors.join(",");
	const first = selectors[0]!;
	const second = selectors[1]!;
	const last = selectors[selectors.length - 1]!;
	return `${first},${second},…,${last}`;
}
