import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { prompt } from "@veyyon/utils";
import { toolsPrompts } from "../prompts/tools/rows";
import type { ToolSession } from ".";
import type { CheckpointParams, CheckpointToolDetails, RewindParams, RewindToolDetails } from "./checkpoint-helpers";
import { checkpointSchema, isTopLevelSession, rewindSchema } from "./checkpoint-helpers";
import { ToolError } from "./tool-errors";
import { toolResult } from "./tool-result";

export type { CheckpointState, CompletedRewindState } from "./checkpoint-helpers";

export class CheckpointTool implements AgentTool<typeof checkpointSchema, CheckpointToolDetails> {
	readonly name = "checkpoint";
	readonly approval = "read" as const;
	readonly label = "Checkpoint";
	readonly summary = "Create a git-based checkpoint to save and restore session state";
	readonly description: string;
	readonly parameters = checkpointSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (args: Partial<CheckpointParams>) => (args.goal ? `checkpointing: ${args.goal}` : "checkpointing");

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/checkpoint"].text);
	}

	static createIf(session: ToolSession): CheckpointTool | null {
		if (!isTopLevelSession(session)) return null;
		return new CheckpointTool(session);
	}

	async execute(
		_toolCallId: string,
		params: CheckpointParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<CheckpointToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<CheckpointToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (this.session.getCheckpointState?.()) {
			throw new ToolError("Checkpoint already active.");
		}
		const startedAt = new Date().toISOString();
		return toolResult<CheckpointToolDetails>({ goal: params.goal, startedAt })
			.text(
				[
					"Checkpoint created.",
					`Goal: ${params.goal}`,
					"Run your investigation, then call rewind with a concise report.",
				].join("\n"),
			)
			.done();
	}
}

export class RewindTool implements AgentTool<typeof rewindSchema, RewindToolDetails> {
	readonly name = "rewind";
	readonly approval = "read" as const;
	readonly label = "Rewind";
	readonly summary = "Rewind to a previously created checkpoint";
	readonly description: string;
	readonly parameters = rewindSchema;
	readonly strict = true;
	readonly loadMode = "discoverable";
	readonly intent = (): string => "rewinding";

	constructor(private readonly session: ToolSession) {
		this.description = prompt.render(toolsPrompts["tools/rewind"].text);
	}

	static createIf(session: ToolSession): RewindTool | null {
		if (!isTopLevelSession(session)) return null;
		return new RewindTool(session);
	}

	async execute(
		_toolCallId: string,
		params: RewindParams,
		_signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<RewindToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<RewindToolDetails>> {
		if (!isTopLevelSession(this.session)) {
			throw new ToolError("Checkpoint not available in subagents.");
		}
		if (!this.session.getCheckpointState?.()) {
			if (this.session.getLastCompletedRewind?.()) {
				throw new ToolError(
					"Checkpoint already completed; continue from the retained rewind report instead of calling rewind again.",
				);
			}
			throw new ToolError("No active checkpoint. Create a checkpoint before calling rewind.");
		}
		const report = params.report.trim();
		if (report.length === 0) {
			throw new ToolError("Report cannot be empty.");
		}
		return toolResult<RewindToolDetails>({ report, rewound: true })
			.text(["Rewind requested.", "Report captured for context replacement."].join("\n"))
			.done();
	}
}
