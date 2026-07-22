/**
 * isProviderRefusalMessage / filterProviderReplayMessages: refuse only error+refusal/sensitive.
 * Why: provider refusals must not be replayed as dialogue; other assistants stay.
 */
import { describe, expect, it } from "bun:test";
import {
	filterProviderReplayMessages,
	isProviderRefusalMessage,
} from "@veyyon/agent-core/replay-policy";
import type { AssistantMessage, Message } from "@veyyon/ai";

function assistant(
	stopReason: AssistantMessage["stopReason"],
	stopType?: string,
): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text: "x" }],
		stopReason,
		stopDetails: stopType ? ({ type: stopType } as never) : undefined,
		api: "openai-completions",
		provider: "openai",
		model: "m",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: 0,
	} as AssistantMessage;
}

describe("filter provider replay refusal and sensitive matrix", () => {
	it("refusal error is provider refusal", () => {
		expect(isProviderRefusalMessage(assistant("error", "refusal"))).toBe(true);
	});

	it("sensitive error is provider refusal", () => {
		expect(isProviderRefusalMessage(assistant("error", "sensitive"))).toBe(true);
	});

	it("error without stopDetails is not refusal", () => {
		expect(isProviderRefusalMessage(assistant("error"))).toBe(false);
	});

	it("stop end is not refusal", () => {
		expect(isProviderRefusalMessage(assistant("stop", "refusal"))).toBe(false);
	});

	it("filter drops only refusal assistants", () => {
		const keep = assistant("stop");
		const drop = assistant("error", "refusal");
		const user = { role: "user", content: "hi", timestamp: 0 } as Message;
		const out = filterProviderReplayMessages([user, drop, keep, assistant("error", "sensitive")]);
		expect(out).toHaveLength(2);
		expect(out[0]).toBe(user);
		expect(out[1]).toBe(keep);
	});

	it("empty stays empty", () => {
		expect(filterProviderReplayMessages([])).toEqual([]);
	});

	it("all non-assistant kept", () => {
		const msgs = [
			{ role: "user", content: "a", timestamp: 0 },
			{ role: "user", content: "b", timestamp: 0 },
		] as Message[];
		expect(filterProviderReplayMessages(msgs)).toEqual(msgs);
	});
});
