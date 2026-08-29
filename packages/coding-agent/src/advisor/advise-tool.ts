import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { advisorPrompts } from "../prompts/advisor/rows";
import type { AdviseDetails, AdviseParams } from "./advise-tool-helpers";

export * from "./advise-tool-helpers";

import { adviseSchema, advisorNoteDedupeKey, advisorSeverityRank } from "./advise-tool-helpers";

export {
	ADVISOR_DEFAULT_TOOL_NAMES,
	annotateForStaleness,
	deriveAdvisorTelemetry,
	formatAdvisorBatchContent,
	isAdvisorInterruptImmuneTurnActive,
	isInterruptingSeverity,
	resolveAdvisorDeliveryChannel,
} from "./advise-tool-helpers";

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
