/**
 * Terminal drawing for the job tool. The tool half in `job.ts` decides what
 * happened; this half decides how a terminal shows it, and is the only one of the two
 * that reaches the TUI.
 */

import type { Component } from "@veyyon/tui";
import { Text } from "@veyyon/tui";
import { formatCount } from "@veyyon/utils";
import { stripTaskResultEnvelope } from "@veyyon/wire/task-result";
import type { RenderResultOptions } from "../extensibility/custom-tools/types";
import { shimmerEnabled, shimmerText } from "../theme/shimmer";
import type { Theme } from "../theme/theme";
import { Ellipsis, Hasher, type RenderCache, renderStatusLine, renderTreeList, truncateToWidth } from "../tui";
import { type AgentActivitySnapshot, COLLAPSED_LIST_LIMIT, type JobSnapshot, type JobToolDetails } from "./job";
import {
	formatBadge,
	formatDuration,
	formatEmptyMessage,
	formatStatusIcon,
	getPreviewLines,
	replaceTabs,
	type ToolUIColor,
	type ToolUIStatus,
} from "./render-utils";

// =============================================================================
// TUI Renderer
// =============================================================================

interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
	list?: boolean;
}

const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;

function statusToIcon(status: JobSnapshot["status"]): ToolUIStatus {
	switch (status) {
		case "completed":
			return "done";
		case "failed":
			return "error";
		case "cancelled":
			return "aborted";
		case "running":
			return "running";
	}
}

function statusToColor(status: JobSnapshot["status"]): ToolUIColor {
	switch (status) {
		case "completed":
			return "success";
		case "failed":
			return "error";
		case "cancelled":
			return "warning";
		case "running":
			return "accent";
	}
}

/**
 * Pretty-printed JSON output wastes the collapsed one-line preview on a lone
 * "{" — flatten structured-looking bodies onto a single line. Slice first:
 * downstream truncation keeps at most a few hundred columns, so collapsing
 * whitespace across a multi-KB body would be pure waste.
 */
function flattenStructuredPreview(text: string): string {
	const first = text[0];
	if (first !== "{" && first !== "[") return text;
	return text.slice(0, PREVIEW_LINES_EXPANDED * PREVIEW_LINE_WIDTH * 2).replace(/\s+/g, " ");
}

function describeTarget(args: JobRenderArgs | undefined): string {
	if (args?.list) return "background jobs";
	const poll = args?.poll ?? [];
	const cancel = args?.cancel ?? [];
	const parts: string[] = [];
	if (cancel.length > 0) {
		parts.push(cancel.length === 1 ? `cancel ${cancel[0]}` : `cancel ${cancel.length} jobs`);
	}
	if (poll.length > 0) {
		parts.push(poll.length === 1 ? `poll ${poll[0]}` : `poll ${poll.length} jobs`);
	}
	if (parts.length === 0) return "all running jobs";
	return parts.join(", ");
}

