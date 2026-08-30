/**
 * Terminal drawing for the ast_edit tool. The tool half in `ast-edit.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { collapseWhitespace } from "@veyyon/utils";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../theme/theme";
import { Ellipsis, fileHyperlink, framedBlock, renderStatusLine, truncateToWidth } from "../tui";
import type { AstEditToolDetails } from "./ast-edit";
import { classifyGroupedLines, groupLineIndicesByBlank } from "./grouped-file-output";
import {
	appendParseErrorsBulletList,
	formatCount,
	formatErrorDetail,
	formatMoreItems,
	formatParseErrorsCountLabel,
	formatScopeMeta,
	PREVIEW_LIMITS,
} from "./render-utils";

// =============================================================================
// TUI Renderer
// =============================================================================

interface AstEditRenderArgs {
	ops?: Array<{ pat?: string; out?: string }>;
	paths?: string[];
}

const COLLAPSED_CHANGE_LIMIT = PREVIEW_LIMITS.COLLAPSED_LINES * 2;

/**
 * Flatten pre-styled change groups into frame body lines. Groups are separated
 * by a blank line and carry no tree guides — the frame border is the container,
 * so nested `├─ │` gutters would just be noise. Collapsed mode always shows at
 * least the first group, then fills up to `budget` lines before summarizing the
 * rest as `… N more changes`.
 */
function buildChangeBody(groups: string[][], expanded: boolean, budget: number, theme: Theme): string[] {
	const lines: string[] = [];
	let shown = 0;
	for (let i = 0; i < groups.length; i++) {
		const group = groups[i]!;
		const separator = shown > 0 ? 1 : 0;
		const remainingAfter = groups.length - (i + 1);
		const reserved = !expanded && remainingAfter > 0 ? 1 : 0;
		// Always emit the first group; budget only gates subsequent ones.
		if (!expanded && shown > 0 && lines.length + separator + group.length + reserved > budget) break;
		if (separator) lines.push("");
		lines.push(...group);
		shown++;
	}
	const remaining = groups.length - shown;
	if (!expanded && remaining > 0) lines.push(theme.fg("muted", formatMoreItems(remaining, "change")));
	return lines;
}

/** One-line header preview of an AST pattern. `renderStatusLine` only flattens
 * CR/LF, so a multi-line tab-indented pattern would otherwise punch raw tabs
 * into the status line; collapse all whitespace runs to single spaces. */
function patternPreview(pat: string | undefined): string | undefined {
	const collapsed = collapseWhitespace(pat);
	return collapsed || undefined;
}

