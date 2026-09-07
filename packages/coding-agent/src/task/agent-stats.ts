/**
 * Shared agent statistics and output formatting utilities.
 *
 * Host-independent ViewSpan definitions for agent statistics and cleaned tool
 * output, shared by the task tool's ToolView and the Agent Dashboard.
 */

import { formatContextUsage, formatNumber, sanitizeText } from "@veyyon/utils";
import { truncateToWidth } from "@veyyon/utils/width";
import { replaceTabs } from "@veyyon/utils/wrap";
import type { ViewSpan, ViewTone } from "@veyyon/view";
import { EXIT_CODE_NOTICE_RE } from "../exec/exit-notice";
import { stripGeneratedOutputNotice, stripRawOutputArtifactNotice } from "../tools/core/output-notice";
import { splitModelSelector } from "./model-selector";

/** Columns a model id may spend on a row that already carries the agent's own name. */
const MODEL_BADGE_WIDTH = 30;

/** A run of the card's own words. */
export function span(text: string, tone?: ViewTone): ViewSpan {
	return tone === undefined ? { text } : { text, tone };
}

/**
 * The separator between two trailing facts of a row, as the host's own glyph.
 *
 * A row that stated a literal dot would draw one on a terminal whose preset writes ` - `, so the mark
 * is named and the fallback text is what a host with no glyph for it writes.
 */
export const STATS_DOT: ViewSpan = { text: " · ", symbol: "sep.dot", tone: "dim" };

export interface AgentStatsOptions {
	toolCount?: number;
	requests?: number;
	tokens: number;
	contextTokens?: number;
	contextWindow?: number;
	cost: number;
	resolvedModel?: string;
	showResolvedModelBadge?: boolean;
}

/** The model an agent runs on and the effort it runs at, as the two runs a badge is. */
export function modelBadgeSpans(resolved: string): ViewSpan[] {
	const { model, level } = splitModelSelector(resolved);
	const id = truncateToWidth(replaceTabs(model), MODEL_BADGE_WIDTH);
	if (level === undefined || level === "off" || level === "inherit") return [span(id, "muted")];
	return [span(id, "muted"), span(" "), { text: level, symbol: `thinking.${level}` }];
}

/** The counts, the context reading and the cost a row carries after what it is doing. */
export function appendAgentStats(line: ViewSpan[], opts: AgentStatsOptions): ViewSpan[] {
	if (opts.toolCount) {
		line.push(STATS_DOT, span(`${formatNumber(opts.toolCount)} `, "dim"), {
			text: "",
			symbol: "icon.extensionTool",
			tone: "dim",
		});
	}
	if (opts.requests) line.push(STATS_DOT, span(`${formatNumber(opts.requests)} req`, "dim"));
	// Current per-turn context — the same tok/tok gauge the status line shows.
	if (opts.contextTokens && opts.contextTokens > 0) {
		line.push(STATS_DOT, span(formatContextUsage(opts.contextTokens, opts.contextWindow ?? 0), "dim"));
	}
	if (opts.cost > 0) line.push(STATS_DOT, span(`$${opts.cost.toFixed(2)}`, "cost"));
	if (opts.resolvedModel && opts.showResolvedModelBadge) line.push(STATS_DOT, ...modelBadgeSpans(opts.resolvedModel));
	return line;
}

const BASH_WALL_TIME_NOTICE_RE = /^Wall time: \d+(?:\.\d+)? seconds$/u;

function stripRecentOutputNoticeLine(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidateStart = lineStart === -1 ? 0 : lineStart + 1;
	const line = trimmed.slice(candidateStart);
	if (!BASH_WALL_TIME_NOTICE_RE.test(line) && !EXIT_CODE_NOTICE_RE.test(line)) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

/**
 * The tail of an agent's output with the runtime notices the bash tool appends
 * (exit code, wall time, artifact pointer) stripped, so the preview is what the
 * child's tools printed rather than what the harness added.
 */
export function sanitizeRecentOutput(output: string): string {
	let text = sanitizeText(output).trimEnd();
	while (text) {
		const withoutArtifactNotice = stripRawOutputArtifactNotice(text).text;
		if (withoutArtifactNotice !== text) {
			text = withoutArtifactNotice;
			continue;
		}
		const withoutOutputNotice = stripGeneratedOutputNotice(text);
		if (withoutOutputNotice !== text) {
			text = withoutOutputNotice;
			continue;
		}
		const withoutRuntimeNotice = stripRecentOutputNoticeLine(text);
		if (withoutRuntimeNotice !== text) {
			text = withoutRuntimeNotice;
			continue;
		}
		break;
	}
	return text;
}
