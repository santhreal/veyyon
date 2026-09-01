/**
 * What the GitHub card shows, for any host.
 *
 * The tool half in `gh.ts` decides what happened; this half decides what a reader is told, and names
 * no colour, glyph, width or component. A terminal draws it through `src/tui/draw-tool-view.ts`, and
 * the React renderer in `@veyyon/tool-render` writes its own mapping from the same value.
 *
 * The card has two subjects, and they are the tool's own: every op reports one operation, and
 * `run_watch` reports a workflow. So the ops share one row -- a title from the op and the arguments
 * that identify it -- while a watch is a panel: the runs, the jobs under each run with how long each
 * ran, and the tail of every failed job's log. The op row is the fallback for a watch that reported
 * nothing structured, which is what a failed `run_watch` is.
 *
 * A job row is the one shape here that needs two columns: the job's name is the subject and its
 * duration is an aside, so the duration is a trailing run and the host decides where a trailing run
 * lands. That is the only layout decision this module makes, and it makes it by naming a meaning.
 */

import { classifyGithubCheckRun, githubIssueRefNumber } from "@veyyon/utils/github-check-run";
import type {
	FramedBlockView,
	StatusRowView,
	ToolView,
	ToolViewContext,
	ToolViewRenderer,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewTone,
} from "@veyyon/view";
import { PREVIEW_LIMITS, replaceTabs, TRUNCATE_LENGTHS, truncateToWidth } from "../core/render-utils";
import type {
	GhRunWatchFailedLogDetails,
	GhRunWatchJobDetails,
	GhRunWatchRunDetails,
	GhRunWatchViewDetails,
	GhToolDetails,
} from "./gh";
import { formatShortSha } from "./gh-format";

/** The tool's own mark, which a settled card is titled by instead of an outcome icon. */
const GH_EMBLEM = "tool.gh";

/** What a watch card is titled, whichever of the two modes it reports. */
const WATCH_TITLE = "GitHub Run Watch";

/** The unit the fallback card's held-back count is in, which the host words. */
const LINE_NOUN = { one: "line", many: "lines" } as const;

/** The unit a failed job's held-back log count is in. */
const LOG_LINE_NOUN = { one: "log line", many: "log lines" } as const;

/** The call arguments a card reads, which are the tool's own input narrowed to what it shows. */
export interface GithubViewArgs {
	op?: string;
	run?: string;
	branch?: string;
	repo?: string;
	pr?: string | string[];
	query?: string;
}

/** The result a card reads, which is the tool's own result shape narrowed to what a card shows. */
export interface GithubViewResult {
	content?: Array<{ type: string; text?: string }>;
	details?: GhToolDetails;
	isError?: boolean;
}

/** What each op names itself, so a card states the operation rather than the tool. */
const OP_TITLES: Record<string, string> = {
	repo_view: "GitHub Repo",
	pr_checkout: "GitHub PR Checkout",
	pr_push: "GitHub PR Push",
	search_issues: "GitHub Search Issues",
	search_prs: "GitHub Search PRs",
	search_code: "GitHub Search Code",
	search_commits: "GitHub Search Commits",
	search_repos: "GitHub Search Repos",
	run_watch: "GitHub Run Watch",
};

function formatOpTitle(op: string | undefined): string {
	if (op && OP_TITLES[op]) return OP_TITLES[op];
	return "GitHub";
}

/** A pull-request or issue reference as the number it names, or as the literal cut to a chip. */
function extractIssueId(value: string | undefined): string | undefined {
	if (!value) return undefined;
	const trimmed = value.trim();
	if (!trimmed) return undefined;
	const id = githubIssueRefNumber(trimmed);
	if (id) return id;
	return truncateToWidth(trimmed, TRUNCATE_LENGTHS.SHORT);
}

/** The pull requests an op names, as the three a row has room for and a count of the rest. */
function formatPrIdentifier(pr: string | string[] | undefined): string | undefined {
	if (pr === undefined) return undefined;
	if (Array.isArray(pr)) {
		const parts = pr.map(p => extractIssueId(p)).filter((p): p is string => p !== undefined);
		if (parts.length === 0) return undefined;
		if (parts.length > 3) {
			return `${parts.slice(0, 3).join(", ")}, +${parts.length - 3} more`;
		}
		return parts.join(", ");
	}
	return extractIssueId(pr);
}

