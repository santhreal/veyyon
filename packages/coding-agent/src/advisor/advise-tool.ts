import type {
	AgentIdentity,
	AgentTelemetryConfig,
	AgentTool,
	AgentToolContext,
	AgentToolResult,
	AgentToolUpdateCallback,
} from "@veyyon/agent-core";
import { escapeXmlAttribute, escapeXmlText } from "@veyyon/utils";
import { type } from "arktype";
import { advisorPrompts } from "../prompts/advisor/rows";

const adviseSchema = type({
	note: type("string").describe(
		"One concrete piece of advice for the agent you are watching. Terse, specific, actionable.",
	),
	"severity?": type("'nit' | 'concern' | 'blocker'").describe("How strongly to weigh this. Omit for a plain nit."),
});

export type AdviseParams = typeof adviseSchema.infer;

export type AdvisorSeverity = "nit" | "concern" | "blocker";

export interface AdviseDetails {
	note: string;
	severity?: AdvisorSeverity;
	advisor?: string;
}

export interface AdvisorNote {
	note: string;
	severity?: AdvisorSeverity;
	advisor?: string;
}

export interface AdvisorMessageDetails {
	notes: AdvisorNote[];
}

const ADVISOR_GUIDANCE = "weigh, don't blindly obey";

export function formatAdvisorBatchContent(notes: readonly AdvisorNote[]): string {
	return notes
		.map(n => {
			const severity = n.severity ? ` severity="${n.severity}"` : "";
			const who = n.advisor ? ` advisor="${escapeXmlAttribute(n.advisor)}"` : "";
			return `<advisory${who}${severity} guidance="${ADVISOR_GUIDANCE}">\n${escapeXmlText(n.note)}\n</advisory>`;
		})
		.join("\n");
}

export function isInterruptingSeverity(severity: AdvisorSeverity | undefined): boolean {
	return severity === "concern" || severity === "blocker";
}

export function annotateForStaleness(note: string, hasFreshBacklog: boolean): string {
	if (!hasFreshBacklog) return note;
	return `${note}\n\n_(Note: newer primary turns arrived after this reviewed window — verify this still applies.)_`;
}

export type AdvisorDeliveryChannel = "aside" | "steer" | "preserve";
export function isAdvisorInterruptImmuneTurnActive(opts: {
	completedTurns: number;
	immuneTurnStart: number | undefined;
	immuneTurns: number;
}): boolean {
	if (opts.immuneTurnStart === undefined || opts.immuneTurns <= 0) return false;
	return opts.completedTurns < opts.immuneTurnStart + opts.immuneTurns;
}

export function resolveAdvisorDeliveryChannel(opts: {
	severity: AdvisorSeverity | undefined;
	autoResumeSuppressed: boolean;
	streaming: boolean;
	aborting: boolean;
	terminalAnswerNoQueuedWork?: boolean;
	interruptImmuneTurnActive?: boolean;
}): AdvisorDeliveryChannel {
	if (!isInterruptingSeverity(opts.severity)) return "aside";
	if (opts.autoResumeSuppressed && (opts.aborting || !opts.streaming)) return "preserve";
	if (opts.terminalAnswerNoQueuedWork && !opts.streaming && !opts.aborting) return "preserve";
	if (opts.interruptImmuneTurnActive) return "aside";
	return "steer";
}

export function deriveAdvisorTelemetry(
	primaryTelemetry: AgentTelemetryConfig | undefined,
	identity: AgentIdentity,
): AgentTelemetryConfig | undefined {
	if (!primaryTelemetry) return undefined;
	return { ...primaryTelemetry, agent: identity, conversationId: undefined };
}

export const ADVISOR_DEFAULT_TOOL_NAMES: ReadonlySet<string> = new Set(["read", "grep", "glob"]);

function advisorNoteDedupeKey(note: string): string {
	return note.trim().replace(/\s+/g, " ");
}

const ADVISOR_SEVERITY_RANK: Record<AdvisorSeverity, number> = { nit: 1, concern: 2, blocker: 3 };
function advisorSeverityRank(severity: AdvisorSeverity | undefined): number {
	return ADVISOR_SEVERITY_RANK[severity ?? "nit"];
}

export class AdviseTool implements AgentTool<typeof adviseSchema, AdviseDetails> {
	readonly name = "advise";
	readonly label = "Advise";
	readonly description = advisorPrompts["advisor/advise-tool"].text;
	readonly parameters = adviseSchema;
	readonly intent = "omit" as const;
	#deliveredNoteSeverities = new Map<string, number>();

	constructor(private readonly onAdvice: (note: string, severity?: AdviseDetails["severity"]) => void) {}

	resetDeliveredNotes(): void {
		this.#deliveredNoteSeverities.clear();
	}

	async execute(
		_toolCallId: string,
		args: AdviseParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<AdviseDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<AdviseDetails>> {
		const key = advisorNoteDedupeKey(args.note);
		const rank = advisorSeverityRank(args.severity);
		const previousRank = this.#deliveredNoteSeverities.get(key) ?? 0;
		if (rank <= previousRank) {
			return {
				content: [{ type: "text", text: "Duplicate advice ignored." }],
				details: { note: args.note, severity: args.severity },
				useless: true,
			};
		}
		this.#deliveredNoteSeverities.set(key, rank);
		this.onAdvice(args.note, args.severity);
		return {
			content: [{ type: "text", text: "Recorded." }],
			details: { note: args.note, severity: args.severity },
			useless: true,
		};
	}
}