export const astEditToolRenderer = {
	inline: true,
	renderCall(args: AstEditRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const meta: string[] = [];
		if (args.paths?.length) meta.push(formatScopeMeta(args.paths));
		const rewriteCount = args.ops?.length ?? 0;
		if (rewriteCount > 1) meta.push(`${rewriteCount} rewrites`);

		const description =
			rewriteCount === 1 ? patternPreview(args.ops?.[0]?.pat) : rewriteCount ? `${rewriteCount} rewrites` : "?";
		const header = renderStatusLine({ icon: "pending", title: "AST Edit", description, meta }, uiTheme);
		// Pending call has no body yet — a lone status line is sleeker than an empty frame.
		return new Text(header, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: AstEditToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: AstEditRenderArgs,
	): Component {
		const details = result.details;

		if (result.isError) {
			const errorText = result.content?.find(c => c.type === "text")?.text || "Unknown error";
			const header = renderStatusLine({ icon: "error", title: "AST Edit" }, uiTheme);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: formatErrorDetail(errorText, uiTheme).split("\n") }],
				state: "error",
				borderColor: "error",
				width,
			}));
		}

		const totalReplacements = details?.totalReplacements ?? 0;
		const filesTouched = details?.filesTouched ?? 0;
		const filesSearched = details?.filesSearched ?? 0;
		const limitReached = details?.limitReached ?? false;

		if (totalReplacements === 0) {
			const rewriteCount = args?.ops?.length ?? 0;
			const description = rewriteCount === 1 ? patternPreview(args?.ops?.[0]?.pat) : undefined;
			const meta = ["0 replacements"];
			if (details?.scopePath) meta.push(formatScopeMeta(details.scopePath));
			if (filesSearched > 0) meta.push(`searched ${filesSearched}`);
			const header = renderStatusLine({ icon: "warning", title: "AST Edit", description, meta }, uiTheme);
			// The "0 replacements" count already rides on the status line; only parse
			// errors are worth a body, so frame solely when there are some.
			const bodyLines: string[] = [];
			appendParseErrorsBulletList(bodyLines, details?.parseErrors, uiTheme, details?.parseErrorsTotal);
			if (bodyLines.length === 0) return new Text(header, 0, 0);
			return framedBlock(uiTheme, width => ({
				header,
				sections: [{ lines: bodyLines }],
				state: "warning",
				borderColor: "borderMuted",
				width,
			}));
		}

		const summaryParts = [formatCount("replacement", totalReplacements), formatCount("file", filesTouched)];
		const meta = [...summaryParts];
		if (details?.scopePath) meta.push(formatScopeMeta(details.scopePath));
		meta.push(`searched ${filesSearched}`);
		if (limitReached) meta.push(uiTheme.fg("warning", "limit reached"));
		const rewriteCount = args?.ops?.length ?? 0;
		const description = rewriteCount === 1 ? patternPreview(args?.ops?.[0]?.pat) : undefined;

		const textContent = result.details?.displayContent ?? result.content?.find(c => c.type === "text")?.text ?? "";
		const allLines = textContent.split("\n");
		// Resolve hyperlinks over the whole output so nested directory headers
		// reconstruct across the blank-line groups the tree list collapses by.
		const contexts = classifyGroupedLines(allLines, details?.cwd ?? details?.searchPath, details?.searchPath);
		const styledLines = allLines.map((line, index) => {
			const ctx = contexts[index]!;
			// Swap the inner code-frame gutter `│` for a space so it does not nest a
			// second vertical bar inside the frame border.
			const display = replaceTabs(line.replace("│", " "));
			if (ctx.kind === "dir") {
				const styled = uiTheme.fg("accent", display);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (ctx.kind === "file") {
				const styled = uiTheme.fg(ctx.depth === 1 ? "accent" : "dim", display);
				return ctx.headerPath ? fileHyperlink(ctx.headerPath, styled) : styled;
			}
			if (display.startsWith("+")) return uiTheme.fg("toolDiffAdded", display);
			if (display.startsWith("-")) return uiTheme.fg("toolDiffRemoved", display);
			return uiTheme.fg("toolOutput", display);
		});
		const changeGroups = groupLineIndicesByBlank(allLines)
			.filter(indices => {
				const first = allLines[indices[0]!]!;
				return !first.startsWith("Safety cap reached") && !first.startsWith("Parse issues:");
			})
			.map(indices => indices.map(index => styledLines[index]!));

		const badge = { label: "proposed", color: "warning" as const };
		const header = renderStatusLine(
			{ icon: limitReached ? "warning" : "success", title: "AST Edit", description, badge, meta },
			uiTheme,
		);

		const extraLines: string[] = [];
		if (limitReached) {
			extraLines.push(uiTheme.fg("warning", "limit reached; narrow path"));
		}
		if (details?.parseErrors?.length) {
			extraLines.push(
				uiTheme.fg("warning", formatParseErrorsCountLabel(details.parseErrors, details.parseErrorsTotal)),
			);
		}
		return framedBlock(uiTheme, width => {
			const changeLines = buildChangeBody(changeGroups, Boolean(options.expanded), COLLAPSED_CHANGE_LIMIT, uiTheme);
			const innerWidth = Math.max(1, width - 3);
			const bodyLines = [...changeLines, ...extraLines].map(l => truncateToWidth(l, innerWidth, Ellipsis.Omit));
			while (bodyLines.length > 0 && bodyLines[0].trim() === "") bodyLines.shift();
			return {
				header,
				sections: bodyLines.length > 0 ? [{ lines: bodyLines }] : [],
				state: options.isPartial ? "pending" : "success",
				borderColor: "borderMuted",
				width,
			};
		});
	},
	mergeCallAndResult: true,
};
