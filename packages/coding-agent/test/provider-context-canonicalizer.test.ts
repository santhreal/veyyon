import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@veyyon/ai";
import { ProviderContextCanonicalizer } from "@veyyon/coding-agent/session/provider-context-canonicalizer";

const LONG_ID = "call_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa|fc_bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb";

function assistantCall(path: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "toolCall", id: LONG_ID, name: "read", arguments: { path } }],
		api: "openai-responses",
		provider: "openai",
		model: "gpt-test",
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "toolUse",
		timestamp: 2,
	};
}

function toolResult(text: string): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId: LONG_ID,
		toolName: "read",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 3,
	};
}

function createCanonicalizer(): ProviderContextCanonicalizer {
	let counter = 0;
	return new ProviderContextCanonicalizer(new Map(), () => {
		counter += 1;
		return `tc_${counter}`;
	});
}

describe("incremental provider context canonicalization", () => {
	/** Regression: an appended turn must reuse already transformed message objects instead of cloning the full history again. */
	it("reuses the transformed prefix when messages append", () => {
		const root = "/workspace";
		const roots = [root];
		const source: Message[] = [
			{ role: "user", content: `read ${root}/src/a.ts`, timestamp: 1 },
			assistantCall(`${root}/src/a.ts`),
			toolResult(`error: ${root}/src/a.ts:1`),
		];
		const canonicalizer = createCanonicalizer();
		const first = canonicalizer.transform(source, roots);
		const second = canonicalizer.transform([...source, { role: "user", content: "continue", timestamp: 4 }], roots);

		expect(second.messages.slice(0, source.length)).toEqual(first.messages);
		for (let i = 0; i < source.length; i++) expect(second.messages[i]).toBe(first.messages[i]);
		expect((second.messages[1] as AssistantMessage).content[0]).toMatchObject({ id: "tc_1" });
		expect((second.messages[2] as ToolResultMessage).toolCallId).toBe("tc_1");
	});

	/** An identical outbound snapshot is common during retries and must return the exact cached array without any transform allocation. */
	it("returns the cached array for an identical snapshot", () => {
		const roots = ["/workspace"];
		const source: Message[] = [assistantCall("/workspace/src/a.ts"), toolResult("/workspace/src/a.ts")];
		const canonicalizer = createCanonicalizer();
		const first = canonicalizer.transform(source, roots);
		const second = canonicalizer.transform([...source], roots);

		expect(second.messages).toBe(first.messages);
		expect(second.bytesSaved).toBe(first.bytesSaved);
	});

	/** Adding a cwd root can change old path rendering, so a roots-version change must invalidate the reusable prefix. */
	it("invalidates cached path rendering when roots change", () => {
		const source: Message[] = [{ role: "user", content: "read /other/src/a.ts", timestamp: 1 }];
		const canonicalizer = createCanonicalizer();
		const first = canonicalizer.transform(source, ["/workspace"]);
		const second = canonicalizer.transform(source, ["/workspace", "/other"]);

		expect(first.messages).toBe(source);
		expect(second.messages).not.toBe(source);
		expect(second.messages[0]).toMatchObject({ content: "read src/a.ts" });
	});

	/** Path-savings telemetry is per outbound request, including reused prefix bytes, not merely newly transformed tail bytes. */
	it("reports cached prefix byte savings on every request", () => {
		const root = "/workspace";
		const roots = [root];
		const source: Message[] = [{ role: "user", content: `${root}/a.ts`, timestamp: 1 }];
		const canonicalizer = createCanonicalizer();
		const first = canonicalizer.transform(source, roots);
		const second = canonicalizer.transform([...source, { role: "user", content: "continue", timestamp: 2 }], roots);

		expect(first.bytesSaved).toBe(root.length + 1);
		expect(second.bytesSaved).toBe(first.bytesSaved);
	});
});
