import { formatNumber, isRecord, sanitizeText } from "@veyyon/utils";
import { EXIT_CODE_NOTICE_RE } from "../exec/exit-notice";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { modelBadgeFromSelector } from "../modes/components/agent-model-badge";
import { formatContextUsage } from "../modes/components/status-line/context-thresholds";
import type { Theme } from "../modes/theme/theme";
import { stripGeneratedOutputNotice, stripRawOutputArtifactNotice } from "../tools/output-meta";
import { formatMoreItems, formatStatusIcon, previewLine, replaceTabs, truncateToWidth } from "../tools/render-utils";
import {
	type FindingPriority,
	getPriorityInfo,
	PRIORITY_LABELS,
	parseReportFindingDetails,
	type ReportFindingDetails,
	type SubmitReviewDetails,
} from "../tools/review";
import { buildTreePrefix } from "../tui/utils";
import { renderTaskItemLines } from "./render";
import { DEFAULT_SPAWN_AGENT } from "./spawn-policy";
import type { AgentProgress, TaskParams, YieldItem } from "./types";
import { assembleYieldResult } from "./yield-assembly";

export interface TaskRenderContext {
	hasResult?: boolean;
	frozen?: boolean;
}
export type TaskRenderOptions = RenderResultOptions & { renderContext?: TaskRenderContext };

export const MAX_NESTED_TASK_RENDER_DEPTH = 8;

export function renderNestedCycleLine(theme: Theme): string {
	return theme.fg("dim", "… nested task progress already shown");
}

export function getStatusIcon(status: AgentProgress["status"], theme: Theme, spinnerFrame?: number): string {
	switch (status) {
		case "pending":
			return formatStatusIcon("pending", theme);
		case "running":
			return formatStatusIcon("running", theme, spinnerFrame);
		case "completed":
			return formatStatusIcon("success", theme);
		case "failed":
			return formatStatusIcon("error", theme);
		case "aborted":
			return formatStatusIcon("aborted", theme);
	}
}

export function appendAgentStats(
	line: string,
	opts: {
		toolCount?: number;
		requests?: number;
		tokens: number;
		contextTokens?: number;
		contextWindow?: number;
		cost: number;
		resolvedModel?: string;
		showResolvedModelBadge?: boolean;
	},
	theme: Theme,
): string {
	if (opts.toolCount) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(opts.toolCount)} ${theme.icon.extensionTool}`)}`;
	}
	if (opts.requests) {
		line += `${theme.sep.dot}${theme.fg("dim", `${formatNumber(opts.requests)} req`)}`;
	}
	if (opts.contextTokens && opts.contextTokens > 0) {
		const ctx = formatContextUsage(opts.contextTokens, opts.contextWindow ?? 0);
		line += `${theme.sep.dot}${theme.fg("dim", ctx)}`;
	}
	if (opts.cost > 0) {
		line += `${theme.sep.dot}${theme.fg("statusLineCost", `$${opts.cost.toFixed(2)}`)}`;
	}
	if (opts.resolvedModel && opts.showResolvedModelBadge) {
		line += `${theme.sep.dot}${truncateToWidth(modelBadgeFromSelector(opts.resolvedModel, theme), 30)}`;
	}
	return line;
}

export function formatFindingSummary(findings: ReportFindingDetails[], theme: Theme): string {
	if (findings.length === 0) return theme.fg("dim", "Findings: none");

	const counts: { [P in FindingPriority]?: number } = {};
	for (const finding of findings) {
		counts[finding.priority] = (counts[finding.priority] ?? 0) + 1;
	}

	const parts: string[] = [];
	for (const label of PRIORITY_LABELS) {
		const { symbol, color } = getPriorityInfo(label);
		const count = counts[label] ?? 0;
		const text = theme.fg(color, `${label}:${count}`);
		parts.push(theme.styledSymbol(symbol, color) ? `${theme.styledSymbol(symbol, color)} ${text}` : text);
	}

	return `${theme.fg("dim", "Findings:")} ${parts.join(theme.sep.dot)}`;
}

