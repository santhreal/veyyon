/**
 * Provider refusal messages (stopReason error + stopDetails type refusal/sensitive)
 * are stripped from live provider replay; other roles and assistant turns stay.
 */
import { describe, expect, it } from "bun:test";
import { filterProviderReplayMessages, isProviderRefusalMessage } from "@veyyon/agent-core/replay-policy";
import type { AssistantMessage, Message } from "@veyyon/ai";

function assistant(
	stopReason: AssistantMessage["stopReason"],
	stopDetails?: AssistantMessage["stopDetails"],
): AssistantMessage {
	return {
		role: "assistant",
		provider: "mock",
		model: "mock",
		api: "mock" as AssistantMessage["api"],
		content: [{ type: "text", text: "x" }],
		stopReason,
		stopDetails,
		timestamp: 1,
	} as AssistantMessage;
}

describe("isProviderRefusalMessage pure matrix", () => {
	it("true for error+refusal", () => {
		expect(isProviderRefusalMessage(assistant("error", { type: "refusal" } as never))).toBe(true);
	});

	it("true for error+sensitive", () => {
		expect(isProviderRefusalMessage(assistant("error", { type: "sensitive" } as never))).toBe(true);
	});

	it("false for error without stopDetails type", () => {
		expect(isProviderRefusalMessage(assistant("error"))).toBe(false);
	});

	it("false for error+other type", () => {
		expect(isProviderRefusalMessage(assistant("error", { type: "rate_limit" } as never))).toBe(false);
	});

	for (const reason of ["stop", "length", "aborted", "toolUse"] as const) {
		it(`false for stopReason=${reason} even with refusal type`, () => {
			expect(isProviderRefusalMessage(assistant(reason as never, { type: "refusal" } as never))).toBe(false);
		});
	}
});

describe("filterProviderReplayMessages pure matrix", () => {
	it("drops refusal and sensitive assistants, keeps users and normal assistants", () => {
		const user = { role: "user", content: "hi", timestamp: 1 } as Message;
		const ok = assistant("stop");
		const refusal = assistant("error", { type: "refusal" } as never);
		const sensitive = assistant("error", { type: "sensitive" } as never);
		const errOther = assistant("error", { type: "timeout" } as never);
		const out = filterProviderReplayMessages([user, ok, refusal, sensitive, errOther]);
		expect(out).toEqual([user, ok, errOther]);
	});

	it("empty input → empty", () => {
		expect(filterProviderReplayMessages([])).toEqual([]);
	});

	it("identity when no refusals", () => {
		const msgs = [{ role: "user", content: "a", timestamp: 1 } as Message, assistant("stop"), assistant("length")];
		expect(filterProviderReplayMessages(msgs)).toEqual(msgs);
	});
});
