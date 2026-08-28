import path from "node:path";
import type { Component } from "@veyyon/tui";
import { Container, Markdown, Text } from "@veyyon/tui";
import { formatCount, formatNumber, sanitizeText } from "@veyyon/utils";
import { settings } from "../config/settings-instance";
import { getMarkdownTheme } from "../modes/theme/markdown-theme";
import type { Theme } from "../modes/theme/theme";
import {
	capPreviewLines,
	formatBadge,
	formatDuration,
	formatExpandHint,
	formatMoreItems,
	previewLine,
	previewWindowRows,
	replaceTabs,
	type ToolUIStatus,
	truncateToWidth,
} from "../tools/render-utils";
import { getPriorityInfo, type ReportFindingDetails, type SubmitReviewDetails } from "../tools/review";
import { framedBlock, renderStatusLine } from "../tui";
import { classifySubagentOutcome } from "./outcome";
import {
	agentTypeBadge,
	appendAgentStats,
	extractIncrementalReviewResult,
	extractMissingYieldWarning,
	formatAgentHeaderLabel,
	formatFindingSummary,
	formatTaskId,
	getStatusIcon,
	MAX_NESTED_TASK_RENDER_DEPTH,
	normalizeReportFindings,
	normalizeYieldData,
	renderNestedCycleLine,
	renderOutputSection,
	renderTaskCallLines,
	renderTaskSection,
	renderTypedYieldSections,
	sanitizeRecentOutput,
	type TaskRenderOptions,
	taskFirstLine,
} from "./render-helpers";
import { repairDoubleEncodedJsonString } from "./repair-args";
import { subprocessToolRegistry, YIELD_TOOL_NAME } from "./subprocess-tool-registry";
import type { AgentProgress, SingleResult, TaskItem, TaskParams, TaskToolDetails } from "./types";

export { formatTaskId } from "./render-helpers";

const COLLAPSED_AGENT_LIMIT = 4;

export function renderTaskItemLines(tasks: TaskItem[] | undefined, theme: Theme): string[] {
	if (!Array.isArray(tasks) || tasks.length === 0) return [];

	const bullet = theme.fg("dim", "•");
	const cap = Math.min(tasks.length, COLLAPSED_AGENT_LIMIT);
	const lines: string[] = [];
	for (let i = 0; i < cap; i++) {
		const item = tasks[i] as Partial<TaskItem> | undefined;
		const rawName = typeof item?.name === "string" ? item.name.trim() : "";
		const idLabel = rawName ? formatTaskId(rawName) : `#${i + 1}`;
		let line = `${bullet} ${theme.fg("accent", theme.bold(idLabel))}`;
		const brief = taskFirstLine(item?.task);
		if (brief) {
			line += `: ${theme.fg("muted", previewLine(brief, 64))}`;
		}
		line += agentTypeBadge(item?.agent, theme);
		if (item?.isolated === true) {
			line += theme.fg("dim", " [isolated]");
		}
		lines.push(line);
	}
	if (cap < tasks.length) {
		lines.push(`${bullet} ${theme.fg("dim", formatMoreItems(tasks.length - cap, "agent"))}`);
	}
	return lines;
}

type TaskRenderSection = { label?: string; lines: readonly string[]; separator?: boolean };
type AssignmentSectionRenderer = (width: number) => TaskRenderSection;

const ASSIGNMENT_FRAME_INSET = 3;

function createAssignmentSectionRenderer(
	args: Partial<TaskParams> | undefined,
	theme: Theme,
): AssignmentSectionRenderer | undefined {
	const assignment = sanitizeText(
		repairDoubleEncodedJsonString(typeof args?.task === "string" ? args.task : ""),
	).trim();
	if (!assignment) return undefined;
	return createMarkdownSectionRenderer(assignment, theme);
}

function createContextSectionRenderer(
	args: Partial<TaskParams> | undefined,
	theme: Theme,
): AssignmentSectionRenderer | undefined {
	const context = sanitizeText(
		repairDoubleEncodedJsonString(typeof args?.context === "string" ? args.context : ""),
	).trim();
	if (!context) return undefined;
	return createMarkdownSectionRenderer(context, theme);
}

function createMarkdownSectionRenderer(text: string, theme: Theme): AssignmentSectionRenderer {
	const markdown = new Markdown(text, 0, 0, getMarkdownTheme(), {
		color: line => theme.fg("muted", line),
	});
	return width => ({ lines: markdown.render(Math.max(1, width - ASSIGNMENT_FRAME_INSET)) });
}

