import { afterEach, describe, expect, it, vi } from "bun:test";
import { streamSimple } from "@veyyon/ai/stream";
import type { Context, Model } from "@veyyon/ai/types";
import { Effort } from "@veyyon/catalog/effort";
import { getBundledModel } from "@veyyon/catalog/models";

/**
 * WHY: the 2026-08 incident class where bundled catalog rows lost their
 * identity-derived thinking surfaces (bare-spec fallback) and the wire
 * silently degraded — requests went out with no `thinking` block, a wrong
 * budget, or an effort the model's ladder does not declare, and 30+ fixtures
 * broke without anyone noticing until providers 400'd.
 *
 * This file pins the Anthropic Messages wire encoding END TO END for the
 * three bundled thinking modes, driving the real selection path
 * (streamSimple → resolveReasoningSelection → mapOptionsForApi → anthropic
 * encoder) and capturing the exact request params via `onPayload`:
 *
 *   - budget          (anthropic/claude-sonnet-4-5): thinking.type "enabled"
 *                     + budget_tokens from the documented schedule, and NO
 *                     output_config.
 *   - budget-effort   (anthropic/claude-opus-4-5): the budget block AND
 *                     output_config.effort ride together.
 *   - adaptive+display (anthropic/claude-opus-4-7): thinking.type "adaptive"
 *                     with display "summarized" (supportsDisplay row) and the
 *                     tier on output_config.effort.
 *
 *   - disableReasoning on a budget model MUST emit thinking.type "disabled";
 *     on an adaptive-only model it MUST omit thinking and pin
 *     output_config.effort "low" (Anthropic rejects "disabled" there — a
 *     regression here is a 400 on every thinking-off call).
 *   - A tier outside the row's declared ladder MUST throw from the selection
 *     path naming the declared ladder, and no request may be built.
 *
 * Ladders are read off the bundled row (model.thinking) and also pinned
 * against the expected declaration, so models.dev drift fails loudly with a
 * diff instead of silently re-deriving expectations.
 */

const context: Context = { messages: [{ role: "user", content: "hi", timestamp: 1 }] };

const sonnet = getBundledModel<"anthropic-messages">("anthropic", "claude-sonnet-4-5");
const opus45 = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-4-5");
const opus47 = getBundledModel<"anthropic-messages">("anthropic", "claude-opus-4-7");

/** Documented Anthropic thinking-budget schedule (reasoning-budget.ts contract). Drift here MUST fail loudly. */
const ANTHROPIC_BUDGET_WIRE: Record<Effort, number> = {
	[Effort.Minimal]: 1024,
	[Effort.Low]: 4096,
	[Effort.Medium]: 8192,
	[Effort.High]: 16_384,
	[Effort.XHigh]: 32_768,
	[Effort.Max]: 32_768,
};

interface AnthropicWireBody {
	thinking?: { type: string; budget_tokens?: number; display?: string };
	output_config?: { effort?: string };
}

/**
 * Capture the exact request params the Anthropic encoder built. `onPayload`
 * fires before the request is sent; the pre-aborted signal then rejects the
 * send, which is ignored — the payload is already captured. A selection-path
 * throw (out-of-ladder tier) propagates synchronously out of streamSimple.
 */
function captureAnthropicBody(
	model: Model<"anthropic-messages">,
	options: { reasoning?: Effort; disableReasoning?: boolean },
): Promise<AnthropicWireBody> {
	const { promise, resolve, reject } = Promise.withResolvers<AnthropicWireBody>();
	const controller = new AbortController();
	controller.abort();
	const stream = streamSimple(model, context, {
		apiKey: "sk-ant-test",
		signal: controller.signal,
		reasoning: options.reasoning,
		disableReasoning: options.disableReasoning,
		onPayload: payload => resolve(payload as AnthropicWireBody),
	});
	stream.result().then(
		() => reject(new Error("the request stream ended without emitting a payload")),
		(error: unknown) => reject(error),
	);
	return promise;
}

describe("bundled Anthropic rows declare their thinking surface (models.dev drift fails here)", () => {
	it("claude-sonnet-4-5 is budget mode with the five budget tiers", () => {
		expect(sonnet).toBeDefined();
		// A `budget_tokens` declaration names no level, so nothing is declared here
		// and the control mode supplies the ladder: every tier below max, each one a
		// distinct budget the endpoint accepts. `max` repeats xhigh's 32768.
		expect(sonnet.reasoningOptions).toBeUndefined();
		expect(sonnet.thinking).toEqual({
			mode: "budget",
			efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
		});
	});

	it("claude-opus-4-5 is budget-effort mode with the low/medium/high ladder", () => {
		expect(opus45).toBeDefined();
		expect(opus45.reasoningOptions).toEqual({ efforts: [Effort.Low, Effort.Medium, Effort.High] });
		expect(opus45.thinking).toEqual({
			mode: "anthropic-budget-effort",
			efforts: [Effort.Low, Effort.Medium, Effort.High],
		});
	});

	it("claude-opus-4-7 is adaptive mode with the full ladder and supportsDisplay", () => {
		expect(opus47).toBeDefined();
		expect(opus47.reasoningOptions).toEqual({
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
		});
		expect(opus47.thinking).toEqual({
			mode: "anthropic-adaptive",
			efforts: [Effort.Low, Effort.Medium, Effort.High, Effort.XHigh, Effort.Max],
			supportsDisplay: true,
		});
	});
});

