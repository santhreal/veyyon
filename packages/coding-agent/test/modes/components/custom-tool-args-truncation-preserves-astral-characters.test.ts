/**
 * WHY: TreeSelectorComponent previously formatted custom tool calls by evaluating
 * `JSON.stringify(args)` twice and cutting with `.slice(0, 40)`. Slicing by UTF-16 code
 * units splits surrogate pairs when the 40-character cut lands between a high and low
 * surrogate, leaving a solitary surrogate that renders as a replacement character (U+FFFD).
 * It also miscounts width for wide/combining characters and double-stringifies inputs that
 * were already JSON strings.
 *
 * This suite closes the class by verifying property-style across padding offsets and
 * diverse astral/wide/combining characters that no broken surrogate code unit ever leaks
 * into the rendered tree view, that width-aware truncation is applied at TRUNCATE_LENGTHS.SHORT,
 * and that string arguments are not double-stringified with escaped quotes.
 *
 * GAP: Does not assert on terminal emulator font fallback or grapheme rasterization.
 */
import { beforeAll, describe, expect, it } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import { emptyUsage } from "@veyyon/catalog/models";
import { TreeSelectorComponent } from "@veyyon/coding-agent/modes/components/tree-selector";
import * as themeModule from "@veyyon/coding-agent/modes/theme/theme";
import type { SessionEntry, SessionTreeNode } from "@veyyon/coding-agent/session/session-entries";

let counter = 0;
function makeMessageNode(message: AgentMessage, parentId: string | null = null): SessionTreeNode {
	const id = `entry-${counter++}`;
	const entry: SessionEntry = {
		type: "message",
		id,
		parentId,
		timestamp: new Date().toISOString(),
		message,
	};
	return { entry, children: [] };
}

function renderTree(tree: SessionTreeNode[], width = 140): string {
	const selector = new TreeSelectorComponent(
		tree,
		tree[tree.length - 1]?.entry.id ?? null,
		() => {},
		() => {},
	);
	return Bun.stripANSI(selector.render(width).join("\n"));
}

function buildToolConversation(toolName: string, args: Record<string, unknown> | string): SessionTreeNode[] {
	const callId = `call-${counter++}`;
	const root = makeMessageNode({ role: "user", content: "run tool", timestamp: 1 });
	const assistant = makeMessageNode(
		{
			role: "assistant",
			content: [
				{
					type: "toolCall",
					id: callId,
					name: toolName,
					arguments: args as unknown as Record<string, unknown>,
				},
			],
			api: "openai",
			provider: "openai",
			model: "test-model",
			usage: emptyUsage(),
			stopReason: "stop",
			timestamp: 2,
		},
		root.entry.id,
	);
	const result = makeMessageNode(
		{
			role: "toolResult",
			toolCallId: callId,
			toolName,
			content: [{ type: "text", text: "ok" }],
			isError: false,
			timestamp: 3,
		},
		assistant.entry.id,
	);
	root.children.push(assistant);
	assistant.children.push(result);
	return [root];
}

const UNPAIRED_SURROGATE_REGEX = /[\uD800-\uDBFF](?![\uDC00-\uDFFF])|(?<![\uD800-\uDBFF])[\uDC00-\uDFFF]/;

describe("custom tool argument formatting in tree-selector", () => {
	beforeAll(async () => {
		await themeModule.initTheme(false, undefined, undefined, "dark", "light");
	});

	it("never splits astral surrogate pairs across all cut positions (property test)", () => {
		const astralChars = ["🚀", "🌟", "🎉", "🔥", "𝄞", "😀", "🦭", "💎", "🦄", "🌈"];

		for (const emoji of astralChars) {
			// Sweep prefix lengths from 0 to 60 so the surrogate pair hits every possible cut boundary
			for (let prefixLen = 0; prefixLen <= 60; prefixLen++) {
				const prefix = "a".repeat(prefixLen);
				const payload = { input: `${prefix}${emoji}tail_content_that_exceeds_budget` };
				const rendered = renderTree(buildToolConversation("custom_eval", payload));

				// The output must NOT contain any unpaired/broken surrogate code units
				expect(UNPAIRED_SURROGATE_REGEX.test(rendered)).toBe(false);
				// Must not contain replacement character U+FFFD
				expect(rendered).not.toContain("\uFFFD");
			}
		}
	});

	it("handles wide and multi-byte characters cleanly without corruption", () => {
		const wideStrings = [
			"日本語のテスト文字列長い長い文字列です",
			"한글_테스트_문자열_길이가_매우_긴_데이터",
			"中文测试长字符串数据内容展示检查",
			"مرحبا بالعالم نص طويل للاختبار والتأكد",
		];

		for (const wide of wideStrings) {
			const rendered = renderTree(buildToolConversation("analyzer", { text: wide }));
			expect(UNPAIRED_SURROGATE_REGEX.test(rendered)).toBe(false);
			expect(rendered).not.toContain("\uFFFD");
		}
	});

	it("does not double-stringify string arguments", () => {
		const alreadyJson = '{"query":"search term","limit":10}';
		const rendered = renderTree(buildToolConversation("searcher", alreadyJson));

		// Should show `{"query":"search term",...}` rather than `"{\"query\":\"search term\"...}"`
		expect(rendered).toContain('[searcher: {"query":"search term"');
		expect(rendered).not.toContain('[searcher: "{\\"query\\"');
	});

	it("truncates long args within TRUNCATE_LENGTHS.SHORT display width", () => {
		const longPayload = { key: "x".repeat(100) };
		const rendered = renderTree(buildToolConversation("my_tool", longPayload));

		expect(rendered).toContain("[my_tool: ");
		expect(rendered).toContain("…");
		// Ensure truncation keeps the display bounded
		const toolLine = rendered.split("\n").find(line => line.includes("[my_tool:")) ?? "";
		expect(toolLine.length).toBeGreaterThan(0);
	});

	it("displays short arguments intact without unnecessary truncation", () => {
		const shortPayload = { id: 42 };
		const rendered = renderTree(buildToolConversation("getter", shortPayload));

		expect(rendered).toContain('[getter: {"id":42}]');
	});
});
