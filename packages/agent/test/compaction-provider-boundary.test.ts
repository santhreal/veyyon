import { afterEach, describe, expect, it, vi } from "bun:test";
import { type CompactionPreparation, compact, DEFAULT_COMPACTION_SETTINGS } from "@veyyon/agent-core/compaction";
import type {
	ApiKeyResolver,
	AssistantMessage,
	Context,
	Model,
	ProviderSessionState,
	SimpleStreamOptions,
} from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { logger } from "@veyyon/utils";

const HOOK_SECRET = "SESSION_HOOK_SECRET_7f31";
const MEMORY_SECRET = "SESSION_MEMORY_SECRET_28e4";
const LATE_SECRET = "SESSION_LATE_SECRET_b881";
afterEach(() => {
	vi.restoreAllMocks();
});

function modelFixture(): Model {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected bundled compaction model");
	return model;
}

function userMessage(text: string) {
	return { role: "user" as const, content: [{ type: "text" as const, text }], timestamp: Date.now() };
}

function assistant(text: string, status?: number): AssistantMessage {
	return {
		role: "assistant",
		provider: "test",
		model: "test/compactor",
		api: "anthropic-messages",
		content: [{ type: "text", text }],
		stopReason: status === undefined ? "stop" : "error",
		errorStatus: status,
		errorMessage: status === undefined ? undefined : "credential rejected",
		timestamp: Date.now(),
	} as AssistantMessage;
}

function preparation(remoteEndpoint?: string): CompactionPreparation {
	return {
		firstKeptEntryId: "kept-entry",
		messagesToSummarize: [userMessage("old safe conversation")],
		turnPrefixMessages: [],
		recentMessages: [userMessage("recent safe conversation")],
		isSplitTurn: false,
		tokensBefore: 100_000,
		previousSummary: undefined,
		previousPreserveData: undefined,
		fileOps: { read: new Set(), edited: new Set(), written: new Set() },
		settings: { ...DEFAULT_COMPACTION_SETTINGS, remoteEndpoint },
	};
}

function contextText(context: Context): string {
	const parts = context.systemPrompt ? [...context.systemPrompt] : [];
	for (const message of context.messages) {
		if (typeof message.content === "string") {
			parts.push(message.content);
			continue;
		}
		for (const block of message.content) {
			if (block.type === "text") parts.push(block.text);
		}
	}
	return parts.join("\n");
}

