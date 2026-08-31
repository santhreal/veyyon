/**
 * Differential oracle: the debug renderer from origin/main.
 *
 * Source SHA: 80cf11d2f49c9535a7e4d51a38506619035b4720, `packages/coding-agent/src/tools/debug.ts`.
 * Frozen: never edited to make a test pass.
 *
 * The edits against that source are the theme parameter, which defaulted to the module-level theme
 * binding and is required here so the oracle draws with the theme the differential hands it, and the
 * import of `formatSessionSnapshot`, which now sits in `debug/session-snapshot.ts`. The lines it
 * draws are the same lines.
 */

import { formatSessionSnapshot } from "@veyyon/coding-agent/debug/session-snapshot";
import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import {
	formatExpandHint,
	PREVIEW_LIMITS,
	replaceTabs,
	shortenPath,
	TRUNCATE_LENGTHS,
} from "@veyyon/coding-agent/tools/core/render-utils";
import { formatStatusIcon } from "@veyyon/coding-agent/tools/core/tool-ui-status";
import type { DebugParams, DebugToolDetails } from "@veyyon/coding-agent/tools/shell/debug";
import { CachedOutputBlock, markFramedBlockComponent } from "@veyyon/coding-agent/tui/output-block";
import { renderStatusLine } from "@veyyon/coding-agent/tui/status-line";
import { type Component, Text } from "@veyyon/tui";
import { formatMoreLines } from "@veyyon/utils/format";
import { truncateToWidth } from "@veyyon/utils/width";

interface DebugRenderArgs extends Partial<DebugParams> {}

function summarizeDebugCall(args: DebugRenderArgs): string {
	const action = args.action ? args.action.replaceAll("_", " ") : "request";
	if (args.program) {
		return `${action} ${truncateToWidth(shortenPath(args.program), TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.file && args.line !== undefined) {
		return `${action} ${truncateToWidth(`${shortenPath(args.file)}:${args.line}`, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.function) {
		return `${action} ${truncateToWidth(args.function, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.expression) {
		return `${action} ${truncateToWidth(args.expression, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.command) {
		return `${action} ${truncateToWidth(args.command, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.memory_reference) {
		return `${action} ${truncateToWidth(args.memory_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.instruction_reference) {
		return `${action} ${truncateToWidth(args.instruction_reference, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.data_id) {
		return `${action} ${truncateToWidth(args.data_id, TRUNCATE_LENGTHS.TITLE)}`;
	}
	if (args.name) {
		return `${action} ${truncateToWidth(args.name, TRUNCATE_LENGTHS.TITLE)}`;
	}
	return action;
}

export const debugToolRenderer = {
	animatedPartialResult: true,
	renderCall(args: DebugRenderArgs, _options: RenderResultOptions, theme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: "Debug", description: summarizeDebugCall(args) }, theme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: DebugToolDetails; isError?: boolean },
		options: RenderResultOptions,
		theme: Theme,
		args?: DebugRenderArgs,
	): Component {
		const outputBlock = new CachedOutputBlock();
		return markFramedBlockComponent({
			render(width: number): readonly string[] {
				const action = (args?.action ?? result.details?.action ?? "debug").replaceAll("_", " ");
				const success = !options.isPartial && !result.isError;
				const statusIcon = success
					? theme.styledSymbol("tool.debug", "accent")
					: formatStatusIcon(options.isPartial ? "running" : "error", theme, options.spinnerFrame);
				const header = `${statusIcon} Debug ${action}`;
				const summaryLines = result.details?.snapshot
					? formatSessionSnapshot(result.details.snapshot).map(line => replaceTabs(line))
					: [];
				const text = result.content.find(block => block.type === "text")?.text ?? "No output";
				const rawLines = replaceTabs(text).split("\n");
				const previewLimit = options.expanded ? PREVIEW_LIMITS.EXPANDED_LINES : PREVIEW_LIMITS.COLLAPSED_LINES;
				const displayedLines = rawLines
					.slice(0, previewLimit)
					.map(line => truncateToWidth(line, TRUNCATE_LENGTHS.LINE));
				const remaining = rawLines.length - displayedLines.length;
				if (remaining > 0) {
					displayedLines.push(
						theme.fg(
							"muted",
							`… ${formatMoreLines(remaining)} ${formatExpandHint(theme, options.expanded, true)}`,
						),
					);
				}
				return outputBlock.render(
					{
						header,
						state: result.isError ? "error" : "success",
						sections: [
							...(summaryLines.length > 0
								? [{ label: theme.fg("toolTitle", "Session"), lines: summaryLines }]
								: []),
							{ label: theme.fg("toolTitle", "Output"), lines: displayedLines },
						],
						width,
						applyBg: false,
					},
					theme,
				);
			},
			invalidate() {
				outputBlock.invalidate();
			},
		});
	},
	mergeCallAndResult: true,
	inline: true,
};
