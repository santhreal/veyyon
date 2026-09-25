/**
 * `customType` to `CustomBlockDisplay`: the typed display a custom or hook message projects to,
 * keyed by its custom type, so a renderer draws a job row, a diagnostic list or an IRC line from
 * the block alone and never from `details`.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import { isRecord } from "@veyyon/utils/type-guards";
import type {
	AdvisorCustomDisplay,
	AdvisorNoteDisplay,
	AsyncResultCustomDisplay,
	AsyncResultJobDisplay,
	BackgroundTanDispatchCustomDisplay,
	CollabPromptCustomDisplay,
	CustomBlockDisplay,
	HandoffSummaryCustomDisplay,
	IrcMessageCustomDisplay,
	LateDiagnosticsCustomDisplay,
	LateDiagnosticsFileDisplay,
	SkillPromptCustomDisplay,
} from "@veyyon/wire/presentation";
import { COLLAB_PROMPT_MESSAGE_TYPE } from "../collab/protocol";
import {
	BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE,
	type CustomMessage,
	IRC_ROOM_MESSAGE_TYPE,
	LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE,
	SKILL_PROMPT_MESSAGE_TYPE,
} from "../session/messages";
import { contentToText } from "./content-text";
import { toHandoffSummaryView } from "./summary-builder";

export function readCustomLevel(message: unknown): "info" | "warning" | "error" {
	if (isRecord(message) && (message.level === "error" || message.level === "warning" || message.level === "info")) {
		return message.level;
	}
	return "info";
}

function projectAsyncResultDisplay(details: unknown): AsyncResultCustomDisplay {
	const d = isRecord(details) ? details : {};
	const jobsRaw = Array.isArray(d.jobs) && d.jobs.length > 0 ? d.jobs : [d];
	const jobs: AsyncResultJobDisplay[] = [];
	for (const j of jobsRaw) {
		if (!isRecord(j)) continue;
		jobs.push({
			jobId: typeof j.jobId === "string" ? j.jobId : undefined,
			type: typeof j.type === "string" ? j.type : undefined,
			label: typeof j.label === "string" ? j.label : undefined,
			durationMs: typeof j.durationMs === "number" ? j.durationMs : undefined,
		});
	}
	return { variant: "async-result", jobs };
}

function projectLateDiagnosticsDisplay(details: unknown): LateDiagnosticsCustomDisplay {
	const filesRaw = isRecord(details) && Array.isArray(details.files) ? details.files : [];
	const files: LateDiagnosticsFileDisplay[] = [];
	for (const f of filesRaw) {
		if (!isRecord(f)) continue;
		files.push({
			path: typeof f.path === "string" ? f.path : undefined,
			summary: typeof f.summary === "string" ? f.summary : undefined,
			errored: typeof f.errored === "boolean" ? f.errored : undefined,
			messages: Array.isArray(f.messages) ? f.messages.filter((m): m is string => typeof m === "string") : undefined,
		});
	}
	return { variant: "late-diagnostics", files };
}

function projectCollabPromptDisplay(details: unknown, content: unknown): CollabPromptCustomDisplay {
	const from = isRecord(details) && typeof details.from === "string" ? details.from.trim() : "guest";
	return { variant: "collab-prompt", from: from || "guest", text: contentToText(content, "") };
}

function projectSkillPromptDisplay(details: unknown, content: unknown): SkillPromptCustomDisplay {
	const d = isRecord(details) ? details : {};
	return {
		variant: "skill-prompt",
		name: typeof d.name === "string" ? d.name.trim() : "unknown",
		path: typeof d.path === "string" ? d.path : undefined,
		args: typeof d.args === "string" ? d.args : undefined,
		lineCount: typeof d.lineCount === "number" ? d.lineCount : undefined,
		promptBytes: typeof d.promptBytes === "number" ? d.promptBytes : undefined,
		text: contentToText(content, "\n", true),
	};
}

function projectIrcDisplay(customType: string, details: unknown, timestamp: number): IrcMessageCustomDisplay {
	const kind = customType === "irc:incoming" ? "incoming" : customType === "irc:autoreply" ? "autoreply" : "relay";
	const d = isRecord(details) ? details : {};
	const body =
		kind === "incoming" && typeof d.message === "string"
			? d.message
			: typeof d.body === "string"
				? d.body
				: undefined;
	return {
		variant: "irc",
		kind,
		from: typeof d.from === "string" ? d.from : undefined,
		to: typeof d.to === "string" ? d.to : undefined,
		body,
		replyTo: typeof d.replyTo === "string" ? d.replyTo : undefined,
		timestamp,
	};
}

/**
 * The lines of a `#room` record, each its poster's label and its body, and whether they are what
 * the room said before the conversation joined. Read field by field, since the details come back
 * from a session file that another build may have written.
 */
