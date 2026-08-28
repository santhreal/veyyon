/**
 * WHY:
 * Model tool executions can emit malformed payloads, partial JSON, raw block strings,
 * or hashline autocorrect warnings. Tool parsing logic must reliably extract text and
 * warning signals without crashing or swallowing diagnostics.
 *
 * This suite verifies:
 * 1. extractToolText handles strings, content blocks, nulls, and malformed inputs.
 * 2. extractHashlineWarnings parses warning headers and identifies autocorrect warnings.
 * 3. extractAssistantToolRawBlocks extracts valid toolCall objects and ignores malformed nodes.
 * 4. Error classes PromptTimeoutError and PromptTurnLimitError retain their telemetry payloads.
 *
 * What this does not catch:
 * Visual terminal rendering anomalies of error text.
 */

import { describe, expect, it } from "bun:test";
import {
	extractAssistantToolRawBlocks,
	extractHashlineWarnings,
	extractToolErrorMessage,
	extractToolText,
	getEditPathFromArgs,
	hasHashlineAutocorrectWarning,
	isEditTool,
	isMutationTool,
	PromptTimeoutError,
	PromptTurnLimitError,
} from "../../../../suites/typescript-edit/runner/telemetry";

describe("telemetry and tool payload extraction", () => {
	it("extracts text from diverse tool result shapes and malformed values", () => {
		expect(extractToolText("raw plain text")).toBe("raw plain text");
		expect(extractToolText({ content: [{ type: "text", text: "block text" }] })).toBe("block text");
		expect(extractToolText(null)).toBeNull();
		expect(extractToolText(undefined)).toBeNull();
		expect(extractToolText(42)).toBeNull();
		expect(extractToolText({ content: "not-an-array" })).toBeNull();
		expect(extractToolText({ content: [{ noText: true }] })).toBeNull();
		expect(extractToolText({})).toBeNull();
	});

	it("extracts hashline warnings and detects autocorrect notices", () => {
		const warningOutput =
			"Patched successfully.\nWarnings:\nAuto-corrected line 10 tag\nUnanchored insert at line 12";
		const warnings = extractHashlineWarnings(warningOutput);
		expect(warnings).toEqual(["Auto-corrected line 10 tag", "Unanchored insert at line 12"]);
		expect(hasHashlineAutocorrectWarning(warnings)).toBe(true);

		const cleanOutput = "Patched successfully.";
		expect(extractHashlineWarnings(cleanOutput)).toEqual([]);
		expect(hasHashlineAutocorrectWarning([])).toBe(false);
	});

	it("extracts tool error messages with fallback formatting", () => {
		expect(extractToolErrorMessage("Simple error")).toBe("Simple error");
		expect(extractToolErrorMessage({ content: [{ text: "Inner error" }] })).toBe("Inner error");
		expect(extractToolErrorMessage({ code: 500 })).toBe('{"code":500}');
	});

	it("extracts assistant tool raw blocks and ignores non-toolCall or invalid records", () => {
		const validEvent = {
			type: "message_end",
			message: {
				role: "assistant",
				content: [
					{ type: "text", text: "I will edit." },
					{ type: "toolCall", id: "call_123", rawBlock: "edit(input: ...)" },
					{ type: "toolCall", id: 456, rawBlock: "invalid id type" },
					{ type: "other", id: "call_789" },
				],
			},
		};
		const blocks = extractAssistantToolRawBlocks(validEvent);
		expect(blocks).toEqual([{ id: "call_123", rawBlock: "edit(input: ...)" }]);

		// User message should yield nothing
		expect(
			extractAssistantToolRawBlocks({
				type: "message_end",
				message: { role: "user", content: [{ type: "toolCall", id: "call_1", rawBlock: "block" }] },
			}),
		).toEqual([]);

		// Malformed message object
		expect(extractAssistantToolRawBlocks({ type: "message_end", message: null })).toEqual([]);
	});

	it("extracts edit target path and evaluates tool predicates", () => {
		expect(getEditPathFromArgs({ path: "src/main.ts" })).toBe("src/main.ts");
		expect(getEditPathFromArgs({ path: "" })).toBeNull();
		expect(getEditPathFromArgs(null)).toBeNull();
		expect(getEditPathFromArgs({})).toBeNull();

		expect(isEditTool("edit")).toBe(true);
		expect(isEditTool("vim")).toBe(true);
		expect(isEditTool("apply_patch")).toBe(true);
		expect(isEditTool("read")).toBe(false);
		expect(isEditTool("write")).toBe(false);

		expect(isMutationTool("edit")).toBe(true);
		expect(isMutationTool("write")).toBe(true);
		expect(isMutationTool("read")).toBe(false);
	});

	it("constructs PromptTimeoutError and PromptTurnLimitError with telemetry data", () => {
		const timeoutErr = new PromptTimeoutError({
			elapsedMs: 5000,
			eventCount: 3,
			toolExecutionStarts: 1,
			toolExecutionEnds: 0,
			messageEnds: 0,
			recentEventTypes: ["turn_start", "tool_execution_start"],
			pendingRetry: false,
		});
		expect(timeoutErr.name).toBe("PromptTimeoutError");
		expect(timeoutErr.telemetry.elapsedMs).toBe(5000);
		expect(timeoutErr.message).toContain("Timeout waiting for agent_end");

		const turnLimitErr = new PromptTurnLimitError({
			elapsedMs: 12000,
			observedTurns: 31,
			maxTurns: 30,
			pendingRetry: false,
			recentEventTypes: ["turn_start"],
		});
		expect(turnLimitErr.name).toBe("PromptTurnLimitError");
		expect(turnLimitErr.telemetry.observedTurns).toBe(31);
		expect(turnLimitErr.message).toContain("limit 30");
	});
});
