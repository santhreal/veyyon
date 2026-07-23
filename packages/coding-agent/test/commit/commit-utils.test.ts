import { describe, expect, it } from "bun:test";
import type { AssistantMessage } from "@veyyon/ai";
import {
	extractTextContent,
	extractToolCall,
	normalizeAnalysis,
	normalizeDetails,
	parseJsonPayload,
} from "@veyyon/coding-agent/commit/utils/analysis";

/**
 * Helpers that turn a model response into a ConventionalAnalysis. They had no
 * direct tests despite carrying real shaping rules: text is trimmed, a
 * changelog category is kept only when the change is user_visible, and scope
 * collapses to null when blank. normalizeAnalysis used to inline a byte copy of
 * normalizeDetails' mapping; it now delegates, and the dedup lock below fails if
 * the two shapings ever diverge again.
 */

// These functions read only `message.content`; the rest of AssistantMessage is
// irrelevant to them, so a content-only fixture is the honest minimum.
function assistantMessage(content: AssistantMessage["content"]): AssistantMessage {
	return { content } as unknown as AssistantMessage;
}

describe("parseJsonPayload", () => {
	it("parses a string that is exactly a JSON object", () => {
		expect(parseJsonPayload('{"type":"feat"}')).toEqual({ type: "feat" });
	});

	it("tolerates surrounding whitespace", () => {
		expect(parseJsonPayload('  \n{"a":1}\n  ')).toEqual({ a: 1 });
	});

	it("extracts the JSON object embedded in surrounding prose", () => {
		expect(parseJsonPayload('Here is the result: {"scope":"api"} — done')).toEqual({ scope: "api" });
	});

	it("captures the outermost object when braces nest", () => {
		expect(parseJsonPayload('prefix {"a":{"b":2}} suffix')).toEqual({ a: { b: 2 } });
	});

	it("throws when there is no JSON object at all", () => {
		expect(() => parseJsonPayload("no json here")).toThrow("No JSON payload found");
	});
});

describe("normalizeDetails", () => {
	it("trims text and defaults userVisible to false with no category", () => {
		expect(normalizeDetails([{ text: "  fix a bug  " }])).toEqual([
			{ text: "fix a bug", changelogCategory: undefined, userVisible: false },
		]);
	});

	it("keeps the changelog category only when the change is user_visible", () => {
		expect(normalizeDetails([{ text: "x", changelog_category: "Added", user_visible: true }])).toEqual([
			{ text: "x", changelogCategory: "Added", userVisible: true },
		]);
	});

	it("drops the changelog category when user_visible is false", () => {
		expect(normalizeDetails([{ text: "x", changelog_category: "Added", user_visible: false }])).toEqual([
			{ text: "x", changelogCategory: undefined, userVisible: false },
		]);
	});

	it("returns an empty array unchanged", () => {
		expect(normalizeDetails([])).toEqual([]);
	});
});

describe("normalizeAnalysis", () => {
	it("collapses a blank or whitespace-only scope to null", () => {
		expect(normalizeAnalysis({ type: "feat", scope: "   ", details: [], issue_refs: [] }).scope).toBeNull();
		expect(normalizeAnalysis({ type: "feat", scope: "", details: [], issue_refs: [] }).scope).toBeNull();
		expect(normalizeAnalysis({ type: "feat", scope: null, details: [], issue_refs: [] }).scope).toBeNull();
	});

	it("trims a real scope and passes the type through", () => {
		const result = normalizeAnalysis({ type: "fix", scope: "  api ", details: [], issue_refs: ["#12"] });
		expect(result.scope).toBe("api");
		expect(result.type).toBe("fix");
		expect(result.issueRefs).toEqual(["#12"]);
	});

	it("defaults missing issue_refs to an empty array", () => {
		const result = normalizeAnalysis({
			type: "chore",
			scope: null,
			details: [],
			issue_refs: undefined as unknown as string[],
		});
		expect(result.issueRefs).toEqual([]);
	});

	it("shapes details identically to normalizeDetails (single-owner dedup lock)", () => {
		const input = [
			{ text: " a ", changelog_category: "Fixed" as const, user_visible: true },
			{ text: "b", changelog_category: "Added" as const, user_visible: false },
		];
		const viaAnalysis = normalizeAnalysis({ type: "fix", scope: null, details: input, issue_refs: [] }).details;
		expect(viaAnalysis).toEqual(normalizeDetails(input));
	});
});

describe("extractToolCall / extractTextContent", () => {
	it("returns the tool call matching the requested name", () => {
		const message = assistantMessage([
			{ type: "text", text: "thinking" },
			{ type: "toolCall", id: "1", name: "other_tool", arguments: {} },
			{ type: "toolCall", id: "2", name: "create_conventional_analysis", arguments: { type: "feat" } },
		]);
		const call = extractToolCall(message, "create_conventional_analysis");
		expect(call?.id).toBe("2");
		expect(call?.arguments).toEqual({ type: "feat" });
	});

	it("returns undefined when no tool call has the requested name", () => {
		const message = assistantMessage([{ type: "toolCall", id: "1", name: "other", arguments: {} }]);
		expect(extractToolCall(message, "create_conventional_analysis")).toBeUndefined();
	});

	it("joins and trims only the text content, ignoring tool calls", () => {
		const message = assistantMessage([
			{ type: "text", text: "  hello " },
			{ type: "toolCall", id: "1", name: "x", arguments: {} },
			{ type: "text", text: "world  " },
		]);
		expect(extractTextContent(message)).toBe("hello world");
	});
});
