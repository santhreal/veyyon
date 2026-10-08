import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import type { FetchImpl, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { streamOpenAICompletions } from "@veyyon/ai/providers/openai-completions";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import type { AnthropicCompat, CursorCompat, DevinCompat, OpenAICompat } from "@veyyon/catalog/types";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { modelsConfigSchemas, type OpenAICompatOverride } from "@veyyon/coding-agent/config/models-config-schema";
import { removeSyncWithRetries } from "@veyyon/utils";
import { type } from "arktype";

/**
 * WHY THIS SUITE EXISTS. `applyCompatOverrides` copies every key of a
 * models-config `compat` block onto the resolved compat record when the record
 * declares that key. The config schema passes undeclared keys through without
 * examining them. So a record key the schema does not declare is overridable
 * and unvalidated at once: `thinkingKeep: "last"` loaded clean and went to
 * Moonshot verbatim as `thinking.keep: "last"`, and its sibling contract keys
 * (`reasoningDisableMode`, `toolSchemaFlavor`, `streamMarkupHealingPattern`,
 * every anthropic-messages flag but three, the devin/cursor
 * `trustExplicitThinkingOnly`) had the same hole.
 *
 * THE CLASS IT CLOSES. Every key a resolved compat record carries, across every
 * bundled model of every api family, is either declared in the schema, and so
 * type-checked at load, or pinned below as derived from the host. A new record
 * key turns the sweep red until it is declared or pinned. Every declared key
 * rejects a value of the wrong type and names itself in the error, at the top
 * level and inside `whenThinking`.
 *
 * WHAT IT DOES NOT CATCH. A host-derived key (`isOpenRouterHost`, ...) is
 * still copied from config without validation: it is a host-classification
 * output, not a documented override, and `models.json` stores it. A declared
 * key whose ArkType literal union is wider than its contract type is not
 * caught here.
 */

const { ModelOverrideSchema, OpenAICompatSchema } = modelsConfigSchemas();

/** Record keys computed from the host classification rather than offered as overrides. */
const HOST_DERIVED_COMPAT_KEYS = [
	"dropThinkingWhenReasoningEffort",
	"isOpenRouterHost",
	"isVercelGatewayHost",
	"officialEndpoint",
	"routedUpstreamSelfCaps",
	"signingEndpoint",
	"supportsObfuscationOptOut",
	"wireModelIdMode",
];

function declaredCompatKeys(): Set<string> {
	const json = OpenAICompatSchema.json as { required?: { key: string }[]; optional?: { key: string }[] };
	return new Set([...(json.required ?? []), ...(json.optional ?? [])].map(prop => prop.key));
}

function recordCompatKeys(): { keys: Set<string>; apis: Set<string> } {
	const keys = new Set<string>();
	const apis = new Set<string>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider)) {
			const compat = (model as { compat?: object }).compat;
			if (!compat) continue;
			apis.add(model.api);
			for (const key of Object.keys(compat)) keys.add(key);
		}
	}
	return { keys, apis };
}

/** True only when `A` and `B` are the same type in both directions. */
type Exactly<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;

describe("every compat key a resolved record accepts is validated at config load", () => {
	it("types the override with exactly the keys of the compat contracts", () => {
		const exact: Exactly<
			keyof OpenAICompatOverride,
			keyof OpenAICompat | keyof AnthropicCompat | keyof DevinCompat | keyof CursorCompat
		> extends true
			? true
			: never = true;
		expect(exact).toBe(true);
	});

	it("declares every record key that is not derived from the host", () => {
		const declared = declaredCompatKeys();
		const { keys, apis } = recordCompatKeys();

		// The sweep has to reach every compat record builder to mean anything.
		for (const api of [
			"anthropic-messages",
			"cursor-agent",
			"devin-agent",
			"openai-completions",
			"openai-responses",
		]) {
			expect(apis.has(api)).toBe(true);
		}
		expect([...keys].filter(key => !declared.has(key)).sort()).toEqual(HOST_DERIVED_COMPAT_KEYS);
		expect([...declared].filter(key => !keys.has(key))).toEqual([]);
	});

	it("rejects a wrong-typed value for every declared key and names the key", () => {
		const invalid = "__not-a-valid-value__";
		const cases: { compat: Record<string, unknown>; keyPath: string }[] = [];
		for (const key of declaredCompatKeys()) {
			cases.push({ compat: { [key]: invalid }, keyPath: `compat.${key}` });
			if (key !== "whenThinking") {
				cases.push({ compat: { whenThinking: { [key]: invalid } }, keyPath: `compat.whenThinking.${key}` });
			}
		}
		const unnamed = cases
			.filter(({ compat, keyPath }) => {
				const result = ModelOverrideSchema({ compat });
				return !(result instanceof type.errors) || !result.summary.includes(keyPath);
			})
			.map(({ keyPath }) => keyPath);
		expect(unnamed).toEqual([]);
	});
});

