/**
 * What a job card shows, for any host.
 *
 * The tool half in `job.ts` decides what happened; this half decides what a reader is told, and
 * names no colour, glyph or component. A terminal draws it through `src/modes/terminal/draw/draw-tool-view.ts` and a
 * second host writes its own mapping from the same value.
 *
 * The card is a row that reports the SET -- how many jobs are still going, how many settled and how
 * many live agents sit outside job control -- with one entry per job under it: its state mark, its
 * id, the kind of job it is, its label and how long it has run, then whatever it returned. A card
 * that holds a set is the shape a headed block carries, so the rows are the tool's and the indent,
 * the width and the held-back note are the host's.
 */

import { formatCount } from "@veyyon/utils";
import type {
	HeadedBlockView,
	StatusRowView,
	TextBlockView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewStatus,
	ViewTone,
} from "@veyyon/view";
import { stripTaskResultEnvelope } from "@veyyon/wire/task-result";
import {
	Ellipsis,
	formatDuration,
	getPreviewLines,
	replaceTabs,
	sanitizeErrorText,
	shortenEmbeddedPaths,
	truncateToWidth,
} from "../core/render-utils";
import { type AgentActivitySnapshot, COLLAPSED_LIST_LIMIT, type JobSnapshot, type JobToolDetails } from "./job";

/** The columns a job's label may spend before it is cut. */
const LABEL_MAX_WIDTH = 60;
const PREVIEW_LINES_COLLAPSED = 1;
const PREVIEW_LINES_EXPANDED = 4;
const LABEL_LINES_COLLAPSED = 1;
const LABEL_LINES_EXPANDED = 3;
const PREVIEW_LINE_WIDTH = 80;

/** The two columns a job's own lines sit in, under the row that names it. */
const ROW_BODY_INDENT = "  ";

/** The units a held-back count is in, which the host words. */
const JOB_NOUN = { one: "job", many: "jobs" } as const;
const AGENT_NOUN = { one: "agent", many: "agents" } as const;

/** The arguments a job card reads, which are the tool's own three fields. */
export interface JobRenderArgs {
	poll?: string[];
	cancel?: string[];
	list?: boolean;
}

/** The result a job card reads: the text the tool returned, and the snapshot it carries. */
export interface JobViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: JobToolDetails;
	isError?: boolean;
}