/** What identifies the call, per op: the reference it names, the query it ran, or the repository. */
function buildOpMeta(args: GithubViewArgs): string[] {
	const meta: string[] = [];
	const op = args.op;
	switch (op) {
		case "pr_checkout":
		case "pr_push": {
			const id = formatPrIdentifier(args.pr);
			if (id) meta.push(id);
			else if (args.branch) meta.push(args.branch);
			if (args.repo) meta.push(args.repo);
			break;
		}
		case "search_issues":
		case "search_prs":
		case "search_code":
		case "search_commits": {
			if (args.query) meta.push(truncateToWidth(args.query, TRUNCATE_LENGTHS.CONTENT));
			if (args.repo) meta.push(args.repo);
			break;
		}
		case "search_repos": {
			if (args.query) meta.push(truncateToWidth(args.query, TRUNCATE_LENGTHS.CONTENT));
			break;
		}
		case "repo_view": {
			if (args.repo) meta.push(args.repo);
			if (args.branch) meta.push(args.branch);
			break;
		}
		case "run_watch":
			break;
		default: {
			if (args.repo) meta.push(args.repo);
			break;
		}
	}
	return meta;
}

/** Each meta fact as its own entry, so the host joins them with its own separator. */
function metaLines(meta: readonly string[]): ViewLine[] {
	return meta.map(entry => [{ text: entry }]);
}

/** What a watch card's head row says it is watching, or what it watched. */
function getWatchHeader(watch: GhRunWatchViewDetails): string {
	if (watch.mode === "run" && watch.run) {
		if (watch.state === "watching") {
			return `watching run #${watch.run.id} on ${watch.repo}`;
		}

		return `run #${watch.run.id} on ${watch.repo}`;
	}

	const shortSha = formatShortSha(watch.headSha) ?? "this commit";
	if (watch.state === "watching") {
		return `watching ${shortSha} on ${watch.repo}`;
	}

	return `workflow runs for ${shortSha} on ${watch.repo}`;
}

/** What a run calls itself: its workflow, else the commit's title, else the product's own name. */
function getRunLabel(run: GhRunWatchRunDetails): string {
	return replaceTabs(run.workflowName ?? run.displayTitle ?? "GitHub Actions");
}

/** What identifies a run beside its name: the branch or commit it ran on, and its number. */
function getRunMeta(run: GhRunWatchRunDetails): string[] {
	const parts: string[] = [];
	if (run.branch) {
		parts.push(replaceTabs(run.branch));
	} else if (run.headSha) {
		parts.push(formatShortSha(run.headSha) ?? run.headSha);
	}
	parts.push(`#${run.id}`);
	return parts;
}

/**
 * The row that names one run.
 *
 * The last of the run's facts is its number, which is detail rather than subject, so it reads muted
 * while the branch beside it is ordinary body text: a run states no tone for that, and the host draws
 * its own.
 */
function runRow(run: GhRunWatchRunDetails): ViewLine {
	const parts = getRunMeta(run);
	const line: ViewLine = [{ text: getRunLabel(run), tone: "accent" }];
	for (const [index, part] of parts.entries()) {
		line.push({ text: "  " }, index === parts.length - 1 ? { text: part, tone: "muted" } : { text: part });
	}
	return line;
}

/** The mark a job's state draws as, and the tone its words carry, which are two decisions. */
function jobVisual(job: GhRunWatchJobDetails): { symbol: string; markTone: ViewTone; tone: ViewTone } {
	switch (classifyGithubCheckRun(job.status, job.conclusion)) {
		case "success":
			return { symbol: "status.success", markTone: "accent", tone: "success" };
		case "failure":
			return { symbol: "status.error", markTone: "error", tone: "error" };
		case "running":
			return { symbol: "status.enabled", markTone: "warning", tone: "warning" };
		default:
			return { symbol: "status.shadowed", markTone: "muted", tone: "muted" };
	}
}

/**
 * The row that reports one job: its state, its name, and how long it has been running.
 *
 * The duration is a trailing run, which is the row's only structure: a column of durations reads as
 * one fact per row, and where that column sits is the host's answer to how many columns it has.
 */
function jobRow(job: GhRunWatchJobDetails): ViewLine {
	const visual = jobVisual(job);
	const row: ViewLine = [
		{ text: "", symbol: visual.symbol, tone: visual.markTone },
		{ text: " " },
		{ text: replaceTabs(job.name), tone: visual.tone },
	];
	if (job.durationSeconds === undefined) return row;
	return [...row, { text: `${job.durationSeconds}s`, tone: visual.tone, trailing: true }];
}

