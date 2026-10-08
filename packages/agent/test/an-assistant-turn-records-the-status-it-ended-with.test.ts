/**
 * An assistant turn records the status it ended with.
 *
 * WHY. With `instrumentation` on, the loop stamps `turnMetrics` and `request` on the message a turn commits, and the
 * stats dashboard counts failed and cancelled turns from `turnMetrics.status`. A status read from the wrong signal
 * books a failure as a success: an `error` event whose message has no `errorMessage`, or a turn the caller aborted,
 * recorded as `ok`.
 *
 * CLASS. Every way a provider stream ends with a terminal outcome, swept from one table: a `done` event, a `done`
 * event whose message carries an error, an `error` event with and without an `errorMessage`, an abort raised while
 * the stream is being read, and an abort raised before the loop reads the first event. Each commits a message whose
 * `turnMetrics.status` is the status that ending maps to, and whose `request` records the call it went out with.
 *
 * GAP. A stream that ends without a terminal event commits its result without `turnMetrics` or `request`; this suite
 * does not cover that ending.
 */
import { describe, expect, it } from "bun:test";
import { agentLoop } from "@veyyon/agent-core/agent-loop";
import type { AgentContext, AgentLoopConfig, AgentMessage, StreamFn } from "@veyyon/agent-core/types";
import type { AssistantMessage, AssistantTurnStatus, Message } from "@veyyon/ai";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { createUserMessage } from "./helpers";

type Ending =
	| "done"
	| "done carrying an error"
	| "error event"
	| "error event without an error message"
	| "abort while reading"
	| "abort before the first read";

const STATUS_FOR: Record<Ending, AssistantTurnStatus> = {
	done: "ok",
	"done carrying an error": "error",
	"error event": "error",
	"error event without an error message": "error",
	"abort while reading": "aborted",
	"abort before the first read": "aborted",
};

const MODEL = createMockModel();

function message(overrides: Partial<AssistantMessage> = {}): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "partial answer" }],
		api: MODEL.api,
		provider: MODEL.provider,
		model: MODEL.id,
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop",
		timestamp: Date.now(),
		...overrides,
	};
}

/** A provider stream that streams one text block, then ends the way `ending` names. */
function scriptedStream(ending: Ending, controller: AbortController): StreamFn {
	return () => {
		const stream = new AssistantMessageEventStream();
		const partial = message();
		stream.push({ type: "start", partial });
		stream.push({ type: "text_start", contentIndex: 0, partial });
		stream.push({ type: "text_delta", contentIndex: 0, delta: "partial answer", partial });
		switch (ending) {
			case "done":
				stream.push({ type: "done", reason: "stop", message: message() });
				break;
			case "done carrying an error":
				stream.push({ type: "done", reason: "stop", message: message({ errorMessage: "upstream truncated" }) });
				break;
			case "error event":
				stream.push({
					type: "error",
					reason: "error",
					error: message({ stopReason: "error", errorMessage: "upstream failed" }),
				});
				break;
			case "error event without an error message":
				stream.push({ type: "error", reason: "error", error: message({ stopReason: "error" }) });
				break;
			case "abort while reading":
				// The loop's per-event hook aborts on the delta; the stream never ends on its own.
				break;
			case "abort before the first read":
				controller.abort();
				break;
		}
		return stream;
	};
}

function identityConverter(messages: AgentMessage[]): Message[] {
	return messages.filter(m => m.role === "user" || m.role === "assistant" || m.role === "toolResult") as Message[];
}

async function runTurn(ending: Ending): Promise<AssistantMessage> {
	const controller = new AbortController();
	const config: AgentLoopConfig = {
		model: MODEL,
		convertToLlm: identityConverter,
		instrumentation: "basic",
		temperature: 0.3,
		onAssistantMessageEvent: (_partial, event) => {
			if (ending === "abort while reading" && event.type === "text_delta") controller.abort();
		},
	};
	const context: AgentContext = { systemPrompt: [""], messages: [], tools: [] };
	const stream = agentLoop(
		[createUserMessage("go")],
		context,
		config,
		controller.signal,
		scriptedStream(ending, controller),
	);
	const messages = await stream.result();
	const committed = messages.findLast((m): m is AssistantMessage => m.role === "assistant");
	if (!committed) throw new Error(`the ${ending} turn committed no assistant message`);
	return committed;
}

describe("an assistant turn records the status it ended with", () => {
	for (const [ending, status] of Object.entries(STATUS_FOR) as [Ending, AssistantTurnStatus][]) {
		it(`${ending} records ${status}`, async () => {
			const committed = await runTurn(ending);
			expect(committed.turnMetrics?.status).toBe(status);
			expect(committed.request?.temperature).toBe(0.3);
		});
	}
});
