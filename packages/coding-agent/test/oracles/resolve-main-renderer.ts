/**
 * Differential oracle: the resolve tool renderer from origin/main.
 *
 * Source SHA: 80cf11d2f49c9535a7e4d51a38506619035b4720, where the renderer was declared in-place at
 * the foot of `packages/coding-agent/src/tools/resolve.ts`.
 * Frozen: never edited to make a test pass.
 *
 * The one edit against that source is the theme parameter, which defaulted to the module-level theme
 * binding and is required here, so the oracle draws with the theme the differential hands it rather
 * than with a second instance.
 */

import type { RenderResultOptions } from "@veyyon/coding-agent/extensibility/custom-tools/types";
import { Ellipsis, padToWidth, renderStatusLine, truncateToWidth } from "@veyyon/coding-agent/modes/terminal/draw";
import type { Theme } from "@veyyon/coding-agent/theme/theme";
import type { ResolveParams, ResolveToolDetails } from "@veyyon/coding-agent/tools/agent/resolve";
import { replaceTabs } from "@veyyon/coding-agent/tools/core/render-utils";
import { type Component, Text } from "@veyyon/tui";

export function renderCall(args: ResolveParams, _options: RenderResultOptions, uiTheme: Theme): Component {
	const reasonTrimmed = args.reason?.trim();
	const reason = reasonTrimmed ? truncateToWidth(reasonTrimmed, 72, Ellipsis.Omit) : undefined;
	const text = renderStatusLine(
		{
			icon: "pending",
			title: "Resolve",
			description: args.action,
			badge: {
				label: args.action === "apply" ? "proposed -> resolved" : "proposed -> rejected",
				color: args.action === "apply" ? "success" : "warning",
			},
			meta: reason ? [uiTheme.fg("muted", reason)] : undefined,
		},
		uiTheme,
	);
	return new Text(text, 0, 0);
}

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: ResolveToolDetails; isError?: boolean },
	_options: RenderResultOptions,
	uiTheme: Theme,
): Component {
	const details = result.details;
	const label = replaceTabs(details?.label ?? "pending action");
	const reason = replaceTabs(details?.reason?.trim() || "No reason provided");
	const action = details?.action ?? "apply";
	const isApply = action === "apply" && !result.isError;
	const isFailedApply = action === "apply" && result.isError;
	const bgColor = result.isError ? "error" : isApply ? "success" : "warning";
	// Bare symbol: the line is wrapped in inverse(fg(...)), so any embedded fg
	// reset (styledSymbol/status glyphs carry their own \x1b[39m) would drop the
	// inverse block back to the default background mid-line.
	const icon = uiTheme.symbol(isApply ? "tool.resolve" : "status.error");
	const verb = isApply ? "Accept" : isFailedApply ? "Failed" : "Discard";
	const separator = ": ";
	const separatorIndex = label.indexOf(separator);
	const sourceLabel = separatorIndex > 0 ? label.slice(0, separatorIndex).trim() : undefined;
	const summaryLabel = separatorIndex > 0 ? label.slice(separatorIndex + separator.length).trim() : label;
	const sourceBadge = sourceLabel
		? uiTheme.bold(`${uiTheme.format.bracketLeft}${sourceLabel}${uiTheme.format.bracketRight}`)
		: undefined;
	const headerLine = `${icon} ${uiTheme.bold(`${verb}:`)} ${summaryLabel}${sourceBadge ? ` ${sourceBadge}` : ""}`;
	const lines = ["", headerLine, "", uiTheme.italic(reason), ""];

	return {
		render(width: number): readonly string[] {
			const lineWidth = Math.max(3, width);
			const innerWidth = Math.max(1, lineWidth - 2);
			return lines.map(line => {
				const truncated = truncateToWidth(line, innerWidth, Ellipsis.Omit);
				const framed = ` ${padToWidth(truncated, innerWidth)} `;
				const padded = padToWidth(framed, lineWidth);
				return uiTheme.inverse(uiTheme.fg(bgColor, padded));
			});
		},
		invalidate() {},
	};
}
