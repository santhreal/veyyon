/**
 * The properties every finished turn has, whatever the provider did.
 *
 * WHY THIS FILE EXISTS. The simulations next to it each script one provider
 * misbehaviour and assert what that one scenario should produce. That finds the bug
 * somebody already thought of. The shapes a provider can actually produce are a
 * cross product (content beats × how the stream ended × whether the user cancelled),
 * and the interesting failures live in combinations nobody wrote a scenario for: a
 * truncated tool call followed by a provider error, two calls where the second names
 * a tool that does not exist, a `length` stop with a call still open.
 *
 * So the invariants live here once, as properties of a FINISHED session rather than
 * of a scenario, and the matrix suites run them over every generated shape. A new
 * shape gets the whole set for free, which is the only way the tail of combinations
 * gets covered at all.
 *
 * WHAT IS AND IS NOT AN INVARIANT. Everything below must hold no matter what the
 * provider did, because each one is a way the NEXT request is malformed or the
 * session is stuck:
 *
 *  - A tool call with no result is what wedges the next request: every provider
 *    rejects a `tool_use` with no answering `tool_result`, so a turn that ends that
 *    way has poisoned the conversation, not just failed.
 *  - A result with no call is the same fault from the other side.
 *  - A duplicate call id makes the pairing ambiguous, and providers differ on which
 *    one they honour.
 *  - A session still streaming after its own prompt resolved is a lost turn: the UI
 *    shows a spinner nothing will ever stop.
 *
 * Deliberately NOT invariants: how many provider calls a shape costs (retry policy
 * is a setting), whether a truncated call is dispatched or refused (either is
 * defensible, as long as it is answered), and what the assistant text says.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import type { Simulation } from "./harness";

/** One violated property, named for the report a failing matrix cell prints. */
export interface Violation {
	readonly rule: string;
	readonly detail: string;
}

function assistantMessages(messages: readonly AgentMessage[]): AssistantMessage[] {
	return messages.filter((message): message is AssistantMessage => message.role === "assistant");
}

/** Every tool call the assistant emitted, in order, as `[id, name]`. */
export function toolCallsIn(messages: readonly AgentMessage[]): { id: string; name: string }[] {
	const calls: { id: string; name: string }[] = [];
	for (const message of assistantMessages(messages)) {
		for (const block of message.content) {
			if (block.type === "toolCall") calls.push({ id: block.id, name: block.name });
		}
	}
	return calls;
}

/** Every tool result the session recorded, in order. */
export function toolResultsIn(messages: readonly AgentMessage[]): { id: string; name: string; isError: boolean }[] {
	const results: { id: string; name: string; isError: boolean }[] = [];
	for (const message of messages) {
		if (message.role !== "toolResult") continue;
		results.push({ id: message.toolCallId, name: message.toolName, isError: message.isError });
	}
	return results;
}

/**
 * Check the finished session against every invariant, returning what failed.
 *
 * Returns a list rather than throwing so a matrix cell can report the shape it ran
 * alongside the violations, which is the difference between "something is wrong" and
 * a reproduction.
 */
export function turnViolations(sim: Simulation): Violation[] {
	const violations: Violation[] = [];
	const messages = sim.session.messages;

	// Four latches, not one. `isStreaming` is the spinner, but a turn can also be
	// left waiting on a retry backoff, mid-compaction, or holding a queued steer
	// that will never start its own run, and each of those is the same operator
	// symptom: the session sits there and no further work happens.
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

/**
 * The pairing rules, over any message list.
 *
 * Stored history is one list a turn must leave well formed; the CONTEXT of the
 * next provider call is the other, and they are not the same list. Compaction,
 * canonicalization, and pruning all rewrite the outbound one, so a session whose
 * stored history is perfect can still put an unpaired `tool_use` on the wire.
 * That is the shape a provider rejects, so the check has to be runnable against
 * whichever list is under test.
 */
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

/** Format violations for an assertion message that names the shape that produced them. */
export function describeViolations(shape: string, violations: readonly Violation[]): string[] {
	return violations.map(violation => `${shape}: [${violation.rule}] ${violation.detail}`);
}