describe("compat.thinkingKeep from a models config reaches Moonshot's thinking.keep", () => {
	let dir: string;
	let auth: AuthStorage;
	let configCount = 0;

	beforeAll(async () => {
		dir = fs.mkdtempSync(path.join(os.tmpdir(), "compat-override-"));
		auth = await AuthStorage.create(":memory:");
	});

	afterAll(() => {
		auth.close();
		removeSyncWithRetries(dir);
	});

	function registryWith(models: { id: string; compat?: Record<string, unknown> }[]): ModelRegistry {
		configCount += 1;
		const configPath = path.join(dir, `models-${configCount}.json`);
		fs.writeFileSync(
			configPath,
			JSON.stringify({
				providers: {
					"my-moonshot": {
						baseUrl: "https://api.moonshot.ai/v1",
						apiKey: "TEST_KEY",
						api: "openai-completions",
						models: models.map(model => ({
							id: model.id,
							name: model.id,
							reasoning: true,
							input: ["text"],
							cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
							contextWindow: 100_000,
							maxTokens: 8_000,
							...(model.compat && { compat: model.compat }),
						})),
					},
				},
			}),
		);
		return new ModelRegistry(auth, configPath);
	}

	async function thinkingOnTheWire(model: Model | undefined): Promise<unknown> {
		if (!model) throw new Error("model missing from the registry");
		const controller = new AbortController();
		controller.abort();
		const { promise, resolve } = Promise.withResolvers<unknown>();
		const fetchImpl: FetchImpl = Object.assign(
			async () => new Response("data: [DONE]\n\n", { headers: { "content-type": "text/event-stream" } }),
			{ preconnect: fetch.preconnect },
		);
		streamOpenAICompletions(
			model as Model<"openai-completions">,
			{ messages: [{ role: "user", content: "hi", timestamp: 0 }] },
			{
				apiKey: "test-key",
				reasoning: "high",
				signal: controller.signal,
				fetch: fetchImpl,
				onPayload: payload => resolve(payload),
			},
		);
		return ((await promise) as { thinking?: unknown }).thinking;
	}

	it("sends the detected keep by default and the configured value in its place", async () => {
		const detected = registryWith([{ id: "kimi-k2.6" }, { id: "kimi-k2.5" }]);
		expect(detected.getError()).toBeUndefined();
		expect(await thinkingOnTheWire(detected.find("my-moonshot", "kimi-k2.6"))).toEqual({
			type: "enabled",
			keep: "all",
		});
		expect(await thinkingOnTheWire(detected.find("my-moonshot", "kimi-k2.5"))).toEqual({ type: "enabled" });

		const configured = registryWith([
			{ id: "kimi-k2.6", compat: { thinkingKeep: false } },
			{ id: "kimi-k2.5", compat: { thinkingKeep: "all" } },
		]);
		expect(configured.getError()).toBeUndefined();
		expect(await thinkingOnTheWire(configured.find("my-moonshot", "kimi-k2.6"))).toEqual({ type: "enabled" });
		expect(await thinkingOnTheWire(configured.find("my-moonshot", "kimi-k2.5"))).toEqual({
			type: "enabled",
			keep: "all",
		});
	});

	it("rejects the config file on a keep value Moonshot does not define, instead of sending it", () => {
		const registry = registryWith([{ id: "kimi-k2.6", compat: { thinkingKeep: "last" } }]);
		const message = registry.getError()?.message ?? "";

		expect(message).toContain("compat.thinkingKeep");
		expect(message).toContain("last");
		expect(registry.find("my-moonshot", "kimi-k2.6")).toBeUndefined();
	});
});
