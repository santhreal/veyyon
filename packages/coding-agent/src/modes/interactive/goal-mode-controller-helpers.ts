import type { AssistantMessage } from "@veyyon/ai";
import type { AgentSessionEvent } from "../../session/agent-session";

export const GOAL_FAILED_TURN_LIMIT = 3;
export const GOAL_CONTINUATION_DELAY_MS = 800;
export const GOAL_CONTINUATION_BUSY_WAIT_MS = 300_000;

export type GoalContinuationBlock =
	| "loop-mode"
	| "no-input-callback"
	| "continuation-mode-off"
	| "plan-mode"
	| "goal-mode-off"
	| "suppressed"
	| "busy"
	| "submission-pending"
	| "draft-in-composer"
	| "images-attached"
	| "goal-not-active"
	| "no-prompt";

export const GOAL_CONTINUATION_QUIET_BLOCKS: ReadonlySet<GoalContinuationBlock> = new Set([
	"loop-mode",
	"no-input-callback",
	"continuation-mode-off",
	"goal-mode-off",
]);

export type GoalSubcommand = "set" | "show" | "pause" | "resume" | "drop";

export function goalTurnEndedInError(event: Extract<AgentSessionEvent, { type: "agent_end" }>): boolean {
	let lastAssistant: AssistantMessage | undefined;
	for (let i = event.messages.length - 1; i >= 0; i--) {
		const message = event.messages[i]!;
		if (message.role === "assistant") {
			lastAssistant = message;
			break;
		}
	}
	return lastAssistant?.stopReason === "error";
}

export function parseGoalSubcommand(args: string): { sub: GoalSubcommand | undefined; rest: string } {
	const trimmed = args.trim();
	if (!trimmed) return { sub: undefined, rest: "" };
	const match = /^(\S+)(?:\s+([\s\S]*))?$/.exec(trimmed);
	if (!match) return { sub: undefined, rest: trimmed };
	const verb = match[1]?.toLowerCase();
	const rest = (match[2] ?? "").trim();
	if (verb === "set" || verb === "show" || verb === "pause" || verb === "resume" || verb === "drop") {
		return { sub: verb, rest };
	}
	return { sub: undefined, rest: trimmed };
}
