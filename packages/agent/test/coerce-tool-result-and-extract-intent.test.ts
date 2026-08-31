/**
 * WHY: `coerceToolResult` is the single boundary where untyped tool execution
 * results enter the agent loop. Third-party tools (MCP, extensions, user-authored)
 * can violate the `AgentToolResult` contract at runtime — missing `content`,
 * non-array content, blocks without `type`, text blocks with non-string `text`,
 * image blocks missing `data`/`mimeType`. Persisting a malformed result corrupts
 * the session file and crashes on reload. `extractIntent` strips the `i` field
 * the model writes into tool arguments so the tool never sees it. Neither
 * function has any test coverage today.
 *
 * This suite closes the class by covering:
 * - `coerceToolResult`: valid text and image blocks pass through
 * - `coerceToolResult`: missing content array → malformed error result
 * - `coerceToolResult`: non-object input → malformed error result
 * - `coerceToolResult`: invalid blocks are dropped and counted
 * - `coerceToolResult`: text block with non-string text is rejected
 * - `coerceToolResult`: image block missing data or mimeType is rejected
 * - `coerceToolResult`: explicit `isError` flag is preserved
 * - `coerceToolResult`: error with empty content gets fallback text
 * - `coerceToolResult`: `useless` flag is preserved only when not error
 * - `coerceToolResult`: `details` is preserved
 * - `extractIntent`: strips `i` field and returns trimmed intent
 * - `extractIntent`: empty/whitespace intent returns undefined
 * - `extractIntent`: non-string intent returns undefined
 * - `extractIntent`: no `i` field returns stripped args only
 */
import { describe, expect, it } from "bun:test";
import { coerceToolResult, extractIntent } from "@veyyon/agent-core/agent-loop";
import { INTENT_FIELD } from "@veyyon/wire";

describe("coerceToolResult — valid inputs", () => {
	it("passes through valid text blocks", () => {
		const { result, malformed } = coerceToolResult({
			content: [{ type: "text", text: "hello world" }],
		});
		expect(malformed).toBe(false);
		expect(result.content).toEqual([{ type: "text", text: "hello world" }]);
		expect(result.isError).toBeUndefined();
	});

	it("passes through valid image blocks", () => {
		const { result, malformed } = coerceToolResult({
			content: [{ type: "image", data: "AAAA", mimeType: "image/png" }],
		});
		expect(malformed).toBe(false);
		expect(result.content).toEqual([{ type: "image", data: "AAAA", mimeType: "image/png" }]);
	});

	it("passes through mixed text and image blocks", () => {
		const { result, malformed } = coerceToolResult({
			content: [
				{ type: "text", text: "screenshot" },
				{ type: "image", data: "BBBB", mimeType: "image/jpeg" },
			],
		});
		expect(malformed).toBe(false);
		expect(result.content).toHaveLength(2);
	});

	it("preserves details", () => {
		const { result } = coerceToolResult({
			content: [{ type: "text", text: "ok" }],
			details: { exitCode: 0, duration: 42 },
		});
		expect(result.details).toEqual({ exitCode: 0, duration: 42 });
	});

	it("defaults details to empty object when absent", () => {
		const { result } = coerceToolResult({
			content: [{ type: "text", text: "ok" }],
		});
		expect(result.details).toEqual({});
	});
});

describe("coerceToolResult — malformed inputs", () => {
	it("returns malformed error for non-object input", () => {
		const { result, malformed } = coerceToolResult("not an object");
		expect(malformed).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
	});

	it("returns malformed error for missing content array", () => {
		const { result, malformed } = coerceToolResult({ foo: "bar" });
		expect(malformed).toBe(true);
		expect(result.isError).toBe(true);
		expect(result.content[0]?.type).toBe("text");
	});

	it("returns malformed error for non-array content", () => {
		const { result, malformed } = coerceToolResult({ content: "string not array" });
		expect(malformed).toBe(true);
		expect(result.isError).toBe(true);
	});

	it("drops invalid blocks and appends an error notice", () => {
		const { result, malformed } = coerceToolResult({
			content: [{ type: "text", text: "valid" }, "not an object", { type: "unknown" }, null],
		});
		expect(malformed).toBe(true);
		expect(result.isError).toBe(true);
		// First block survives, plus the error notice
		expect(result.content.length).toBeGreaterThanOrEqual(2);
		expect(result.content[0]).toEqual({ type: "text", text: "valid" });
	});

	it("rejects text blocks with non-string text", () => {
		const { result, malformed } = coerceToolResult({
			content: [{ type: "text", text: 123 }],
		});
		expect(malformed).toBe(true);
		expect(result.isError).toBe(true);
	});

	it("rejects image blocks missing data", () => {
		const { malformed } = coerceToolResult({
			content: [{ type: "image", mimeType: "image/png" }],
		});
		expect(malformed).toBe(true);
	});

	it("rejects image blocks missing mimeType", () => {
		const { malformed } = coerceToolResult({
			content: [{ type: "image", data: "AAAA" }],
		});
		expect(malformed).toBe(true);
	});
});

