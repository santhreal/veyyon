import { afterEach, describe, expect, it, vi } from "bun:test";
import type { ApiKeyResolver } from "@veyyon/ai";
import * as ai from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { BlockAccumulator, SpeechEnhancer } from "@veyyon/coding-agent/tts/speech-enhancer";

afterEach(() => {
	vi.restoreAllMocks();
});

describe("SpeechEnhancer rewriting", () => {
	it("uses a reasoning-safe rewrite budget when the catalog disables reasoning", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const model = { ...baseModel, reasoning: false };
		const settings = {
			get() {
				return undefined;
			},
			getModelRole(role: string) {
				return role === "tiny" ? `${model.provider}/${model.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Spoken text" }],
		} as never);

		const rewritten = await new SpeechEnhancer({ settings, registry, sessionId: "session-1" }).rewrite(
			"**Spoken text**",
		);
		const options = completeSimpleMock.mock.calls[0]?.[2] as
			| { disableReasoning?: boolean; maxTokens?: number }
			| undefined;

		expect(rewritten).toBe("Spoken text");
		expect(options).toMatchObject({ disableReasoning: true, maxTokens: 1536 });
	});

	it("obfuscates enhanced speech text immediately before the nested rewrite request", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const model = { ...baseModel, reasoning: false };
		const settings = {
			get() {
				return undefined;
			},
			getModelRole(role: string) {
				return role === "tiny" ? `${model.provider}/${model.id}` : undefined;
			},
			getStorage() {
				return undefined;
			},
		} as never;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const secret = "SPEECH_RAW_SECRET_123";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Safe speech" }],
		} as never);

		await new SpeechEnhancer({
			settings,
			registry,
			sessionId: "session-secret",
			obfuscateProviderText: text => obfuscator.obfuscate(text),
		}).rewrite(`Speak ${secret} once`);

		const providerContext = completeSimpleMock.mock.calls[0]?.[1] as {
			messages: Array<{ content: string }>;
		};
		const captured = JSON.stringify(providerContext);
		expect(captured).not.toContain(secret);
		expect(providerContext.messages[0]?.content).toBe(`Speak ${placeholder} once`);
	});

	it("keeps a complete placeholder when speech bounding cuts through a secret", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const model = { ...baseModel, reasoning: false };
		const settings = {
			get: () => undefined,
			getModelRole: (role: string) => (role === "tiny" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		} as never;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => "test-key",
		} as never;
		const secret = "SPEECH_BOUNDARY_SECRET_ABCDEF";
		const obfuscator = new SecretObfuscator([{ type: "plain", content: secret }]);
		const placeholder = obfuscator.obfuscate(secret);
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Safe speech" }],
		} as never);

		// Why: bounding raw speech first retained a reconstructable prefix; a
		// replacement straddling the same cut must survive only as a whole token.
		await new SpeechEnhancer({
			settings,
			registry,
			sessionId: "speech-boundary",
			obfuscateProviderText: text => obfuscator.obfuscate(text),
		}).rewrite(`${"a".repeat(1995)}${secret}${"z".repeat(2500)}`);

		const context = completeSimpleMock.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };
		expect(context.messages[0]?.content).toContain(placeholder);
		expect(context.messages[0]?.content).not.toContain(secret);
	});

	it("re-reads the speech sanitizer after credential resolution", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const model = { ...baseModel, reasoning: false };
		const settings = {
			get: () => undefined,
			getModelRole: (role: string) => (role === "tiny" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		} as never;
		const secret = "SPEECH_NEW_RUNTIME_SECRET_812";
		const placeholder = "#SPEECH_RUNTIME_SECRET#";
		let sanitize = (text: string) => text;
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => {
				sanitize = text => text.replaceAll(secret, placeholder);
				return "test-key";
			},
			resolver: () => async () => "test-key",
		} as never;
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "stop",
			content: [{ type: "text", text: "Safe speech" }],
		} as never);

		// Why: OAuth/key lookup can refresh the active runtime before the rewrite
		// dispatch, so pre-await transformed speech is stale.
		await new SpeechEnhancer({
			settings,
			registry,
			sessionId: "speech-stale",
			obfuscateProviderText: text => sanitize(text),
		}).rewrite(`Speak ${secret}`);

		const context = completeSimpleMock.mock.calls[0]?.[1] as { messages: Array<{ content: string }> };
		expect(context.messages[0]?.content).toContain(placeholder);
		expect(context.messages[0]?.content).not.toContain(secret);
	});

	it("re-sanitizes speech for a credential retry", async () => {
		const baseModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!baseModel) throw new Error("Expected bundled Claude Sonnet 4.5 model");
		const model = { ...baseModel, reasoning: false };
		const settings = {
			get: () => undefined,
			getModelRole: (role: string) => (role === "tiny" ? `${model.provider}/${model.id}` : undefined),
			getStorage: () => undefined,
		} as never;
		const secret = "SPEECH_RETRY_SECRET_662";
		const placeholder = "#SPEECH_RETRY_SECRET#";
		let sanitize = (text: string) => text;
		let attempt = 0;
		const captures: string[] = [];
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: () => async () => {
				attempt++;
				if (attempt === 2) sanitize = text => text.replaceAll(secret, placeholder);
				return `test-key-${attempt}`;
			},
		} as never;
		vi.spyOn(ai, "completeSimple").mockImplementation(async (_model, context, options) => {
			const resolveKey = options?.apiKey as ApiKeyResolver;
			await resolveKey({ lastChance: false, error: undefined });
			captures.push(JSON.stringify(context));
			await resolveKey({ lastChance: true, error: new Error("401"), previousKey: "test-key-1" });
			captures.push(JSON.stringify(context));
			return { stopReason: "stop", content: [{ type: "text", text: "Safe speech" }] } as never;
		});

		// Why: completeSimple owns auth retries, so the resolver is the final seam
		// where a refreshed runtime can rebuild the speech body.
		await new SpeechEnhancer({
			settings,
			registry,
			sessionId: "speech-retry",
			obfuscateProviderText: text => sanitize(text),
		}).rewrite(`Speak ${secret}`);

		expect(captures[1]).toContain(placeholder);
		expect(captures[1]).not.toContain(secret);
	});

});

/** Push each delta in order; returns blocks completed by pushes plus the flush tail. */
function feed(...deltas: string[]): { blocks: string[]; tail: string | null } {
	const acc = new BlockAccumulator();
	const blocks = deltas.flatMap(delta => acc.push(delta));
	return { blocks, tail: acc.flush() };
}

describe("BlockAccumulator paragraph splitting", () => {
	it("emits blank-line-delimited paragraphs in order", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("First paragraph.\n\nSecond paragraph.\n\n")).toEqual(["First paragraph.", "Second paragraph."]);
	});

	it("keeps single-newline lines (a multi-line list) in one block", () => {
		const { blocks, tail } = feed("- item one\n- item two\n- item three\n");
		expect(blocks).toEqual([]);
		expect(tail).toBe("- item one\n- item two\n- item three");
	});
});

describe("BlockAccumulator fence atomicity", () => {
	it("a ``` fence with an internal blank line stays one whole block between prose blocks", () => {
		const { blocks } = feed("Intro text.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro text.\n\n");
		expect(blocks).toEqual(["Intro text.", "```ts\nconst a = 1;\n\nconst b = 2;\n```", "Outro text."]);
	});

	it("~~~ fences hold a block together like ``` fences", () => {
		const { blocks } = feed("~~~\nfirst line\n\nsecond line\n~~~\n\nAfter the fence.\n\n");
		expect(blocks).toEqual(["~~~\nfirst line\n\nsecond line\n~~~", "After the fence."]);
	});

	it("a ``` line inside an open ~~~ fence does not close it", () => {
		const { blocks } = feed("~~~\n```\nstill code\n\nstill code too\n~~~\n\nAfter the fence.\n\n");
		expect(blocks).toEqual(["~~~\n```\nstill code\n\nstill code too\n~~~", "After the fence."]);
	});
});

describe("BlockAccumulator delta splitting", () => {
	it("one-character deltas yield the same blocks and flush tail as a single push", () => {
		const input = "Intro text.\n\n```ts\nconst a = 1;\n\nconst b = 2;\n```\n\nOutro text.\nTrailing partial";
		expect(feed(...input.split(""))).toEqual(feed(input));
	});
});

describe("BlockAccumulator flushPartial", () => {
	it("returns null mid-fence and preserves fence state for the eventual close", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("```ts\nconst x = 1;\nconst y")).toEqual([]);
		expect(acc.flushPartial()).toBeNull();
		expect(acc.push(" = 2;\n```\n\n")).toEqual(["```ts\nconst x = 1;\nconst y = 2;\n```"]);
	});

	it("drains a pending partial line outside a fence, and later pushes continue cleanly", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("Stalled sentence with no newline")).toEqual([]);
		expect(acc.flushPartial()).toBe("Stalled sentence with no newline");
		expect(acc.push("Fresh paragraph after the stall.\n\n")).toEqual(["Fresh paragraph after the stall."]);
		expect(acc.flush()).toBeNull();
	});
});

describe("BlockAccumulator flush", () => {
	it("drops an unterminated fence from its opening line but keeps preceding prose in the same block", () => {
		const acc = new BlockAccumulator();
		expect(acc.push("Prose before the code:\n```ts\nconst broken = ")).toEqual([]);
		expect(acc.flush()).toBe("Prose before the code:");
	});

	it("returns null with no pending content, both fresh and after a drain", () => {
		const acc = new BlockAccumulator();
		expect(acc.flush()).toBeNull();
		acc.push("Some text\n");
		acc.flush();
		expect(acc.flush()).toBeNull();
	});
});
