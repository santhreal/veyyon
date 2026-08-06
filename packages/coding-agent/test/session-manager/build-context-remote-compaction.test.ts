import { describe, expect, test } from "bun:test";
import type { AgentMessage } from "@veyyon/agent-core";
import {
	convertMessageToLlm,
	REMOTE_COMPACTION_PRESERVE_KEY,
	type RemoteCompactionPreserveData,
} from "@veyyon/agent-core/compaction";
import type { Model } from "@veyyon/ai";
import { buildResponsesInput } from "@veyyon/ai/providers/openai-shared";
import type { Message } from "@veyyon/ai/types";
import { getBundledModel } from "@veyyon/catalog/models";
import { buildSessionContext } from "@veyyon/coding-agent/session/session-context";
import type { CompactionEntry, SessionEntry, SessionMessageEntry } from "@veyyon/coding-agent/session/session-entries";

/**
 * The resume/rebuild contract for server-side (remote) compaction — the
 * contract the removed provider-native path got wrong. A remote compaction
 * entry dual-writes a real readable summary plus the provider's canonical
 * compacted window. These tests compact remotely, then prove rebuild, reload
 * (JSON round trip), fork, and provider replay all produce the correct
 * model-visible context with exact content and counts.
 */

function msg(id: string, parentId: string | null, role: "user" | "assistant", text: string): SessionMessageEntry {
	const base = { type: "message" as const, id, parentId, timestamp: "2025-01-01T00:00:00Z" };
	if (role === "user") {
		return { ...base, message: { role, content: text, timestamp: 1 } };
	}
	return {
		...base,
		message: {
			role,
			content: [{ type: "text", text }],
			api: "openai-responses",
			provider: "openai",
			model: "gpt-5.1",
			usage: {
				input: 1,
				output: 1,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 2,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			stopReason: "stop",
			timestamp: 1,
		},
	};
}

/** The canonical window the compact endpoint returned, stored verbatim. */
const REMOTE_WINDOW: Array<Record<string, unknown>> = [
	{
		id: "msg_000",
		type: "message",
		status: "completed",
		role: "user",
		content: [{ type: "input_text", text: "turn one" }],
	},
	{ id: "cmp_001", type: "compaction", encrypted_content: "gAAAAABpM0Yj-fake" },
];

function remoteCompaction(id: string, parentId: string | null, firstKeptEntryId: string): CompactionEntry {
	const data: RemoteCompactionPreserveData = {
		version: 1,
		provider: "openai",
		api: "openai-responses",
		model: "gpt-5.1",
		window: REMOTE_WINDOW,
		inputTokens: 139,
		outputTokens: 438,
		compactedAt: "2025-01-01T00:01:00Z",
	};
	return {
		type: "compaction",
		id,
		parentId,
		timestamp: "2025-01-01T00:01:00Z",
		summary: "Real summary of the early turns.",
		firstKeptEntryId,
		tokensBefore: 221_568,
		preserveData: { [REMOTE_COMPACTION_PRESERVE_KEY]: data },
	};
}

function sessionEntries(): SessionEntry[] {
	return [
		msg("msg-1", null, "user", "turn one"),
		msg("msg-2", "msg-1", "assistant", "reply one"),
		msg("msg-3", "msg-2", "user", "turn two"),
		msg("msg-4", "msg-3", "assistant", "reply two"),
		msg("msg-5", "msg-4", "user", "kept turn"),
		remoteCompaction("compact-1", "msg-5", "msg-5"),
		msg("msg-6", "compact-1", "user", "after compaction"),
	];
}

function getOpenAIModel(): Model {
	const model = getBundledModel("openai", "gpt-5.1");
	if (!model) throw new Error("Expected built-in openai/gpt-5.1 to exist");
	return model;
}

function summaryMessage(messages: AgentMessage[]) {
	const first = messages[0];
	if (first?.role !== "compactionSummary") throw new Error(`Expected a compactionSummary first, got ${first?.role}`);
	return first;
}

describe("remote compaction entry rebuild", () => {
	test("rebuild emits the real summary first, then the kept tail, with the window attached", () => {
		const ctx = buildSessionContext(sessionEntries());

		// Summary + kept user turn + post-compaction turn: 3 messages, and the
		// four pre-cut messages are gone behind the summary.
		expect(ctx.messages).toHaveLength(3);
		const summary = summaryMessage(ctx.messages);
		expect(summary.summary).toBe("Real summary of the early turns.");
		expect(summary.compactedBy).toBe("openai/gpt-5.1");
		expect(summary.providerPayload?.type).toBe("openaiResponsesHistory");
		expect(summary.providerPayload?.items).toEqual(REMOTE_WINDOW);
		expect(ctx.messages[1].role === "user" && ctx.messages[1].content).toBe("kept turn");
		expect(ctx.messages[2].role === "user" && ctx.messages[2].content).toBe("after compaction");
	});

	test("reload after a JSON round trip (process restart) rebuilds the identical context", () => {
		const revived = JSON.parse(JSON.stringify(sessionEntries())) as SessionEntry[];
		const ctx = buildSessionContext(revived);

		expect(ctx.messages).toHaveLength(3);
		const summary = summaryMessage(ctx.messages);
		expect(summary.summary).toBe("Real summary of the early turns.");
		// The opaque window survives persistence byte-for-byte: it is stateless
		// provider data, so a reloaded session still replays it natively.
		expect(summary.providerPayload?.items).toEqual(REMOTE_WINDOW);
	});

	test("fork below the compaction keeps the summary and window on the new branch", () => {
		const entries = [...sessionEntries(), msg("msg-7", "msg-6", "user", "forked turn")];
		const ctx = buildSessionContext(entries, "msg-7");

		expect(ctx.messages).toHaveLength(4);
		const summary = summaryMessage(ctx.messages);
		expect(summary.summary).toBe("Real summary of the early turns.");
		expect(summary.providerPayload?.items).toEqual(REMOTE_WINDOW);
		const last = ctx.messages[3];
		expect(last.role === "user" && last.content).toBe("forked turn");
	});

	test("a Responses provider replays the native window in place of the summary text", () => {
		const ctx = buildSessionContext(sessionEntries());
		const llmMessages = ctx.messages
			.map(message => convertMessageToLlm(message))
			.filter((message): message is Message => message !== undefined);

		const input = buildResponsesInput({
			model: getOpenAIModel() as Model<"openai-responses">,
			context: { messages: llmMessages },
			strictResponsesPairing: false,
			supportsImageDetailOriginal: true,
			supportsDeveloperRole: true,
			nativeHistory: { replay: true, filterReasoning: false },
			repairOrphanOutputs: true,
		});

		const wire = JSON.stringify(input);
		// The opaque item replays; the summary text it replaces does NOT ride
		// beside it; the kept and post-compaction turns follow the window.
		expect(wire).toContain("gAAAAABpM0Yj-fake");
		expect(wire).not.toContain("Real summary of the early turns.");
		expect(wire).toContain("kept turn");
		expect(wire).toContain("after compaction");
	});

	test("a provider that does not match the window sees the readable summary instead", () => {
		const azure = getBundledModel("azure", "gpt-4");
		if (!azure) throw new Error("Expected built-in azure/gpt-4 to exist");
		const ctx = buildSessionContext(sessionEntries());
		const llmMessages = ctx.messages
			.map(message => convertMessageToLlm(message))
			.filter((message): message is Message => message !== undefined);

		const input = buildResponsesInput({
			model: azure as Model<"azure-openai-responses">,
			context: { messages: llmMessages },
			strictResponsesPairing: true,
			supportsImageDetailOriginal: true,
			supportsDeveloperRole: true,
			nativeHistory: { replay: false, filterReasoning: false },
			repairOrphanOutputs: true,
		});

		const wire = JSON.stringify(input);
		// provider "azure" never replays an "openai" window: the fork/resume
		// degradation is the real summary, never a foreign blob and never nothing.
		expect(wire).toContain("Real summary of the early turns.");
		expect(wire).not.toContain("gAAAAABpM0Yj-fake");
		expect(wire).toContain("kept turn");
	});
});
