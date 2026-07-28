import { describe, expect, it } from "bun:test";
import type { AssistantMessage, Context, Message } from "@veyyon/ai";
import {
	deobfuscateAssistantContent,
	obfuscateMessages,
	obfuscateProviderContext,
	SecretObfuscator,
} from "@veyyon/coding-agent/secrets/obfuscator";
import { type } from "arktype";

const usage: AssistantMessage["usage"] = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], secretInReplay?: string): AssistantMessage {
	return {
		role: "assistant",
		content,
		api: "test",
		provider: "test",
		model: "test",
		usage,
		stopReason: "stop",
		timestamp: 1,
		providerPayload:
			secretInReplay === undefined
				? undefined
				: { type: "openaiResponsesHistory", items: [{ type: "message", text: secretInReplay }] },
	};
}

describe("final provider secret boundary", () => {
	/** Resumed assistant prose is re-sanitized after local display restoration, or a restart sends the raw credential back. */
	it("re-obfuscates restored assistant text, tool arguments, and replay payloads", () => {
		const secret = "resume-secret-value-123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret, name: "RESUME_TOKEN" }]);
		const persisted = assistant([
			{ type: "text", text: "use #RESUME_TOKEN#" },
			{ type: "toolCall", id: "call-1", name: "run", arguments: { token: "#RESUME_TOKEN#" } },
		]);
		const restored = deobfuscateAssistantContent(obfuscator, persisted.content);
		const [outbound] = obfuscateMessages(obfuscator, [
			{
				...persisted,
				content: restored,
				providerPayload: { type: "openaiResponsesHistory", items: [{ text: secret }] },
			},
		]);

		expect(JSON.stringify(restored)).toContain(secret);
		expect(JSON.stringify(outbound)).not.toContain(secret);
		expect(JSON.stringify(outbound)).toContain("#RESUME_TOKEN#");
	});

	/** Dynamic instructions and emitted schemas share the provider trust boundary with messages and must not bypass redaction. */
	it("redacts system prompts, every message role, ArkType schemas, examples, and custom formats", () => {
		const secret = "provider-boundary-secret-456";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }], {
			placeholderKey: new Uint8Array(32).fill(3),
		});
		const parameters = type({ note: "string" }).describe(`schema ${secret}`);
		const context: Context = {
			systemPrompt: [`system ${secret}`],
			messages: [
				{ role: "developer", content: `developer ${secret}`, timestamp: 1 },
				assistant([{ type: "text", text: `assistant ${secret}` }], secret),
				{ role: "user", content: `user ${secret}`, timestamp: 1 },
				{
					role: "toolResult",
					toolCallId: "call-1",
					toolName: "read",
					content: [{ type: "text", text: `result ${secret}` }],
					isError: false,
					timestamp: 1,
				},
			],
			tools: [
				{
					name: "extension_tool",
					description: `description ${secret}`,
					parameters,
					customFormat: { syntax: "regex", definition: `grammar ${secret}` },
					examples: [{ call: { note: secret } }],
				},
			],
		};

		const outbound = obfuscateProviderContext(obfuscator, context);

		expect(JSON.stringify(outbound)).not.toContain(secret);
		expect(JSON.stringify(outbound)).toContain("#0");
		expect(context.systemPrompt?.[0]).toContain(secret);
		expect(context.tools?.[0]?.description).toContain(secret);
	});
});

