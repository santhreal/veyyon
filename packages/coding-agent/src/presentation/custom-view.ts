/**
 * `CustomBlockDisplay` to `ToolView`: what a recorded message that is neither a prompt nor a model
 * reply states, in the host-agnostic block vocabulary.
 *
 * A background job that finished, diagnostics that arrived after a turn, a guest's prompt, a skill
 * invocation, agent-to-agent traffic, an advisor note, a dispatched tangent and a handoff summary
 * are eight different facts, and a host given their text alone draws eight identical paragraphs.
 * The terminal reads the same typed display and builds a card per variant out of its own
 * components; those components are terminal references, so nothing else can draw them. Stated as a
 * view, each variant keeps its identity — what the message is, who it is from, what it names — and
 * every host draws it with the renderer it already has for a tool's output.
 */

import { collapseWhitespace, formatCount, formatDuration } from "@veyyon/utils";
import type {
	FramedBlockView,
	HeadedBlockView,
	StatusRowView,
	ToolView,
	ViewHiddenCount,
	ViewLine,
	ViewSection,
	ViewSpan,
	ViewTone,
} from "@veyyon/view";
import type {
	AdvisorCustomDisplay,
	AsyncResultCustomDisplay,
	BackgroundTanDispatchCustomDisplay,
	CollabPromptCustomDisplay,
	CustomBlockDisplay,
	HandoffSummaryCustomDisplay,
	IrcMessageCustomDisplay,
	LateDiagnosticsCustomDisplay,
	SkillPromptCustomDisplay,
} from "@veyyon/wire/presentation";
import { diagnosticsSection } from "../tools/core/diagnostics";
import { previewLine } from "../tools/core/render-utils";

/** The rows a message body states before the rest is counted instead. */
const BODY_LINES = 12;
/** The columns one body row is cut to before a host fits it to its own width. */
const BODY_WIDTH = 120;
/** The columns a one-line subject is cut to. */
const SUBJECT_WIDTH = 72;

const LINE_NOUN = { one: "line", many: "lines" } as const;

/** A message body as rows, with the rows past the bound counted rather than dropped in silence. */
function bodyRows(text: string): { lines: ViewLine[]; hidden?: ViewHiddenCount } {
	const rows = text.split("\n").filter(row => row.trim().length > 0);
	const lines: ViewLine[] = rows
		.slice(0, BODY_LINES)
		.map(row => [{ text: previewLine(row, BODY_WIDTH), tone: "output" }]);
	const held = rows.length - lines.length;
	return held > 0 ? { lines, hidden: { count: held, noun: LINE_NOUN, revealable: false } } : { lines };
}

/** A framed card: a header row, the body under it, and what the body held back. */
function framed(header: StatusRowView, body: { lines: ViewLine[]; hidden?: ViewHiddenCount }): FramedBlockView {
	const section: ViewSection = body.hidden ? { lines: body.lines, hidden: body.hidden } : { lines: body.lines };
	return { kind: "framedBlock", header, sections: [section], contents: "data" };
}

function asyncResultView(display: AsyncResultCustomDisplay): ToolView {
	const lines: ViewLine[] = display.jobs.map(job => {
		const spans: ViewSpan[] = [
			{ text: "", symbol: "status.done", tone: "success" },
			{ text: "Background job completed", tone: "success" },
			{ text: job.type ? `[${job.type}]` : "[job]", tone: "dim" },
			{ text: job.jobId ?? "unknown", tone: "accent" },
		];
		if (typeof job.durationMs === "number") {
			spans.push({ text: `(${formatDuration(job.durationMs)})`, tone: "dim" });
		}
		return spans;
	});
	return { kind: "headedBlock", lines };
}

function lateDiagnosticsView(display: LateDiagnosticsCustomDisplay): ToolView | undefined {
	const messages: string[] = [];
	const summaries: string[] = [];
	let errored = false;
	for (const file of display.files) {
		if (file.messages?.length) messages.push(...file.messages);
		if (file.summary) summaries.push(file.summary);
		if (file.errored) errored = true;
	}
	const section = diagnosticsSection({ errored, summary: summaries.join(", "), messages }, false, {
		title: "Late diagnostics",
	});
	if (section === undefined) return undefined;
	return {
		kind: "framedBlock",
		state: errored ? "error" : "warning",
		sections: [section],
		contents: "report",
	};
}

function collabPromptView(display: CollabPromptCustomDisplay): ToolView {
	return framed({ kind: "statusRow", title: `«${display.from}»`, titleTone: "accent" }, bodyRows(display.text));
}

