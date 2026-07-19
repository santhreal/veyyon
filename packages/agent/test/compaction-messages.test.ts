import { describe, expect, it } from "bun:test";
import type { ImageContent, Message, TextContent, ToolResultMessage } from "@veyyon/ai";
import {
	convertMessageToLlm,
	createBranchSummaryMessage,
	createCustomMessage,
	defaultConvertToLlm,
	renderBranchSummaryContext,
	renderCompactionSummaryContext,
} from "../src/compaction/messages";
import type { AgentMessage } from "../src/types";

// The core-role transformer is the single source of truth for how compaction
// messages reach the provider. snapcompact-frames.test.ts pins the
// compactionSummary+images path; this file pins every other role and the two
// message constructors so an in-place edit to any branch is caught.

const image: ImageContent = { type: "image", data: "ZmFrZQ==", mimeType: "image/png" };

/** Compaction messages are narrowed AgentMessage shapes; fixtures are built
 *  minimally and cast once here rather than per-site. */
function agentMessage(fields: Record<string, unknown>): AgentMessage {
	return fields as unknown as AgentMessage;
}

/** `attribution` is absent on AssistantMessage in the `Message` union; read it
 *  through one narrowed helper instead of casting at every assertion site. */
function attributionOf(message: Message | undefined): string | undefined {
	return (message as { attribution?: string } | undefined)?.attribution;
}

describe("renderBranchSummaryContext", () => {
	it("wraps the summary in the branch-return template", () => {
		const rendered = renderBranchSummaryContext("we tried the async path and reverted");
		expect(rendered).toContain("summary of a branch that this conversation came back from");
		expect(rendered).toContain("<summary>\nwe tried the async path and reverted\n</summary>");
	});
});

describe("renderCompactionSummaryContext", () => {
	it("wraps the summary in the build-on-prior-work template", () => {
		const rendered = renderCompactionSummaryContext("prior model outlined the fix");
		expect(rendered).toContain("You MUST build on the work already done and NEVER duplicate it");
		expect(rendered).toContain("<summary>\nprior model outlined the fix\n</summary>");
	});
});

describe("createBranchSummaryMessage", () => {
	it("builds a branchSummary with the ISO timestamp parsed to epoch ms", () => {
		const iso = "2026-05-30T12:00:00.000Z";
		const msg = createBranchSummaryMessage("branch recap", "msg-42", iso);
		expect(msg).toEqual({
			role: "branchSummary",
			summary: "branch recap",
			fromId: "msg-42",
			timestamp: new Date(iso).getTime(),
		});
	});
});

describe("createCustomMessage", () => {
	it("carries every field through and parses the ISO timestamp", () => {
		const iso = "2026-05-30T12:00:00.000Z";
		const details = { toolCallId: "c1" };
		const msg = createCustomMessage("tool-status", "running read", true, details, iso, "agent");
		expect(msg).toEqual({
			role: "custom",
			customType: "tool-status",
			content: "running read",
			display: true,
			details,
			attribution: "agent",
			timestamp: new Date(iso).getTime(),
		});
	});

	it("leaves attribution undefined when the caller omits it", () => {
		const msg = createCustomMessage("note", "hello", false, undefined, "2026-01-01T00:00:00.000Z");
		expect(msg.attribution).toBeUndefined();
		expect(msg.details).toBeUndefined();
		expect(msg.display).toBe(false);
	});
});

describe("convertMessageToLlm: compaction roles", () => {
	it("maps a string-content custom message to a developer message with a text block", () => {
		const converted = convertMessageToLlm(
			agentMessage({
				role: "custom",
				customType: "hook",
				content: "hook fired",
				display: true,
				attribution: "user",
				timestamp: 1000,
			}),
		);
		expect(converted).toEqual({
			role: "developer",
			content: [{ type: "text", text: "hook fired" }],
			attribution: "user",
			timestamp: 1000,
		});
	});

	it("passes array content through unchanged for a custom message", () => {
		const content: (TextContent | ImageContent)[] = [{ type: "text", text: "look" }, image];
		const converted = convertMessageToLlm(
			agentMessage({ role: "custom", customType: "hook", content, display: true, timestamp: 2000 }),
		);
		expect(converted?.role).toBe("developer");
		expect(converted?.content).toBe(content);
		expect(attributionOf(converted)).toBeUndefined();
	});

	it("maps a legacy hookMessage the same way as a custom message", () => {
		const converted = convertMessageToLlm(
			agentMessage({
				role: "hookMessage",
				customType: "legacy",
				content: "legacy hook",
				display: false,
				timestamp: 3000,
			}),
		);
		expect(converted).toEqual({
			role: "developer",
			content: [{ type: "text", text: "legacy hook" }],
			attribution: undefined,
			timestamp: 3000,
		});
	});

	it("renders a branchSummary into an agent-attributed user message", () => {
		const converted = convertMessageToLlm(
			agentMessage({ role: "branchSummary", summary: "the branch", fromId: "m1", timestamp: 4000 }),
		);
		expect(converted?.role).toBe("user");
		expect(attributionOf(converted)).toBe("agent");
		expect(converted?.timestamp).toBe(4000);
		const [block] = converted!.content as TextContent[];
		expect(block.type).toBe("text");
		expect(block.text).toContain("<summary>\nthe branch\n</summary>");
	});

	it("renders a blockless compactionSummary through the build-on-prior template", () => {
		const converted = convertMessageToLlm(
			agentMessage({ role: "compactionSummary", summary: "prior recap", tokensBefore: 10, timestamp: 5000 }),
		);
		expect(converted?.role).toBe("user");
		expect(attributionOf(converted)).toBe("agent");
		const content = converted?.content as Array<TextContent | ImageContent>;
		expect(content).toHaveLength(1);
		expect((content[0] as TextContent).text).toContain("NEVER duplicate it");
		expect((content[0] as TextContent).text).toContain("prior recap");
	});
});

