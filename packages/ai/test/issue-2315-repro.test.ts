import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import type { Context, FetchImpl, Model, ModelSpec } from "@veyyon/ai/types";
import { buildModel } from "@veyyon/catalog/build";
import { Effort } from "@veyyon/catalog/effort";
import { readModelCache } from "@veyyon/catalog/model-cache";
import { getSupportedEfforts } from "@veyyon/catalog/model-thinking";
import { getBundledModel } from "@veyyon/catalog/models";
import { OPENAI_REASONING_DISABLE_MODES } from "@veyyon/catalog/types";
import { removeWithRetries } from "../../utils/src/temp";

const testContext: Context = {
	messages: [{ role: "user", content: "hello", timestamp: 0 }],
};

function createSseResponse(events: unknown[]): Response {
	const payload = `${events.map(event => `data: ${typeof event === "string" ? event : JSON.stringify(event)}`).join("\n\n")}\n\n`;
	return new Response(payload, {
		status: 200,
		headers: { "content-type": "text/event-stream" },
	});
}

interface CaptureOptions {
	disableReasoning?: boolean;
	reasoning?: Effort;
}

async function capturePayload(
	model: Model<"openai-completions">,
	options: CaptureOptions,
): Promise<Record<string, unknown>> {
	let payload: Record<string, unknown> | undefined;
	const fetchMock: FetchImpl = Object.assign(
		async (_input: string | URL | Request, init?: RequestInit): Promise<Response> => {
			payload = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as Record<string, unknown>;
			return createSseResponse([
				{
					id: "x",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: { content: "ok" } }],
				},
				{
					id: "x",
					object: "chat.completion.chunk",
					created: 0,
					model: model.id,
					choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
				},
				"[DONE]",
			]);
		},
		{ preconnect: fetch.preconnect },
	);
	await streamOpenAICompletions(model, testContext, {
		apiKey: "test-key",
		fetch: fetchMock,
		disableReasoning: options.disableReasoning,
		reasoning: options.reasoning,
	}).result();
	if (!payload) throw new Error("Expected request payload");
	return payload;
}

