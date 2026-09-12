import { toolResultNeverRan } from "@veyyon/agent-core";
import { isRecord } from "@veyyon/utils/type-guards";
import type { ReadEntryView } from "@veyyon/wire/presentation/transcript";
import { extractResultTextOrUndefined } from "../tools/core/output-notice";
import { splitPathAndSel } from "../tools/core/path-utils";
import type { ToolExecutionBuildParams } from "./tool-execution";

type ReadGroupResult = NonNullable<ToolExecutionBuildParams["result"]>;

interface ReadResultDetails {
	resolvedPath?: string;
	suffixResolution?: { from?: string; to?: string };
	conflictCount?: number;
	displayReadTargets?: unknown;
	displayContent?: { text?: string; startLine?: number; lineNumbers?: Array<number | null> };
	meta?: { source?: { type?: string; value?: string } };
}

export function readArgsTarget(args: unknown): string | undefined {
	if (!isRecord(args)) return undefined;
	return typeof args.path === "string" ? args.path : typeof args.file_path === "string" ? args.file_path : undefined;
}

/** Partial results do not settle a read entry or replace its completed preview. */
export function updateReadEntryResult(
	entry: ReadEntryView,
	result: ReadGroupResult,
	isPartial = false,
	isError = result.isError,
): void {
	if (isPartial) return;
	if (toolResultNeverRan(result.details)) {
		entry.status = "notExecuted";
		return;
	}
	const details = result.details as ReadResultDetails | undefined;
	const suffix = details?.suffixResolution;
	const correctedFrom = suffix?.from;
	const correctedTo = suffix?.to;
	const corrected = typeof correctedFrom === "string" && typeof correctedTo === "string";
	const source = details?.meta?.source;
	entry.linkPath =
		typeof details?.resolvedPath === "string"
			? details.resolvedPath
			: source?.type === "path" && typeof source.value === "string"
				? source.value
				: undefined;
	if (corrected) {
		const selector = splitPathAndSel(entry.path).sel;
		entry.path = selector && !splitPathAndSel(correctedTo).sel ? `${correctedTo}:${selector}` : correctedTo;
		entry.correctedFrom = correctedFrom;
		entry.displayPaths = undefined;
	} else {
		entry.correctedFrom = undefined;
		const targets = Array.isArray(details?.displayReadTargets)
			? details.displayReadTargets
					.filter((target): target is string => typeof target === "string")
					.map(target => target.trim())
					.filter(target => target.length > 0)
			: undefined;
		entry.displayPaths = targets && targets.length > 0 ? targets : undefined;
	}
	entry.conflictCount =
		typeof details?.conflictCount === "number" && details.conflictCount > 0 ? details.conflictCount : undefined;
	entry.status = isError ? "error" : corrected ? "warning" : "success";
	const displayContent = details?.displayContent;
	const textContent = extractResultTextOrUndefined(result.content);
	if (displayContent !== undefined || textContent !== undefined) {
		entry.contentText = displayContent?.text ?? textContent;
		entry.codeStartLine = displayContent?.startLine;
		entry.codeLineNumbers = displayContent?.lineNumbers;
	}
}

export function toReadEntryView(
	toolCallId: string,
	args: unknown,
	result?: ReadGroupResult,
	isPartial = false,
	isError = result?.isError,
): ReadEntryView | undefined {
	const path = readArgsTarget(args);
	if (path === undefined) return undefined;
	const entry: ReadEntryView = { toolCallId, path, status: "pending" };
	if (result !== undefined) updateReadEntryResult(entry, result, isPartial, isError);
	return entry;
}