function skillPromptView(display: SkillPromptCustomDisplay): ToolView {
	const header: StatusRowView = {
		kind: "statusRow",
		status: "info",
		title: `skill: ${display.name}`,
		titleTone: "title",
	};
	const args = collapseWhitespace(display.args ?? "");
	if (args) {
		header.description = previewLine(args, SUBJECT_WIDTH);
		header.descriptionTone = "dim";
	}
	const meta: ViewLine[] = [];
	if (display.path) meta.push([{ text: display.path, tone: "link", file: display.path }]);
	if (typeof display.lineCount === "number") {
		meta.push([{ text: formatCount("line", display.lineCount), tone: "dim" }]);
	}
	if (meta.length > 0) header.meta = meta;
	return framed(header, bodyRows(display.text));
}

function ircView(display: IrcMessageCustomDisplay): ToolView {
	const from = display.from?.trim() || "?";
	const to = display.to?.trim() || "?";
	const title =
		display.kind === "incoming"
			? `IRC ← ${from}`
			: display.kind === "autoreply"
				? `IRC → ${to}`
				: `IRC ${from} → ${to}`;
	const header: StatusRowView = { kind: "statusRow", emblem: "tool.irc", title, titleTone: "title" };
	const meta: ViewLine[] = [];
	if (display.kind === "autoreply") meta.push([{ text: "auto", tone: "dim" }]);
	if (display.replyTo) meta.push([{ text: "reply", tone: "dim" }]);
	if (meta.length > 0) header.meta = meta;
	return framed(header, bodyRows(display.body ?? ""));
}

function severityTone(severity: AdvisorCustomDisplay["notes"][number]["severity"]): ViewTone {
	if (severity === "blocker") return "error";
	return severity === "concern" ? "warning" : "muted";
}

function advisorView(display: AdvisorCustomDisplay): ToolView {
	const blockers = display.notes.filter(note => note.severity === "blocker").length;
	const header: StatusRowView = {
		kind: "statusRow",
		status: "info",
		title: "Advisor",
		titleTone: "title",
		description: formatCount("note", display.notes.length),
		descriptionTone: "dim",
	};
	if (blockers > 0) header.badge = { label: formatCount("blocker", blockers), tone: "error" };
	const lines: ViewLine[] = display.notes.map(note => {
		const spans: ViewSpan[] = [];
		if (note.severity) spans.push({ text: note.severity, tone: severityTone(note.severity), bold: true });
		if (note.advisor) spans.push({ text: note.advisor, tone: "accent" });
		spans.push({ text: previewLine(note.note, BODY_WIDTH), tone: "output" });
		return spans;
	});
	return { kind: "framedBlock", header, state: blockers > 0 ? "warning" : "info", sections: [{ lines }] };
}

function backgroundTanView(display: BackgroundTanDispatchCustomDisplay): ToolView {
	const spans: ViewSpan[] = [
		{ text: "", symbol: "tool.output", tone: "muted" },
		{ text: "Tangent dispatched", tone: "muted" },
		{ text: "[task]", tone: "dim" },
		{ text: display.jobId, tone: "accent" },
	];
	if (display.work) spans.push({ text: previewLine(display.work, SUBJECT_WIDTH), tone: "dim" });
	const block: HeadedBlockView = { kind: "headedBlock", lines: [spans] };
	return block;
}

function handoffView(display: HandoffSummaryCustomDisplay): ToolView {
	return framed(
		{ kind: "statusRow", status: "info", title: "Handoff summary", titleTone: "title" },
		bodyRows(display.summary),
	);
}

/**
 * The view one typed display states, or `undefined` for a display whose card states nothing at all.
 *
 * Only late diagnostics has that case: a message recorded with no diagnostic in it draws no card in
 * the terminal either, and a host handed an empty frame would draw a titled box around nothing.
 */
export function customDisplayToView(display: CustomBlockDisplay): ToolView | undefined {
	switch (display.variant) {
		case "async-result":
			return asyncResultView(display);
		case "late-diagnostics":
			return lateDiagnosticsView(display);
		case "collab-prompt":
			return collabPromptView(display);
		case "skill-prompt":
			return skillPromptView(display);
		case "irc":
			return ircView(display);
		case "advisor":
			return advisorView(display);
		case "background-tan":
			return backgroundTanView(display);
		case "handoff":
			return handoffView(display);
	}
}