describe("compaction provider confidentiality boundary", () => {
	it("sanitizes hook and memory extra context on both long and short local sends while retaining safe text", async () => {
		// WHY: extraContext is appended after conversation conversion, so both fan-out requests need a final boundary.
		const captures: string[] = [];

		const result = await compact(preparation(), modelFixture(), "test-key", undefined, undefined, {
			extraContext: [`${HOOK_SECRET} hook-safe`, `memory-safe ${MEMORY_SECRET}`],
			obfuscateProviderText: text => text.replaceAll(HOOK_SECRET, "#HOOK#").replaceAll(MEMORY_SECRET, "#MEMORY#"),
			completeImpl: async (_model, context) => {
				captures.push(contextText(context));
				return assistant(captures.length === 1 ? "long summary" : "short summary");
			},
		});

		expect(result.summary).toContain("long summary");
		expect(captures).toHaveLength(2);
		for (const capture of captures) {
			expect(capture).not.toContain(HOOK_SECRET);
			expect(capture).not.toContain(MEMORY_SECRET);
			expect(capture).toContain("hook-safe");
			expect(capture).toContain("memory-safe");
		}
	});

	it("sanitizes boundary-positioned repeated secrets without changing a safe payload", async () => {
		// WHY: beginning/end and repeated markers catch transforms accidentally applied only to projected subfields.
		const raw = `${HOOK_SECRET} safe ${HOOK_SECRET}`;
		const safe = "ordinary context remains byte stable";
		const captures: string[] = [];

		await compact(preparation(), modelFixture(), "test-key", undefined, undefined, {
			extraContext: [raw, safe],
			obfuscateProviderText: text => text.replaceAll(HOOK_SECRET, "#HOOK#"),
			completeImpl: async (_model, context) => {
				captures.push(contextText(context));
				return assistant("summary");
			},
		});

		expect(captures).toHaveLength(2);
		for (const capture of captures) {
			expect(capture).not.toContain(HOOK_SECRET);
			expect(capture).toContain("#HOOK# safe #HOOK#");
			expect(capture).toContain(safe);
		}
	});

	it("re-sanitizes remote long/short bodies after auth refresh with the current runtime", async () => {
		// WHY: remote withAuth awaits credential rotation between physical fetches; stale sanitized snapshots are unsafe.
		const bodies: string[] = [];
		const warn = vi.spyOn(logger, "warn").mockImplementation(() => {});
		let lateSecretIsLive = false;
		const resolver: ApiKeyResolver = async context => (context.error ? "refreshed-key" : "initial-key");
		const fetchImpl = vi.fn(
			async (_input: Parameters<NonNullable<SimpleStreamOptions["fetch"]>>[0], init?: RequestInit) => {
				if (typeof init?.body !== "string") throw new Error("Expected JSON request body");
				bodies.push(init.body);
				if (bodies.length === 1) {
					lateSecretIsLive = true;
					return new Response(`credential rejected ${LATE_SECRET}`, { status: 401, statusText: "Unauthorized" });
				}
				return Response.json({ summary: bodies.length === 2 ? "remote long" : "remote short" });
			},
		);

		const result = await compact(
			preparation("https://summarizer.test/compact"),
			modelFixture(),
			resolver,
			undefined,
			undefined,
			{
				extraContext: [`early ${HOOK_SECRET}`, `late ${LATE_SECRET}`, "remote-safe"],
				obfuscateProviderText: text => {
					const earlySafe = text.replaceAll(HOOK_SECRET, "#HOOK#");
					return lateSecretIsLive ? earlySafe.replaceAll(LATE_SECRET, "#LATE#") : earlySafe;
				},
				fetch: fetchImpl as unknown as typeof fetch,
			},
		);

		expect(result.summary).toContain("remote long");
		expect(bodies).toHaveLength(3);
		expect(bodies[0]).not.toContain(HOOK_SECRET);
		expect(bodies[0]).toContain(LATE_SECRET);
		for (const retriedBody of bodies.slice(1)) {
			expect(retriedBody).not.toContain(HOOK_SECRET);
			expect(retriedBody).not.toContain(LATE_SECRET);
			expect(retriedBody).toContain("remote-safe");
		}
		expect(JSON.stringify(warn.mock.calls)).not.toContain(LATE_SECRET);
	});

	it("preserves opaque authenticated provider state by exact identity", async () => {
		// WHY: recursively rewriting encrypted replay bytes corrupts provider authentication state instead of protecting text.
		const replayState = Object.freeze({
			close() {},
			encryptedContent: `opaque-${HOOK_SECRET}`,
		});
		const providerState = new Map<string, ProviderSessionState>([["openai", replayState]]);
		const observedOptions: SimpleStreamOptions[] = [];

		await compact(preparation(), modelFixture(), "test-key", undefined, undefined, {
			extraContext: [HOOK_SECRET],
			providerSessionState: providerState,
			obfuscateProviderText: text => text.replaceAll(HOOK_SECRET, "#HOOK#"),
			completeImpl: async (_model, context, options) => {
				expect(contextText(context)).not.toContain(HOOK_SECRET);
				observedOptions.push(options);
				return assistant("summary");
			},
		});

		expect(observedOptions).toHaveLength(2);
		for (const options of observedOptions) expect(options.providerSessionState).toBe(providerState);
		expect(providerState.get("openai")).toBe(replayState);
		expect(replayState.encryptedContent).toBe(`opaque-${HOOK_SECRET}`);
	});

	it("fails closed before dispatch and omits secret-bearing sanitizer errors", async () => {
		// WHY: a hostile/buggy live transform must neither send raw context nor reflect it through the thrown error.
		const completeImpl = vi.fn(async () => assistant("must not send"));
		let caught: unknown;
		try {
			await compact(preparation(), modelFixture(), "test-key", undefined, undefined, {
				extraContext: [HOOK_SECRET],
				obfuscateProviderText: () => {
					throw new Error(`failed on ${HOOK_SECRET}`);
				},
				completeImpl,
			});
		} catch (error) {
			caught = error;
		}

		expect(caught).toBeInstanceOf(Error);
		if (!(caught instanceof Error)) throw new Error("Expected compaction error");
		expect(caught.message).toBe("Compaction provider payload sanitization failed");
		expect(caught.message).not.toContain(HOOK_SECRET);
		expect(completeImpl).not.toHaveBeenCalled();
	});
});
