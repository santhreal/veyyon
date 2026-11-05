import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as ai from "@veyyon/ai";
import * as aiStream from "@veyyon/ai/stream";
import { Effort } from "@veyyon/catalog/effort";
import { generateCommitMessage } from "@veyyon/coding-agent/utils/commit-message-generator";
import { generateSessionTitle } from "@veyyon/coding-agent/utils/title-generator";
import { requireBundledModel } from "../../agent/test/helpers";

function createSettings(helpers: Record<string, { model?: string; thinkingLevel?: string }>, defaultModel?: string) {
	return {
		get(path: string) {
			if (path === "providers.tinyModel") return "online";
			if (path === "agent.helpers") return helpers;
			if (path === "defaultModel") return defaultModel ? [defaultModel] : [];
			return undefined;
		},
	} as never;
}

beforeEach(() => {
	vi.clearAllMocks();
});

afterEach(() => {
	vi.restoreAllMocks();
});

describe("helper thinking propagation", () => {
	// Opus 4.5 rather than a budget row, because the assertion has to be able to
	// fail: `low` must arrive as `low` and nothing else. Opus declares
	// `low`/`medium`/`high`, so a suffix that never propagated would send the
	// default model's stored `high` and read red instead of matching a clamp.
	it("passes the commit helper's effort to commit message generation", async () => {
		const model = requireBundledModel("anthropic", "claude-opus-4-5");
		const settings = createSettings({ commit: { thinkingLevel: "low" } }, `${model.provider}/${model.id}:high`);
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix scope handling" }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/x b/x\n+change\n`,
			registry as never,
			settings,
			() => text => text,
		);
		expect(message).toBe("fix scope handling");
		// A request that sends an effort carries no answer cap, which would cut its reasoning off.
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: Effort.Low,
			maxTokens: undefined,
		});
	});

	it("keeps the commit budget reasoning-safe when the catalog disables reasoning", async () => {
		const model = { ...requireBundledModel("anthropic", "claude-sonnet-4-5"), reasoning: false };
		const settings = createSettings({ commit: { model: `${model.provider}/${model.id}` } });
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(ai, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "fix qwen title budget" }],
		} as never);

		const message = await generateCommitMessage(
			`diff --git a/x b/x\n+change\n`,
			registry as never,
			settings,
			() => text => text,
		);
		expect(message).toBe("fix qwen title budget");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			maxTokens: 1024,
		});
	});

	it("runs title generation at the title helper's effort", async () => {
		const model = requireBundledModel("anthropic", "claude-opus-4-5");
		const settings = createSettings({ title: { thinkingLevel: "low" } }, `${model.provider}/${model.id}:high`);
		const registry = {
			getAvailable: () => [model],
			getApiKey: async () => "test-key",
			resolver: vi.fn(() => async () => "test-key"),
		};
		const completeSimpleMock = vi.spyOn(aiStream, "completeSimple").mockResolvedValue({
			stopReason: "end_turn",
			content: [{ type: "text", text: "<title>Investigate resolver</title>" }],
		} as never);

		const title = await generateSessionTitle("Investigate resolver", registry as never, settings);
		expect(title).toBe("Investigate resolver");
		expect(completeSimpleMock.mock.calls[0]?.[2]).toMatchObject({
			reasoning: Effort.Low,
			disableReasoning: false,
			maxTokens: undefined,
		});
	});
});
