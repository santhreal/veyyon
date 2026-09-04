/**
 * Differential oracle: the file search tool renderer from origin/main.
 *
 * Source SHA: e9467ab12c976cd830eb7a61e30bfd6adc4bff1f.
 * Frozen: never edited to make a test pass.
 *
 * On main this was the renderer half of `src/tools/file-search.ts`, which this branch extracted to
 * `src/tools/search/file-search-render.ts` without touching a byte of it. Only the import specifiers
 * are rewritten to the package subpaths this branch publishes, and the one constant the renderer
 * reads is restated here rather than imported, so what it draws is main's.
 */

import * as path from "node:path";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import {
	fileHyperlink,
	framedBlock,
	outputBlockContentWidth,
	renderFileList,
	renderStatusLine,
	truncateToWidth,
} from "@veyyon/coding-agent/modes/terminal/draw";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import { formatFullOutputReference } from "@veyyon/coding-agent/tools/core/output-meta";
import { PREVIEW_LIMITS } from "@veyyon/coding-agent/tools/core/render-limits";
import {
	formatCount,
	formatEmptyMessage,
	formatErrorMessage,
	formatMoreItems,
} from "@veyyon/coding-agent/tools/core/render-utils";
import type { FileSearchDetails, FileSearchRenderArgs } from "@veyyon/coding-agent/tools/search/file-search";
import { Ellipsis } from "@veyyon/natives";
import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";

function formatFileSearchRenderInput(args: FileSearchRenderArgs | undefined): string | undefined {
	return args?.input;
}

const COLLAPSED_LIST_LIMIT = PREVIEW_LIMITS.COLLAPSED_ITEMS;

function fileSearchStatusIcon(uiTheme: Theme): string {
	return uiTheme.fg("toolTitle", uiTheme.symbol("icon.search"));
}

export const fileSearchRenderer = {
	inline: true,
	renderCall(args: FileSearchRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.limit !== undefined) meta.push(`limit:${args.limit}`);

		const text = renderStatusLine(
			{
				icon: "pending",
				title: "Search files",
				titleColor: "toolTitle",
				description: formatFileSearchRenderInput(args) || "*",
				meta,
			},
			uiTheme,
		);
		return new Text(text, 1, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: FileSearchDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: FileSearchRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError || details?.error) {
			const errorText = details?.error || result.content?.find(c => c.type === "text")?.text || "Unknown error";
			return new Text(formatErrorMessage(errorText, uiTheme), 1, 0);
		}

		const hasDetailedData = details?.fileCount !== undefined;
		const textContent = result.content?.find(c => c.type === "text")?.text;

		if (!hasDetailedData) {
			if (
				!textContent ||
				textContent.includes("No files matching") ||
				textContent.includes("No files found") ||
				textContent.trim() === ""
			) {
				return new Text(formatEmptyMessage("No files found", uiTheme), 1, 0);
			}

			const lines = textContent.split("\n").filter(l => l.trim());
			const header = renderStatusLine(
				{
					iconOverride: fileSearchStatusIcon(uiTheme),
					title: "Search files",
					titleColor: "toolTitle",
					description: formatFileSearchRenderInput(args),
					meta: [formatCount("file", lines.length)],
				},
				uiTheme,
			);
			return framedBlock(uiTheme, width => {
				const maxItems = options.expanded ? lines.length : Math.min(lines.length, COLLAPSED_LIST_LIMIT);
				const contentWidth = outputBlockContentWidth(width);
				const bodyLines: string[] = [];
				for (let i = 0; i < maxItems; i++) {
					bodyLines.push(truncateToWidth(`  ${uiTheme.fg("accent", lines[i]!)}`, contentWidth, Ellipsis.Omit));
				}
				const remaining = lines.length - maxItems;
				if (!options.expanded && remaining > 0) {
					bodyLines.push(
						truncateToWidth(uiTheme.fg("dim", formatMoreItems(remaining, "file")), contentWidth, Ellipsis.Omit),
					);
				}
				return {
					header,
					sections: [{ lines: bodyLines }],
					state: "success",
					width,
				};
			});
		}

		const fileCount = details?.fileCount ?? 0;
		const truncation = details?.truncation ?? details?.meta?.truncation;
		const limits = details?.meta?.limits;
		const truncated = Boolean(details?.truncated || truncation || details?.resultLimitReached || limits?.resultLimit);
		const files = details?.files ?? [];

		const missingPaths = details?.missingPaths ?? [];
		const missingNote =
			missingPaths.length > 0 ? uiTheme.fg("warning", `skipped missing: ${missingPaths.join(", ")}`) : undefined;

		if (fileCount === 0) {
			// `truncated` on an empty result means the scan timed out mid-walk —
			// render "incomplete", not a definitive "No files found".
			const emptyLabel = truncated ? "No matches before timeout (scan incomplete)" : "No files found";
			const header = renderStatusLine(
				{
					icon: "warning",
					title: "Search files",
					titleColor: "toolTitle",
					description: formatFileSearchRenderInput(args),
					meta: truncated ? ["0 files", uiTheme.fg("warning", "timed out")] : ["0 files"],
				},
				uiTheme,
			);
			const lines = [header, formatEmptyMessage(emptyLabel, uiTheme)];
			if (missingNote) lines.push(missingNote);
			return new Text(lines.join("\n"), 1, 0);
		}
		const meta: string[] = [formatCount("file", fileCount)];
		if (details?.scopePath) meta.push(`in ${details.scopePath}`);
		if (truncated) meta.push(uiTheme.fg("warning", "truncated"));
		const header = renderStatusLine(
			{
				...(truncated ? { icon: "warning" as const } : { iconOverride: fileSearchStatusIcon(uiTheme) }),
				title: "Search files",
				titleColor: "toolTitle",
				description: formatFileSearchRenderInput(args),
				meta,
			},
			uiTheme,
		);

		const truncationReasons: string[] = [];
		// One reason for the result cap: details and limits both carry the same
		// number, and pushing both rendered "limit 200 results, limit 200 results".
		const resultLimit = details?.resultLimitReached ?? limits?.resultLimit?.reached;
		if (resultLimit) truncationReasons.push(`limit ${resultLimit} results`);
		if (truncation) truncationReasons.push(truncation.truncatedBy === "lines" ? "line limit" : "size limit");
		const artifactId = truncation && "artifactId" in truncation ? truncation.artifactId : undefined;
		if (artifactId) truncationReasons.push(formatFullOutputReference(artifactId));

		const extraLines: string[] = [];
		if (truncationReasons.length > 0) {
			extraLines.push(uiTheme.fg("warning", `truncated: ${truncationReasons.join(", ")}`));
		}
		if (missingNote) extraLines.push(missingNote);

		return framedBlock(uiTheme, width => {
			const cwd = details?.cwd;
			const fileLines = renderFileList(
				{
					files: files.map(entry => ({
						path: entry,
						isDirectory: entry.endsWith("/"),
						absPath: cwd && !entry.endsWith("/") ? path.resolve(cwd, entry) : undefined,
					})),
					expanded: options.expanded,
					maxCollapsed: COLLAPSED_LIST_LIMIT,
					hyperlinkFn: fileHyperlink,
				},
				uiTheme,
			);
			const contentWidth = outputBlockContentWidth(width);
			const bodyLines = [...fileLines, ...extraLines].map(l => truncateToWidth(l, contentWidth, Ellipsis.Omit));
			return {
				header,
				sections: [{ lines: bodyLines }],
				state: truncated ? "warning" : "success",
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
