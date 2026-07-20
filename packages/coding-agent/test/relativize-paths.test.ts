import { describe, expect, test } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage, Usage } from "@veyyon/ai";
import { normalizeRoots, relativizePathsUnderRoots } from "@veyyon/coding-agent/session/relativize-paths";

const ROOT = "/media/mukund-thiru/SanthData/Santh/software/veyyon/veyyon";
const OTHER = "/media/mukund-thiru/other-checkout";

function usage(): Usage {
	return {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		timestamp: 1,
		provider: "mock",
		model: "mock",
		api: "mock",
		usage: usage(),
		stopReason: "stop",
	};
}

function toolResult(text: string, toolCallId = "call-1"): ToolResultMessage {
	return {
		role: "toolResult",
		toolCallId,
		toolName: "bash",
		content: [{ type: "text", text }],
		isError: false,
		timestamp: 1,
	};
}

describe("normalizeRoots", () => {
	test("strips trailing slashes, drops non-absolute and root-only entries, sorts longest-first", () => {
		expect(normalizeRoots([`${ROOT}/`, "/tmp", "/", "relative", " /tmp "])).toEqual([ROOT, "/tmp"]);
	});
});

describe("relativizePathsUnderRoots", () => {
	test("returns the input array identity when nothing matches", () => {
		const messages: Message[] = [toolResult("no paths here")];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages).toBe(messages);
		expect(result.bytesSaved).toBe(0);
	});

	test("tool result text renders root-relative at token boundaries, preserving suffixes", () => {
		const messages: Message[] = [
			toolResult(`error: ${ROOT}/src/foo.ts:12:3 cannot find x\n(${ROOT}/src/bar.ts) done`),
		];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		expect(text.text).toBe("error: src/foo.ts:12:3 cannot find x\n(src/bar.ts) done");
		expect(result.bytesSaved).toBe((ROOT + "/").length * 2);
		// Original message is untouched: outbound copy only.
		const original = messages[0] as ToolResultMessage;
		expect((original.content[0] as { text: string }).text).toContain(ROOT);
	});

	test("bare root token renders as dot", () => {
		const messages: Message[] = [toolResult(`cwd is ${ROOT} ok`)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		expect(text.text).toBe("cwd is . ok");
	});

	test("does not rewrite a root prefix glued to a longer token", () => {
		const messages: Message[] = [toolResult(`file://${ROOT}/src/a.ts and ${ROOT}x/y`)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages).toBe(messages);
	});

	test("paths outside every registered root stay absolute", () => {
		const messages: Message[] = [toolResult(`/etc/hosts and ${OTHER}/x.ts`)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages).toBe(messages);
	});

	test("longest root wins for nested roots (setCwd into a subdirectory)", () => {
		const nested = `${ROOT}/packages`;
		const messages: Message[] = [toolResult(`${nested}/agent/src/a.ts`)];
		const result = relativizePathsUnderRoots(messages, normalizeRoots([ROOT, nested]));
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		expect(text.text).toBe("agent/src/a.ts");
	});

	test("assistant tool call arguments rewrite whole-string path values only", () => {
		const messages: Message[] = [
			assistant([
				{
					type: "toolCall",
					id: "call-1",
					name: "read",
					arguments: {
						path: `${ROOT}/src/foo.ts`,
						note: `reads ${ROOT}/src/foo.ts here`,
						multi: `${ROOT}/a.ts\n${ROOT}/b.ts`,
					},
				},
			]),
		];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const call = (result.messages[0] as AssistantMessage).content[0] as {
			arguments: Record<string, unknown>;
		};
		expect(call.arguments.path).toBe("src/foo.ts");
		// Embedded mentions inside a longer string are left for the text pass; argument
		// strings that are not whole paths are not rewritten.
		expect(call.arguments.note).toBe(`reads ${ROOT}/src/foo.ts here`);
		expect(call.arguments.multi).toBe(`${ROOT}/a.ts\n${ROOT}/b.ts`);
	});

	test("assistant thinking blocks are never rewritten", () => {
		const thinking = `${ROOT}/secret-plan`;
		const messages: Message[] = [
			assistant([
				{ type: "thinking", thinking, thinkingSignature: "sig" },
				{ type: "text", text: `${ROOT}/src/foo.ts` },
			]),
		];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const blocks = (result.messages[0] as AssistantMessage).content;
		expect((blocks[0] as { thinking: string }).thinking).toBe(thinking);
		expect((blocks[1] as { text: string }).text).toBe("src/foo.ts");
	});

	test("user string content is relativized", () => {
		const messages: Message[] = [
			{ role: "user", content: `look at ${ROOT}/src/foo.ts please`, timestamp: 1 },
		];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		expect(result.messages[0]).toMatchObject({ content: "look at src/foo.ts please" });
	});

	test("round-trip: every rewritten token resolves back under its root", () => {
		const body = `${ROOT}/src/a.ts ${ROOT}/src/deep/b.ts`;
		const messages: Message[] = [toolResult(body)];
		const result = relativizePathsUnderRoots(messages, [ROOT]);
		const text = (result.messages[0] as ToolResultMessage).content[0] as { text: string };
		const restored = text.text
			.split(" ")
			.map(token => (token.startsWith("/") ? token : `${ROOT}/${token}`))
			.join(" ");
		expect(restored).toBe(body);
	});
});