export function normalizeReportFindings(value: unknown): ReportFindingDetails[] {
	if (!Array.isArray(value)) return [];
	const findings: ReportFindingDetails[] = [];
	for (const item of value) {
		const finding = parseReportFindingDetails(item);
		if (finding) findings.push(finding);
	}
	return findings;
}

export const REVIEWER_ARRAY_LABELS: ReadonlySet<string> = new Set(["findings"]);

export function extractIncrementalReviewResult(
	items: RenderYieldItem[],
): { summary: SubmitReviewDetails; findings: ReportFindingDetails[] } | undefined {
	const yieldItems: YieldItem[] = items.map(item => ({
		data: item.data,
		type: item.type,
		status: item.status === "aborted" ? "aborted" : item.status === "success" ? "success" : undefined,
		useLastTurn: item.useLastTurn,
	}));
	const assembled = assembleYieldResult(yieldItems, undefined, REVIEWER_ARRAY_LABELS);
	const data = assembled?.data;
	if (!isRecord(data)) return undefined;
	const record = data as Record<string, unknown>;
	const overallCorrectness = record.overall_correctness;
	const explanation = record.explanation;
	const confidence = record.confidence;
	if (
		(overallCorrectness !== "correct" && overallCorrectness !== "incorrect") ||
		typeof explanation !== "string" ||
		typeof confidence !== "number"
	) {
		return undefined;
	}
	return {
		summary: {
			overall_correctness: overallCorrectness,
			explanation,
			confidence,
		},
		findings: normalizeReportFindings(record.findings),
	};
}

export interface RenderYieldItem {
	data?: unknown;
	type?: string | string[];
	status?: string;
	useLastTurn?: boolean;
}

export function normalizeYieldData(value: unknown): RenderYieldItem[] {
	const items = Array.isArray(value) ? value : value !== null && typeof value === "object" ? [value] : [];
	const normalized: RenderYieldItem[] = [];
	for (const item of items) {
		if (item === null || typeof item !== "object") continue;
		const record = item as Record<string, unknown>;
		const typeValue = record.type;
		let type: RenderYieldItem["type"];
		if (typeof typeValue === "string") {
			type = typeValue;
		} else if (Array.isArray(typeValue)) {
			const labels: string[] = [];
			let allLabels = true;
			for (const label of typeValue) {
				if (typeof label !== "string") {
					allLabels = false;
					break;
				}
				labels.push(label);
			}
			if (allLabels) type = labels;
		}
		normalized.push({
			data: record.data,
			type,
			status: typeof record.status === "string" ? record.status : undefined,
			useLastTurn: record.useLastTurn === true ? true : undefined,
		});
	}
	return normalized;
}

export function getRenderYieldLabels(type: RenderYieldItem["type"]): string[] {
	if (typeof type === "string") {
		const label = type.trim();
		return label ? [label] : [];
	}
	if (!Array.isArray(type)) return [];
	const labels: string[] = [];
	for (const value of type) {
		const label = value.trim();
		if (label) labels.push(label);
	}
	return labels;
}

export function formatYieldPreview(item: RenderYieldItem): string {
	if (item.useLastTurn === true && item.data === undefined) return "last assistant turn";
	if (item.data === undefined) return "last assistant turn";
	if (typeof item.data === "string") return previewLine(replaceTabs(sanitizeText(item.data)), 70);
	try {
		return previewLine(replaceTabs(sanitizeText(JSON.stringify(item.data) ?? "null")), 70);
	} catch {
		return previewLine(replaceTabs(sanitizeText(String(item.data))), 70);
	}
}