export function readRoomRecord(details: unknown): {
	readonly lines: ReadonlyArray<{ readonly label: string; readonly body: string }>;
	readonly backlog: boolean;
} {
	const d = isRecord(details) ? details : {};
	const lines = (Array.isArray(d.lines) ? d.lines : []).filter(isRecord).map(line => ({
		label: typeof line.label === "string" ? line.label : "?",
		body: typeof line.body === "string" ? line.body : "",
	}));
	return { lines, backlog: d.backlog === true };
}

/**
 * A `#room` record as its card: one line as its poster and body, or the lines posted before the
 * conversation joined as one `poster: body` row each.
 */
function projectRoomDisplay(details: unknown, timestamp: number): IrcMessageCustomDisplay {
	const { lines, backlog } = readRoomRecord(details);
	if (backlog) {
		return {
			variant: "irc",
			kind: "room",
			body: lines.map(line => `${line.label}: ${line.body}`).join("\n"),
			timestamp,
			backlog: true,
		};
	}
	const line = lines[0];
	return { variant: "irc", kind: "room", from: line?.label, body: line?.body, timestamp };
}

function projectAdvisorDisplay(details: unknown): AdvisorCustomDisplay {
	const notesRaw = isRecord(details) && Array.isArray(details.notes) ? details.notes : [];
	const notes: AdvisorNoteDisplay[] = [];
	for (const n of notesRaw) {
		if (!isRecord(n)) continue;
		notes.push({
			note: typeof n.note === "string" ? n.note : "",
			severity:
				n.severity === "blocker" || n.severity === "concern" || n.severity === "nit" ? n.severity : undefined,
			advisor: typeof n.advisor === "string" ? n.advisor : undefined,
		});
	}
	return { variant: "advisor", notes };
}

function projectBackgroundTanDisplay(details: unknown): BackgroundTanDispatchCustomDisplay {
	const d = isRecord(details) ? details : {};
	return {
		variant: "background-tan",
		jobId: typeof d.jobId === "string" ? d.jobId : "unknown",
		work: typeof d.work === "string" ? d.work : undefined,
		sessionFile: typeof d.sessionFile === "string" ? d.sessionFile : undefined,
	};
}

function projectHandoffDisplay(
	message: Extract<AgentMessage, { role: "custom" }>,
): HandoffSummaryCustomDisplay | undefined {
	const handoffView = toHandoffSummaryView(message as CustomMessage<unknown>);
	if (!handoffView) return undefined;
	return { variant: "handoff", summary: handoffView.summary };
}

export function projectCustomDisplay(
	customType: string,
	details: unknown,
	content: unknown,
	timestamp: number,
	message: unknown,
): CustomBlockDisplay | undefined {
	if (customType === "async-result") {
		return projectAsyncResultDisplay(details);
	}
	if (customType === LSP_LATE_DIAGNOSTIC_MESSAGE_TYPE) {
		return projectLateDiagnosticsDisplay(details);
	}
	if (customType === COLLAB_PROMPT_MESSAGE_TYPE) {
		return projectCollabPromptDisplay(details, content);
	}
	if (customType === SKILL_PROMPT_MESSAGE_TYPE) {
		return projectSkillPromptDisplay(details, content);
	}
	if (customType === "irc:incoming" || customType === "irc:autoreply" || customType === "irc:relay") {
		return projectIrcDisplay(customType, details, timestamp);
	}
	if (customType === IRC_ROOM_MESSAGE_TYPE) {
		return projectRoomDisplay(details, timestamp);
	}
	if (customType === "advisor") {
		return projectAdvisorDisplay(details);
	}
	if (customType === BACKGROUND_TAN_DISPATCH_MESSAGE_TYPE) {
		return projectBackgroundTanDisplay(details);
	}
	if (customType === "handoff") {
		return projectHandoffDisplay(message as Extract<AgentMessage, { role: "custom" }>);
	}
	return undefined;
}
