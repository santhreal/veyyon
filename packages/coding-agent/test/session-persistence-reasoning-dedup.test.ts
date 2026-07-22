import { describe, expect, it } from "bun:test";
import type { AssistantMessage, ProviderPayload, Usage } from "@veyyon/ai";
import { BlobStore, isTextBlobRef } from "@veyyon/coding-agent/session/blob-store";
import type { FileEntry, SessionMessageEntry } from "@veyyon/coding-agent/session/session-entries";
import { resolveBlobRefsInEntries } from "@veyyon/coding-agent/session/session-loader";
import { prepareEntryForPersistence } from "@veyyon/coding-agent/session/session-persistence";
import { TempDir } from "@veyyon/utils";

const usage = (): Usage => ({
	input: 1,
	output: 1,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 2,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

function reasoningItem(id: string, encryptedContent: string): Record<string, unknown> {
	return { type: "reasoning", id, encrypted_content: encryptedContent };
}

function assistantEntry(
	content: AssistantMessage["content"],
	providerPayload: ProviderPayload | undefined,
): SessionMessageEntry {
	return {
		type: "message",
		id: "entry-1",
		parentId: null,
		timestamp: new Date(0).toISOString(),
		message: {
			role: "assistant",
			content,
			api: "openai-codex-responses",
			provider: "openai-codex",
			model: "gpt-5.2-codex",
			usage: usage(),
			stopReason: "stop",
			...(providerPayload ? { providerPayload } : {}),
			timestamp: 2,
		},
	};
}

function persistedAssistant(entry: SessionMessageEntry, blobStore: BlobStore): AssistantMessage {
	const persisted = prepareEntryForPersistence(entry, blobStore);
	if (persisted.type !== "message" || persisted.message.role !== "assistant") {
		throw new Error("Expected persisted assistant message");
	}
	return persisted.message;
}

// The happy path — duplicate dropped on disk, durable copy preserved through a
// real reload — is covered end-to-end in signature-persistence.test.ts. These
// cases pin the two safety branches: never drop a signature the payload cannot
// reconstruct, and never touch messages with no replay payload at all.
describe("session reasoning-signature dedup", () => {
	it("keeps a thinkingSignature the payload does not cover", () => {
		using tempDir = TempDir.createSync("@pi-session-reasoning-keep-");
		const blobStore = new BlobStore(tempDir.path());
		const covered = reasoningItem("rs_covered", "ENC_COVERED");
		const orphanSignature = JSON.stringify(reasoningItem("rs_orphan", "ENC_ORPHAN"));

		const message = persistedAssistant(
			assistantEntry(
				[
					{ type: "thinking", thinking: "covered", thinkingSignature: JSON.stringify(covered) },
					{ type: "thinking", thinking: "orphan", thinkingSignature: orphanSignature },
				],
				{ type: "openaiResponsesHistory", provider: "openai-codex", items: [covered] },
			),
			blobStore,
		);

		const thinkingBlocks = message.content.filter(block => block.type === "thinking");
		expect(thinkingBlocks).toHaveLength(2);
		// Covered block: signature dropped. Orphan block: signature kept — its encrypted
		// reasoning is not recoverable from the payload, so dropping it would lose data.
		expect(thinkingBlocks[0]?.thinkingSignature).toBeUndefined();
		expect(thinkingBlocks[1]?.thinkingSignature).toBe(orphanSignature);
	});

	it("leaves thinkingSignatures untouched when there is no provider payload", () => {
		using tempDir = TempDir.createSync("@pi-session-reasoning-nopayload-");
		const blobStore = new BlobStore(tempDir.path());
		const signature = JSON.stringify(reasoningItem("rs_1", "ENC"));

		const message = persistedAssistant(
			assistantEntry([{ type: "thinking", thinking: "reasoning", thinkingSignature: signature }], undefined),
			blobStore,
		);

		const thinking = message.content.find(block => block.type === "thinking");
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinkingSignature).toBe(signature);
	});
});

describe("session atomic reasoning persistence", () => {
	const truncationNotice = "[Session persistence truncated large content]";

	it("preserves an oversized signed thinking block and its signature verbatim", () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-thinking-");
		const blobStore = new BlobStore(tempDir.path());

		const message = persistedAssistant(
			assistantEntry([{ type: "thinking", thinking: "x".repeat(600_000), thinkingSignature: "sig-abc" }], undefined),
			blobStore,
		);

		const thinking = message.content[0];
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinking).toHaveLength(600_000);
		expect(thinking.thinking.endsWith(truncationNotice)).toBe(false);
		expect(thinking.thinkingSignature).toBe("sig-abc");
	});

	it("preserves an oversized redactedThinking blob verbatim", () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-redacted-");
		const blobStore = new BlobStore(tempDir.path());

		const message = persistedAssistant(
			assistantEntry([{ type: "redactedThinking", data: "r".repeat(600_000) }], undefined),
			blobStore,
		);

		const redactedThinking = message.content[0];
		if (redactedThinking?.type !== "redactedThinking") throw new Error("Expected redactedThinking block");
		expect(redactedThinking.data).toHaveLength(600_000);
		expect(redactedThinking.data.endsWith(truncationNotice)).toBe(false);
	});

	it("externalizes oversized UNSIGNED thinking and text blocks losslessly instead of truncating", async () => {
		// WHY (DATALOSS-2): unsigned oversized reasoning/text carries no exact-bytes
		// binding, so it used to be TRUNCATED to ~500k + a notice — permanently losing
		// the tail from the study record. The new contract externalizes it to a
		// `blobtext:` ref (small on the JSONL line) and restores the full content on
		// load. This test asserts both: the persisted line holds a ref (not truncated
		// text and NOT the truncation notice), and the load restores every byte.
		using tempDir = TempDir.createSync("@pi-session-atomic-unsigned-");
		const blobStore = new BlobStore(tempDir.path());

		const bigThinking = `${"y".repeat(600_000)}#thinking-tail#`;
		const bigText = `${"z".repeat(600_000)}#text-tail#`;
		const entry = assistantEntry(
			[
				{ type: "thinking", thinking: bigThinking },
				{ type: "text", text: bigText },
			],
			undefined,
		);
		const message = persistedAssistant(entry, blobStore);

		const thinking = message.content[0];
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(isTextBlobRef(thinking.thinking)).toBe(true);
		expect(thinking.thinking.endsWith(truncationNotice)).toBe(false);

		const text = message.content[1];
		if (text?.type !== "text") throw new Error("Expected text block");
		expect(isTextBlobRef(text.text)).toBe(true);

		// Load restores the full original content, tail and all — no data lost.
		const loaded: FileEntry[] = [structuredClone(prepareEntryForPersistence(entry, blobStore))];
		await resolveBlobRefsInEntries(loaded, blobStore);
		const restored = loaded[0];
		if (restored.type !== "message" || restored.message.role !== "assistant") {
			throw new Error("Expected restored assistant message");
		}
		const restoredThinking = restored.message.content[0];
		const restoredText = restored.message.content[1];
		if (restoredThinking?.type !== "thinking" || restoredText?.type !== "text") {
			throw new Error("Expected restored thinking + text blocks");
		}
		expect(restoredThinking.thinking).toBe(bigThinking);
		expect(restoredText.text).toBe(bigText);
	});

	it("survives a full JSONL string round-trip for signed thinking", () => {
		using tempDir = TempDir.createSync("@pi-session-atomic-roundtrip-");
		const blobStore = new BlobStore(tempDir.path());
		const entry = assistantEntry(
			[{ type: "thinking", thinking: "x".repeat(600_000), thinkingSignature: "sig-abc" }],
			undefined,
		);

		const persistedEntry = prepareEntryForPersistence(entry, blobStore);
		const line = JSON.stringify(persistedEntry);
		const reparsed = JSON.parse(line);
		if (reparsed.type !== "message" || reparsed.message.role !== "assistant") {
			throw new Error("Expected reparsed assistant message");
		}

		const thinking = reparsed.message.content[0];
		if (thinking?.type !== "thinking") throw new Error("Expected thinking block");
		expect(thinking.thinking).toHaveLength(600_000);
		expect(thinking.thinking.endsWith(truncationNotice)).toBe(false);
		expect(thinking.thinkingSignature).toBe("sig-abc");
	});
});
