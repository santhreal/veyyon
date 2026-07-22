import { describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	convertToLlm,
	isCustomMessageContent,
	normalizeCustomMessagePayload,
} from "@veyyon/coding-agent/session/messages";
import { buildSessionContext } from "@veyyon/coding-agent/session/session-context";
import type { CustomMessageEntry, SessionEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";

describe("bare custom_message recovery", () => {
	it("drops poisoned custom messages before LLM conversion", () => {
		const messages: AgentMessage[] = JSON.parse(
			`[{"role":"custom","timestamp":1,"customType":"hook-warning","display":false}]`,
		);

		expect(convertToLlm(messages)).toEqual([]);
	});

	it("skips legacy bare custom_message entries while rebuilding context", () => {
		const entries: SessionEntry[] = JSON.parse(
			`[{"type":"custom_message","id":"1","parentId":null,"timestamp":"2026-07-02T00:00:00.000Z","attribution":"agent"}]`,
		);

		const context = buildSessionContext(entries);

		expect(context.messages).toEqual([]);
	});

	it("normalizes nullish custom message fields before persistence", () => {
		const session = SessionManager.inMemory();
		const malformed = JSON.parse("{}");

		const id = session.appendCustomMessageEntry(
			malformed.customType,
			malformed.content,
			malformed.display,
			undefined,
			malformed.attribution,
		);
		const entry = session.getBranch().find(entry => entry.id === id);

		expect(entry).toMatchObject({
			type: "custom_message",
			customType: "custom-message",
			content: "",
			display: false,
			attribution: "agent",
		} satisfies Partial<CustomMessageEntry>);
	});

	it("treats a bare string payload as visible custom message content", () => {
		expect(normalizeCustomMessagePayload("some warning")).toEqual({
			customType: "custom-message",
			content: "some warning",
			display: true,
			attribution: "agent",
		});
	});
});

/**
 * isCustomMessageContent is the guard normalizeCustomMessagePayload leans on to decide
 * whether a persisted or extension-supplied `content` value is usable as-is (string or a
 * content-part array) versus coerced to "". It had no direct test. The contract is exactly
 * "string or array" — an object, number, null, or undefined is not custom-message content,
 * and an empty array still counts (an empty content list is valid).
 */
describe("isCustomMessageContent", () => {
	it("accepts a string or any array, including an empty array", () => {
		expect(isCustomMessageContent("hi")).toBe(true);
		expect(isCustomMessageContent([{ type: "text", text: "x" }])).toBe(true);
		expect(isCustomMessageContent([])).toBe(true);
	});

	it("rejects objects, numbers, null, and undefined", () => {
		expect(isCustomMessageContent({})).toBe(false);
		expect(isCustomMessageContent(5)).toBe(false);
		expect(isCustomMessageContent(null)).toBe(false);
		expect(isCustomMessageContent(undefined)).toBe(false);
	});
});
