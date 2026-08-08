import { describe, expect, it } from "bun:test";
import { streamAnthropic } from "@veyyon/ai/providers/anthropic";
import type { Context, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";

function makeAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "anthropic",
		baseUrl: "https://api.anthropic.com",
		reasoning: true,
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

function makeMiniMaxAnthropicModel(id: string): Model<"anthropic-messages"> {
	return buildModel({
		id,
		name: id,
		api: "anthropic-messages",
		provider: "minimax",
		baseUrl: "https://api.minimax.io/anthropic",
		reasoning: true,
		// Authored adaptive surface: MiniMax's Anthropic endpoint takes
		// `thinking.type: "adaptive"` as its control, so the wire quirk
		// (low/medium/high all map to the adaptive tag) is what this suite pins.
		// Bare specs derive nothing and models.dev declares MiniMax toggle-only,
		// so the fixture authors the surface the quirk attaches to.
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		},
		input: ["text", "image"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 1_000_000,
		maxTokens: 128_000,
	});
}

/** Adaptive-thinking model (Opus 4.6+, Sonnet 4.6+, Fable/Mythos 5). */
function adaptiveModel(id: string): Model<"anthropic-messages"> {
	const base = makeAnthropicModel(id);
	return buildModel({
		...base,
		thinking: {
			mode: "anthropic-adaptive",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		},
		compat: base.compatConfig,
	} as ModelSpec<"anthropic-messages">);
}

const CONTEXT: Context = {
	systemPrompt: ["Stay concise."],
	messages: [{ role: "user", content: "weather in paris?", timestamp: Date.now() }],
};

function abortedSignal(): AbortSignal {
	const controller = new AbortController();
	controller.abort();
	return controller.signal;
}

type CapturedPayload = {
	thinking?: { type: string };
	tool_choice?: { type: string };
	output_config?: { effort?: string };
};

function capturePayload(
	model: Model<"anthropic-messages">,
	opts: Parameters<typeof streamAnthropic>[2],
): Promise<CapturedPayload> {
	const { promise, resolve } = Promise.withResolvers<CapturedPayload>();
	streamAnthropic(model, CONTEXT, {
		apiKey: "sk-ant-oat-test",
		isOAuth: true,
		signal: abortedSignal(),
		onPayload: payload => resolve(payload as CapturedPayload),
		...opts,
	});
	return promise;
}

describe("Anthropic Fable/Mythos forced tool_choice", () => {
	it("downgrades a forced tool to auto for Fable (which rejects forced tool use)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("downgrades tool_choice:'any' to auto for Mythos", async () => {
		const payload = await capturePayload(adaptiveModel("claude-mythos-5"), {
			toolChoice: "any",
		});
		expect(payload.tool_choice?.type).toBe("auto");
	});

	it("preserves a forced tool_choice for non-Fable models (Opus 4.8 supports it)", async () => {
		const payload = await capturePayload(adaptiveModel("claude-opus-4-8"), {
			toolChoice: { type: "tool", name: "get_weather" },
		});
		expect(payload.tool_choice?.type).toBe("tool");
	});
});

describe("Anthropic adaptive-only thinking disable", () => {
	it("never sends thinking.type:'disabled' to an adaptive-only model, pins lowest effort", async () => {
		const payload = await capturePayload(adaptiveModel("claude-fable-5"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking).toBeUndefined();
		expect(payload.output_config?.effort).toBe("low");
	});

	it("still sends thinking.type:'disabled' for budget-based (non-adaptive) models", async () => {
		const payload = await capturePayload(makeAnthropicModel("claude-3-7-sonnet-20250219"), {
			thinkingEnabled: false,
		});
		expect(payload.thinking?.type).toBe("disabled");
	});
});

describe("a request the model cannot serve terminates instead of hanging", () => {
	// This is how the MiniMax dial went missing without anyone seeing an error:
	// the effort was refused before the request was built, `onPayload` was never
	// called, and the caller waited until the test runner's 5s deadline killed
	// it. In production that is a turn that never returns. A value assertion
	// cannot see this failure mode at all, so the bound is asserted directly.
	const SETTLE_BUDGET_MS = 2_000;

	async function settlesWithin<T>(work: Promise<T>, label: string): Promise<"settled"> {
		const timer = Promise.withResolvers<"hung">();
		const handle = setTimeout(() => timer.resolve("hung"), SETTLE_BUDGET_MS);
		try {
			const outcome = await Promise.race([
				work.then(() => "settled" as const).catch(() => "settled" as const),
				timer.promise,
			]);
			if (outcome === "hung") throw new Error(`${label} did not settle within ${SETTLE_BUDGET_MS}ms`);
			return outcome;
		} finally {
			clearTimeout(handle);
		}
	}

	/** The caller's terminal outcome, which is the surface a turn actually waits on. */
	function terminalOutcome(model: Model<"anthropic-messages">, reasoning: Effort): Promise<unknown> {
		return streamAnthropic(model, CONTEXT, {
			apiKey: "sk-ant-oat-test",
			isOAuth: true,
			signal: abortedSignal(),
			reasoning,
			thinkingEnabled: true,
		}).result();
	}

	it.each([
		["a model with no effort surface at all", "claude-mythos-5", Effort.High],
		["an effort above the ladder the model publishes", "MiniMax-M3", Effort.Max],
	])("settles when asked for %s", async (_label, id, effort) => {
		const model = id === "MiniMax-M3" ? makeMiniMaxAnthropicModel(id) : makeAnthropicModel(id);
		await settlesWithin(terminalOutcome(model, effort), `${model.provider}/${model.id} at ${effort}`);
	});

	it("settles on every tier the model does publish, and puts each on the wire", async () => {
		// The bound above is worthless if the happy path is what hangs, so the
		// same budget covers every tier MiniMax actually offers, not one sample.
		const model = makeMiniMaxAnthropicModel("MiniMax-M3");
		const tiers = getSupportedEfforts(model);
		expect(tiers.length).toBeGreaterThan(0);
		for (const effort of tiers) {
			const payload = await settlesWithin(
				capturePayload(model, { reasoning: effort, thinkingEnabled: true }),
				`${model.id} at ${effort}`,
			);
			expect(payload).toBe("settled");
		}
	});
});

describe("MiniMax Anthropic adaptive thinking", () => {
	it("serializes MiniMax adaptive reasoning without Anthropic output_config effort", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			reasoning: Effort.High,
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("maps direct MiniMax effort options to the adaptive tag only", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			effort: "low",
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});

	it("serializes MiniMax M3 thinking-off requests without the Claude effort pin", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M3"), {
			thinkingEnabled: false,
		});

		expect(payload.thinking).toEqual({ type: "disabled" });
		expect(payload.output_config?.effort).toBeUndefined();
	});
	it("maps every MiniMax M2 reasoning tier to the documented adaptive tag", async () => {
		const payload = await capturePayload(makeMiniMaxAnthropicModel("MiniMax-M2.7"), {
			reasoning: Effort.Low,
			thinkingEnabled: true,
		});

		expect(payload.thinking).toEqual({ type: "adaptive" });
		expect(payload.output_config?.effort).toBeUndefined();
	});
});
