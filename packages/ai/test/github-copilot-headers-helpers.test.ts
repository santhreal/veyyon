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

	it("returns 'agent' when last message attribution is 'agent'", () => {
		expect(inferCopilotInitiator([{ role: "user", attribution: "agent", content: "hi" }])).toBe("agent");
	});

	it("returns 'user' when last message attribution is 'user'", () => {
		expect(inferCopilotInitiator([{ role: "assistant", attribution: "user", content: [] }])).toBe("user");
	});

	it("returns 'agent' when last message role is not 'user'", () => {
		expect(inferCopilotInitiator([{ role: "assistant", content: [] }])).toBe("agent");
	});

	it("returns 'user' when last message role is 'user' with text content", () => {
		expect(inferCopilotInitiator([{ role: "user", content: "hello" }])).toBe("user");
	});

	it("returns 'agent' when last user message has tool_result content block", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [{ type: "tool_result" }] }])).toBe("agent");
	});

	it("returns 'user' when last user message has text content block", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [{ type: "text", text: "hi" }] }])).toBe("user");
	});

	it("returns 'user' when last message has no role", () => {
		expect(inferCopilotInitiator([{ content: "hi" }])).toBe("user");
	});

	it("normalizes attribution to lowercase", () => {
		expect(inferCopilotInitiator([{ role: "user", attribution: "AGENT", content: "hi" }])).toBe("agent");
		expect(inferCopilotInitiator([{ role: "user", attribution: "User", content: "hi" }])).toBe("user");
	});

	it("ignores non-user/agent attribution strings", () => {
		expect(inferCopilotInitiator([{ role: "user", attribution: "system", content: "hi" }])).toBe("user");
	});

	it("returns 'user' for empty content array on user message", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [] }])).toBe("user");
	});

	it("trims attribution before checking", () => {
		expect(inferCopilotInitiator([{ role: "user", attribution: "  agent  ", content: "hi" }])).toBe("agent");
	});
});

describe("hasCopilotVisionInput", () => {
	it("returns false for empty messages", () => {
		expect(hasCopilotVisionInput([])).toBe(false);
	});

	it("returns true for user message with image content", () => {
		const messages = [
			{ role: "user", content: [{ type: "image", source: { data: "abc" } }] },
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns true for toolResult message with image content", () => {
		const messages = [
			{
				role: "toolResult",
				toolCallId: "c1",
				toolName: "read",
				content: [{ type: "image", source: { data: "abc" } }],
				isError: false,
				timestamp: 0,
			},
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});

	it("returns false for user message with only text content", () => {
		const messages = [{ role: "user", content: "hello" }] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});

	it("returns false for assistant messages", () => {
		const messages = [{ role: "assistant", content: [{ type: "text", text: "hi" }] }] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});

	it("returns false for user message with text blocks only", () => {
		const messages = [{ role: "user", content: [{ type: "text", text: "hi" }] }] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});

	it("returns true when any message has image", () => {
		const messages = [
			{ role: "user", content: "hello" },
			{ role: "user", content: [{ type: "image", source: { data: "abc" } }] },
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});
});

describe("getCopilotInitiatorOverride", () => {
	it("returns undefined for undefined headers", () => {
		expect(getCopilotInitiatorOverride(undefined)).toBeUndefined();
	});

	it("returns undefined for empty headers", () => {
		expect(getCopilotInitiatorOverride({})).toBeUndefined();
	});

	it("returns 'user' for x-initiator: user", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "user" })).toBe("user");
	});

	it("returns 'agent' for x-initiator: agent", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "agent" })).toBe("agent");
	});

	it("is case-insensitive for header key", () => {
		expect(getCopilotInitiatorOverride({ "X-Initiator": "agent" })).toBe("agent");
	});

	it("normalizes value to lowercase", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "AGENT" })).toBe("agent");
		expect(getCopilotInitiatorOverride({ "x-initiator": "User" })).toBe("user");
	});

	it("trims value before checking", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "  agent  " })).toBe("agent");
	});

	it("returns undefined for non-user/agent value", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "system" })).toBeUndefined();
	});

	it("returns last matching x-initiator when multiple present", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "user", "X-Initiator": "agent" })).toBe("agent");
	});

	it("ignores other headers", () => {
		expect(getCopilotInitiatorOverride({ "content-type": "application/json" })).toBeUndefined();
	});
});

describe("getCopilotPremiumMultiplier", () => {
	it("returns 1 for undefined multiplier", () => {
		expect(getCopilotPremiumMultiplier(undefined)).toBe(1);
	});

	it("returns the multiplier when provided", () => {
		expect(getCopilotPremiumMultiplier(5)).toBe(5);
	});

	it("returns 0 for paid tier with 0 multiplier", () => {
		expect(getCopilotPremiumMultiplier(0, "paid")).toBe(0);
	});

	it("returns 1 for free tier with 0 multiplier (overridden)", () => {
		expect(getCopilotPremiumMultiplier(0, "free")).toBe(1);
	});

	it("returns 1 for free tier with 0 multiplier and undefined planTier", () => {
		// undefined planTier normalizes to "free"
		expect(getCopilotPremiumMultiplier(0)).toBe(1);
	});

	it("returns multiplier for free tier with non-zero multiplier", () => {
		expect(getCopilotPremiumMultiplier(3, "free")).toBe(3);
	});

	it("returns multiplier for paid tier with non-zero multiplier", () => {
		expect(getCopilotPremiumMultiplier(3, "paid")).toBe(3);
	});

	it("returns 0 for paid tier with 0 multiplier explicitly", () => {
		expect(getCopilotPremiumMultiplier(0, "paid")).toBe(0);
	});

	it("normalizes unknown planTier to free", () => {
		expect(getCopilotPremiumMultiplier(0, "unknown")).toBe(1);
	});
});
