import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import type { Simulation } from "./harness";

export interface Violation {
	readonly rule: string;
	readonly detail: string;
}

function assistantMessages(messages: readonly AgentMessage[]): AssistantMessage[] {
	return messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

export function toolCallsIn(messages: readonly AgentMessage[]): { id: string; name: string }[] {
	const calls: { id: string; name: string }[] = [];
	for (const message of assistantMessages(messages)) {
		for (const block of message.content) {
			if (block.type === "toolCall") calls.push({ id: block.id, name: block.name });
		}
	}
	return calls;
}

export function toolResultsIn(messages: readonly AgentMessage[]): { id: string; name: string; isError: boolean }[] {
	const results: { id: string; name: string; isError: boolean }[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		results.push({ id: message.toolCallId, name: message.toolName, isError: message.isError });
	}
	return results;
}

export function turnViolations(sim: Simulation): Violation[] {
	const violations: Violation[] = [];
	const messages = sim.session.messages;

	if (sim.session.isStreaming) {
		violations.push({ rule: "settles", detail: "the session is still streaming after its own prompt resolved" });
	}
	if (sim.session.isRetrying) {
		violations.push({ rule: "settles", detail: "a retry backoff is still armed after the prompt resolved" });
	}
	if (sim.session.isCompacting) {
		violations.push({ rule: "settles", detail: "compaction is still running after the prompt resolved" });
	}
	if (sim.session.agent.hasQueuedMessages()) {
		violations.push({ rule: "settles", detail: "a queued message was never drained into a turn" });
	}

	violations.push(...pairingViolations(messages));
	return violations;
}

export function pairingViolations(messages: readonly AgentMessage[]): Violation[] {
	const violations: Violation[] = [];
	const calls = toolCallsIn(messages);
	const results = toolResultsIn(messages);

	const seen = new Set<string>();
	for (const call of calls) {
		if (seen.has(call.id)) {
			violations.push({ rule: "unique-call-ids", detail: `tool call id ${call.id} was emitted twice` });
		}
		seen.add(call.id);
	}

	const answered = new Set(results.map(result => result.id));
	for (const call of calls) {
		if (!answered.has(call.id)) {
			violations.push({
				rule: "every-call-answered",
				detail: `${call.name} (${call.id}) has no tool result, so the next request carries an unanswered tool_use`,
			});
		}
	}

	for (const result of results) {
		if (!seen.has(result.id)) {
			violations.push({
				rule: "no-orphan-results",
				detail: `a result for ${result.name} (${result.id}) answers a call that was never emitted`,
			});
		}
	}

	return violations;
}

export function describeViolations(shape: string, violations: readonly Violation[]): string[] {
	return violations.map(violation => `${shape}: [${violation.rule}] ${violation.detail}`);
}