export function renderCall(args: TaskParams, options: TaskRenderOptions, theme: Theme): Component {
	const showIsolated = "isolated" in args && args.isolated === true;
	const header = renderStatusLine(
		{
			iconOverride: theme.styledSymbol("tool.task", "accent"),
			title: "Task",
			description: formatAgentHeaderLabel(args),
		},
		theme,
	);
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);
	return framedBlock(theme, width => {
		const sections: Array<{ label?: string; lines: readonly string[]; separator?: boolean }> = [];

		if (!options.renderContext?.hasResult) {
			if (contextSection) sections.push(contextSection(width));
			if (assignmentSection) sections.push(assignmentSection(width));
			const callLines = renderTaskCallLines(args, theme);
			if (callLines.length > 0) sections.push({ separator: true, lines: callLines });
		}

		return {
			header,
			headerMeta: showIsolated ? "isolated" : undefined,
			sections,
			state: "pending",
			borderColor: "borderMuted",
			width,
		};
	});
}

function renderAgentProgress(
	progress: AgentProgress,
	prefix: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	frozen = false,
	seenNestedTasks?: WeakSet<object>,
	nestedDepth = 0,
): string[] {
	const lines: string[] = [];

	const icon = getStatusIcon(progress.status, theme, spinnerFrame);
	const iconColor =
		progress.status === "completed"
			? "success"
			: progress.status === "failed" || progress.status === "aborted"
				? "error"
				: "accent";

	const trimmedDescription = progress.description?.trim();
	const description = trimmedDescription ? previewLine(sanitizeText(trimmedDescription), 64) : undefined;
	const displayId = formatTaskId(progress.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	const indent = prefix ? `${prefix} ` : "";
	let statusLine: string;
	if (progress.status === "running" || progress.status === "pending") {
		const dot = theme.styledSymbol("status.done", frozen ? "dim" : "accent");
		const nameColor = frozen ? "dim" : "accent";
		const name = theme.fg(nameColor, description ? theme.bold(displayId) : displayId);
		statusLine = `${indent}${dot} ${name}`;
		if (description) {
			statusLine += `${theme.fg(nameColor, ":")} ${theme.fg(nameColor, description)}`;
		}
	} else if (progress.status === "completed") {
		statusLine = `${indent}${theme.styledSymbol("status.done", "text")} ${theme.fg("text", titlePart)}`;
	} else {
		statusLine = `${indent}${theme.fg(iconColor, icon)} ${theme.fg("accent", titlePart)}`;
	}
	statusLine += agentTypeBadge(progress.agent, theme);

	if (progress.retryState && progress.status === "running") {
		statusLine += ` ${formatBadge(progress.retryState.mode === "continue" ? "continuing" : "retrying", "warning", theme)}`;
	} else if (progress.retryFailure && (progress.status === "failed" || progress.status === "aborted")) {
		const gaveUp = progress.retryFailure.mode === "continue" ? "continuation gave up" : "retries gave up";
		statusLine += ` ${formatBadge(gaveUp, "error", theme)}`;
	} else if (progress.status === "failed" || progress.status === "aborted") {
		const statusLabel = progress.status === "failed" ? "failed" : "aborted";
		statusLine += ` ${formatBadge(statusLabel, iconColor, theme)}`;
	}

	const showBadge = settings.get("subagent.showResolvedModelBadge");
	if (progress.status === "running") {
		if (!description) {
			const taskPreview = previewLine(sanitizeText(progress.assignment ?? progress.task), 40);
			statusLine += ` ${theme.fg("muted", taskPreview)}`;
		}
		statusLine = appendAgentStats(statusLine, { ...progress, showResolvedModelBadge: showBadge }, theme);
	} else if (progress.status === "completed") {
		statusLine = appendAgentStats(statusLine, { ...progress, showResolvedModelBadge: showBadge }, theme);
	}

	lines.push(statusLine);

	const rl = renderTaskSection(progress.assignment ?? progress.task, continuePrefix, expanded, theme);
	for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);

	if (progress.status === "running") {
		if (progress.currentTool) {
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("muted", sanitizeText(progress.currentTool))}`;
			const toolDetail = progress.lastIntent ?? progress.currentToolArgs;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", previewLine(sanitizeText(toolDetail), 40))}`;
			}
			if (progress.currentToolStartMs) {
				const elapsed = Date.now() - progress.currentToolStartMs;
				if (elapsed > 5000) {
					toolLine += `${theme.sep.dot}${theme.fg("warning", formatDuration(elapsed))}`;
				}
			}
			lines.push(toolLine);
		} else if (progress.recentTools.length > 0) {
			const recent = progress.recentTools[0];
			let toolLine = `${continuePrefix}${theme.tree.hook} ${theme.fg("dim", sanitizeText(recent.tool))}`;
			const toolDetail = progress.lastIntent ?? recent.args;
			if (toolDetail) {
				toolLine += `: ${theme.fg("dim", previewLine(sanitizeText(toolDetail), 40))}`;
			}
			lines.push(toolLine);
		}
	}

	if (progress.retryState && progress.status === "running") {
		const remainingMs = Math.max(0, progress.retryState.startedAtMs + progress.retryState.delayMs - Date.now());
		const waitLabel = remainingMs > 0 ? `in ${formatDuration(remainingMs)}` : "now";
		const verb = progress.retryState.mode === "continue" ? "continuing" : "retrying";
		const summary =
			`${verb} ${progress.retryState.attempt}/${progress.retryState.maxAttempts} ${waitLabel}: ` +
			previewLine(sanitizeText(progress.retryState.errorMessage), 60);
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("warning", summary)}`);
	} else if (progress.retryFailure && progress.status !== "running") {
		const gaveUp = progress.retryFailure.mode === "continue" ? "continuation" : "auto-retry";
		const summary = `${gaveUp} gave up after ${formatCount("attempt", progress.retryFailure.attempt)}: ${previewLine(sanitizeText(progress.retryFailure.errorMessage), 80)}`;
		lines.push(`${continuePrefix}${theme.tree.hook} ${theme.fg("error", summary)}`);
	}

	if (progress.extractedToolData) {
		if (progress.status === "completed") {
			const completeData = normalizeYieldData(progress.extractedToolData.yield);
			const incrementalReview = extractIncrementalReviewResult(completeData);
			const reportFindingData = normalizeReportFindings(progress.extractedToolData.report_finding);
			if (incrementalReview) {
				lines.push(
					...renderReviewResult(
						incrementalReview.summary,
						incrementalReview.findings,
						continuePrefix,
						expanded,
						theme,
					),
				);
				return lines; // Review result handles its own rendering
			}
			const reviewData = completeData
				.map(c => c.data as SubmitReviewDetails)
				.filter(d => d && typeof d === "object" && "overall_correctness" in d);
			if (reviewData.length > 0) {
				const summary = reviewData[reviewData.length - 1];
				const findings = reportFindingData;
				const rl = renderReviewResult(summary, findings, continuePrefix, expanded, theme);
				for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
				return lines; // Review result handles its own rendering
			}
		}

		for (const toolName in progress.extractedToolData) {
			const dataArray = progress.extractedToolData[toolName];
			if (toolName === YIELD_TOOL_NAME) {
				const rl = renderTypedYieldSections(dataArray, continuePrefix, expanded, theme);
				for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
				continue;
			}

			if (toolName === "report_finding") {
				const findings = normalizeReportFindings(dataArray);
				if (findings.length === 0) continue;
				lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);
				const rl = renderFindings(findings, continuePrefix, expanded, theme);
				for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
				continue;
			}

			if (toolName === "task") continue;

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderInline) {
				const displayCount = expanded ? (dataArray as unknown[]).length : 3;
				const recentData = (dataArray as unknown[]).slice(-displayCount);
				for (const data of recentData) {
					const component = handler.renderInline(data, theme);
					if (component instanceof Text) {
						lines.push(`${continuePrefix}${component.getText()}`);
					}
				}
				if ((dataArray as unknown[]).length > displayCount) {
					lines.push(
						`${continuePrefix}${theme.fg(
							"dim",
							formatMoreItems((dataArray as unknown[]).length - displayCount, "item"),
						)}`,
					);
				}
			}
		}
	}

	const completedTaskCalls = (progress.extractedToolData?.task as TaskToolDetails[] | undefined) ?? [];
	const inflight = progress.inflightTaskDetails;
	if (completedTaskCalls.length > 0 || inflight) {
		const snapshots = inflight ? completedTaskCalls.concat([inflight]) : completedTaskCalls;
		const nestedLines = renderNestedTaskTree(
			snapshots,
			expanded,
			theme,
			spinnerFrame,
			frozen,
			seenNestedTasks,
			nestedDepth,
		);
		for (const line of nestedLines) {
			lines.push(`${continuePrefix}${line}`);
		}
	}

	if (expanded && progress.status === "running") {
		const previewRows = previewWindowRows();
		const output = capPreviewLines(
			sanitizeRecentOutput(progress.recentOutput.slice().reverse().join("\n")).split("\n"),
			theme,
			{
				max: previewRows,
				expandHint: false,
			},
		).join("\n");
		const rl = renderOutputSection(output, continuePrefix, expanded, theme, 2, previewRows);
		for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
	}

	return lines;
}

function renderReviewResult(
	summary: SubmitReviewDetails,
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	const verdictColor = summary.overall_correctness === "correct" ? "success" : "error";
	const isCorrect = summary.overall_correctness === "correct";
	const verdictIcon = isCorrect
		? theme.styledSymbol("status.done", "accent")
		: theme.fg(verdictColor, theme.status.error);
	lines.push(
		`${continuePrefix} Patch is ${theme.fg(verdictColor, summary.overall_correctness)} ${verdictIcon} ${theme.fg(
			"dim",
			`(${(summary.confidence * 100).toFixed(0)}% confidence)`,
		)}`,
	);

	if (summary.explanation) {
		if (expanded) {
			lines.push(`${continuePrefix}${theme.fg("dim", "Summary")}`);
			const explanationLines = sanitizeText(summary.explanation).split("\n");
			for (const line of explanationLines) {
				lines.push(`${continuePrefix}  ${theme.fg("dim", replaceTabs(line))}`);
			}
		} else {
			const flat = replaceTabs(sanitizeText(summary.explanation)).replace(/[\r\n]+/g, " ");
			const firstSentence = flat.split(/[.!?]/)[0].trim();
			const preview = truncateToWidth(`${firstSentence}.`, 100);
			lines.push(`${continuePrefix}${theme.fg("dim", preview)}`);
		}
	}

	lines.push(`${continuePrefix}${formatFindingSummary(findings, theme)}`);

	if (findings.length > 0) {
		const rl = renderFindings(findings, continuePrefix, expanded, theme);
		for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
	}

	return lines;
}

function renderFindings(
	findings: ReportFindingDetails[],
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
): string[] {
	const lines: string[] = [];

	const sortedFindings = expanded
		? findings
		: findings.slice().sort((a, b) => getPriorityInfo(a.priority).ord - getPriorityInfo(b.priority).ord);
	const displayCount = expanded ? sortedFindings.length : Math.min(3, sortedFindings.length);

	for (let i = 0; i < displayCount; i++) {
		const finding = sortedFindings[i];
		const isLastFinding = i === displayCount - 1 && (expanded || sortedFindings.length <= 3);
		const findingPrefix = isLastFinding ? theme.tree.last : theme.tree.branch;
		const findingContinue = isLastFinding ? "   " : `${theme.tree.vertical}  `;

		const { color } = getPriorityInfo(finding.priority);
		const rawTitle = sanitizeText(finding.title?.replace(/^\[P\d\]\s*/, "") ?? "Untitled");
		const titleText = replaceTabs(rawTitle).replace(/[\r\n]+/g, " ");
		const loc = `${path.basename(sanitizeText(finding.file_path || "<unknown>"))}:${finding.line_start}`;

		lines.push(
			`${continuePrefix}${findingPrefix} ${theme.fg(color, `[${finding.priority}]`)} ${titleText} ${theme.fg("dim", loc)}`,
		);

		if (expanded && finding.body) {
			const bodyLines = sanitizeText(finding.body).split("\n");
			for (const bodyLine of bodyLines) {
				lines.push(`${continuePrefix}${findingContinue}${theme.fg("dim", replaceTabs(bodyLine))}`);
			}
		}
	}

	if (!expanded && findings.length > 3) {
		lines.push(`${continuePrefix}${theme.fg("dim", formatMoreItems(findings.length - 3, "finding"))}`);
	}

	return lines;
}

function renderAgentResult(
	result: SingleResult,
	prefix: string,
	continuePrefix: string,
	expanded: boolean,
	theme: Theme,
	seenNestedTasks?: WeakSet<object>,
	nestedDepth = 0,
): string[] {
	const lines: string[] = [];

	const { warning: missingCompleteWarning, rest: outputWithoutWarning } = extractMissingYieldWarning(result.output);
	const outcome = classifySubagentOutcome(result);
	const aborted = outcome.kind === "aborted";
	const mergeFailed = outcome.kind === "merge-failed";
	const success = outcome.kind === "completed";
	const needsWarning = Boolean(missingCompleteWarning) && success;
	const icon = aborted
		? theme.status.aborted
		: needsWarning
			? theme.status.warning
			: success
				? theme.styledSymbol("status.done", "text")
				: theme.status.error;
	const iconColor = needsWarning ? "warning" : success ? "success" : mergeFailed ? "warning" : "error";
	const statusText = aborted
		? "aborted"
		: needsWarning
			? "warning"
			: success
				? "done"
				: mergeFailed
					? "merge failed"
					: "failed";

	const trimmedDescription = result.description ? sanitizeText(result.description).trim() : undefined;
	const description = trimmedDescription ? previewLine(trimmedDescription, 64) : undefined;
	const displayId = formatTaskId(result.id);
	const titlePart = description ? `${theme.bold(displayId)}: ${description}` : displayId;
	let statusLine = `${prefix ? `${prefix} ` : ""}${theme.fg(iconColor, icon)} ${theme.fg(
		success && !needsWarning ? "text" : "accent",
		titlePart,
	)}${agentTypeBadge(result.agent, theme)} ${formatBadge(statusText, iconColor, theme)}`;
	const showBadge = settings.get("subagent.showResolvedModelBadge");
	statusLine = appendAgentStats(
		statusLine,
		{
			tokens: result.tokens,
			requests: result.requests,
			contextTokens: result.contextTokens,
			contextWindow: result.contextWindow,
			cost: result.usage?.cost.total ?? 0,
			resolvedModel: result.resolvedModel,
			showResolvedModelBadge: showBadge,
		},
		theme,
	);
	statusLine += `${theme.sep.dot}${theme.fg("dim", formatDuration(result.durationMs))}`;

	if (result.truncated) {
		statusLine += ` ${theme.fg("warning", "[truncated]")}`;
	}

	lines.push(statusLine);

	const rl = renderTaskSection(result.assignment ?? result.task, continuePrefix, expanded, theme);
	for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);

	if (aborted && result.abortReason) {
		lines.push(
			`${continuePrefix}${theme.fg("error", theme.status.aborted)} ${theme.fg(
				"dim",
				previewLine(sanitizeText(result.abortReason), 80),
			)}`,
		);
	}
	const completeData = normalizeYieldData(result.extractedToolData?.yield);
	const reportFindingData = normalizeReportFindings(result.extractedToolData?.report_finding);
	const incrementalReview = extractIncrementalReviewResult(completeData);

	if (incrementalReview) {
		lines.push(
			...renderReviewResult(incrementalReview.summary, incrementalReview.findings, continuePrefix, expanded, theme),
		);
		return lines;
	}

	const reviewData = completeData
		.map(c => c.data as SubmitReviewDetails)
		.filter(d => d && typeof d === "object" && "overall_correctness" in d);
	const submitReviewData = reviewData.length > 0 ? reviewData : undefined;

	if (submitReviewData) {
		const summary = submitReviewData[submitReviewData.length - 1];
		const findings = reportFindingData;
		const rl = renderReviewResult(summary, findings, continuePrefix, expanded, theme);
		for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
		return lines;
	}
	if (reportFindingData.length > 0) {
		const hasCompleteData = completeData.length > 0;
		const message = hasCompleteData
			? "Review verdict missing expected fields"
			: "Review incomplete (yield not called)";
		lines.push(`${continuePrefix}${theme.fg("warning", theme.status.warning)} ${theme.fg("dim", message)}`);
		lines.push(`${continuePrefix}${formatFindingSummary(reportFindingData, theme)}`);
		const rl = renderFindings(reportFindingData, continuePrefix, expanded, theme);
		for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
		return lines;
	}

	let hasCustomRendering = false;
	const deferredToolLines: string[] = [];
	if (result.extractedToolData) {
		for (const toolName in result.extractedToolData) {
			const dataArray = result.extractedToolData[toolName];
			if (toolName === YIELD_TOOL_NAME) {
				const yieldLines = renderTypedYieldSections(dataArray, continuePrefix, expanded, theme);
				if (yieldLines.length > 0) {
					hasCustomRendering = true;
					const yl = yieldLines;
					for (let li = 0; li < yl.length; li++) lines.push(yl[li]!);
				}
				continue;
			}
			if (toolName === "report_finding") continue;

			const isTaskTool = toolName === "task";
			if (isTaskTool && (dataArray as unknown[]).length > 0) {
				for (const line of renderNestedTaskResults(
					dataArray as TaskToolDetails[],
					expanded,
					theme,
					seenNestedTasks,
					nestedDepth,
				)) {
					deferredToolLines.push(`${continuePrefix}${line}`);
				}
				continue;
			}

			const handler = subprocessToolRegistry.getHandler(toolName);
			if (handler?.renderFinal && (dataArray as unknown[]).length > 0) {
				const component = handler.renderFinal(dataArray as unknown[], theme, expanded);
				const target = lines;
				if (!isTaskTool) {
					hasCustomRendering = true;
					target.push(`${continuePrefix}${theme.fg("dim", `Tool: ${toolName}`)}`);
				}
				if (component instanceof Text) {
					const text = component.getText();
					for (const line of text.split("\n")) {
						target.push(`${continuePrefix}${line}`);
					}
				} else if (component instanceof Container) {
					for (const child of (component as Container).children) {
						if (child instanceof Text) {
							target.push(`${continuePrefix}${child.getText()}`);
						}
					}
				}
			}
		}
	}

	if (hasCustomRendering && missingCompleteWarning) {
		lines.push(
			`${continuePrefix}${theme.fg("warning", theme.status.warning)} ${theme.fg(
				"dim",
				truncateToWidth(sanitizeText(missingCompleteWarning), 80),
			)}`,
		);
	}

	if (!hasCustomRendering) {
		lines.push(
			...renderOutputSection(outputWithoutWarning, continuePrefix, expanded, theme, 3, 12, missingCompleteWarning),
		);
	}

	if (deferredToolLines.length > 0) {
		const dl = deferredToolLines;
		for (let li = 0; li < dl.length; li++) lines.push(dl[li]!);
	}

	if (result.patchPath && !aborted && result.exitCode === 0) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Patch: ${result.patchPath}`)}`);
	} else if (result.branchName && !aborted && result.exitCode === 0) {
		lines.push(`${continuePrefix}${theme.fg("dim", `Branch: ${result.branchName}`)}`);
	}

	if (result.error && (!success || mergeFailed) && (!aborted || result.error !== result.abortReason)) {
		lines.push(
			`${continuePrefix}${theme.fg(mergeFailed ? "warning" : "error", previewLine(sanitizeText(result.error), 70))}`,
		);
	}

	return lines;
}

function orderProgressForDisplay(progress: readonly AgentProgress[]): AgentProgress[] {
	const finished: AgentProgress[] = [];
	const unfinished: AgentProgress[] = [];
	for (const p of progress) {
		(p.status === "pending" || p.status === "running" ? unfinished : finished).push(p);
	}
	finished.sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
	return finished.concat(unfinished);
}

function orderResultsForDisplay(results: readonly SingleResult[]): SingleResult[] {
	return results.slice().sort((a, b) => a.durationMs - b.durationMs || a.index - b.index);
}

function formatHiddenProgressLine(hidden: readonly AgentProgress[], theme: Theme): string {
	const counts: Record<AgentProgress["status"], number> = {
		pending: 0,
		running: 0,
		completed: 0,
		failed: 0,
		aborted: 0,
	};
	for (const p of hidden) counts[p.status]++;
	const parts: string[] = [];
	if (counts.completed > 0) parts.push(theme.fg("dim", `${counts.completed} done`));
	if (counts.running > 0) parts.push(theme.fg("dim", `${counts.running} running`));
	if (counts.pending > 0) parts.push(theme.fg("dim", `${counts.pending} pending`));
	if (counts.failed > 0) parts.push(theme.fg("error", `${counts.failed} failed`));
	if (counts.aborted > 0) parts.push(theme.fg("error", `${counts.aborted} aborted`));
	const breakdown =
		parts.length > 0
			? `${theme.fg("dim", " (")}${parts.join(theme.fg("dim", theme.sep.dot))}${theme.fg("dim", ")")}`
			: "";
	const hint = formatExpandHint(theme, false, true);
	return `${theme.fg("dim", formatMoreItems(hidden.length, "agent"))}${breakdown}${hint ? ` ${hint}` : ""}`;
}

function selectCollapsedResults(ordered: readonly SingleResult[]): readonly SingleResult[] {
	if (ordered.length <= COLLAPSED_AGENT_LIMIT) return ordered;
	const picked = new Set<SingleResult>();
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		if (result.aborted || result.exitCode !== 0 || result.error) picked.add(result);
	}
	for (const result of ordered) {
		if (picked.size >= COLLAPSED_AGENT_LIMIT) break;
		picked.add(result);
	}
	return ordered.filter(result => picked.has(result));
}

export function renderResult(
	result: { content: Array<{ type: string; text?: string }>; details?: TaskToolDetails; isError?: boolean },
	options: TaskRenderOptions,
	theme: Theme,
	args?: TaskParams,
): Component {
	const fallbackText = result.content.find(c => c.type === "text")?.text ?? "";
	const details = result.details;
	const agentLabel = formatAgentHeaderLabel(args);
	const assignmentSection = createAssignmentSectionRenderer(args, theme);
	const contextSection = createContextSectionRenderer(args, theme);

	if (!details) {
		const text = result.content.find(c => c.type === "text")?.text || "";
		const errored = result.isError === true;
		const header = errored
			? renderStatusLine({ icon: "error", title: "Task", description: agentLabel }, theme)
			: renderStatusLine(
					{
						iconOverride: theme.styledSymbol("status.done", "accent"),
						title: "Task",
						description: agentLabel,
					},
					theme,
				);
		return framedBlock(theme, width => ({
			header,
			sections: [
				...(contextSection ? [contextSection(width)] : []),
				...(assignmentSection ? [assignmentSection(width)] : []),
				...(text ? [{ separator: true, lines: [theme.fg("dim", truncateToWidth(text, width))] }] : []),
			],
			state: errored ? "error" : "success",
			borderColor: errored ? "error" : "borderMuted",
			width,
		}));
	}

	const hasResults = Boolean(details.results && details.results.length > 0);
	let abortedCount = 0;
	let failCount = 0;
	let mergeFailedCount = 0;
	let successCount = 0;
	let requestTotal = 0;
	if (hasResults) {
		for (const r of details.results) {
			requestTotal += r.requests ?? 0;
			switch (classifySubagentOutcome(r).kind) {
				case "aborted":
					abortedCount++;
					break;
				case "failed":
					failCount++;
					break;
				case "merge-failed":
					mergeFailedCount++;
					break;
				default:
					successCount++;
			}
		}
	}
	const aborted = abortedCount > 0;
	const failed = failCount > 0;
	const mergeFailed = mergeFailedCount > 0;
	const isError = aborted || failed;
	const refusalWarning = details.warning;
	const agentCount = hasResults ? details.results.length : (details.progress?.length ?? 0);
	const icon: ToolUIStatus = options.isPartial
		? "running"
		: refusalWarning
			? "warning"
			: isError
				? "error"
				: mergeFailed
					? "warning"
					: "success";
	const countLabel = agentCount > 0 ? `${agentCount} ${agentCount === 1 ? "agent" : "agents"}` : undefined;
	const metaLabel = countLabel ?? agentLabel;
	const header = renderStatusLine(
		{
			icon: icon === "success" || icon === "running" ? undefined : icon,
			iconOverride:
				icon === "running"
					? theme.styledSymbol("tool.task", "accent")
					: icon === "success"
						? theme.styledSymbol("status.done", "accent")
						: undefined,
			title: "Task",
			meta: metaLabel ? [metaLabel] : undefined,
		},
		theme,
	);

	return framedBlock(theme, width => {
		const { expanded, isPartial, spinnerFrame } = options;
		const frozen = options.renderContext?.frozen === true;
		const lines: string[] = [];

		const shouldRenderProgress =
			Boolean(details.progress && details.progress.length > 0) && details.results.length === 0;
		if (shouldRenderProgress && details.progress) {
			const ordered = orderProgressForDisplay(details.progress);
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			if (visible.length < ordered.length) {
				lines.push(formatHiddenProgressLine(ordered.slice(0, ordered.length - visible.length), theme));
			}
			for (const progress of visible) {
				const rl = renderAgentProgress(progress, "", "  ", expanded, theme, spinnerFrame, frozen);
				for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
			}
		} else if (details.results && details.results.length > 0) {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			for (const res of visible) {
				const rl = renderAgentResult(res, "", "  ", expanded, theme);
				for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
			}
			if (visible.length < ordered.length) {
				const hint = formatExpandHint(theme, false, true);
				lines.push(
					`${theme.fg("dim", formatMoreItems(ordered.length - visible.length, "agent"))}${hint ? ` ${hint}` : ""}`,
				);
			}

			const supplementalProgress = details.progress
				? orderProgressForDisplay(
						details.progress.filter(progress => !details.results.some(res => res.id === progress.id)),
					)
				: [];
			for (const progress of supplementalProgress) {
				const rl = renderAgentProgress(progress, "", "  ", expanded, theme, spinnerFrame, frozen);
				for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
			}

			const summaryParts: string[] = [];
			if (abortedCount > 0) summaryParts.push(theme.fg("error", `${abortedCount} aborted`));
			if (successCount > 0) summaryParts.push(theme.fg("success", `${successCount} succeeded`));
			if (mergeFailedCount > 0) summaryParts.push(theme.fg("warning", `${mergeFailedCount} merge failed`));
			if (failCount > 0) summaryParts.push(theme.fg("error", `${failCount} failed`));
			const totalRequests = requestTotal;
			if (totalRequests > 0) summaryParts.push(theme.fg("dim", `${formatNumber(totalRequests)} req`));
			summaryParts.push(theme.fg("dim", formatDuration(details.totalDurationMs)));
			lines.push(
				theme.fg("dim", theme.format.bracketLeft) +
					summaryParts.join(theme.fg("dim", theme.sep.dot)) +
					theme.fg("dim", theme.format.bracketRight),
			);
		}

		const state = isPartial
			? "running"
			: refusalWarning
				? "warning"
				: isError
					? "error"
					: mergeFailed
						? "warning"
						: "success";
		const borderColor = refusalWarning ? "warning" : isError ? "error" : "borderMuted";

		if (lines.length === 0) {
			const text = fallbackText.trim() ? fallbackText : "No results";
			return {
				header,
				sections: [
					...(contextSection ? [contextSection(width)] : []),
					...(assignmentSection ? [assignmentSection(width)] : []),
					{ separator: true, lines: [theme.fg(refusalWarning ? "warning" : "dim", truncateToWidth(text, width))] },
				],
				state,
				borderColor,
				width,
			};
		}

		if (fallbackText.trim()) {
			const summaryLines = fallbackText.split("\n");
			const markerIndex = summaryLines.findIndex(
				line =>
					line.includes("<system-notification>") ||
					line.startsWith("Applied patches:") ||
					line.startsWith("No changes to apply."),
			);
			if (markerIndex >= 0) {
				const extra = summaryLines.slice(markerIndex);
				for (const line of extra) {
					if (!line.trim()) continue;
					lines.push(theme.fg("dim", line));
				}
			}
		}

		while (lines.length > 0 && lines[0].trim() === "") lines.shift();
		return {
			header,
			sections: [
				...(contextSection ? [contextSection(width)] : []),
				...(assignmentSection ? [assignmentSection(width)] : []),
				...(lines.length > 0 ? [{ separator: true, lines }] : []),
			],
			state,
			borderColor,
			width,
		};
	});
}

function isTaskToolDetails(value: unknown): value is TaskToolDetails {
	return (
		Boolean(value) &&
		typeof value === "object" &&
		"results" in (value as TaskToolDetails) &&
		Array.isArray((value as TaskToolDetails).results)
	);
}

function nestedMarkers(isLast: boolean, theme: Theme): { prefix: string; continuePrefix: string } {
	return {
		prefix: isLast ? theme.fg("dim", theme.tree.last) : theme.fg("dim", theme.tree.branch),
		continuePrefix: isLast ? "   " : `${theme.fg("dim", theme.tree.vertical)}  `,
	};
}

function renderNestedTaskResults(
	detailsList: TaskToolDetails[],
	expanded: boolean,
	theme: Theme,
	seen: WeakSet<object> = new WeakSet<object>(),
	depth = 0,
): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			lines.push(renderNestedCycleLine(theme));
			continue;
		}
		if (depth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			lines.push(theme.fg("dim", "… nested task depth limit reached"));
			continue;
		}
		seen.add(details);
		if (!details.results || details.results.length === 0) {
			seen.delete(details);
			continue;
		}
		const ordered = orderResultsForDisplay(details.results);
		const visible = expanded ? ordered : selectCollapsedResults(ordered);
		const hiddenCount = ordered.length - visible.length;
		visible.forEach((result, index) => {
			const { prefix, continuePrefix } = nestedMarkers(hiddenCount === 0 && index === visible.length - 1, theme);
			const rl = renderAgentResult(result, prefix, continuePrefix, expanded, theme, seen, depth + 1);
			for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
		});
		if (hiddenCount > 0) {
			const { prefix } = nestedMarkers(true, theme);
			lines.push(`${prefix} ${theme.fg("dim", formatMoreItems(hiddenCount, "agent"))}`);
		}
		seen.delete(details);
	}
	return lines;
}

function renderNestedTaskTree(
	detailsList: TaskToolDetails[],
	expanded: boolean,
	theme: Theme,
	spinnerFrame?: number,
	frozen = false,
	seen: WeakSet<object> = new WeakSet<object>(),
	depth = 0,
): string[] {
	const lines: string[] = [];
	for (const details of detailsList) {
		if (seen.has(details)) {
			lines.push(renderNestedCycleLine(theme));
			continue;
		}
		if (depth >= MAX_NESTED_TASK_RENDER_DEPTH) {
			lines.push(theme.fg("dim", "… nested task depth limit reached"));
			continue;
		}
		seen.add(details);
		const hasResults = Boolean(details.results && details.results.length > 0);
		if (hasResults) {
			const ordered = orderResultsForDisplay(details.results);
			const visible = expanded ? ordered : selectCollapsedResults(ordered);
			const hiddenCount = ordered.length - visible.length;
			visible.forEach((result, index) => {
				const { prefix, continuePrefix } = nestedMarkers(hiddenCount === 0 && index === visible.length - 1, theme);
				const rl = renderAgentResult(result, prefix, continuePrefix, expanded, theme, seen, depth + 1);
				for (let li = 0; li < rl.length; li++) lines.push(rl[li]!);
			});
			if (hiddenCount > 0) {
				const { prefix } = nestedMarkers(true, theme);
				lines.push(`${prefix} ${theme.fg("dim", formatMoreItems(hiddenCount, "agent"))}`);
			}
			seen.delete(details);
			continue;
		}
		const inflight = details.progress;
		if (inflight && inflight.length > 0) {
			const ordered = orderProgressForDisplay(inflight);
			const visible = expanded ? ordered : ordered.slice(Math.max(0, ordered.length - COLLAPSED_AGENT_LIMIT));
			const hiddenCount = ordered.length - visible.length;
			visible.forEach((prog, index) => {
				const { prefix, continuePrefix } = nestedMarkers(hiddenCount === 0 && index === visible.length - 1, theme);
				lines.push(
					...renderAgentProgress(
						prog,
						prefix,
						continuePrefix,
						expanded,
						theme,
						spinnerFrame,
						frozen,
						seen,
						depth + 1,
					),
				);
			});
			if (hiddenCount > 0) {
				const { prefix } = nestedMarkers(true, theme);
				lines.push(`${prefix} ${theme.fg("dim", formatMoreItems(hiddenCount, "agent"))}`);
			}
		}
		seen.delete(details);
	}
	return lines;
}

subprocessToolRegistry.register<TaskToolDetails>("task", {
	extractData: event => {
		const details = event.result?.details;
		return isTaskToolDetails(details) ? details : undefined;
	},
	renderFinal: (allData, theme, expanded) => {
		const lines = renderNestedTaskResults(allData, expanded, theme);
		return new Text(lines.join("\n"), 0, 0);
	},
});
