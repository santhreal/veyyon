/**
 * Terminal drawing for the ssh tool. The tool half in `ssh.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { Component } from "@veyyon/tui";
import type { RenderResultOptions } from "../../extensibility/custom-tools/types";
import { truncateToVisualLines } from "../../modes/terminal/components/transcript/visual-truncate";
import { expandHintSuffix } from "../../modes/terminal/utils/key-hint";
import type { Theme } from "../../theme/theme";
import { renderStatusLine } from "../../tui";
import { CachedOutputBlock, markFramedBlockComponent, outputBlockContentWidth } from "../../tui/output-block";
import { formatStyledTruncationWarning, stripOutputNotice } from "../core/output-meta";
import { capPreviewLines, PREVIEW_LIMITS, replaceTabs } from "../core/render-utils";
import type { SSHToolDetails } from "./ssh";

// =============================================================================
// TUI Renderer
// =============================================================================

interface SshRenderArgs {
	host?: string;
	command?: string;
	timeout?: number;
}

/** Whether the painted call args still carry the streamed raw-JSON buffer —
 *  the shape that renders the `⏳ SSH: […]` / `$ …` placeholder. */
function hasStreamedRenderArgs(args: unknown): boolean {
	if (args == null || typeof args !== "object" || !("__partialJson" in args)) return false;
	return typeof args.__partialJson === "string";
}

interface SshRenderContext {
	/** Visual lines for truncated output (pre-computed by tool-execution) */
	visualLines?: string[];
	/** Number of lines skipped */
	skippedCount?: number;
	/** Total visual lines */
	totalVisualLines?: number;
}

function formatSshCommandLines(command: string, uiTheme: Theme): string[] {
	const sanitized = replaceTabs(command);
	const rawLines = sanitized.length > 0 ? sanitized.split("\n") : ["…"];
	const prefix = uiTheme.fg("dim", "$ ");
	return rawLines.map((line, i) => (i === 0 ? `${prefix}${line}` : line));
}

export const sshToolRenderer = {
	animatedPendingPreview: true,
	renderCall(args: SshRenderArgs, options: RenderResultOptions, uiTheme: Theme): Component {
		const host = args.host || "…";
		const command = args.command ?? "";
		const cmdLines = formatSshCommandLines(command, uiTheme);
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				const header = renderStatusLine(
					{
						icon: options.spinnerFrame !== undefined ? "running" : "pending",
						spinnerFrame: options.spinnerFrame,
						title: "SSH",
						description: `[${host}]`,
					},
					uiTheme,
				);
				return outputBlock.render(
					{
						header,
						state: options.spinnerFrame !== undefined ? "running" : "pending",
						sections: [{ lines: capPreviewLines(cmdLines, uiTheme, { expanded: options.expanded }) }],
						width,
					},
					uiTheme,
				);
			},
			invalidate: () => {
				outputBlock.invalidate();
			},
		});
	},

	renderResult(
		result: {
			content: Array<{ type: string; text?: string }>;
			details?: SSHToolDetails;
			isError?: boolean;
		},
		options: RenderResultOptions & { renderContext?: SshRenderContext },
		uiTheme: Theme,
		args?: SshRenderArgs,
	): Component {
		const details = result.details;
		const host = args?.host || "…";
		const command = args?.command ?? "";
		const isError = result.isError === true;
		const isPartial = options.isPartial === true;
		const header = renderStatusLine(
			isPartial
				? { icon: "pending", title: "SSH", description: `[${host}]` }
				: isError
					? { icon: "error", title: "SSH", description: `[${host}]` }
					: { iconOverride: uiTheme.styledSymbol("tool.ssh", "accent"), title: "SSH", description: `[${host}]` },
			uiTheme,
		);
		const cmdLines = formatSshCommandLines(command, uiTheme);
		const textContent = result.content?.find(c => c.type === "text")?.text ?? "";
		const outputBlock = new CachedOutputBlock();

		return markFramedBlockComponent({
			render: (width: number): readonly string[] => {
				// REACTIVE: read mutable options at render time
				const { expanded } = options;
				// Strip LLM-facing notice so we don't echo it next to the styled warning.
				const output = stripOutputNotice(textContent, details?.meta).trimEnd();
				const outputLines: string[] = [];

				if (output) {
					if (expanded) {
						outputLines.push(...output.split("\n").map(line => uiTheme.fg("toolOutput", replaceTabs(line))));
					} else {
						// Measured at the box's inner width, the same way `bash` measures
						// its own tail, so a wrapped remote line spends the lines it
						// actually occupies. This branch used to read
						// `renderContext.visualLines`, which nothing ever populated for
						// `ssh` — the render context is built for `bash` only — so every
						// collapsed remote result fell through to a flat five-line slice
						// with tabs left in it, opening holes in the frame.
						const sanitized = output.split("\n").map(replaceTabs).join("\n");
						const result = truncateToVisualLines(
							sanitized,
							PREVIEW_LIMITS.OUTPUT_COLLAPSED,
							outputBlockContentWidth(width),
						);
						if (result.skippedCount > 0) {
							outputLines.push(
								uiTheme.fg(
									"dim",
									`… (${result.skippedCount} earlier lines, showing ${result.visualLines.length} of ${result.skippedCount + result.visualLines.length})${expandHintSuffix()}`,
								),
							);
						}
						outputLines.push(...result.visualLines.map(line => uiTheme.fg("toolOutput", line)));
					}
				}

				if (details?.meta?.truncation) {
					const warning = formatStyledTruncationWarning(details.meta, uiTheme);
					if (warning) outputLines.push(warning);
				}

				return outputBlock.render(
					{
						header,
						state: isPartial ? "pending" : isError ? "error" : "success",
						sections: [
							{
								// Viewport-sized tail window in every state — streaming and final
								// render identically; only ctrl+o uncaps.
								lines: capPreviewLines(cmdLines, uiTheme, { expanded }),
							},
							{ label: uiTheme.fg("toolTitle", "Output"), lines: outputLines },
						],
						width,
					},
					uiTheme,
				);
			},
			invalidate: () => {
				outputBlock.invalidate();
			},
		});
	},
	mergeCallAndResult: true,
	// Streamed args can initially render the SSH placeholder (`⏳ SSH: […]` /
	// `$ …`), then the first partial result inserts the `Output` section and
	// re-anchors the frame. Force a full repaint only at that streamed-placeholder
	// seam so placeholder rows do not survive in viewport/native scrollback.
	forceFirstResultViewportRepaint: hasStreamedRenderArgs,
	// The provisional pending-result frame settles into the final `⇄ SSH: [host]`
	// frame, so clear/replay the viewport at that topology flip too.
	forceResultViewportRepaintOnSettle: true,
};
