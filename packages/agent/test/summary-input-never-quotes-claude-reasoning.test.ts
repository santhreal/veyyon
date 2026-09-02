import { describe, expect, test } from "bun:test";
import { serializeConversation } from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Message, Usage } from "@veyyon/ai";
import { DIALECTS } from "@veyyon/catalog/identity";

/**
 * WHY: compaction feeds the region it is about to summarize back to a model as
 * TEXT, rendered through that model's dialect. The Anthropic dialect renders a
 * thinking block verbatim inside `<thinking>` tags, so summarizing with a
 * Claude model asked it to read its own reasoning back — which its
 * `reasoning_extraction` classifier declines with
 * `stop_reason: "refusal"`. The session then cannot compact at all: every
 * retry rebuilds the same input and earns the same refusal.
 *
 * The class this closes: no Anthropic-dialect summary input may quote prior
 * reasoning, in tags or otherwise. The dialect list is swept from
 * {@link DIALECTS} at run time, so a new dialect that renders reasoning into
 * summary input has to record a decision here rather than inherit one.
 *
 * What it does NOT catch: reasoning replayed as a structured `thinking` block
 * on the wire (that is `transformMessages`' job, and the classifier accepts
 * signed native blocks), or a summary whose own text a model chooses to write
 * about its reasoning.
 */

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

const REASONING = "The user wants auth.ts patched; read it, then edit the guard.";
const VISIBLE = "Patching the guard in auth.ts.";

function assistantMessage(content: AssistantMessage["content"]): Message {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage: ZERO_USAGE,
		stopReason: "stop",
		timestamp: 0,
	};
}

const HISTORY: Message[] = [
	{ role: "user", content: "Fix the failing auth test.", timestamp: 0 },
	assistantMessage([
		{ type: "thinking", thinking: REASONING, thinkingSignature: "sig" },
		{ type: "text", text: VISIBLE },
	]),
];

describe("summary input", () => {
	test("omits prior reasoning for the anthropic dialect and keeps the visible turn", () => {
		const rendered = serializeConversation(HISTORY, "anthropic");

		expect(rendered).not.toContain(REASONING);
		expect(rendered).not.toContain("<thinking");
		expect(rendered).toContain(VISIBLE);
	});

	test("keeps prior reasoning for every dialect that carries it natively", () => {
		// Swept from the dialect registry, anthropic included: it lands in the
		// omitting set because it actually omits, not because the sweep put it
		// there. A dialect added later shows up here as a decision to make,
		// not as silent inherited behavior.
		const omitsReasoning = DIALECTS.filter(dialect => !serializeConversation(HISTORY, dialect).includes(REASONING));

		// Anthropic is the only dialect whose summary input is stripped, and it
		// is stripped because the classifier refuses it — not as a size saving.
		expect(omitsReasoning).toEqual(["anthropic"]);
	});
});
