import type { AnyAgentTool } from "@veyyon/agent-core";
import type { EditMode, PerFileDiffPreview } from "../../edit";
import { isWaitingPollDetails } from "../../tools/job";
import type { TodoToolDetails } from "../../tools/todo";

export function stripTrailingUnbalancedRemoval(diff: string | undefined): string | undefined {
	if (!diff) return diff;
	let lastAddIdx = -1;
	for (let i = diff.length - 1; i >= 0; i--) {
		if (diff.charCodeAt(i) === 10 && i + 1 < diff.length && diff[i + 1] === "+") {
			lastAddIdx = i + 1;
			break;
		}
		if (i === 0 && diff[0] === "+") {
			lastAddIdx = 0;
			break;
		}
	}
	let hasTrailingUnbalanced = false;
	let pos = lastAddIdx === -1 ? 0 : diff.indexOf("\n", lastAddIdx) + 1;
	while (pos < diff.length) {
		const nextNl = diff.indexOf("\n", pos);
		const lineEnd = nextNl === -1 ? diff.length : nextNl;
		const ch = diff[pos];
		if (ch === "-" || (ch === "@" && diff[pos + 1] === "@")) {
			hasTrailingUnbalanced = true;
			break;
		}
		pos = lineEnd + 1;
	}
	if (!hasTrailingUnbalanced) return diff;
	if (lastAddIdx === -1) return "";
	const lineEnd = diff.indexOf("\n", lastAddIdx);
	return diff.slice(0, lineEnd === -1 ? diff.length : lineEnd);
}

export type DisplaceableToolName = "job" | "todo";

export function isTodoToolDetails(details: unknown): details is TodoToolDetails {
	return (
		typeof details === "object" &&
		details !== null &&
		"phases" in details &&
		Array.isArray((details as { phases?: unknown }).phases)
	);
}

export function displaceableToolName(
	toolName: string,
	result: { details?: unknown; isError?: boolean },
	isPartial: boolean,
): DisplaceableToolName | undefined {
	if (result.isError === true) return undefined;
	if (toolName === "job" && isWaitingPollDetails(result.details)) return "job";
	if (toolName === "todo" && !isPartial && isTodoToolDetails(result.details)) return "todo";
	return undefined;
}

export function stabilizeStreamingPreviews(previews: PerFileDiffPreview[]): PerFileDiffPreview[] {
	let changed = false;
	const next: PerFileDiffPreview[] = new Array(previews.length);
	for (let pi = 0; pi < previews.length; pi++) {
		const preview = previews[pi]!;
		if (!preview.diff) {
			next[pi] = preview;
			continue;
		}
		const trimmed = stripTrailingUnbalancedRemoval(preview.diff);
		if (trimmed === preview.diff) {
			next[pi] = preview;
			continue;
		}
		changed = true;
		next[pi] = { ...preview, diff: trimmed ?? "" };
	}
	return changed ? next : previews;
}

export function isEditLikeToolName(toolName: string): boolean {
	return toolName === "edit" || toolName === "apply_patch";
}

export const ROW_INDENT_PATTERN = /^((?:\x1b\[[0-9;]*m)*)( *)/;

export function dedent(rows: readonly string[]): string[] {
	let shared = Number.POSITIVE_INFINITY;
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		if (row.trim() === "") continue;
		shared = Math.min(shared, ROW_INDENT_PATTERN.exec(row)?.[2]?.length ?? 0);
		if (shared === 0) return rows.slice();
	}
	if (!Number.isFinite(shared) || shared === 0) return rows.slice();
	const result = new Array<string>(rows.length);
	for (let ri = 0; ri < rows.length; ri++) {
		const row = rows[ri]!;
		result[ri] =
			row.trim() === ""
				? row
				: row.replace(ROW_INDENT_PATTERN, (_, color: string, indent: string) => color + indent.slice(shared));
	}
	return result;
}

export function resolveEditModeForTool(toolName: string, tool: AnyAgentTool | undefined): EditMode | undefined {
	if (toolName === "apply_patch") return "apply_patch";
	if (toolName !== "edit") return undefined;
	return (tool as { mode?: EditMode } | undefined)?.mode;
}

export function rawTextInputFromPartialJson(partialJson: unknown): string | undefined {
	if (typeof partialJson !== "string") return undefined;
	if (partialJson.length === 0) return undefined;
	const trimmed = partialJson.trimStart();
	if (trimmed.length === 0) return undefined;
	const first = trimmed[0];
	if (first === "{" || first === '"') return undefined;
	return partialJson;
}

export function partialJsonOf(args: unknown): string | undefined {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return undefined;
	const value = args.__partialJson;
	return typeof value === "string" ? value : undefined;
}
