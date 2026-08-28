import type { Component } from "@veyyon/tui";
import { formatMoreLines } from "@veyyon/utils/format";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import type { Theme } from "../modes/theme/theme";
import {
	formatArgsInline,
	JSON_TREE_MAX_DEPTH_COLLAPSED,
	JSON_TREE_MAX_DEPTH_EXPANDED,
	JSON_TREE_MAX_LINES_COLLAPSED,
	JSON_TREE_MAX_LINES_EXPANDED,
	JSON_TREE_SCALAR_LEN_COLLAPSED,
	JSON_TREE_SCALAR_LEN_EXPANDED,
	renderJsonTreeLines,
} from "../tools/json-tree";
import { formatStyledTruncationWarning, stripOutputNotice } from "../tools/output-meta";
import { formatExpandHint, truncateToWidth } from "../tools/render-utils";
import { renderStatusLine, WidthAwareText } from "../tui";
import type { MCPToolDetails } from "./tool-bridge";

export function renderMCPCall(args: Record<string, unknown>, theme: Theme, label: string): Component {
	return new WidthAwareText(
		contentWidth => {
			const lines: string[] = [];
			lines.push(renderStatusLine({ icon: "pending", title: label }, theme));

			if (args && typeof args === "object" && Object.keys(args).length > 0) {
				const inlineBudget = Math.max(20, contentWidth - Bun.stringWidth(theme.tree.last) - 2);
				const preview = formatArgsInline(args, inlineBudget);
				if (preview) {
					lines.push(` ${theme.fg("dim", theme.tree.last)} ${theme.fg("dim", preview)}`);
				}
			}

			return lines.join("\n");
		},
		0,
		0,
	);
}

export function renderMCPResult(
	result: { content: Array<{ type: string; text?: string }>; details?: MCPToolDetails; isError?: boolean },
	options: RenderResultOptions,
	theme: Theme,
	args?: Record<string, unknown>,
): Component {
	const { expanded } = options;
	return new WidthAwareText(
		contentWidth => {
			const lines: string[] = [];
			const isError = result.isError ?? result.details?.isError ?? false;
			const title = result.details ? `${result.details.serverName}/${result.details.mcpToolName}` : "MCP";
			const success = !isError;
			lines.push(
				renderStatusLine(
					success ? { iconOverride: theme.styledSymbol("tool.mcp", "accent"), title } : { icon: "error", title },
					theme,
				),
			);

			if (expanded && args && typeof args === "object" && Object.keys(args).length > 0) {
				lines.push(`${theme.fg("dim", "Args")}`);
				const maxDepth = JSON_TREE_MAX_DEPTH_EXPANDED;
				const maxLines = JSON_TREE_MAX_LINES_EXPANDED;
				const tree = renderJsonTreeLines(args, theme, maxDepth, maxLines, JSON_TREE_SCALAR_LEN_EXPANDED);
				for (const line of tree.lines) {
					lines.push(line);
				}
				if (tree.truncated) {
					lines.push(theme.fg("dim", "…"));
				}
				lines.push(""); // Blank line before output
			}

			const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
			const trimmedOutput = stripOutputNotice(textContent, result.details?.meta).trimEnd();
			const truncationWarning = result.details?.meta?.truncation
				? formatStyledTruncationWarning(result.details.meta, theme)
				: null;

			if (!trimmedOutput) {
				lines.push(theme.fg("dim", "(no output)"));
				return lines.join("\n");
			}

			if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
				try {
					const parsed = JSON.parse(trimmedOutput);
					const maxDepth = expanded ? JSON_TREE_MAX_DEPTH_EXPANDED : JSON_TREE_MAX_DEPTH_COLLAPSED;
					const maxLines = expanded ? JSON_TREE_MAX_LINES_EXPANDED : JSON_TREE_MAX_LINES_COLLAPSED;
					const maxScalarLen = expanded ? JSON_TREE_SCALAR_LEN_EXPANDED : JSON_TREE_SCALAR_LEN_COLLAPSED;
					const tree = renderJsonTreeLines(parsed, theme, maxDepth, maxLines, maxScalarLen);

					if (tree.lines.length > 0) {
						for (const line of tree.lines) {
							lines.push(line);
						}
						if (!expanded) {
							lines.push(formatExpandHint(theme, expanded, true));
						} else if (tree.truncated) {
							lines.push(theme.fg("dim", "…"));
						}
						if (truncationWarning) lines.push(truncationWarning);
						return lines.join("\n");
					}
				} catch {}
			}

			const outputLines = trimmedOutput.split("\n");
			const maxOutputLines = expanded ? 12 : 4;
			const displayLines = outputLines.slice(0, maxOutputLines);

			for (const line of displayLines) {
				lines.push(theme.fg("toolOutput", truncateToWidth(line, contentWidth)));
			}

			if (outputLines.length > maxOutputLines) {
				const remaining = outputLines.length - maxOutputLines;
				lines.push(
					`${theme.fg("dim", `… ${formatMoreLines(remaining)}`)} ${formatExpandHint(theme, expanded, true)}`,
				);
			} else if (!expanded) {
				lines.push(formatExpandHint(theme, expanded, true));
			}

			if (truncationWarning) lines.push(truncationWarning);
			return lines.join("\n");
		},
		0,
		0,
	);
}