describe("budget-mode wire fidelity (claude-sonnet-4-5)", () => {
	// Encoder lines under test: stream.ts resolveThinkingBudget(ANTHROPIC_THINKING_BUDGETS)
	// and anthropic.ts `thinking = { type: "enabled", budget_tokens, display }`.
	it("serializes every declared tier as an enabled thinking block with the scheduled budget", async () => {
		for (const tier of sonnet.thinking?.efforts ?? []) {
			const body = await captureAnthropicBody(sonnet, { reasoning: tier });
			expect(body.thinking).toEqual({
				type: "enabled",
				budget_tokens: ANTHROPIC_BUDGET_WIRE[tier],
				display: "summarized",
			});
			// Budget mode has no effort side-channel: output_config must not appear.
			expect(body.output_config).toBeUndefined();
		}
	});
});

describe("budget-effort wire fidelity (claude-opus-4-5)", () => {
	// Encoder line under test: anthropic.ts `if (mode === "anthropic-budget-effort" && effort …)
	// outputConfigEffort = effort` — the budget block and the effort field ride together.
	it("serializes every declared tier as budget thinking plus output_config.effort", async () => {
		for (const tier of opus45.thinking?.efforts ?? []) {
			const body = await captureAnthropicBody(opus45, { reasoning: tier });
			expect(body.thinking).toEqual({
				type: "enabled",
				budget_tokens: ANTHROPIC_BUDGET_WIRE[tier],
				display: "summarized",
			});
			// Wire tier comes from the row's own effortMap (identity when unmapped).
			expect(body.output_config).toEqual({ effort: opus45.thinking?.effortMap?.[tier] ?? tier });
		}
	});
});

describe("adaptive wire fidelity (claude-opus-4-7)", () => {
	// Encoder lines under test: anthropic.ts `adaptive = { type: "adaptive" }`,
	// `if (model.thinking?.supportsDisplay) adaptive.display = …`, and
	// `if (effort && effort !== "adaptive") outputConfigEffort = effort`.
	it("serializes every declared tier as adaptive thinking with display plus output_config.effort", async () => {
		for (const tier of opus47.thinking?.efforts ?? []) {
			const body = await captureAnthropicBody(opus47, { reasoning: tier });
			expect(body.thinking).toEqual({ type: "adaptive", display: "summarized" });
			expect(body.output_config).toEqual({ effort: opus47.thinking?.effortMap?.[tier] ?? tier });
		}
	});
});

describe("disableReasoning encodings per Anthropic mode", () => {
	// Encoder line under test: anthropic.ts `thinking = { type: "disabled" }`.
	it("budget mode emits an explicit disabled thinking block and no effort side-channel", async () => {
		const body = await captureAnthropicBody(sonnet, { disableReasoning: true });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.output_config).toBeUndefined();
	});

	it("budget-effort mode emits an explicit disabled thinking block and drops output_config.effort", async () => {
		const body = await captureAnthropicBody(opus45, { disableReasoning: true });
		expect(body.thinking).toEqual({ type: "disabled" });
		expect(body.output_config).toBeUndefined();
	});

	// Encoder line under test: anthropic.ts `outputConfigEffort = "low"` adaptive-off pin.
	// Adaptive-only models REJECT thinking.type "disabled" with a 400, so the off
	// toggle is the omission of `thinking` plus the lowest-effort pin.
	it("adaptive mode omits the thinking field and pins output_config.effort to low", async () => {
		const body = await captureAnthropicBody(opus47, { disableReasoning: true });
		expect(body.thinking).toBeUndefined();
		expect(body.output_config).toEqual({ effort: "low" });
	});
});

describe("out-of-ladder tiers never reach the wire", () => {
	afterEach(() => vi.restoreAllMocks());

	// Selection line under test: catalog model-thinking.ts requireSupportedEffort /
	// resolveSelectedEffort — the normal path REJECTS, never clamps or fabricates.
	async function expectRejected(model: Model<"anthropic-messages">, tier: Effort): Promise<void> {
		let payloadSeen = false;
		let caught: unknown;
		// Pre-aborted so a BROKEN rejection (tier silently accepted) fails fast on
		// the abort instead of hanging on a real request.
		const controller = new AbortController();
		controller.abort();
		try {
			const stream = streamSimple(model, context, {
				apiKey: "sk-ant-test",
				signal: controller.signal,
				reasoning: tier,
				onPayload: () => {
					payloadSeen = true;
				},
			});
			for await (const event of stream) {
				if (event.type === "done" || event.type === "error") break;
			}
			await stream.result();
		} catch (error) {
			caught = error;
		}
		const ladder = (model.thinking?.efforts ?? []).join(", ");
		expect(caught).toBeInstanceOf(Error);
		expect((caught as Error).message).toBe(
			`Thinking effort ${tier} is not supported by ${model.provider}/${model.id}. Supported efforts: ${ladder}`,
		);
		expect(payloadSeen).toBe(false);
	}

	it("claude-sonnet-4-5 rejects max (the budget ladder tops out at xhigh)", async () => {
		await expectRejected(sonnet, Effort.Max);
	});

	it("claude-opus-4-5 rejects xhigh (ladder is low/medium/high)", async () => {
		await expectRejected(opus45, Effort.XHigh);
	});

	it("claude-opus-4-7 rejects minimal (ladder starts at low)", async () => {
		await expectRejected(opus47, Effort.Minimal);
	});
});
