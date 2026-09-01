import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message } from "@veyyon/ai";
import { filterProviderReplayMessages, isProviderRefusalMessage } from "../src/replay-policy";

function makeAssistant(overrides: Partial<AssistantMessage>): AssistantMessage {
	return {
		role: "assistant",
		content: [],
		stopReason: "stop",
		...overrides,
	} as AssistantMessage;
}

describe("isProviderRefusalMessage", () => {
	it("returns false when stopReason is not error", () => {
		const msg = makeAssistant({ stopReason: "stop" });
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
	it("returns true when stopReason is error and type is refusal", () => {
		const msg = makeAssistant({ stopReason: "error", stopDetails: { type: "refusal" } });
		expect(isProviderRefusalMessage(msg)).toBe(true);
	});
	it("returns true when stopReason is error and type is sensitive", () => {
		const msg = makeAssistant({ stopReason: "error", stopDetails: { type: "sensitive" } });
		expect(isProviderRefusalMessage(msg)).toBe(true);
	});
	it("returns false when stopReason is error but type is other", () => {
		const msg = makeAssistant({ stopReason: "error", stopDetails: { type: "other_error" } });
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
	it("returns false when stopReason is error and stopDetails is undefined", () => {
		const msg = makeAssistant({ stopReason: "error", stopDetails: undefined });
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
	it("returns false when stopReason is error and stopDetails is null", () => {
		const msg = makeAssistant({ stopReason: "error", stopDetails: null } as unknown as AssistantMessage);
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
	it("returns false when stopReason is length", () => {
		const msg = makeAssistant({ stopReason: "length" });
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
	it("returns false when stopReason is tool_use", () => {
		const msg = makeAssistant({ stopReason: "toolUse" });
		expect(isProviderRefusalMessage(msg)).toBe(false);
	});
});

describe("filterProviderReplayMessages", () => {
	it("filters out refusal messages", () => {
		const messages: Message[] = [
			makeAssistant({ stopReason: "error", stopDetails: { type: "refusal" } }) as Message,
			makeAssistant({ stopReason: "stop" }) as Message,
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(1);
	expect((filtered[0] as AssistantMessage).stopReason).toBe("stop");
	});
	it("filters out sensitive messages", () => {
		const messages: Message[] = [
			makeAssistant({ stopReason: "error", stopDetails: { type: "sensitive" } }) as Message,
			makeAssistant({ stopReason: "stop" }) as Message,
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(1);
	});
	it("preserves non-assistant messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "" } as Message,
			makeAssistant({ stopReason: "error", stopDetails: { type: "refusal" } }) as Message,
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(1);
		expect(filtered[0].role).toBe("user");
	});
	it("preserves assistant messages with non-error stopReason", () => {
		const messages: Message[] = [
			makeAssistant({ stopReason: "stop" }) as Message,
			makeAssistant({ stopReason: "length" }) as Message,
		makeAssistant({ stopReason: "toolUse" }) as Message,
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(3);
	});
	it("preserves assistant error messages with non-refusal type", () => {
		const messages: Message[] = [makeAssistant({ stopReason: "error", stopDetails: { type: "other" } }) as Message];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(1);
	});
	it("returns empty array when all messages are refusals", () => {
		const messages: Message[] = [
			makeAssistant({ stopReason: "error", stopDetails: { type: "refusal" } }) as Message,
			makeAssistant({ stopReason: "error", stopDetails: { type: "sensitive" } }) as Message,
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toEqual([]);
	});
	it("returns empty array for empty input", () => {
		expect(filterProviderReplayMessages([])).toEqual([]);
	});
	it("preserves order of remaining messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "" } as Message,
			makeAssistant({ stopReason: "stop" }) as Message,
			makeAssistant({ stopReason: "error", stopDetails: { type: "refusal" } }) as Message,
			{ role: "user", content: "" } as Message,
			makeAssistant({ stopReason: "length" }) as Message,
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(4);
		expect(filtered[0].role).toBe("user");
		expect(filtered[1].role).toBe("assistant");
		expect(filtered[2].role).toBe("user");
		expect(filtered[3].role).toBe("assistant");
	});
	it("handles mix of user, assistant, and refusal messages", () => {
		const messages: Message[] = [
			{ role: "user", content: "" } as Message,
			makeAssistant({ stopReason: "error", stopDetails: { type: "refusal" } }) as Message,
			makeAssistant({ stopReason: "stop" }) as Message,
			{ role: "user", content: "" } as Message,
			makeAssistant({ stopReason: "error", stopDetails: { type: "sensitive" } }) as Message,
		makeAssistant({ stopReason: "toolUse" }) as Message,
		];
		const filtered = filterProviderReplayMessages(messages);
		expect(filtered).toHaveLength(4);
	});
});
