import { describe, expect, it, vi } from "bun:test";
import type { Model } from "@veyyon/ai";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/types";
import { executeBuiltinSlashCommand } from "@veyyon/coding-agent/slash-commands/builtin-registry";

/**
 * `/thinking` (alias `/effort`) offers and accepts exactly what the active
 * model's catalog row declares. Pinned per mechanism:
 *  - param row: a declared level applies; an undeclared one is refused with
 *    the accepted set named (never clamped);
 *  - routing row without an off sibling: off and auto are refused;
 *  - id-baked row (effort in the model id): every level is refused with a
 *    message naming the baked tier and the base id;
 *  - none row (no reasoning): refused as reasonless.
 * The ephemeral contract holds throughout: accepted sets call
 * setThinkingLevel(level, false), never the persisted default.
 */
function fakeModel(overrides: {
	id: string;
	reasoning: boolean;
	thinking?: Model["thinking"];
}): Model {
	return {
		id: overrides.id,
		name: overrides.id,
		api: "openai-completions",
		provider: "fixture",
		baseUrl: "https://fixture.invalid/v1",
		reasoning: overrides.reasoning,
		thinking: overrides.thinking,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 200000,
		maxTokens: 32000,
	} as Model;
}

function createRuntime(model: Model) {
	const showStatus = vi.fn();
	const setThinkingLevel = vi.fn();
	const runtime = {
		ctx: {
			editor: { setText: vi.fn() },
			showStatus,
			statusLine: { invalidate: vi.fn() },
			ui: { requestRender: vi.fn() },
			updateEditorBorderColor: vi.fn(),
			session: {
				model,
				setThinkingLevel,
				configuredThinkingLevel: () => undefined,
			},
		} as unknown as InteractiveModeContext,
	};
	return { runtime, showStatus, setThinkingLevel };
}

describe("/thinking accepts only the row's declared levels", () => {
	const paramRow = fakeModel({
		id: "glm-5.2",
		reasoning: true,
		thinking: { mode: "effort", efforts: ["high", "max"] } as Model["thinking"],
	});

	it("applies a declared level ephemerally", async () => {
		const { runtime, setThinkingLevel } = createRuntime(paramRow);
		const handled = await executeBuiltinSlashCommand("/thinking high", runtime);
		expect(handled).toBe(true);
		expect(setThinkingLevel).toHaveBeenCalledWith("high", false);
	});

	it("refuses an undeclared level, naming the accepted set", async () => {
		const { runtime, showStatus, setThinkingLevel } = createRuntime(paramRow);
		await executeBuiltinSlashCommand("/thinking low", runtime);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		const message = showStatus.mock.calls[0]?.[0] as string;
		expect(message).toContain("does not accept low");
		expect(message).toContain("off, auto, high, max");
	});

	it("refuses off and auto on a routed row with no off sibling", async () => {
		const routed = fakeModel({
			id: "gpt-5.3-codex",
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: ["low", "high", "xhigh"],
				effortRouting: { low: "gpt-5.3-codex-low", high: "gpt-5.3-codex-high", xhigh: "gpt-5.3-codex-xhigh" },
			} as Model["thinking"],
		});
		for (const level of ["off", "auto"]) {
			const { runtime, showStatus, setThinkingLevel } = createRuntime(routed);
			await executeBuiltinSlashCommand(`/thinking ${level}`, runtime);
			expect(setThinkingLevel).not.toHaveBeenCalled();
			expect(showStatus.mock.calls[0]?.[0] as string).toContain(`does not accept ${level}`);
		}
	});

	it("refuses every level on an id-baked row, naming the baked tier", async () => {
		const baked = fakeModel({ id: "gpt-5.4-high", reasoning: true, thinking: undefined });
		const { runtime, showStatus, setThinkingLevel } = createRuntime(baked);
		await executeBuiltinSlashCommand("/thinking low", runtime);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		const message = showStatus.mock.calls[0]?.[0] as string;
		expect(message).toContain('effort "high" baked into the model id');
		expect(message).toContain("gpt-5.4");
	});

	it("refuses on a non-reasoning row", async () => {
		const plain = fakeModel({ id: "composer-1", reasoning: false, thinking: undefined });
		const { runtime, showStatus, setThinkingLevel } = createRuntime(plain);
		await executeBuiltinSlashCommand("/effort high", runtime);
		expect(setThinkingLevel).not.toHaveBeenCalled();
		expect(showStatus.mock.calls[0]?.[0] as string).toContain("does not reason");
	});
});