export const jobToolRenderer = {
	inline: true,

	renderCall(args: JobRenderArgs, _options: RenderResultOptions, uiTheme: Theme): Component {
		const text = renderStatusLine({ icon: "pending", title: describeTarget(args) || "Job" }, uiTheme);
		return new Text(text, 0, 0);
	},

	renderResult(
		result: { content: Array<{ type: string; text?: string }>; details?: JobToolDetails; isError?: boolean },
		options: RenderResultOptions,
		uiTheme: Theme,
		args?: JobRenderArgs,
	): Component {
		let jobs = result.details?.jobs ?? [];
		const agents = result.details?.agents ?? [];

		if (jobs.length === 0 && agents.length === 0) {
			const fallback = result.content?.find(c => c.type === "text")?.text || "No jobs to process";
			const header = renderStatusLine({ icon: "warning", title: describeTarget(args) || "Job" }, uiTheme);
			return new Text([header, formatEmptyMessage(fallback, uiTheme)].join("\n"), 0, 0);
		}

		const isPollCall = args
			? !args.list && (!args.cancel || args.cancel.length === 0 || args.poll !== undefined)
			: true;

		// Agent-carrying results (list / empty-poll roster) are real snapshots,
		// not displaceable waiting frames — only agentless polls collapse their
		// still-running rows once sealed.
		if (!options.isPartial && isPollCall && agents.length === 0) {
			jobs = jobs.filter(job => job.status !== "running");
			if (jobs.length === 0) {
				return new Text("", 0, 0);
			}
		}

		const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
		for (const job of jobs) counts[job.status]++;

		// The title already carries the running count, so meta lists only the
		// settled categories — "waiting on 19 of 19 · 19 running" read awkward.
		const meta: string[] = [];
		if (counts.completed > 0) meta.push(uiTheme.fg("success", `${counts.completed} done`));
		if (counts.failed > 0) meta.push(uiTheme.fg("error", `${counts.failed} failed`));
		if (counts.cancelled > 0) meta.push(uiTheme.fg("warning", `${counts.cancelled} cancelled`));
		if (agents.length > 0 && jobs.length > 0) {
			meta.push(uiTheme.fg("accent", `${formatCount("agent", agents.length)}`));
		}

		const headerIcon: ToolUIStatus =
			counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success";
		const jobsNoun = jobs.length === 1 ? "job" : "jobs";
		const description =
			jobs.length === 0
				? `${formatCount("running agent", agents.length)} — no jobs`
				: counts.running > 0
					? counts.running === jobs.length
						? `waiting on ${jobs.length} ${jobsNoun}`
						: `waiting on ${counts.running} of ${jobs.length} ${jobsNoun}`
					: `${jobs.length} ${jobsNoun} settled`;

		const header = renderStatusLine(
			{
				icon: headerIcon,
				spinnerFrame: counts.running > 0 || agents.length > 0 ? options.spinnerFrame : undefined,
				title: description,
				meta,
			},
			uiTheme,
		);

		// Sort: running first (so user sees what's still pending), then failed, then completed/cancelled.
		const statusOrder: Record<JobSnapshot["status"], number> = {
			running: 0,
			failed: 1,
			cancelled: 2,
			completed: 3,
		};
		const sortedJobs = [...jobs].sort((a, b) => {
			const diff = statusOrder[a.status] - statusOrder[b.status];
			if (diff !== 0) return diff;
			return b.durationMs - a.durationMs;
		});

		let cached: RenderCache | undefined;
		return {
			render(width: number): readonly string[] {
				const expanded = options.expanded;
				const spinnerFrame = options.spinnerFrame ?? 0;
				// Running-job labels shimmer while the poll block is live; the band
				// phase is Date.now()-sampled at render time, so serving cached bytes
				// would pin it to the ~12.5fps spinner-glyph cadence instead of the
				// 30fps redraw. Bypass the cache while any row animates, and key on
				// the animation state so a sealed block never hits stale shimmered
				// bytes (spinnerFrame falls back to 0 on both sides of the seal).
				const shimmerActive = counts.running > 0 && options.spinnerFrame !== undefined && shimmerEnabled();
				const key = new Hasher().bool(expanded).u32(width).u32(spinnerFrame).bool(shimmerActive).digest();
				if (!shimmerActive && cached?.key === key) return cached.lines;

				const itemLines = renderTreeList<JobSnapshot>(
					{
						items: sortedJobs,
						expanded,
						maxCollapsed: COLLAPSED_LIST_LIMIT,
						itemType: "job",
						renderItem: job => {
							const lines: string[] = [];
							const icon = formatStatusIcon(
								statusToIcon(job.status),
								uiTheme,
								job.status === "running" ? options.spinnerFrame : undefined,
							);
							const typeBadge = formatBadge(job.type, statusToColor(job.status), uiTheme);
							// Task jobs label themselves with their agent id, which is also
							// the job id — drop the id column instead of stuttering it twice.
							const idPart = job.label.trim() === job.id ? "" : ` ${uiTheme.fg("muted", job.id)}`;
							const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
							const maxLabelLines = expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
							const visibleLabelLines = rawLabelLines
								.slice(0, maxLabelLines)
								.map(l => truncateToWidth(replaceTabs(l), LABEL_MAX_WIDTH, Ellipsis.Unicode));
							if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
								const last = visibleLabelLines[visibleLabelLines.length - 1]!;
								visibleLabelLines[visibleLabelLines.length - 1] = `${last} …`;
							}
							const durationText = uiTheme.fg("dim", formatDuration(job.durationMs));
							// Running rows in a live block shimmer their label; once the block
							// stops animating (sealed, or a settled snapshot — spinnerFrame
							// cleared) they render static so scrollback never keeps a mid-sweep
							// shimmer band.
							const live = job.status === "running" && options.spinnerFrame !== undefined;
							const headRaw = visibleLabelLines[0] ?? "";
							const headLabel = live
								? shimmerEnabled()
									? shimmerText(headRaw, uiTheme)
									: uiTheme.fg("accent", headRaw)
								: uiTheme.fg("toolOutput", headRaw);
							lines.push(`${icon}${idPart} ${typeBadge} ${headLabel} ${durationText}`);
							for (let i = 1; i < visibleLabelLines.length; i++) {
								lines.push(`  ${uiTheme.fg("toolOutput", visibleLabelLines[i]!)}`);
							}

							const preview = flattenStructuredPreview(
								stripTaskResultEnvelope(job.errorText?.trim() || job.resultText?.trim() || ""),
							);
							if (preview) {
								const maxLines = expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
								const previewLines = getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode);
								const tone = job.errorText ? "error" : "dim";
								for (const pl of previewLines) {
									lines.push(`  ${uiTheme.fg(tone, pl)}`);
								}
							}
							return lines;
						},
					},
					uiTheme,
				);

				// Agents run outside job control; render them as their own tree so
				// they never skew the job counts or the "waiting on N jobs" title.
				const agentLines =
					agents.length === 0
						? []
						: renderTreeList<AgentActivitySnapshot>(
								{
									items: agents,
									expanded,
									maxCollapsed: COLLAPSED_LIST_LIMIT,
									itemType: "agent",
									renderItem: agent => {
										const icon = formatStatusIcon("running", uiTheme, options.spinnerFrame);
										const badge = formatBadge("agent", "accent", uiTheme);
										const gist = agent.activity
											? ` ${uiTheme.fg("toolOutput", truncateToWidth(replaceTabs(agent.activity), LABEL_MAX_WIDTH, Ellipsis.Unicode))}`
											: "";
										const parent = agent.parentId ? uiTheme.fg("dim", ` ← ${agent.parentId}`) : "";
										const age = uiTheme.fg("dim", formatDuration(agent.ageMs));
										return [`${icon} ${uiTheme.fg("muted", agent.id)} ${badge}${gist} ${age}${parent}`];
									},
								},
								uiTheme,
							);

				const all = [header, ...itemLines, ...agentLines].map(l => truncateToWidth(l, width, Ellipsis.Unicode));
				cached = { key, lines: all };
				return all;
			},
			invalidate() {
				cached = undefined;
			},
		};
	},

	mergeCallAndResult: true,
};