describe("convertMessageToLlm: core roles", () => {
	it("defaults a developer message attribution to agent and preserves an explicit one", () => {
		const defaulted = convertMessageToLlm(
			agentMessage({ role: "developer", content: [{ type: "text", text: "dev" }], timestamp: 10 }),
		);
		expect(defaulted).toEqual({
			role: "developer",
			content: [{ type: "text", text: "dev" }],
			timestamp: 10,
			attribution: "agent",
		});

		const explicit = convertMessageToLlm(
			agentMessage({
				role: "developer",
				content: [{ type: "text", text: "dev" }],
				attribution: "user",
				timestamp: 11,
			}),
		);
		expect(attributionOf(explicit)).toBe("user");
	});

	it("defaults a user message attribution to user", () => {
		const converted = convertMessageToLlm(
			agentMessage({ role: "user", content: [{ type: "text", text: "hi" }], timestamp: 20 }),
		);
		expect(converted?.role).toBe("user");
		expect(attributionOf(converted)).toBe("user");
	});

	it("returns an assistant message untouched", () => {
		const assistant = agentMessage({ role: "assistant", content: [{ type: "text", text: "ok" }], timestamp: 30 });
		expect(convertMessageToLlm(assistant)).toBe(assistant as unknown as Message);
	});

	it("drops an unknown role by returning undefined", () => {
		expect(convertMessageToLlm(agentMessage({ role: "appOnly", content: "x", timestamp: 40 }))).toBeUndefined();
	});
});

describe("convertMessageToLlm: pruned tool results", () => {
	function toolResult(fields: Partial<ToolResultMessage>): AgentMessage {
		return {
			role: "toolResult",
			toolCallId: "c1",
			toolName: "read",
			isError: false,
			content: [],
			timestamp: 100,
			...fields,
		} as unknown as AgentMessage;
	}

	it("passes an unpruned tool result content through unchanged", () => {
		const content: TextContent[] = [{ type: "text", text: "full output" }];
		const converted = convertMessageToLlm(toolResult({ content }));
		expect(converted?.content).toBe(content);
		expect(attributionOf(converted)).toBe("agent");
	});

	it("collapses a pruned tool result to a single joined text block", () => {
		const converted = convertMessageToLlm(
			toolResult({
				prunedAt: 12345,
				content: [{ type: "text", text: "part one " }, image, { type: "text", text: "part two" }],
			}),
		);
		expect(converted?.content).toEqual([{ type: "text", text: "part one part two" }]);
	});

	it("substitutes the truncation marker when a pruned result has no text blocks", () => {
		const converted = convertMessageToLlm(toolResult({ prunedAt: 12345, content: [image] }));
		expect(converted?.content).toEqual([{ type: "text", text: "[Output truncated]" }]);
	});
});

describe("defaultConvertToLlm", () => {
	it("maps every convertible message and drops the undefined ones", () => {
		const messages: AgentMessage[] = [
			agentMessage({ role: "user", content: [{ type: "text", text: "q" }], timestamp: 1 }),
			agentMessage({ role: "appOnly", content: "drop me", timestamp: 2 }),
			agentMessage({ role: "branchSummary", summary: "recap", fromId: "m", timestamp: 3 }),
		];
		const converted = defaultConvertToLlm(messages);
		expect(converted).toHaveLength(2);
		expect(converted[0]!.role).toBe("user");
		expect(converted[1]!.role).toBe("user");
		expect(attributionOf(converted[1])).toBe("agent");
	});
});
