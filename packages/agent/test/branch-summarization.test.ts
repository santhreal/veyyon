import { describe, expect, test } from "bun:test";
import {
	collectEntriesForBranchSummary,
	type GenerateBranchSummaryOptions,
	generateBranchSummary,
	prepareBranchEntries,
	type ReadonlySessionManager,
	type SessionEntry,
} from "@veyyon/agent-core/compaction";
import type { AssistantMessage, Model, Usage } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";

/** In-memory ReadonlySessionManager: getBranch walks parentId to the root and
 *  returns the path root-first, mirroring the real manager's contract. */
function fakeSession(entries: SessionEntry[]): ReadonlySessionManager {
	const byId = new Map(entries.map(e => [e.id, e]));
	return {
		getEntry: id => byId.get(id),
		getBranch(leafId) {
			const path: SessionEntry[] = [];
			let cur: string | null | undefined = leafId;
			while (cur) {
				const entry = byId.get(cur);
				if (!entry) break;
				path.push(entry);
				cur = entry.parentId;
			}
			return path.reverse();
		},
	};
}

/** Minimal message node — collectEntries only reads id/parentId. */
function node(id: string, parentId: string | null): SessionEntry {
	return {
		type: "message",
		id,
		parentId,
		timestamp: new Date(0).toISOString(),
		message: { role: "user", content: id, timestamp: 0 },
	};
}

const MODEL: Model = buildModel({
	id: "mock-model",
	name: "mock-model",
	api: "mock",
	provider: "mock",
	baseUrl: "mock://",
	reasoning: false,
	input: ["text"],
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
	contextWindow: 200_000,
	maxTokens: 32_768,
});

const ZERO_USAGE: Usage = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

describe("branch summarization", () => {
	test("includes informative tool results and drops useless ones", async () => {
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "Inspect the branch-only state.", timestamp: 0 },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: new Date(1).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "config.txt" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: "BRANCH_ONLY_FACT_4076=enabled" }],
					isError: false,
					timestamp: 2,
				},
			},
			{
				type: "message",
				id: "assistant-2",
				parentId: "tool-1",
				timestamp: new Date(3).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-search", name: "search", arguments: { pattern: "absent" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 3,
				},
			},
			{
				type: "message",
				id: "tool-2",
				parentId: "assistant-2",
				timestamp: new Date(4).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: "NO_MATCH_SENTINEL_4076" }],
					isError: false,
					useless: true,
					timestamp: 4,
				},
			},
		];
		let capturedPrompt = "";
		const completeImpl: GenerateBranchSummaryOptions["completeImpl"] = async (_model, ctx) => {
			const message = ctx.messages[0];
			if (message?.role !== "user") {
				throw new Error("branch summary request did not contain a user prompt");
			}
			if (typeof message.content === "string") {
				capturedPrompt = message.content;
			} else {
				for (const block of message.content) {
					if (block.type === "text") capturedPrompt += block.text;
				}
			}
			const response: AssistantMessage = {
				role: "assistant",
				content: [{ type: "text", text: "branch summary text" }],
				api: "mock",
				provider: "mock",
				model: "mock-model",
				usage: ZERO_USAGE,
				stopReason: "stop",
				timestamp: 5,
			};
			return response;
		};

		await generateBranchSummary(entries, {
			model: MODEL,
			apiKey: "test-api-key",
			signal: new AbortController().signal,
			completeImpl,
		});

		expect(capturedPrompt).toContain("BRANCH_ONLY_FACT_4076=enabled");
		expect(capturedPrompt).not.toContain("NO_MATCH_SENTINEL_4076");
	});

	test("useless tool results do not consume the token budget", () => {
		const uselessBlob = "USELESS_".repeat(4000);
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "user-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: { role: "user", content: "OLDER_USEFUL_FACT_4076", timestamp: 0 },
			},
			{
				type: "message",
				id: "assistant-1",
				parentId: "user-1",
				timestamp: new Date(1).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-search", name: "search", arguments: { pattern: "absent" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 1,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date(2).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-search",
					toolName: "search",
					content: [{ type: "text", text: uselessBlob }],
					isError: false,
					useless: true,
					timestamp: 2,
				},
			},
		];

		// Budget tight enough that the useless blob alone would blow it out.
		const { messages } = prepareBranchEntries(entries, 100);

		const userMessages = messages.filter((m): m is Extract<typeof m, { role: "user" }> => m.role === "user");
		expect(userMessages).toHaveLength(1);
		expect(userMessages[0].content).toBe("OLDER_USEFUL_FACT_4076");
		expect(messages.some(m => m.role === "toolResult")).toBe(false);
	});

	test("large informative tool results are budgeted after summary truncation", () => {
		const informativeBlob = `IMPORTANT_LARGE_TOOL_FACT_4112\n${"x".repeat(20_000)}`;
		const entries: SessionEntry[] = [
			{
				type: "message",
				id: "assistant-1",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				message: {
					role: "assistant",
					content: [{ type: "toolCall", id: "call-read", name: "read", arguments: { path: "big.txt" } }],
					api: "mock",
					provider: "mock",
					model: "mock-model",
					usage: ZERO_USAGE,
					stopReason: "toolUse",
					timestamp: 0,
				},
			},
			{
				type: "message",
				id: "tool-1",
				parentId: "assistant-1",
				timestamp: new Date(1).toISOString(),
				message: {
					role: "toolResult",
					toolCallId: "call-read",
					toolName: "read",
					content: [{ type: "text", text: informativeBlob }],
					isError: false,
					timestamp: 1,
				},
			},
		];

		const { messages } = prepareBranchEntries(entries, 700);

		expect(messages.some(m => m.role === "toolResult")).toBe(true);
	});
});

