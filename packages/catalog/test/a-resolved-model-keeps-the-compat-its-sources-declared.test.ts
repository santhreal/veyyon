/**
 * WHY: `resolveProviderModels` built every models.dev row twice. `fetchModelsDev` builds the overlay rows,
 * and the merge then ran them through `normalizeModelList` again, so the second `buildModel` read the first
 * build's resolved compat as the row's own sparse declaration. That record won the merge over the bundled
 * declaration of the model it enriched: a wafer.ai GLM row requested `thinkingFormat: "openai"` instead of
 * the bundled `"zai"`, and an xAI OAuth row lost its `minimal -> low` effort map. It was also persisted as the
 * row's `compat`, so every later load pinned it again, and a refresh whose discovery failed merged the cached
 * copy back into the next row it wrote.
 *
 * Class closed: a resolved model's `compatConfig` is the sparse record its sources declared, never a resolved
 * record, and its resolved `compat` is the one the bundled declaration produces. This holds on every channel
 * the manager merges (the models.dev overlay, live discovery, a failed discovery that merges the cached row,
 * and an offline read of the persisted row), for every model of every bundled provider. Providers and models
 * are enumerated from the bundled catalog at run time, so a new provider joins the sweep on arrival.
 *
 * Not covered: a built model re-entering `buildModel` outside the model manager (the coding-agent registry
 * rebuilds from `compatConfig` at each of its own sites), and the rows written before the fix, which the
 * cache schema version retires (`stale-cached-gateway-limits.test.ts` sweeps every older version).
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { closeModelCache, readModelCache } from "@veyyon/catalog/model-cache";
import { type ModelManagerOptions, resolveProviderModels } from "@veyyon/catalog/model-manager";
import { getBundledModels, getBundledProviders } from "@veyyon/catalog/models";
import { defaultModelsDevFallback } from "@veyyon/catalog/modelsdev-overlay";
import type { Api, Model, ModelSpec } from "@veyyon/catalog/types";

const tempDirs: string[] = [];

afterEach(() => {
	closeModelCache();
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDbPath(name: string): string {
	const dir = mkdtempSync(path.join(tmpdir(), "veyyon-declared-compat-"));
	tempDirs.push(dir);
	return path.join(dir, `${name}.db`);
}

/** The spec a source would publish for a bundled model when it declares no compat of its own. */
function undeclared(model: Model<Api>): ModelSpec<Api> {
	const { compat: _compat, compatConfig: _compatConfig, ...spec } = model;
	return spec as ModelSpec<Api>;
}

/** An overlay that contributes nothing, so the default models.dev fallback never reaches the network. */
const NO_OVERLAY = { fetch: async () => ({}), map: () => [] };

interface Channel {
	readonly name: string;
	/** Refreshes `providerId` online with `rows` arriving through this channel; returns the resolved models. */
	resolve(providerId: string, rows: readonly ModelSpec<Api>[], dbPath: string): Promise<Model<Api>[]>;
}

async function online(options: ModelManagerOptions<Api>): Promise<Model<Api>[]> {
	return (await resolveProviderModels<Api>(options, "online")).models;
}

const CHANNELS: readonly Channel[] = [
	{
		name: "models.dev overlay",
		resolve: (providerId, rows, dbPath) =>
			online({ providerId, cacheDbPath: dbPath, modelsDev: { fetch: async () => ({}), map: () => rows } }),
	},
	{
		name: "live discovery",
		resolve: (providerId, rows, dbPath) =>
			online({ providerId, cacheDbPath: dbPath, modelsDev: NO_OVERLAY, fetchDynamicModels: async () => rows }),
	},
	{
		name: "failed discovery merging the cached row",
		resolve: async (providerId, rows, dbPath) => {
			await online({
				providerId,
				cacheDbPath: dbPath,
				modelsDev: { fetch: async () => ({}), map: () => rows },
				fetchDynamicModels: async () => null,
			});
			// The overlay is gone, so the only copy of each row this refresh can merge is the cached one.
			return online({
				providerId,
				cacheDbPath: dbPath,
				modelsDev: NO_OVERLAY,
				fetchDynamicModels: async () => null,
			});
		},
	},
];

/** Every bundled model whose resolved compat or sparse compat differs from the bundled model's. */
function offenders(resolved: readonly Model<Api>[], bundled: readonly Model<Api>[]): string[] {
	const byId = new Map(resolved.map(model => [model.id, model]));
	const found: string[] = [];
	for (const expected of bundled) {
		const actual = byId.get(expected.id);
		if (!actual) {
			found.push(`${expected.provider}/${expected.id}: missing`);
		} else if (!Bun.deepEquals(actual.compatConfig, expected.compatConfig)) {
			found.push(`${expected.provider}/${expected.id}: compatConfig`);
		} else if (!Bun.deepEquals(actual.compat, expected.compat)) {
			found.push(`${expected.provider}/${expected.id}: compat`);
		}
	}
	return found;
}