/** The state a job reports, as the mark a host draws for it. */
function statusMark(status: JobSnapshot["status"]): ViewStatus {
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

/** The tone a job's kind badge carries, which is what its state means. */
function statusTone(status: JobSnapshot["status"]): ViewTone {
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

/** What the call asked for, in the words the row is titled with. */
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

/**
 * One job's lines: what it is, then what it returned.
 *
 * The label of a running job is stated as live, so a host with a clock animates that run alone while
 * the id, the kind and the elapsed time beside it stand still. A settled job's label is body text,
 * which is what a row in scrollback should be: nothing there is still arriving.
 */
function jobLines(job: JobSnapshot, context: ToolViewContext): ViewLine[] {
	const lines: ViewLine[] = [];
	const tone = statusTone(job.status);
	// Task jobs label themselves with their agent id, which is also the job id — drop the id column
	// instead of stuttering it twice.
	const named = job.label.trim() !== job.id;
	const rawLabelLines = (job.label || "(no label)").split(/\r?\n/);
	const maxLabelLines = context.expanded ? LABEL_LINES_EXPANDED : LABEL_LINES_COLLAPSED;
	const visibleLabelLines = rawLabelLines
		.slice(0, maxLabelLines)
		.map(line => truncateToWidth(replaceTabs(line), LABEL_MAX_WIDTH, Ellipsis.Unicode));
	if (rawLabelLines.length > maxLabelLines && visibleLabelLines.length > 0) {
		visibleLabelLines[visibleLabelLines.length - 1] = `${visibleLabelLines[visibleLabelLines.length - 1]!} …`;
	}
	// A running job is live only where the surface repaints: a still capture and a settled snapshot
	// carry the words and no motion, so the label is drawn as body text there.
	const live = job.status === "running" && context.frame !== undefined;
	lines.push([
		{ text: "", status: statusMark(job.status) },
		...(named ? [{ text: " " }, { text: job.id, tone: "muted" as ViewTone }] : []),
		{ text: " " },
		{ text: job.type, badge: true, tone },
		{ text: " " },
		{ text: visibleLabelLines[0] ?? "", tone: live ? "accent" : "output", ...(live ? { live: true } : {}) },
		{ text: " " },
		{ text: formatDuration(job.durationMs), tone: "dim" },
	]);
	for (let index = 1; index < visibleLabelLines.length; index++) {
		lines.push([{ text: ROW_BODY_INDENT }, { text: visibleLabelLines[index]!, tone: "output" }]);
	}

	const preview = flattenStructuredPreview(
		stripTaskResultEnvelope(job.errorText?.trim() || job.resultText?.trim() || ""),
	);
	if (preview) {
		const maxLines = context.expanded ? PREVIEW_LINES_EXPANDED : PREVIEW_LINES_COLLAPSED;
		const tone: ViewTone = job.errorText ? "error" : "dim";
		for (const line of getPreviewLines(preview, maxLines, PREVIEW_LINE_WIDTH, Ellipsis.Unicode)) {
			lines.push([{ text: ROW_BODY_INDENT }, { text: line, tone }]);
		}
	}
	return lines;
}

/**
 * One live agent's line.
 *
 * An agent runs outside job control, so it is stated as its own row rather than folded into the job
 * counts: what it is, what it was last doing, how long it has been registered and who spawned it.
 */
function agentLine(agent: AgentActivitySnapshot): ViewLine {
	return [
		{ text: "", status: "running" },
		{ text: " " },
		{ text: agent.id, tone: "muted" },
		{ text: " " },
		{ text: "agent", badge: true, tone: "accent" },
		...(agent.activity
			? [
					{ text: " " },
					{
						text: truncateToWidth(replaceTabs(agent.activity), LABEL_MAX_WIDTH, Ellipsis.Unicode),
						tone: "output" as ViewTone,
					},
				]
			: []),
		{ text: " " },
		{ text: formatDuration(agent.ageMs), tone: "dim" },
		...(agent.parentId ? [{ text: ` ← ${agent.parentId}`, tone: "dim" as ViewTone }] : []),
	];
}

/**
 * What the card holds back, in the unit it held back.
 *
 * Jobs and agents are two sets under one header, so a card that trimmed both states the bare count:
 * the noun would have to name one of the two and the rows above already show which. A card that
 * trimmed one names it.
 */
function heldBack(jobs: number, agents: number): ViewHiddenCount | undefined {
	const count = jobs + agents;
	if (count <= 0) return undefined;
	const noun = jobs > 0 && agents > 0 ? undefined : jobs > 0 ? JOB_NOUN : AGENT_NOUN;
	return { count, ...(noun === undefined ? {} : { noun }), revealable: true };
}

/** Running first, so a reader sees what is still pending, then failed, then what settled. */
const STATUS_ORDER: Record<JobSnapshot["status"], number> = { running: 0, failed: 1, cancelled: 2, completed: 3 };

/** The row that reports the set: how many are still going, and what became of the rest. */
function summaryRow(
	jobs: readonly JobSnapshot[],
	agents: readonly AgentActivitySnapshot[],
	counts: Record<JobSnapshot["status"], number>,
): StatusRowView {
	// The title already carries the running count, so meta lists only the settled categories —
	// "waiting on 19 of 19 · 19 running" read awkward.
	const meta: ViewLine[] = [];
	if (counts.completed > 0) meta.push([{ text: `${counts.completed} done`, tone: "success" }]);
	if (counts.failed > 0) meta.push([{ text: `${counts.failed} failed`, tone: "error" }]);
	if (counts.cancelled > 0) meta.push([{ text: `${counts.cancelled} cancelled`, tone: "warning" }]);
	if (agents.length > 0 && jobs.length > 0) {
		meta.push([{ text: formatCount("agent", agents.length), tone: "accent" }]);
	}
	const jobsNoun = jobs.length === 1 ? "job" : "jobs";
	const title =
		jobs.length === 0
			? `${formatCount("running agent", agents.length)} — no jobs`
			: counts.running > 0
				? counts.running === jobs.length
					? `waiting on ${jobs.length} ${jobsNoun}`
					: `waiting on ${counts.running} of ${jobs.length} ${jobsNoun}`
				: `${jobs.length} ${jobsNoun} settled`;
	return {
		kind: "statusRow",
		status: counts.failed > 0 ? "warning" : counts.running > 0 || agents.length > 0 ? "info" : "success",
		title,
		meta,
	};
}

/** The card a snapshot with neither a job nor an agent in it falls back to. */
function emptyCard(result: JobViewResult, args: JobRenderArgs | undefined): HeadedBlockView {
	if (result.isError) {
		const fallback = result.content?.find(part => part.type === "text")?.text || "Job operation failed";
		const sanitized = sanitizeErrorText(fallback);
		return {
			kind: "headedBlock",
			header: { kind: "statusRow", status: "error", title: describeTarget(args) || "Job" },
			lines: sanitized.split("\n").map(line => [{ text: line, tone: "error" }]),
		};
	}
	const fallback = result.content?.find(part => part.type === "text")?.text || "No jobs to process";
	return {
		kind: "headedBlock",
		header: { kind: "statusRow", status: "warning", title: describeTarget(args) || "Job" },
		lines: [
			[
				{ text: "", symbol: "status.warning", tone: "warning" },
				{ text: " " },
				{ text: replaceTabs(shortenEmbeddedPaths(fallback)), tone: "muted" },
			],
		],
	};
}

/**
 * The card a sealed poll that is still waiting on everything collapses to, which is nothing at all.
 *
 * A poll whose every watched job is still running has said nothing a newer poll will not say again,
 * so once the block is sealed the card holds no rows and no header: the transcript keeps the result
 * and shows none of it.
 */
const NOTHING: TextBlockView = { kind: "textBlock", spans: [{ text: "" }] };

export const jobToolView: Required<ToolViewRenderer<JobRenderArgs, JobViewResult>> = {
	renderCall(args: JobRenderArgs): ToolView {
		return { kind: "statusRow", status: "pending", title: describeTarget(args) || "Job" };
	},

	renderResult(result: JobViewResult, context: ToolViewContext, args?: JobRenderArgs): ToolView {
		let jobs = result.details?.jobs ?? [];
		const agents = result.details?.agents ?? [];
		if (jobs.length === 0 && agents.length === 0) return emptyCard(result, args);

		const isPollCall = args
			? !args.list && (!args.cancel || args.cancel.length === 0 || args.poll !== undefined)
			: true;

		// Agent-carrying results (list / empty-poll roster) are real snapshots, not displaceable
		// waiting frames — only agentless polls collapse their still-running rows once sealed.
		if (!context.partial && isPollCall && agents.length === 0) {
			jobs = jobs.filter(job => job.status !== "running");
			if (jobs.length === 0) return NOTHING;
		}

		const counts = { completed: 0, failed: 0, cancelled: 0, running: 0 };
		for (const job of jobs) counts[job.status]++;

		const sorted = [...jobs].sort(
			(left, right) => STATUS_ORDER[left.status] - STATUS_ORDER[right.status] || right.durationMs - left.durationMs,
		);
		const shownJobs = context.expanded ? sorted : sorted.slice(0, COLLAPSED_LIST_LIMIT);
		const shownAgents = context.expanded ? agents : agents.slice(0, COLLAPSED_LIST_LIMIT);
		const hidden = heldBack(sorted.length - shownJobs.length, agents.length - shownAgents.length);

		return {
			kind: "headedBlock",
			header: summaryRow(jobs, agents, counts),
			lines: [...shownJobs.flatMap(job => jobLines(job, context)), ...shownAgents.map(agent => agentLine(agent))],
			...(hidden === undefined ? {} : { hidden }),
		} satisfies HeadedBlockView;
	},
};
