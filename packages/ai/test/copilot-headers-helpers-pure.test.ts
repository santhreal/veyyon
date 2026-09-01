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
	it("returns 'agent' when last message has attribution 'agent'", () => {
		expect(inferCopilotInitiator([{ attribution: "agent" }])).toBe("agent");
	});
	it("returns 'user' when last message has attribution 'user'", () => {
		expect(inferCopilotInitiator([{ attribution: "user" }])).toBe("user");
	});
	it("returns 'agent' when last message role is not 'user'", () => {
		expect(inferCopilotInitiator([{ role: "assistant" }])).toBe("agent");
	});
	it("returns 'user' when last message role is 'user' with text content", () => {
		expect(inferCopilotInitiator([{ role: "user", content: "hello" }])).toBe("user");
	});
	it("returns 'agent' when last message role is 'user' with tool_result content", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [{ type: "tool_result" }] }])).toBe("agent");
	});
	it("returns 'user' when last message has no role", () => {
		expect(inferCopilotInitiator([{}])).toBe("user");
	});
	it("normalizes attribution to lowercase", () => {
		expect(inferCopilotInitiator([{ attribution: "Agent" }])).toBe("agent");
		expect(inferCopilotInitiator([{ attribution: "USER" }])).toBe("user");
	});
	it("ignores invalid attribution values", () => {
		expect(inferCopilotInitiator([{ attribution: "invalid", role: "assistant" }])).toBe("agent");
	});
	it("trims attribution before checking", () => {
		expect(inferCopilotInitiator([{ attribution: "  agent  " }])).toBe("agent");
	});
	it("returns 'user' for user role with empty content array", () => {
		expect(inferCopilotInitiator([{ role: "user", content: [] }])).toBe("user");
	});
	it("returns 'user' for user role with non-array content", () => {
		expect(inferCopilotInitiator([{ role: "user", content: "text" }])).toBe("user");
	});
});

describe("hasCopilotVisionInput", () => {
	it("returns false for empty messages", () => {
		expect(hasCopilotVisionInput([])).toBe(false);
	});
	it("returns true when user message has image", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "image", data: "abc", mimeType: "image/png" }],
			},
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});
	it("returns true when toolResult message has image", () => {
		const messages = [
			{
				role: "toolResult",
				content: [{ type: "image", data: "abc", mimeType: "image/png" }],
			},
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(true);
	});
	it("returns false when no images", () => {
		const messages = [
			{
				role: "user",
				content: [{ type: "text", text: "hello" }],
			},
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});
	it("returns false for assistant messages with images (not checked)", () => {
		const messages = [
			{
				role: "assistant",
				content: [{ type: "image", data: "abc", mimeType: "image/png" }],
			},
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(false);
	});
	it("returns true when any message has image", () => {
		const messages = [
			{ role: "user", content: [{ type: "text", text: "hello" }] },
			{ role: "user", content: [{ type: "image", data: "abc", mimeType: "image/png" }] },
		] as unknown as Message[];
		expect(hasCopilotVisionInput(messages)).toBe(true);
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
	it("normalizes to lowercase", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "Agent" })).toBe("agent");
		expect(getCopilotInitiatorOverride({ "x-initiator": "USER" })).toBe("user");
	});
	it("trims value before checking", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "  agent  " })).toBe("agent");
	});
	it("returns undefined for invalid value", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "invalid" })).toBeUndefined();
	});
	it("handles case-insensitive header name", () => {
		expect(getCopilotInitiatorOverride({ "X-Initiator": "agent" })).toBe("agent");
		expect(getCopilotInitiatorOverride({ "X-INITIATOR": "user" })).toBe("user");
	});
	it("returns last matching header when multiple present", () => {
		expect(getCopilotInitiatorOverride({ "x-initiator": "user", "X-Initiator": "agent" })).toBe("agent");
	});
});

describe("getCopilotPremiumMultiplier", () => {
	it("returns 1 when premiumMultiplier is undefined", () => {
		expect(getCopilotPremiumMultiplier(undefined)).toBe(1);
	});
	it("returns the multiplier when set", () => {
		expect(getCopilotPremiumMultiplier(2)).toBe(2);
	});
	it("returns 1 when free plan and multiplier is 0", () => {
		expect(getCopilotPremiumMultiplier(0, "free")).toBe(1);
	});
	it("returns 0 when paid plan and multiplier is 0", () => {
		expect(getCopilotPremiumMultiplier(0, "paid")).toBe(0);
	});
	it("returns 1 when no plan specified and multiplier is 0 (defaults to free)", () => {
		expect(getCopilotPremiumMultiplier(0)).toBe(1);
	});
	it("returns multiplier for free plan when non-zero", () => {
		expect(getCopilotPremiumMultiplier(3, "free")).toBe(3);
	});
	it("returns multiplier for paid plan", () => {
		expect(getCopilotPremiumMultiplier(5, "paid")).toBe(5);
	});
	it("treats unknown plan tier as free", () => {
		expect(getCopilotPremiumMultiplier(0, "unknown")).toBe(1);
	});
	it("treats undefined plan as free (returns 1 for 0 multiplier)", () => {
		expect(getCopilotPremiumMultiplier(0, undefined)).toBe(1);
	});
});