describe("collectEntriesForBranchSummary", () => {
	test("returns nothing when there is no old position", () => {
		const session = fakeSession([node("A", null)]);
		expect(collectEntriesForBranchSummary(session, null, "A")).toEqual({ entries: [], commonAncestorId: null });
	});

	test("collects from the old leaf back to the deepest common ancestor in chronological order", () => {
		// A <- B <- C <- E (old leaf)   and   B <- D (target leaf)
		const session = fakeSession([node("A", null), node("B", "A"), node("C", "B"), node("E", "C"), node("D", "B")]);

		const { entries, commonAncestorId } = collectEntriesForBranchSummary(session, "E", "D");

		expect(commonAncestorId).toBe("B");
		expect(entries.map(e => e.id)).toEqual(["C", "E"]);
	});

	test("walks to the root with a null ancestor and stops on a missing parent link", () => {
		// X dangles off a parent id that no entry supplies; the target shares nothing.
		const session = fakeSession([node("A", null), node("B", "A"), node("D", "B"), node("X", "ghost")]);

		const { entries, commonAncestorId } = collectEntriesForBranchSummary(session, "X", "D");

		expect(commonAncestorId).toBeNull();
		expect(entries.map(e => e.id)).toEqual(["X"]);
	});
});

describe("prepareBranchEntries entry conversion", () => {
	test("converts custom_message, branch_summary, and compaction entries and drops non-content entries", () => {
		const entries: SessionEntry[] = [
			{
				type: "custom_message",
				id: "cm",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				customType: "status",
				content: "doing work",
				display: true,
			},
			{
				type: "branch_summary",
				id: "bs",
				parentId: "cm",
				timestamp: new Date(1).toISOString(),
				fromId: "old-leaf",
				summary: "recap of the abandoned branch",
			},
			{
				type: "compaction",
				id: "cp",
				parentId: "bs",
				timestamp: new Date(2).toISOString(),
				summary: "compacted history",
				firstKeptEntryId: "cm",
				tokensBefore: 1234,
			},
			{
				type: "model_change",
				id: "mc",
				parentId: "cp",
				timestamp: new Date(3).toISOString(),
				model: "mock/mock-model",
			},
		];

		const { messages } = prepareBranchEntries(entries, 0);

		// model_change contributes no conversation content and is dropped; the rest
		// keep chronological order.
		expect(messages.map(m => m.role)).toEqual(["custom", "branchSummary", "compactionSummary"]);
	});

	test("accumulates file ops from pi-generated branch summaries and skips extension-generated ones", () => {
		const entries: SessionEntry[] = [
			{
				type: "branch_summary",
				id: "bs-pi",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				fromId: "leaf-1",
				summary: "pi branch",
				fromExtension: false,
				details: { readFiles: ["src/read.ts:10-20"], modifiedFiles: ["src/edit.ts"] },
			},
			{
				type: "branch_summary",
				id: "bs-ext",
				parentId: "bs-pi",
				timestamp: new Date(1).toISOString(),
				fromId: "leaf-2",
				summary: "extension branch",
				fromExtension: true,
				details: { readFiles: ["src/skip.ts"], modifiedFiles: ["src/skip-edit.ts"] },
			},
		];

		const { fileOps } = prepareBranchEntries(entries, 0);

		// The read selector is stripped and the modified file lands in `edited`.
		expect([...fileOps.read]).toEqual(["src/read.ts"]);
		expect([...fileOps.edited]).toEqual(["src/edit.ts"]);
		// Extension-generated summary details are ignored.
		expect(fileOps.read.has("src/skip.ts")).toBe(false);
		expect(fileOps.edited.has("src/skip-edit.ts")).toBe(false);
	});

	test("force-fits an over-budget summary entry when the log is still nearly empty", () => {
		const entries: SessionEntry[] = [
			{
				type: "compaction",
				id: "cp",
				parentId: null,
				timestamp: new Date(0).toISOString(),
				summary: "IMPORTANT_COMPACTION_CONTEXT ".repeat(200),
				firstKeptEntryId: "cp",
				tokensBefore: 5000,
			},
		];

		// The single summary alone exceeds the tiny budget, but totalTokens is 0
		// (< 90% of budget), so it is kept anyway rather than dropped.
		const { messages } = prepareBranchEntries(entries, 100);

		expect(messages).toHaveLength(1);
		expect(messages[0].role).toBe("compactionSummary");
	});
});