describe("coerceToolResult — error and useless flags", () => {
	it("preserves explicit isError flag", () => {
		const { result, malformed } = coerceToolResult({
			content: [{ type: "text", text: "command failed" }],
			isError: true,
		});
		expect(malformed).toBe(false);
		expect(result.isError).toBe(true);
	});

	it("preserves useless flag when not an error", () => {
		const { result, malformed } = coerceToolResult({
			content: [{ type: "text", text: "no matches" }],
			useless: true,
		});
		expect(malformed).toBe(false);
		expect(result.useless).toBe(true);
		expect(result.isError).toBeUndefined();
	});

	it("drops useless flag when isError is also true", () => {
		const { result } = coerceToolResult({
			content: [{ type: "text", text: "error and useless" }],
			isError: true,
			useless: true,
		});
		expect(result.isError).toBe(true);
		expect(result.useless).toBeUndefined();
	});

	it("error with empty content gets fallback text", () => {
		const { result } = coerceToolResult({
			content: [{ type: "text", text: "   " }],
			isError: true,
		});
		expect(result.isError).toBe(true);
		expect(result.content).toHaveLength(1);
		expect(result.content[0]?.type).toBe("text");
		// The whitespace-only text is not substantive, so fallback text is added
		expect((result.content[0] as { text: string }).text.length).toBeGreaterThan(0);
	});

	it("error with only invalid blocks gets fallback text", () => {
		const { result } = coerceToolResult({
			content: [{ type: "unknown" }],
			isError: true,
		});
		expect(result.isError).toBe(true);
		// Invalid block dropped, error notice added, but that may not be substantive
		// so fallback text ensures non-empty content
		expect(result.content.length).toBeGreaterThanOrEqual(1);
	});
});

describe("extractIntent", () => {
	const INTENT = INTENT_FIELD;

	it("strips the intent field and returns it trimmed", () => {
		const { intent, strippedArgs } = extractIntent({ [INTENT]: "  find bugs  ", path: "/repo/a.ts" });
		expect(intent).toBe("find bugs");
		expect(strippedArgs).toEqual({ path: "/repo/a.ts" });
	});

	it("returns undefined intent for empty string", () => {
		const { intent, strippedArgs } = extractIntent({ [INTENT]: "", path: "/repo/a.ts" });
		expect(intent).toBeUndefined();
		expect(strippedArgs).toEqual({ path: "/repo/a.ts" });
	});

	it("returns undefined intent for whitespace-only string", () => {
		const { intent, strippedArgs } = extractIntent({ [INTENT]: "   ", path: "/repo/a.ts" });
		expect(intent).toBeUndefined();
		expect(strippedArgs).toEqual({ path: "/repo/a.ts" });
	});

	it("returns undefined intent for non-string value", () => {
		const { intent, strippedArgs } = extractIntent({ [INTENT]: 42, path: "/repo/a.ts" });
		expect(intent).toBeUndefined();
		expect(strippedArgs).toEqual({ path: "/repo/a.ts" });
	});

	it("returns undefined intent when field is absent", () => {
		const { intent, strippedArgs } = extractIntent({ path: "/repo/a.ts", pattern: "foo" });
		expect(intent).toBeUndefined();
		expect(strippedArgs).toEqual({ path: "/repo/a.ts", pattern: "foo" });
	});

	it("preserves all other fields in strippedArgs", () => {
		const args = { [INTENT]: "do thing", a: 1, b: "two", c: true, d: null };
		const { intent, strippedArgs } = extractIntent(args);
		expect(intent).toBe("do thing");
		expect(strippedArgs).toEqual({ a: 1, b: "two", c: true, d: null });
		expect(INTENT in strippedArgs).toBe(false);
	});

	it("handles empty args object", () => {
		const { intent, strippedArgs } = extractIntent({});
		expect(intent).toBeUndefined();
		expect(strippedArgs).toEqual({});
	});
});