export function renderTypedYieldSections(
	value: unknown,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const typedItems: Array<{ item: RenderYieldItem; labels: string[] }> = [];
	for (const item of normalizeYieldData(value)) {
		const labels = getRenderYieldLabels(item.type);
		if (labels.length === 0) continue;
		typedItems.push({ item, labels });
	}
	const displayCount = expanded ? typedItems.length : 3;
	const lines: string[] = [];
	for (const { item, labels } of typedItems.slice(-displayCount)) {
		const terminal = !Array.isArray(item.type);
		const prefix = terminal ? "yield" : "yield+";
		const label = `${prefix}[${labels.join(", ")}]`;
		lines.push(`${continuePrefix}${theme.fg("dim", label)}: ${theme.fg("dim", formatYieldPreview(item))}`);
	}
	if (typedItems.length > displayCount) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(typedItems.length - displayCount, "yield"))}`);
	}
	return lines;
}

export function formatJsonScalar(value: unknown, _theme: Theme): string {
	if (value === null) return "null";
	if (typeof value === "string") {
		const trimmed = truncateToWidth(sanitizeText(value), 70);
		return `"${trimmed}"`;
	}
	if (typeof value === "number" || typeof value === "boolean") return String(value);
	return "";
}

export function formatTaskId(id: string): string {
	const sanitizedId = sanitizeText(id);
	const segments = sanitizedId.split(".");
	return segments.length < 2 ? sanitizedId : segments.join(">");
}

export const MISSING_YIELD_WARNING_PREFIX = "SYSTEM WARNING: Subagent exited without calling yield tool";

export function extractMissingYieldWarning(output: string): { warning?: string; rest: string } {
	const lines = output.split("\n");
	const firstLine = lines[0]?.trim() ?? "";
	if (!firstLine.startsWith(MISSING_YIELD_WARNING_PREFIX)) {
		return { rest: output };
	}
	const rest = lines
		.slice(1)
		.join("\n")
		.replace(/^\s*\n+/, "");
	return { warning: firstLine, rest };
}

export function renderJsonTreeLines(
	value: unknown,
	theme: Theme,
	maxDepth: number,
	maxLines: number,
): { lines: string[]; truncated: boolean } {
	const lines: string[] = [];
	let truncated = false;

	const iconObject = theme.styledSymbol("icon.folder", "muted");
	const iconArray = theme.styledSymbol("icon.package", "muted");
	const iconScalar = theme.styledSymbol("icon.file", "muted");

	const pushLine = (line: string) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return false;
		}
		lines.push(line);
		return true;
	};

	const renderNode = (val: unknown, key: string | undefined, ancestors: boolean[], isLast: boolean, depth: number) => {
		if (lines.length >= maxLines) {
			truncated = true;
			return;
		}

		const connector = isLast ? theme.tree.last : theme.tree.branch;
		const prefix = `${buildTreePrefix(ancestors, theme)}${theme.fg("dim", connector)} `;
		const scalar = formatJsonScalar(val, theme);

		if (scalar) {
			const label = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "value");
			pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", scalar)}`);
			return;
		}

		if (Array.isArray(val)) {
			const header = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "array");
			pushLine(`${prefix}${iconArray} ${header}`);
			if (val.length === 0) {
				pushLine(
					`${buildTreePrefix(ancestors.concat(!isLast), theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"[]",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix(ancestors.concat(!isLast), theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = ancestors.concat(!isLast);
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, nextAncestors, i === val.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		if (val && typeof val === "object") {
			const header = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "object");
			pushLine(`${prefix}${iconObject} ${header}`);
			const entries = Object.entries(val as Record<string, unknown>);
			if (entries.length === 0) {
				pushLine(
					`${buildTreePrefix(ancestors.concat(!isLast), theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"{}",
					)}`,
				);
				return;
			}
			if (depth >= maxDepth) {
				pushLine(
					`${buildTreePrefix(ancestors.concat(!isLast), theme)}${theme.fg("dim", theme.tree.last)} ${theme.fg(
						"dim",
						"…",
					)}`,
				);
				return;
			}
			const nextAncestors = ancestors.concat(!isLast);
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, nextAncestors, i === entries.length - 1, depth + 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}

		const label = key ? theme.fg("muted", sanitizeText(key)) : theme.fg("muted", "value");
		pushLine(`${prefix}${iconScalar} ${label}: ${theme.fg("dim", sanitizeText(String(val)))}`);
	};

	const renderRoot = (val: unknown) => {
		if (Array.isArray(val)) {
			for (let i = 0; i < val.length; i++) {
				renderNode(val[i], `[${i}]`, [], i === val.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		if (val && typeof val === "object") {
			const entries = Object.entries(val as Record<string, unknown>);
			for (let i = 0; i < entries.length; i++) {
				const [childKey, child] = entries[i];
				renderNode(child, childKey, [], i === entries.length - 1, 1);
				if (lines.length >= maxLines) {
					truncated = true;
					return;
				}
			}
			return;
		}
		renderNode(val, undefined, [], true, 0);
	};

	renderRoot(value);

	return { lines, truncated };
}

export const BASH_WALL_TIME_NOTICE_RE = /^Wall time: \d+(?:\.\d+)? seconds$/u;

export function stripRecentOutputNoticeLine(text: string): string {
	const trimmed = text.trimEnd();
	const lineStart = trimmed.lastIndexOf("\n");
	const candidateStart = lineStart === -1 ? 0 : lineStart + 1;
	const line = trimmed.slice(candidateStart);
	if (!BASH_WALL_TIME_NOTICE_RE.test(line) && !EXIT_CODE_NOTICE_RE.test(line)) return text;
	return trimmed.slice(0, lineStart === -1 ? 0 : lineStart).trimEnd();
}

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

export function renderOutputSection(
	output: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxCollapsed = 3,
	maxExpanded = 10,
	warning?: string,
): string[] {
	const lines: string[] = [];
	const sanitizedOutput = sanitizeText(output);
	const trimmedOutput = sanitizedOutput.trimEnd();
	if (!trimmedOutput && !warning) return lines;

	if (warning) {
		lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
		lines.push(
			`${continuePrefix}  ${theme.fg("warning", theme.status.warning)} ${theme.fg(
				"dim",
				truncateToWidth(sanitizeText(warning), 80),
			)}`,
		);

		if (!trimmedOutput) {
			return lines;
		}

		if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
			try {
				const parsed = JSON.parse(trimmedOutput);

				if (!expanded) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", formatOutputInline(parsed, theme))}`);
					return lines;
				}

				const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
				if (tree.lines.length > 0) {
					for (const line of tree.lines) {
						lines.push(`${continuePrefix}  ${line}`);
					}
					if (tree.truncated) {
						lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
					}
					return lines;
				}
			} catch {}
		}

		const outputLines = trimmedOutput.split("\n");
		const previewCount = expanded ? maxExpanded : maxCollapsed;
		for (const line of outputLines.slice(0, previewCount)) {
			lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
		}

		if (outputLines.length > previewCount) {
			lines.push(
				`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`,
			);
		}

		return lines;
	}

	if (trimmedOutput.startsWith("{") || trimmedOutput.startsWith("[")) {
		try {
			const parsed = JSON.parse(trimmedOutput);

			if (!expanded) {
				lines.push(`${continuePrefix}${theme.fg("dim", formatOutputInline(parsed, theme))}`);
				return lines;
			}

			lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);
			const tree = renderJsonTreeLines(parsed, theme, expanded ? 6 : 2, expanded ? 24 : 6);
			if (tree.lines.length > 0) {
				for (const line of tree.lines) {
					lines.push(`${continuePrefix}  ${line}`);
				}
				if (tree.truncated) {
					lines.push(`${continuePrefix}  ${theme.fg("dim", "…")}`);
				}
				return lines;
			}
		} catch {}
	}

	lines.push(`${continuePrefix}${theme.fg("dim", "Output")}`);

	const outputLines = trimmedOutput.split("\n");
	const previewCount = expanded ? maxExpanded : maxCollapsed;
	for (const line of outputLines.slice(0, previewCount)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}

	if (outputLines.length > previewCount) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(outputLines.length - previewCount, "line"))}`);
	}

	return lines;
}

export function renderTaskSection(
	task: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	maxExpanded = 20,
): string[] {
	const lines: string[] = [];
	const trimmed = sanitizeText(task).trim();
	if (!expanded || !trimmed) return lines;

	lines.push(`${continuePrefix}${theme.fg("dim", "Task")}`);
	const taskLines = trimmed.split("\n");
	for (const line of taskLines.slice(0, maxExpanded)) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", truncateToWidth(replaceTabs(line), 70))}`);
	}
	if (taskLines.length > maxExpanded) {
		lines.push(`${continuePrefix}  ${theme.fg("dim", formatMoreItems(taskLines.length - maxExpanded, "line"))}`);
	}

	return lines;
}

