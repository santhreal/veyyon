/**
 * Legacy hidden review-finding tool for agents that have not migrated to
 * incremental `yield` sections.
 *
 * Hidden by default - only enabled when explicitly listed in an agent's tools.
 * Reviewers now finish via incremental `yield`; this tool remains for
 * compatibility with older or custom review agents.
 */
// ─────────────────────────────────────────────────────────────────────────────

import type { AgentTool } from "@veyyon/agent-core";
import { isRecord } from "@veyyon/utils";
import type { TextBlockView, ViewSpan, ViewTone } from "@veyyon/view";
import { type } from "arktype";
import { subprocessToolRegistry } from "../task/subprocess-tool-registry";
import type { ReviewFinding } from "../task/types";
import type { ThemeColor } from "../theme/theme";
export type FindingPriority = "P0" | "P1" | "P2" | "P3";

export interface FindingPriorityInfo {
	ord: 0 | 1 | 2 | 3;
	symbol: "status.error" | "status.warning" | "status.info";
	color: ThemeColor;
}

const PRIORITY_INFO: Record<FindingPriority, FindingPriorityInfo> = {
	P0: { ord: 0, symbol: "status.error", color: "error" },
	P1: { ord: 1, symbol: "status.warning", color: "warning" },
	P2: { ord: 2, symbol: "status.warning", color: "muted" },
	P3: { ord: 3, symbol: "status.info", color: "accent" },
};

export const PRIORITY_LABELS: FindingPriority[] = ["P0", "P1", "P2", "P3"];

export function isFindingPriority(value: unknown): value is FindingPriority {
	return value === "P0" || value === "P1" || value === "P2" || value === "P3";
}

export function getPriorityInfo(priority: FindingPriority): FindingPriorityInfo {
	return PRIORITY_INFO[priority] ?? { ord: 3, symbol: "status.info", color: "muted" };
}

/**
 * The tone each priority speaks in, which a host maps to its own palette.
 *
 * A second map beside `PRIORITY_INFO.color` rather than a cast of it: `color` is a terminal palette
 * entry `task/render.ts` draws with, and the four names agreeing today is a coincidence of naming, not
 * a contract. A tone is what a finding MEANS -- P0 is a failure, P3 is a note -- so a host that draws
 * `muted` as grey text and one that draws it as a collapsed chip both read it correctly.
 */
const PRIORITY_TONES: Record<FindingPriority, ViewTone> = {
	P0: "error",
	P1: "warning",
	P2: "muted",
	P3: "accent",
};

/**
 * The priority mark and its label, as the two spans every finding row carries.
 *
 * The mark is a symbol key rather than a glyph, so a host resolves it from its own registry; its
 * fallback text is empty because the `[P1]` span beside it already states the priority in words.
 */
function prioritySpans(priority: FindingPriority): readonly ViewSpan[] {
	const tone = PRIORITY_TONES[priority] ?? "muted";
	return [
		{ symbol: getPriorityInfo(priority).symbol, text: "", tone },
		{ text: " " },
		{ text: `[${priority}]`, tone },
	];
}

/** The title a finding reports, without the priority prefix an agent may have written into it. */
function findingTitle(title: string): string {
	return title.replace(/^\[P\d\]\s*/, "");
}

// report_finding schema
const ReportFindingParams = type({
	title: type("string").describe("prefixed imperative title"),
	body: type("string").describe("problem explanation"),
	priority: type("'P0' | 'P1' | 'P2' | 'P3'").describe("priority 0-3"),
	confidence: type("number >= 0 & number <= 1").describe("confidence score"),
	file_path: type("string").describe("file path"),
	line_start: type("number").describe("start line"),
	line_end: type("number").describe("end line"),
});

interface ReportFindingDetails {
	title: string;
	body: string;
	priority: FindingPriority;
	confidence: number;
	file_path: string;
	line_start: number;
	line_end: number;
}

function normalizeFindingPriority(value: unknown): FindingPriority | undefined {
	if (isFindingPriority(value)) return value;
	if (value === 0) return "P0";
	if (value === 1) return "P1";
	if (value === 2) return "P2";
	if (value === 3) return "P3";
	return undefined;
}