describe("redaction tombstones", () => {
	/** Expiry revokes substitution but retains a one-way HMAC tombstone, or old transcript text becomes provider-visible. */
	it("keeps expired raw values redacted while refusing their old placeholder", () => {
		let now = 10;
		const secret = "expiring-secret-value-789";
		const expired: string[] = [];
		const obfuscator = new SecretObfuscator(
			[{ type: "plain", content: secret, name: "EXPIRING_TOKEN", expiresAt: 20 }],
			{
				now: () => now,
				onExpiry: placeholder => expired.push(placeholder),
				placeholderKey: new Uint8Array(32).fill(4),
			},
		);
		expect(obfuscator.deobfuscate("#EXPIRING_TOKEN#")).toBe(secret);

		now = 20;
		expect(obfuscator.deobfuscate("#EXPIRING_TOKEN#")).toBe("#EXPIRING_TOKEN#");
		const redacted = obfuscator.obfuscate(secret);
		expect(redacted).not.toContain(secret);
		expect(redacted).toMatch(/^#0[A-F0-9]{24}#$/);
		expect(expired).toEqual(["EXPIRING_TOKEN"]);
	});

	/** A same-scope runtime refresh carries redaction history without carrying authority to expand the removed value. */
	it("transfers removed-value redaction without transferring expansion rights", () => {
		const secret = "removed-secret-value-abc";
		const previous = new SecretObfuscator([{ type: "plain", content: secret, name: "REMOVED_TOKEN" }], {
			placeholderKey: new Uint8Array(32).fill(5),
		});
		const next = new SecretObfuscator([], { placeholderKey: new Uint8Array(32).fill(5) });

		next.retainRedactionsFrom(previous);

		expect(next.obfuscate(secret)).toMatch(/^#0[A-F0-9]{24}#$/);
		expect(next.deobfuscate("#REMOVED_TOKEN#")).toBe("#REMOVED_TOKEN#");
	});

	/** Rotating a name must retire the old raw value so it cannot be mistaken for, or expanded as, the new credential. */
	it("redacts stale values after a named rotation and removal", () => {
		const oldValue = "rotated-old-secret-123";
		const newValue = "rotated-new-secret-456";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: oldValue, name: "ROTATING_TOKEN" }], {
			placeholderKey: new Uint8Array(32).fill(6),
		});

		obfuscator.addNamedSecret("ROTATING_TOKEN", newValue);
		expect(obfuscator.obfuscate(oldValue)).toMatch(/^#0[A-F0-9]{24}#$/);
		expect(obfuscator.deobfuscate("#ROTATING_TOKEN#")).toBe(newValue);
		obfuscator.forgetNamedSecret("ROTATING_TOKEN");
		expect(obfuscator.obfuscate(newValue)).toMatch(/^#0[A-F0-9]{24}#$/);
		expect(obfuscator.deobfuscate("#ROTATING_TOKEN#")).toBe("#ROTATING_TOKEN#");
	});
});

describe("opaque placeholder identity", () => {
	/** Value placeholders use the persisted HMAC key, so restarts keep cache bytes stable without exposing an index oracle. */
	it("is stable across instances with the same key and changes with a different key", () => {
		const secret = "stable-secret-value-123";
		const key = new Uint8Array(32).fill(7);
		const first = new SecretObfuscator([{ type: "plain", content: secret }], { placeholderKey: key });
		const second = new SecretObfuscator([{ type: "plain", content: secret }], { placeholderKey: key });
		const other = new SecretObfuscator([{ type: "plain", content: secret }], {
			placeholderKey: new Uint8Array(32).fill(8),
		});

		expect(first.obfuscate(secret)).toBe(second.obfuscate(secret));
		expect(first.obfuscate(secret)).not.toBe(other.obfuscate(secret));
	});

	/** The former 16-bit index encoding collided at indexes 199 and 1380, so a large registry must preserve one token per value. */
	it("keeps 1,500 distinct secrets mapped to 1,500 distinct placeholders", () => {
		const secrets = Array.from({ length: 1_500 }, (_, index) => `collision-secret-value-${index}`);
		const obfuscator = new SecretObfuscator(
			secrets.map(content => ({ type: "plain" as const, content })),
			{ placeholderKey: new Uint8Array(32).fill(9) },
		);
		const placeholders = secrets.map(secret => obfuscator.obfuscate(secret));

		expect(new Set(placeholders).size).toBe(secrets.length);
		expect(obfuscator.deobfuscate(placeholders[199]!)).toBe(secrets[199]);
		expect(obfuscator.deobfuscate(placeholders[1380]!)).toBe(secrets[1380]);
	});
});

describe("one-pass substitution", () => {
	/** Deterministic replacements for short fixed-point values must never equal or contain any configured secret. */
	it("does not preserve the R, 8, or og replacement fixed points", () => {
		const obfuscator = new SecretObfuscator([
			{ type: "plain", content: "R", mode: "replace" },
			{ type: "plain", content: "8", mode: "replace" },
			{ type: "plain", content: "og", mode: "replace" },
		]);

		const output = obfuscator.obfuscate("R8og");
		expect(output).not.toContain("R");
		expect(output).not.toContain("8");
		expect(output).not.toContain("og");
		expect(output).not.toBe("R8og");
	});

	/** A custom replacement that contains another configured secret would reintroduce plaintext after the first rule runs. */
	it("rejects identity and cross-entry custom replacements", () => {
		expect(
			() =>
				new SecretObfuscator([
					{ type: "plain", content: "first-secret-value", mode: "replace", replacement: "second-secret-value" },
					{ type: "plain", content: "second-secret-value", mode: "replace" },
				]),
		).toThrow("contains a configured secret");
		expect(
			() =>
				new SecretObfuscator([
					{
						type: "plain",
						content: "identity-secret-value",
						mode: "replace",
						replacement: "identity-secret-value",
					},
				]),
		).toThrow("contains a configured secret");
	});

	/** Contextual regexes may redact only their matched span, or common values disappear from unrelated prose. */
	it("replaces exact regex spans without rewriting equal text outside the match context", () => {
		const secret = "abcdefgh";
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "(?<=token=)[a-z]{8}" }], {
			placeholderKey: new Uint8Array(32).fill(10),
		});

		const output = obfuscator.obfuscate(`public ${secret}; token=${secret}`);
		expect(output).toMatch(/^public abcdefgh; token=#0[A-F0-9]{24}#$/);
		expect(obfuscator.deobfuscate(output)).toBe(`public ${secret}; token=${secret}`);
	});

	/** The minimum is measured in Unicode characters, not UTF-16 code units, so astral symbols cannot bypass the floor. */
	it("applies regex minimum length by Unicode code points", () => {
		const obfuscator = new SecretObfuscator([{ type: "regex", content: "(?:🔐)+" }], {
			placeholderKey: new Uint8Array(32).fill(11),
		});
		const seven = "🔐".repeat(7);
		const eight = "🔐".repeat(8);

		expect(obfuscator.obfuscate(seven)).toBe(seven);
		expect(obfuscator.obfuscate(eight)).toMatch(/^#0[A-F0-9]{24}#$/);
		expect(obfuscator.rejections()).toEqual([
			expect.objectContaining({ reason: "too-short-to-obfuscate", length: 7 }),
		]);
	});
});
