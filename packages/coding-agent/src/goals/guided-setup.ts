import { instrumentedCompleteSimple, resolveTelemetry } from "@veyyon/agent-core";
import type { ApiKey, Context, Tool } from "@veyyon/ai";
import { isRecord, prompt, Snowflake } from "@veyyon/utils";
import { extractTextContent, extractToolCall, parseJsonPayload } from "../commit/utils";
import { missingCredentialsMessage } from "../config/missing-credentials";
import { goalsPrompts } from "../prompts/goals/rows";
import { mapJsonStrings } from "../secrets/obfuscator";
import type { AgentSession } from "../session/agent-session";
import { concreteThinkingLevel, shouldDisableReasoning, toReasoningEffort } from "../thinking";

const RESPOND_TOOL_NAME = "respond";

const RESPOND_TOOL: Tool = {
	name: RESPOND_TOOL_NAME,
	description: "Return the next guided-goal interview step.",
	parameters: {
		type: "object",
		properties: {
			kind: { type: "string", enum: ["question", "ready"] },
			question: { type: "string" },
			objective: { type: "string" },
		},
		required: ["kind"],
		additionalProperties: false,
	},
	strict: false,
};

export interface GuidedGoalMessage {
	role: "user" | "assistant";
	content: string;
}

export type GuidedGoalTurnResult =
	| { kind: "question"; question: string; objective?: string }
	| { kind: "ready"; objective: string };

export interface GuidedGoalTurnOptions {
	messages: readonly GuidedGoalMessage[];
	signal?: AbortSignal;
	sideSessionId?: string;
}

export function newGuidedGoalSessionId(session: AgentSession): string {
	return `${session.sessionId}:guided-goal:${Snowflake.next()}`;
}

export function parseGuidedGoalPayload(value: unknown): GuidedGoalTurnResult {
	if (!isRecord(value)) {
		throw new Error("guided goal returned an invalid response");
	}
	const payload = value as Record<string, unknown>;
	const kind = typeof payload.kind === "string" ? payload.kind.trim().toLowerCase() : undefined;
	const question = typeof payload.question === "string" ? payload.question.trim() : "";
	const objective = typeof payload.objective === "string" ? payload.objective.trim() : "";

	if (kind === "ready" && objective) return { kind: "ready", objective };
	if (kind === "question" && question) {
		return objective ? { kind: "question", question, objective } : { kind: "question", question };
	}
	if (question) {
		return objective ? { kind: "question", question, objective } : { kind: "question", question };
	}
	if (kind !== "question" && objective) return { kind: "ready", objective };
	throw new Error("guided goal returned an invalid response");
}

function parseToolArguments(value: unknown): unknown {
	return typeof value === "string" ? parseJsonPayload(value) : value;
}

function refreshGuidedContextForApiKey(apiKey: ApiKey, refresh: () => void): ApiKey {
	refresh();
	if (typeof apiKey === "string") return apiKey;
	return async context => {
		const resolved = await apiKey(context);
		refresh();
		return resolved;
	};
}

export async function runGuidedGoalTurn(
	session: AgentSession,
	options: GuidedGoalTurnOptions,
): Promise<GuidedGoalTurnResult> {
	const plan = session.resolveRoleModelWithThinking("plan");
	const slow = plan.model ? plan : session.resolveRoleModelWithThinking("slow");
	const resolved = slow.model
		? slow
		: {
				model: session.model,
				thinkingLevel: session.thinkingLevel,
				explicitThinkingLevel: false,
				warning: undefined,
			};
	if (!resolved.model) {
		throw new Error("No plan, slow, or current session model is available for /guided-goal.");
	}

	let apiKey: string | undefined;
	try {
		apiKey = await session.modelRegistry.getApiKey(resolved.model, session.sessionId);
	} catch {
		throw new Error("Could not resolve credentials for the guided goal request.");
	}
	if (!apiKey) {
		throw new Error(missingCredentialsMessage(resolved.model.provider, resolved.model.id, "the guided-goal model"));
	}

	const rawSystemPrompt = prompt.render(goalsPrompts["goals/guided-goal-system"].text);
	const sanitizeLive = (text: string): string => session.obfuscateProviderText(text);
	const providerContext: Context = { messages: [] };
	const refreshProviderContext = (): void => {
		const providerMessages = options.messages.map(message => ({
			label: message.role.toUpperCase(),
			content: sanitizeLive(message.content),
		}));
		const userPrompt = prompt.render(goalsPrompts["goals/guided-goal-interview"].text, {
			messages: providerMessages,
		});
		providerContext.systemPrompt = [sanitizeLive(rawSystemPrompt)];
		providerContext.messages = [
			{ role: "user", content: [{ type: "text", text: sanitizeLive(userPrompt) }], timestamp: Date.now() },
		];
		providerContext.tools = [RESPOND_TOOL];
	};
	const thinkingLevel = concreteThinkingLevel(resolved.thinkingLevel);
	const response = await instrumentedCompleteSimple(
		resolved.model,
		providerContext,
		{
			apiKey: refreshGuidedContextForApiKey(
				session.modelRegistry.resolver(resolved.model, session.sessionId),
				refreshProviderContext,
			),
			signal: options.signal,
			reasoning: toReasoningEffort(thinkingLevel),
			disableReasoning: shouldDisableReasoning(thinkingLevel),
			toolChoice: { type: "tool", name: RESPOND_TOOL_NAME },
			onPayload: payload => mapJsonStrings(payload, sanitizeLive),
			sessionId: options.sideSessionId ?? newGuidedGoalSessionId(session),
			promptCacheKey: session.agent.promptCacheKey ?? session.sessionId,
			preferWebsockets: session.preferWebsockets,
			providerSessionState: session.providerSessionState,
		},
		{ telemetry: resolveTelemetry(session.agent.telemetry, session.sessionId), oneshotKind: "guided_goal_setup" },
	);

	if (response.stopReason === "error") {
		throw new Error(sanitizeLive(response.errorMessage ?? "guided goal request failed"));
	}
	if (response.stopReason === "aborted") {
		throw new Error("guided goal request aborted");
	}

	const call = extractToolCall(response, RESPOND_TOOL_NAME);
	let result: GuidedGoalTurnResult;
	if (call) {
		result = parseGuidedGoalPayload(parseToolArguments(call.arguments));
	} else {
		const text = extractTextContent(response);
		if (!text) {
			throw new Error("guided goal returned an invalid response");
		}
		result = parseGuidedGoalPayload(parseJsonPayload(text));
	}

	const obfuscator = session.obfuscator;
	if (!obfuscator?.hasSecrets()) return result;
	if (result.kind === "question") {
		return {
			kind: "question",
			question: obfuscator.deobfuscate(result.question),
			objective: result.objective !== undefined ? obfuscator.deobfuscate(result.objective) : undefined,
		};
	}
	return { kind: "ready", objective: obfuscator.deobfuscate(result.objective) };
}