describe("issue #2315 — MiniMax M2 / GPT-OSS catalog excludes unsupported reasoning_effort tiers", () => {
	it("declares only low/medium/high for fireworks/minimax-m2.7 and disables reasoning with low", async () => {
		const model = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		const body = await capturePayload(model, { disableReasoning: true });
		// Pre-fix the catalog included `minimal`, so the Fireworks compat map turned
		// the auto-thinking classifier's disableReasoning request into `"none"`.
		expect(body.reasoning_effort).toBe("low");
	});

	it("declares only low/medium/high for fireworks/gpt-oss-120b and disables reasoning with low", async () => {
		const model = getBundledModel("fireworks", "gpt-oss-120b") as Model<"openai-completions">;
		expect(getSupportedEfforts(model)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		const body = await capturePayload(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBe("low");
	});

	it("discards a cached MiniMax M2 row carrying the pre-declaration ladder", async () => {
		// A ladder now travels with the row, so a spec on disk IS the declaration
		// and nothing downstream can repair it. A cache written before ladders
		// came from the endpoint still offers `minimal` plus the Fireworks
		// `minimal -> none` mapping, which is exactly what turned an auto-thinking
		// disable request into the `none` Fireworks MiniMax rejects. The schema
		// version is what keeps that row from being served.
		const base = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		const stale = buildModel({
			id: base.id,
			name: base.name,
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: base.baseUrl,
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Minimal, Effort.Low, Effort.Medium, Effort.High, Effort.XHigh],
				effortMap: { minimal: "none", xhigh: "max" },
			},
			input: base.input,
			cost: base.cost,
			contextWindow: base.contextWindow,
			maxTokens: base.maxTokens,
		});
		// The stale row really does reproduce #2315 when it is served.
		expect(await capturePayload(stale, { disableReasoning: true })).toMatchObject({
			reasoning_effort: "none",
		});

		const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "pi-ai-issue-2315-"));
		try {
			const dbPath = path.join(tempDir, "models.db");
			const db = new Database(dbPath, { create: true });
			db.run(`
				CREATE TABLE model_cache (
					provider_id TEXT PRIMARY KEY,
					version INTEGER NOT NULL,
					updated_at INTEGER NOT NULL,
					authoritative INTEGER NOT NULL DEFAULT 0,
					static_fingerprint TEXT NOT NULL DEFAULT '',
					models TEXT NOT NULL
				)
			`);
			db.run(
				"INSERT INTO model_cache (provider_id, version, updated_at, authoritative, static_fingerprint, models) VALUES (?, ?, ?, ?, ?, ?)",
				["fireworks", 8, Date.now(), 1, "static", JSON.stringify([stale])],
			);
			db.close();

			expect(readModelCache("fireworks", 24 * 60 * 60 * 1000, Date.now, dbPath)).toBeNull();
		} finally {
			await removeWithRetries(tempDir);
		}

		// And the row discovery writes in its place carries the declared ladder.
		expect(getSupportedEfforts(base)).toEqual([Effort.Low, Effort.Medium, Effort.High]);
		expect(await capturePayload(base, { disableReasoning: true })).toMatchObject({
			reasoning_effort: "low",
		});
	});

	it("preserves a custom compat.whenThinking reasoningEffortMap override at request time", async () => {
		const base = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		// Custom proxy: minimal stays clamped to low, xhigh is force-mapped to high
		// via a whenThinking variant — the swap was getting lost when this PR
		// moved effort maps onto `model.thinking.effortMap`.
		const model = buildModel({
			id: base.id,
			name: base.name,
			api: "openai-completions",
			provider: "fireworks",
			baseUrl: base.baseUrl,
			reasoning: true,
			thinking: { mode: "effort", efforts: [Effort.Low, Effort.Medium, Effort.High] },
			compat: { whenThinking: { reasoningEffortMap: { high: "max" } } },
			input: base.input,
			cost: base.cost,
			contextWindow: base.contextWindow,
			maxTokens: base.maxTokens,
		});

		const body = await capturePayload(model, { reasoning: Effort.High });
		expect(body.reasoning_effort).toBe("max");
	});

	it("preserves low/medium/high passthrough on fireworks/minimax-m2.7", async () => {
		const model = getBundledModel("fireworks", "minimax-m2.7") as Model<"openai-completions">;
		const lowBody = await capturePayload(model, { reasoning: Effort.Low });
		expect(lowBody.reasoning_effort).toBe("low");
		const medBody = await capturePayload(model, { reasoning: Effort.Medium });
		expect(medBody.reasoning_effort).toBe("medium");
		const highBody = await capturePayload(model, { reasoning: Effort.High });
		expect(highBody.reasoning_effort).toBe("high");
	});

	// Every dialect has its own spelling of "stop reasoning", and each one has to
	// survive a model that publishes no effort ladder. Only `lowest-effort`
	// reached for the ladder and so only it ever crashed, but a future dialect
	// that does the same would fail exactly the same way, silently, in one
	// provider. The union is read from source so a seventh spelling is RED here
	// until someone runs it against a laddered and an ladderless model.
	it.each([...OPENAI_REASONING_DISABLE_MODES])(
		"turns thinking off through the %s dialect without a ladder to lean on",
		async disableMode => {
			const model = buildModel({
				id: "no-ladder-model",
				name: "No Ladder Model",
				api: "openai-completions",
				provider: "custom-openai-compatible",
				baseUrl: "https://example.invalid/v1",
				reasoning: true,
				compat: { reasoningDisableMode: disableMode, supportsReasoningEffort: true },
				input: ["text"],
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
				contextWindow: 128_000,
				maxTokens: 8_192,
			} as ModelSpec<"openai-completions">);
			expect(getSupportedEfforts(model)).toEqual([]);

			// Terminates and produces a request. A throw here takes the whole turn
			// down over a knob the operator asked to switch OFF.
			const body = await capturePayload(model, { disableReasoning: true });
			expect(body).toHaveProperty("messages");
			// Whatever the dialect encodes, it never names a tier the model never
			// published. That is the invariant; the per-dialect field is not.
			expect(body.reasoning_effort).toBeUndefined();
		},
	);

	it("omits reasoning_effort when a lowest-effort host publishes no tiers (glm-5.1)", async () => {
		// Fireworks cannot be told to stop reasoning, so a disable request is
		// served by pinning the floor tier. GLM-5.1 publishes no tiers there, so
		// there is no floor: the request goes out without the knob rather than
		// failing, which is what an operator asking to turn thinking off wants.
		const model = getBundledModel("fireworks", "glm-5.1") as Model<"openai-completions">;
		const body = await capturePayload(model, { disableReasoning: true });
		expect(body.reasoning_effort).toBeUndefined();
		expect(body).toHaveProperty("messages");
	});
});