export function formatScalarInline(value: unknown, maxLen: number, _theme: Theme): string {
	if (value === null) return "null";
	if (value === undefined) return "undefined";
	if (typeof value === "boolean") return String(value);
	if (typeof value === "number") return String(value);
	if (typeof value === "string") {
		const sanitizedValue = sanitizeText(value);
		let firstNl = -1;
		let lineCount = 1;
		for (let i = 0; i < sanitizedValue.length; i++) {
			if (sanitizedValue.charCodeAt(i) === 0x0a) {
				if (firstNl === -1) firstNl = i;
				lineCount++;
			}
		}
		const firstLine = (firstNl === -1 ? sanitizedValue : sanitizedValue.slice(0, firstNl)).trim();
		if (firstLine.length === 0) return `"" (${lineCount} lines)`;
		const preview = truncateToWidth(firstLine, maxLen);
		if (firstNl !== -1) return `"${preview}…" (${lineCount} lines)`;
		return `"${preview}"`;
	}
	if (Array.isArray(value)) return `[${value.length} items]`;
	if (typeof value === "object") {
		const keys = Object.keys(value);
		return `{${keys.length} keys}`;
	}
	return sanitizeText(String(value));
}

export function formatOutputInline(data: unknown, theme: Theme, maxWidth = 80): string {
	if (data === null || data === undefined) return "Output: none";

	if (typeof data !== "object") {
		return `Output: ${formatScalarInline(data, 60, theme)}`;
	}

	if (Array.isArray(data)) {
		if (data.length === 0) return "Output: []";
		const preview = formatScalarInline(data[0], 40, theme);
		return `Output: [${data.length} items] ${preview}${data.length > 1 ? "…" : ""}`;
	}

	const entries = Object.entries(data as Record<string, unknown>);
	if (entries.length === 0) return "Output: {}";

	const pairs: string[] = [];
	let totalLen = "Output: ".length;

	for (const [key, value] of entries) {
		const valueStr = formatScalarInline(value, 24, theme);
		const pairStr = `${sanitizeText(key)}=${valueStr}`;
		const addLen = pairs.length > 0 ? pairStr.length + 2 : pairStr.length; // +2 for ", "

		if (totalLen + addLen > maxWidth && pairs.length > 0) {
			pairs.push("…");
			break;
		}

		pairs.push(pairStr);
		totalLen += addLen;
	}

	return `Output: ${pairs.join(", ")}`;
}