export function parseReportFindingDetails(value: unknown): ReportFindingDetails | undefined {
	if (!isRecord(value)) return undefined;

	const title = typeof value.title === "string" ? value.title : undefined;
	const body = typeof value.body === "string" ? value.body : undefined;
	const priority = normalizeFindingPriority(value.priority);
	const confidence =
		typeof value.confidence === "number" &&
		Number.isFinite(value.confidence) &&
		value.confidence >= 0 &&
		value.confidence <= 1
			? value.confidence
			: undefined;
	const filePath = typeof value.file_path === "string" && value.file_path.length > 0 ? value.file_path : undefined;
	const lineStart =
		typeof value.line_start === "number" && Number.isFinite(value.line_start) ? value.line_start : undefined;
	const lineEnd = typeof value.line_end === "number" && Number.isFinite(value.line_end) ? value.line_end : undefined;

	if (
		title === undefined ||
		body === undefined ||
		priority === undefined ||
		confidence === undefined ||
		filePath === undefined ||
		lineStart === undefined ||
		lineEnd === undefined
	) {
		return undefined;
	}

	return {
		title,
		body,
		priority,
		confidence,
		file_path: filePath,
		line_start: lineStart,
		line_end: lineEnd,
	};
}

export const reportFindingTool: AgentTool<typeof ReportFindingParams, ReportFindingDetails> = {
	name: "report_finding",
	label: "Report Finding",
	approval: "read",
	description: "Report a code review finding. Use this for each issue found. Call yield when done.",
	parameters: ReportFindingParams,
	intent: "omit",
	async execute(_toolCallId, params, _signal, _onUpdate, _ctx) {
		const { title, body, priority, confidence, file_path, line_start, line_end } = params;
		const location = `${file_path}:${line_start}${line_end !== line_start ? `-${line_end}` : ""}`;

		return {
			content: [
				{
					type: "text",
					text: `Finding recorded: ${priority} ${title}\nLocation: ${location}\nConfidence: ${(
						confidence * 100
					).toFixed(0)}%`,
				},
			],
			details: { title, body, priority, confidence, file_path, line_start, line_end },
		};
	},

	/**
	 * The call and result rows as views, so this tool names no terminal component.
	 *
	 * Both rows are text blocks rather than status rows: the finding's own mark sits INSIDE the line,
	 * after the tool name, where a status row would put an outcome icon in front of it. A host draws the
	 * spans in order and owns every colour.
	 */
	view: {
		renderCall(args): TextBlockView {
			return {
				kind: "textBlock",
				spans: [
					{ text: "report_finding ", tone: "title", bold: true },
					...prioritySpans(args.priority),
					{ text: " " },
					{ text: findingTitle(String(args.title)), tone: "dim" },
				],
			};
		},

		renderResult(result): TextBlockView {
			const { details } = result;
			if (!details) {
				const text = result.content[0];
				return { kind: "textBlock", spans: [{ text: text?.type === "text" ? text.text : "" }] };
			}

			const location = `${details.file_path}:${details.line_start}${
				details.line_end !== details.line_start ? `-${details.line_end}` : ""
			}`;

			return {
				kind: "textBlock",
				spans: [
					{ symbol: "tool.review", text: "", tone: "accent" },
					{ text: " " },
					...prioritySpans(details.priority),
					{ text: " " },
					{ text: location, tone: "dim" },
				],
			};
		},
	},
};

/** SubmitReviewDetails - used for rendering review results from yield tool */
export interface SubmitReviewDetails {
	overall_correctness: "correct" | "incorrect";
	explanation: string;
	confidence: number;
}

// Re-export types for external use
export type { ReportFindingDetails };
/**
 * Coerce a tool-side `ReportFindingDetails` into the cross-boundary
 * `ReviewFinding` shape consumed by the reviewer agent's JTD output schema.
 *
 * The `report_finding` tool exposes `priority` as a string enum (`"P0".."P3"`)
 * for ergonomics, but the bundled reviewer schema (and every custom review
 * agent that mirrors it) declares `priority: number`. Without this coercion
 * the auto-populated `findings[]` fails JTD validation and every review run
 * that surfaces a finding is rejected with `findings.0.priority: expected
 * number, received string`.
 */
export function toReviewFinding(details: ReportFindingDetails): ReviewFinding {
	return {
		title: details.title,
		body: details.body,
		priority: getPriorityInfo(details.priority).ord,
		confidence: details.confidence,
		file_path: details.file_path,
		line_start: details.line_start,
		line_end: details.line_end,
	};
}

/**
 * Extraction only, which is all the subprocess registry ever asked of this tool.
 *
 * The `renderInline` and `renderFinal` handlers that used to sit here were unreachable: both readers
 * in `task/render.ts` skip `report_finding` by name before they look a handler up, because findings
 * are drawn by that module's own summary and finding rows. They drew nothing and were deleted with the
 * registry member that typed them.
 */
subprocessToolRegistry.register<ReportFindingDetails>("report_finding", {
	extractData: event => {
		if (event.isError) return undefined;
		return parseReportFindingDetails(event.result?.details);
	},
});