/** One run and the jobs under it, or the word that says the workflow has not reported any yet. */
function runRows(run: GhRunWatchRunDetails): ViewLine[] {
	const rows: ViewLine[] = [runRow(run)];
	if (run.jobs.length === 0) {
		rows.push([{ text: "waiting for workflow jobs...", tone: "dim" }]);
		return rows;
	}
	for (const job of run.jobs) rows.push(jobRow(job));
	return rows;
}

/** The header of one failed job's log: the job, and the run it belongs to. */
function failedLogHeader(entry: GhRunWatchFailedLogDetails): ViewLine {
	const context = entry.workflowName ? `${entry.workflowName}  #${entry.runId}` : `run #${entry.runId}`;
	return [
		{ text: "", symbol: "status.error", tone: "error" },
		{ text: " " },
		{ text: replaceTabs(entry.jobName), tone: "error" },
		{ text: "  " },
		{ text: context, tone: "muted" },
	];
}

/**
 * The tail of every failed job's log, headed by the job it came from.
 *
 * The rows are the log's own, cut by the host: a log line is one row of a listing rather than prose,
 * so a line that runs out of columns ends there instead of wrapping into a second row.
 *
 * One section per job, because what a preview held back belongs to the job whose log was trimmed and
 * has to be said where those rows end: a count carried by the whole group would sit under the last
 * job and name lines that came from the first. Only the first section is labelled, so the group
 * still reads as one heading over every job under it.
 */
function failedLogSections(failedLogs: readonly GhRunWatchFailedLogDetails[], expanded: boolean): ViewSection[] {
	const sections: ViewSection[] = [];
	for (const entry of failedLogs) {
		const lines: ViewLine[] = [failedLogHeader(entry)];
		let held = 0;

		if (!entry.available || !entry.tail) {
			lines.push([{ text: "  log tail unavailable", tone: "dim" }]);
		} else {
			const tailLines = replaceTabs(entry.tail)
				.split("\n")
				.filter(line => line.length > 0);
			const previewLimit = expanded ? tailLines.length : Math.min(PREVIEW_LIMITS.OUTPUT_COLLAPSED, tailLines.length);
			for (const line of tailLines.slice(-previewLimit)) {
				lines.push([{ text: `  ${line}`, tone: "dim" }]);
			}
			if (!expanded) held = tailLines.length - previewLimit;
		}

		sections.push({
			...(sections.length === 0 ? { label: "failed logs" } : {}),
			lines,
			clip: true,
			...(held > 0 ? { hidden: { count: held, noun: LOG_LINE_NOUN, revealable: true } } : {}),
		});
	}
	return sections;
}

/** What a watch card holds: the runs it is following, then the logs of whatever failed. */
function watchSections(watch: GhRunWatchViewDetails, expanded: boolean): ViewSection[] {
	const main: ViewLine[] = [];

	if (watch.note) main.push([{ text: replaceTabs(watch.note), tone: "dim" }]);

	if (watch.mode === "run" && watch.run) {
		main.push(...runRows(watch.run));
	} else if (watch.mode === "commit") {
		const runs = watch.runs ?? [];
		if (runs.length === 0) {
			main.push([{ text: "waiting for workflow runs...", tone: "dim" }]);
		} else {
			runs.forEach((run, index) => {
				if (index > 0) main.push([]);
				main.push(...runRows(run));
			});
		}
	}

	const sections: ViewSection[] = [];
	if (main.length > 0) sections.push({ lines: main });
	sections.push(...failedLogSections(watch.failedLogs ?? [], expanded));
	return sections;
}

/** The parts of a result the model was sent, which is what a card falls back to showing. */
function extractText(content: readonly { type: string; text?: string }[]): string {
	return content
		.filter(part => part.type === "text")
		.map(part => part.text)
		.filter((value): value is string => typeof value === "string" && value.length > 0)
		.join("\n");
}

/**
 * The head row of a settled card, which is titled by the tool's own mark when it succeeded and by an
 * outcome icon when it did not.
 */
function settledHeader(title: string, meta: readonly ViewLine[], outcome: "ok" | "empty" | "error"): StatusRowView {
	if (outcome === "error") {
		return { kind: "statusRow", status: "error", title, titleTone: "error", meta };
	}
	if (outcome === "empty") {
		return { kind: "statusRow", status: "warning", title, titleTone: "accent", meta };
	}
	return { kind: "statusRow", emblem: GH_EMBLEM, emblemTone: "accent", title, titleTone: "accent", meta };
}