describe("generateBranchSummary early returns", () => {
	const baseOptions = {
		model: MODEL,
		apiKey: "test-api-key" as const,
		signal: new AbortController().signal,
	};

	function assistant(fields: Partial<AssistantMessage>): AssistantMessage {
		return {
			role: "assistant",
			content: [{ type: "text", text: "" }],
			api: "mock",
			provider: "mock",
			model: "mock-model",
			usage: ZERO_USAGE,
			stopReason: "stop",
			timestamp: 0,
			...fields,
		} as AssistantMessage;
	}

	const oneUserEntry: SessionEntry[] = [
		{
			type: "message",
			id: "u1",
			parentId: null,
			timestamp: new Date(0).toISOString(),
			message: { role: "user", content: "summarize me", timestamp: 0 },
		},
	];

	test("reports no content when there are no summarizable entries", async () => {
		expect(await generateBranchSummary([], baseOptions)).toEqual({ summary: "No content to summarize" });
	});

	test("surfaces an aborted summarization", async () => {
		const result = await generateBranchSummary(oneUserEntry, {
			...baseOptions,
			completeImpl: async () => assistant({ stopReason: "aborted" }),
		});
		expect(result).toEqual({ aborted: true });
	});

	test("surfaces the provider error message, falling back to a default when absent", async () => {
		const withMessage = await generateBranchSummary(oneUserEntry, {
			...baseOptions,
			completeImpl: async () => assistant({ stopReason: "error", errorMessage: "rate limited" }),
		});
		expect(withMessage).toEqual({ error: "rate limited" });

		const withoutMessage = await generateBranchSummary(oneUserEntry, {
			...baseOptions,
			completeImpl: async () => assistant({ stopReason: "error" }),
		});
		expect(withoutMessage).toEqual({ error: "Summarization failed" });
	});
});