describe("a row that declares no compat keeps the bundled declaration", () => {
	for (const channel of CHANNELS) {
		it(`through the ${channel.name}, then from the persisted row`, async () => {
			const found: string[] = [];
			let swept = 0;
			for (const providerId of getBundledProviders()) {
				const bundled = getBundledModels(providerId) as Model<Api>[];
				if (bundled.length === 0) continue;
				swept += bundled.length;
				const dbPath = tempDbPath(providerId);
				found.push(...offenders(await channel.resolve(providerId, bundled.map(undeclared), dbPath), bundled));

				const cached = readModelCache<Api>(providerId, Number.POSITIVE_INFINITY, Date.now, dbPath);
				const persisted = new Map(cached?.models.map(spec => [spec.id, spec.compat]) ?? []);
				for (const model of bundled) {
					if (!Bun.deepEquals(persisted.get(model.id), model.compatConfig)) {
						found.push(`${providerId}/${model.id}: persisted compat`);
					}
				}
				const offline = await resolveProviderModels<Api>({ providerId, cacheDbPath: dbPath }, "offline");
				found.push(...offenders(offline.models, bundled).map(offender => `offline ${offender}`));
			}
			// The sweep ran over the catalog, not over an empty list.
			expect(swept).toBeGreaterThan(1000);
			expect(found).toEqual([]);
		});
	}
});

describe("a row that declares compat keeps exactly its declaration", () => {
	const declared = { supportsStore: true, maxTokensField: "max_tokens" as const };
	const probe: ModelSpec<Api> = {
		id: "probe-declared",
		name: "Probe",
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://models.example.com/v1",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		compat: declared,
	};

	// A bare row and its `-thinking` twin collapse at run time into one logical row that the collapse rebuilds,
	// so the pair exercises the one merge step that builds a row the sources never published.
	const pair: readonly ModelSpec<Api>[] = [
		{ ...probe, id: "probe-pair" },
		{ ...probe, id: "probe-pair-thinking", reasoning: true, compat: { supportsStore: false } },
	];

	for (const channel of CHANNELS) {
		it(`through the ${channel.name}, then from the persisted row`, async () => {
			const dbPath = tempDbPath("declared");
			const models = await channel.resolve("openai", [probe, ...pair], dbPath);
			const resolved = models.find(model => model.id === probe.id);
			expect(resolved?.compatConfig).toEqual(declared);
			expect(resolved?.compat).toMatchObject(declared);
			// The collapsed row takes the bare member's declaration.
			const collapsed = models.find(model => model.id === "probe-pair");
			expect(collapsed?.thinking?.effortRouting?.off).toBe("probe-pair");
			expect(collapsed?.compatConfig).toEqual(declared);

			const offline = await resolveProviderModels<Api>({ providerId: "openai", cacheDbPath: dbPath }, "offline");
			expect(offline.models.find(model => model.id === probe.id)?.compatConfig).toEqual(declared);
			expect(offline.models.find(model => model.id === "probe-pair")?.compatConfig).toEqual(declared);
		});
	}

	it("replaces the bundled row's declaration rather than merging into it", async () => {
		const models = await online({
			providerId: "openai",
			staticModels: [{ ...probe, compat: { supportsDeveloperRole: false } }],
			cacheDbPath: tempDbPath("replaced"),
			modelsDev: { fetch: async () => ({}), map: () => [probe] },
		});
		expect(models.find(model => model.id === probe.id)?.compatConfig).toEqual(declared);
	});
});

describe("the models.dev mapper path", () => {
	it("keeps a bundled thinking format in force when the models.dev row enriches the model", async () => {
		// The reported instance: wafer.ai publishes GLM-5.1 on models.dev with no compat, and the bundled row
		// declares the Z.ai thinking wire the endpoint speaks.
		const fallback = defaultModelsDevFallback<Api>("wafer-serverless");
		if (!fallback) throw new Error("wafer-serverless lost its models.dev descriptor");
		const payload = {
			"wafer.ai": {
				models: {
					"GLM-5.1": {
						name: "GLM-5.1",
						tool_call: true,
						reasoning: true,
						cost: { input: 1, output: 3 },
						limit: { context: 200_000, output: 32_000 },
						modalities: { input: ["text"] },
					},
				},
			},
		};
		const models = await online({
			providerId: "wafer-serverless",
			cacheDbPath: tempDbPath("wafer"),
			modelsDev: { ...fallback, fetch: async () => payload },
		});
		const glm = models.find(model => model.id === "GLM-5.1");
		expect(glm?.compat).toMatchObject({ thinkingFormat: "zai", reasoningDisableMode: "zai-thinking-disabled" });
		expect(glm?.compatConfig).toEqual(
			(getBundledModels("wafer-serverless") as Model<Api>[]).find(model => model.id === "GLM-5.1")?.compatConfig,
		);
	});
});