export function taskFirstLine(task: unknown): string {
	if (typeof task !== "string") return "";
	const trimmed = sanitizeText(task).trim();
	const newline = trimmed.indexOf("\n");
	return newline === -1 ? trimmed : trimmed.slice(0, newline);
}

export function formatAgentHeaderLabel(args: Partial<TaskParams> | undefined): string | undefined {
	if (!args) return undefined;
	const flat = typeof args.agent === "string" ? args.agent.trim() : "";
	return flat || undefined;
}

export function agentTypeBadge(agent: string | undefined, theme: Theme): string {
	const trimmed = agent?.trim();
	if (!trimmed || trimmed === DEFAULT_SPAWN_AGENT) return "";
	return ` ${theme.fg("dim", `${theme.format.bracketLeft}${trimmed}${theme.format.bracketRight}`)}`;
}

export function renderTaskCallLines(args: Partial<TaskParams> | undefined, theme: Theme): string[] {
	if (!args) return [];
	const bullet = theme.fg("dim", "•");
	const lines: string[] = [];

	const rawName = typeof args.name === "string" ? args.name.trim() : "";
	const idLabel = rawName ? formatTaskId(rawName) : "";
	const brief = taskFirstLine(args.task);
	if (idLabel || brief) {
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel || "agent"))}`;
		if (brief) {
			line += `: ${theme.fg("muted", previewLine(brief, 64))}`;
		}
		line += agentTypeBadge(args.agent, theme);
		lines.push(line);
	}
	const rl = renderTaskItemLines(args.tasks, theme);
	for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
	return lines;
}