/** The whole card for a watch: what is being watched, the runs under it, and any failed logs. */
function watchCard(watch: GhRunWatchViewDetails, isError: boolean, expanded: boolean): FramedBlockView {
	return {
		kind: "framedBlock",
		header: settledHeader(WATCH_TITLE, [[{ text: getWatchHeader(watch) }]], isError ? "error" : "ok"),
		state: isError ? "error" : "success",
		// The body is the workflow the tool read rather than a report it wrote, so the outcome belongs
		// on the card's edge and the runs sit on the ordinary ground.
		contents: "data",
		sections: watchSections(watch, expanded),
	};
}

/** The rows the tool's text becomes, with the blank lines at either end of it dropped. */
function bodyLines(text: string): string[] {
	const lines = replaceTabs(text).split("\n");
	while (lines.length > 0 && lines[0].trim() === "") lines.shift();
	while (lines.length > 0 && lines[lines.length - 1].trim() === "") lines.pop();
	return lines;
}

/** The card every op that is not a watch draws for its result: a row, two rows, or a panel. */
function opCard(result: GithubViewResult, args: GithubViewArgs, expanded: boolean): ToolView {
	const text = extractText(result.content ?? []);
	const title = formatOpTitle(args.op);
	const meta = metaLines(buildOpMeta(args));
	const isError = result.isError === true;
	const header = settledHeader(title, meta, isError ? "error" : text ? "ok" : "empty");

	if (!text) {
		return {
			kind: "headedBlock",
			header,
			lines: [[{ text: isError ? "request failed" : "no output", tone: "dim" }]],
		};
	}

	const lines = bodyLines(text);

	// A trivial one-line success is a row and its answer: a panel around one line reads as a frame
	// around nothing. A failure always frames, so the message reads as a block rather than as a red
	// wrap of prose.
	if (lines.length <= 1 && !isError) {
		const body = lines[0];
		if (!body) return header;
		return { kind: "headedBlock", header, lines: [[{ text: body, tone: "output" }]] };
	}

	const limit = Math.min(lines.length, expanded ? PREVIEW_LIMITS.OUTPUT_EXPANDED : PREVIEW_LIMITS.OUTPUT_COLLAPSED);
	const visible = lines.slice(0, limit);
	const remaining = lines.length - visible.length;
	const hidden: ViewHiddenCount | undefined =
		!expanded && remaining > 0 ? { count: remaining, noun: LINE_NOUN, revealable: true } : undefined;
	return {
		kind: "framedBlock",
		header,
		state: isError ? "error" : "success",
		contents: "data",
		sections:
			visible.length > 0
				? [
						{
							lines: visible.map(line => [{ text: line, tone: isError ? "error" : "output" }] as ViewLine),
							clip: true,
							...(hidden === undefined ? {} : { hidden }),
						},
					]
				: [],
	};
}

/**
 * The reference a watch call names before any workflow data has arrived.
 *
 * Stated as one meta fact with no tone: the row's trailing detail is secondary by being trailing
 * detail, so a tone here would be the tool answering a question the host has already answered.
 */
function watchCallMeta(args: GithubViewArgs): ViewLine {
	const runId = typeof args.run === "string" && args.run.trim().length > 0 ? args.run.trim() : undefined;
	if (runId) return [{ text: `#${runId}` }];
	const branch = typeof args.branch === "string" && args.branch.trim().length > 0 ? args.branch.trim() : undefined;
	if (branch) return [{ text: branch }];
	return [{ text: "current HEAD" }];
}

export const githubToolView: Required<ToolViewRenderer<GithubViewArgs, GithubViewResult>> = {
	renderCall(args: GithubViewArgs, context: ToolViewContext): ToolView {
		const op = typeof args.op === "string" && args.op.trim().length > 0 ? args.op.trim() : undefined;
		const status = context.frame === undefined ? "pending" : "running";
		if (op === "run_watch") {
			return {
				kind: "headedBlock",
				header: {
					kind: "statusRow",
					status,
					title: WATCH_TITLE,
					titleTone: "accent",
					meta: [watchCallMeta(args)],
				},
				lines: [[{ text: "waiting for workflow data...", tone: "dim" }]],
			};
		}
		return {
			kind: "statusRow",
			status,
			title: formatOpTitle(op),
			meta: metaLines(buildOpMeta({ ...args, op })),
		};
	},

	renderResult(result: GithubViewResult, context: ToolViewContext, args?: GithubViewArgs): ToolView {
		const watch = result.details?.watch;
		if (watch) return watchCard(watch, result.isError === true, context.expanded);
		return opCard(result, args ?? {}, context.expanded);
	},
};
