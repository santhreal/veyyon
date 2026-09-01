import { describe, expect, it } from "bun:test";
import {
	getCopilotInitiatorOverride,
	getCopilotPremiumMultiplier,
	hasCopilotVisionInput,
	inferCopilotInitiator,
} from "../src/providers/github-copilot-headers";
import type { Message } from "../src/types";

describe("inferCopilotInitiator", () => {
	it("returns 'user' for empty messages", () => {
		expect(inferCopilotInitiator([])).toBe("user");
	});
	it("returns 'agent' when last message role is 'assistant'", () => {
		expect(inferCopilotInitiator([{ role: "assistant" }])).toBe("agent");
	});
	it("returns 'user' when last message role is 'user'", () => {
		expect(inferCopilotInitiator([{ role: "user" }])).toBe("user");
	});
	it("returns 'agent' when last message role is 'user' but content has tool_result", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [{ type: "tool_result" }] }])).toBe("agent");
	});
	it("returns 'user' when last message has no role", () => {
		expect(inferCopilotInitiator([{}])).toBe("user");
	});
	it("returns attribution value when present as 'user'", () => {
		expect(inferCopilotInitiator([{ attribution: "user" }])).toBe("user");
	});
	it("returns attribution value when present as 'agent'", () => {
		expect(inferCopilotInitiator([{ attribution: "agent" }])).toBe("agent");
	});
	it("attribution is case-insensitive", () => {
		expect(inferCopilotInitiator([{ attribution: "AGENT" }])).toBe("agent");
	});
	it("ignores invalid attribution", () => {
		expect(inferCopilotInitiator([{ attribution: "invalid", role: "assistant" }])).toBe("agent");
	});
	it("returns 'agent' for tool_result as last block in user message", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [{ type: "text" }, { type: "tool_result" }] }])).toBe(
			"agent",
		);
	});
	it("returns 'user' when last block is text in user message", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [{ type: "text" }] }])).toBe("user");
	});
});

describe("hasCopilotVisionInput", () => {
	it("returns false for empty messages", () => {
		expect(hasCopilotVisionInput([])).toBe(false);
	});
	it("returns true for user message with image content", () => {
		const messages: Message[] = [
			{ role: "user", content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "" } }] },
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});
	it("returns false for user message with only text", () => {
		const messages: Message[] = [{ role: "user", content: [{ type: "text", text: "hello" }] }];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});
	it("returns true for toolResult message with image content", () => {
		const messages: Message[] = [
			{
				role: "toolResult",
				toolCallId: "1",
				content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "" } }],
			},
		];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});
	it("returns false for assistant message with image (not checked)", () => {
		const messages: Message[] = [
			{
				role: "assistant",
				content: [{ type: "image", source: { kind: "base64", mediaType: "image/png", data: "" } }],
			} as Message,
		];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});
});

describe("getCopilotInitiatorOverride", () => {
	it("returns undefined for undefined headers", () => {
		expect(getCopilotInitiatorOverride(undefined)).toBeUndefined();
	});
	it("returns undefined when no x-initiator header", () => {
		expect(getCopilotInitiatorOverride({ "content-type": "application/json" })).toBeUndefined();
	});
	it("returns 'user' for x-initiator: user", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "user" })).toBe("user");
	});
	it("returns 'agent' for x-initiator: agent", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "agent" })).toBe("agent");
	});
	it("is case-insensitive for header name", () => {
		expect(getCopilotInitiatorOverride({ "X-Initiator": "agent" })).toBe("agent");
	});
	it("is case-insensitive for value", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "AGENT" })).toBe("agent");
	});
	it("returns undefined for invalid value", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "invalid" })).toBeUndefined();
	});
	it("trims whitespace in value", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "  agent  " })).toBe("agent");
	});
});

describe("getCopilotPremiumMultiplier", () => {
	it("returns 1 for undefined multiplier", () => {
		expect(getCopilotPremiumMultiplier(undefined)).toBe(1);
	});
	it("returns the multiplier when provided", () => {
		expect(getCopilotPremiumMultiplier(5)).toBe(5);
	});
	it("returns 0 when multiplier is 0 and planTier is paid", () => {
		expect(getCopilotPremiumMultiplier(0, "paid")).toBe(0);
	});
	it("returns 1 when multiplier is 0 and planTier is free", () => {
		expect(getCopilotPremiumMultiplier(0, "free")).toBe(1);
	});
	it("returns 1 when multiplier is 0 and no planTier", () => {
		expect(getCopilotPremiumMultiplier(0)).toBe(1);
	});
	it("returns multiplier for free plan with non-zero multiplier", () => {
		expect(getCopilotPremiumMultiplier(3, "free")).toBe(3);
	});
	it("returns multiplier for paid plan", () => {
		expect(getCopilotPremiumMultiplier(10, "paid")).toBe(10);
	});
	it("treats unknown planTier as free", () => {
		expect(getCopilotPremiumMultiplier(0, "unknown")).toBe(1);
	});
});
