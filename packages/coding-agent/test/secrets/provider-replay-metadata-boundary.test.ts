import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Message, ToolResultMessage } from "@veyyon/ai";
import {
	deobfuscateAssistantContent,
	obfuscateMessages,
	SecretObfuscator,
} from "@veyyon/coding-agent/secrets/obfuscator";

const SECRET = "provider-replay-metadata-secret";
const PLACEHOLDER = "#REPLAY_SECRET#";
const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function obfuscator(): SecretObfuscator {
	return new SecretObfuscator([{ type: "plain", origin: "config", content: SECRET, name: "REPLAY_SECRET" }], {
		placeholderKey: new Uint8Array(32).fill(13),
	});
}

function assistant(content: AssistantMessage["content"]): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "mock",
		provider: "mock",
		model: "mock",
		usage,
		stopReason: "stop",
		timestamp: 1,
	};
}

describe("provider replay metadata shares the secret boundary", () => {
	/**
	 * Unsigned synthetic reasoning can be injected by hooks and is replayed as request content. It
	 * must be redacted like visible assistant text rather than bypassing the final boundary.
	 */
	it("obfuscates unsigned thinking before replay", () => {
		const [outbound] = obfuscateMessages(obfuscator(), [
			assistant([{ type: "thinking", thinking: `credential ${SECRET}` }]),
		]);
		const block = (outbound as AssistantMessage).content[0];

		expect(block).toEqual({ type: "thinking", thinking: `credential ${PLACEHOLDER}` });
	});

	/**
	 * A signed reasoning block cannot be rewritten without invalidating its provider signature. The
	 * only confidentiality-preserving behavior is to stop dispatch with an error that omits the value.
	 */
	it("fails closed when signed thinking contains a secret", () => {
		let caught: unknown;
		try {
			obfuscateMessages(obfuscator(), [
				assistant([
					{ type: "thinking", thinking: `credential ${SECRET}`, thinkingSignature: "signed-provider-bytes" },
				]),
			]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("signed thinking contains a configured secret");
		expect((caught as Error).message).not.toContain(SECRET);
	});

	/**
	 * OpenAI reasoning item ids bind replay state even when no signature field is present. Rewriting
	 * their thinking would be the same invalid authenticated replay and must be refused.
	 */
	it("fails closed when item-bound thinking contains a secret", () => {
		expect(() =>
			obfuscateMessages(obfuscator(), [
				assistant([{ type: "thinking", thinking: SECRET, itemId: "reasoning-item-1" }]),
			]),
		).toThrow("signed thinking contains a configured secret");
	});

	/**
	 * Tool call ids, names, and custom wire names are serialized into provider history. They must be
	 * redacted consistently and restored before local dispatch so id correlation and tool lookup work.
	 */
	it("round-trips tool call identity metadata", () => {
		const local = assistant([
			{
				type: "toolCall",
				id: `call-${SECRET}`,
				name: `tool-${SECRET}`,
				customWireName: `wire-${SECRET}`,
				arguments: { [`key-${SECRET}`]: SECRET },
			},
		]);

		const [outbound] = obfuscateMessages(obfuscator(), [local]);
		const block = (outbound as AssistantMessage).content[0];
		expect(block).toEqual({
			type: "toolCall",
			id: `call-${PLACEHOLDER}`,
			name: `tool-${PLACEHOLDER}`,
			customWireName: `wire-${PLACEHOLDER}`,
			arguments: { [`key-${PLACEHOLDER}`]: PLACEHOLDER },
		});
		expect(deobfuscateAssistantContent(obfuscator(), (outbound as AssistantMessage).content)).toEqual(local.content);
	});

	/**
	 * Tool-result correlation uses the same id and name strings as the preceding call. Redacting one
	 * side only breaks provider replay even if it prevents the literal credential leak.
	 */
	it("redacts matching tool-result identity metadata", () => {
		const result: ToolResultMessage = {
			role: "toolResult",
			toolCallId: `call-${SECRET}`,
			toolName: `tool-${SECRET}`,
			content: [{ type: "text", text: "safe" }],
			isError: false,
			timestamp: 1,
		};

		const [outbound] = obfuscateMessages(obfuscator(), [result]);
		expect((outbound as ToolResultMessage).toolCallId).toBe(`call-${PLACEHOLDER}`);
		expect((outbound as ToolResultMessage).toolName).toBe(`tool-${PLACEHOLDER}`);
	});

	/**
	 * Thought signatures are opaque authenticated bytes. Sending a credential inside one leaks it,
	 * while rewriting it would invalidate replay, so the boundary rejects it without echoing bytes.
	 */
	it("rejects a secret inside a tool thought signature", () => {
		let caught: unknown;
		try {
			obfuscateMessages(obfuscator(), [
				assistant([
					{
						type: "toolCall",
						id: "call-1",
						name: "read",
						arguments: {},
						thoughtSignature: `opaque-${SECRET}`,
					},
				]),
			]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("opaque tool-thought-signature metadata");
		expect((caught as Error).message).not.toContain(SECRET);
	});

	/**
	 * Text signatures and redacted-thinking blobs are also opaque provider replay fields. Neither may
	 * bypass the boundary merely because changing it would be invalid.
	 */
	it.each<Message>([
		assistant([{ type: "text", text: "safe", textSignature: `opaque-${SECRET}` }]),
		assistant([{ type: "redactedThinking", data: `opaque-${SECRET}` }]),
	])("rejects credentials in opaque replay blocks", message => {
		expect(() => obfuscateMessages(obfuscator(), [message])).toThrow("opaque");
	});

	/**
	 * Signed provider reasoning that contains no credential remains byte-identical, preserving both
	 * replay validity and the no-allocation fast path for ordinary history.
	 */
	it("preserves safe signed thinking by reference", () => {
		const message = assistant([
			{ type: "thinking", thinking: "safe reasoning", thinkingSignature: "signed-provider-bytes" },
		]);
		const messages = [message];

		expect(obfuscateMessages(obfuscator(), messages)).toBe(messages);
		expect(message.content[0]).toEqual({
			type: "thinking",
			thinking: "safe reasoning",
			thinkingSignature: "signed-provider-bytes",
		});
	});

	/**
	 * Native payloads carry provider-authenticated or encrypted replay records. Safe payloads must
	 * remain byte- and reference-identical rather than being recursively rebuilt.
	 */
	it("preserves safe native provider payloads by reference", () => {
		const payload: NonNullable<AssistantMessage["providerPayload"]> = {
			type: "openaiResponsesHistory",
			items: [{ encrypted_content: "opaque-provider-ciphertext", signature: "opaque-signature" }],
		};
		const message = { ...assistant([{ type: "text", text: "safe" }]), providerPayload: payload };
		const messages = [message];

		const outbound = obfuscateMessages(obfuscator(), messages);
		expect(outbound).toBe(messages);
		expect((outbound[0] as AssistantMessage).providerPayload).toBe(payload);
	});

	/**
	 * A raw credential inside opaque native replay cannot be safely rewritten because the enclosing
	 * provider authentication may cover it. Dispatch stops without echoing the credential.
	 */
	it("fails closed on a secret inside native provider payloads", () => {
		const message: AssistantMessage = {
			...assistant([{ type: "text", text: "safe" }]),
			providerPayload: { type: "openaiResponsesHistory", items: [{ encrypted_content: SECRET }] },
		};
		let caught: unknown;
		try {
			obfuscateMessages(obfuscator(), [message]);
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toContain("opaque native replay metadata");
		expect((caught as Error).message).not.toContain(SECRET);
	});
});
