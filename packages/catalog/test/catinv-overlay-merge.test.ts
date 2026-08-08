/**
 * WHY: the models.dev overlay must enrich bundled rows, never erase them —
 * and poisoned overlay rows must be rejected with a name, never merged.
 *
 * `mergeDynamicModel` spreads `{...existing, ...dynamic}` and then re-decides
 * each field, so every bundled field the merge does NOT explicitly protect is
 * one overlay row away from being clobbered. The one instance that already
 * shipped: an overlay row declaring no thinking surface overwrote a collapsed
 * row's `thinking.effortRouting` with undefined (pinned in
 * model-manager-routed-thinking.test.ts). The same spread shape guards —
 * or fails to guard — the row's declared cost, reasoningOptions, headers, and
 * image input, and nothing pinned those.
 *
 * The second half is the poisoned-row path. `fetchModelsDev`
 * (src/model-manager.ts) runs overlay specs through the same rejection gate
 * as dynamic discovery, but the rejected-specs suite only exercises the
 * `fetchDynamicModels` channel — the models.dev channel, which enriches every
 * descriptor-covered provider, had no guard at all. A drifted models.dev
 * payload (a `cost` missing `cacheRead`, a `contextWindow` arriving as a
 * string) must be dropped per row, reported once with the id and field, and
 * must leave the bundled row of the same id untouched.
 *
 * Both halves run through the real `createModelManager` with an injected
 * `modelsDev` hook, so the assertions observe exactly what the picker would.
 */
import { afterEach, describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { buildModel } from "@veyyon/catalog/build";
import type { DiscoveryFailure } from "@veyyon/catalog/discovery/failure";
import { Effort } from "@veyyon/catalog/effort";
import { createModelManager } from "@veyyon/catalog/model-manager";
import type { Api, Model, ModelSpec } from "@veyyon/catalog/types";

type Spec = ModelSpec<"openai-completions">;

function spec(id: string, overrides: Partial<Spec> = {}): Spec {
	return {
		id,
		name: `Model ${id}`,
		api: "openai-completions",
		provider: "openai",
		baseUrl: "https://models.example.com",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 1024,
		...overrides,
	};
}

interface RefreshOutcome {
	models: Model<Api>[];
	failures: DiscoveryFailure[];
}

const tempDirs: string[] = [];

afterEach(() => {
	for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** Refresh once through the real manager with an injected models.dev overlay. */
async function refreshWithOverlay(
	staticSpecs: readonly Spec[],
	overlaySpecs: readonly unknown[],
): Promise<RefreshOutcome> {
	const failures: DiscoveryFailure[] = [];
	const dir = mkdtempSync(path.join(tmpdir(), "veyyon-catinv-overlay-"));
	tempDirs.push(dir);
	const manager = createModelManager<Api>({
		providerId: "openai",
		staticModels: staticSpecs as readonly ModelSpec<Api>[],
		cacheDbPath: path.join(dir, "models.db"),
		modelsDev: {
			fetch: async () => ({}),
			map: () => overlaySpecs as ModelSpec<Api>[],
		},
		onDiscoveryFailure: failure => failures.push(failure),
	});
	const result = await manager.refresh("online");
	return { models: result.models, failures };
}

function byId(models: readonly Model<Api>[], id: string): Model<Api> {
	const found = models.find(model => model.id === id);
	if (!found) throw new Error(`expected ${id} in [${models.map(m => m.id).join(", ")}]`);
	return found;
}

describe("a sparse overlay row never clobbers bundled fields it did not declare", () => {
	const staticRow = spec("probe-base", {
		name: "Bundled Name",
		reasoning: true,
		reasoningOptions: { efforts: [Effort.Low, Effort.High] },
		input: ["text", "image"],
		cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
		contextWindow: 200_000,
		maxTokens: 8192,
		headers: { "X-Bundled": "yes" },
	});

	it("keeps bundled cost, surface, headers and image input while declared limits and name win", async () => {
		const staticBuilt = buildModel(staticRow);
		const overlayRow = spec("probe-base", {
			name: "Overlay Name",
			// Undeclared: reasoning stays false here, no reasoningOptions, no
			// headers, zeroed cost (models.dev publishes no pricing for this row).
			contextWindow: 256_000,
			maxTokens: 16_384,
		});
		const { models } = await refreshWithOverlay([staticRow], [overlayRow]);
		const merged = byId(models, "probe-base");

		// Declared by the overlay: wins over the bundle.
		expect(merged.contextWindow).toBe(256_000);
		expect(merged.maxTokens).toBe(16_384);
		expect(merged.name).toBe("Overlay Name");
		// Not declared by the overlay: the bundled facts survive.
		expect(merged.cost).toEqual({ input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 });
		expect(merged.reasoning).toBe(true);
		expect(merged.reasoningOptions).toEqual({ efforts: [Effort.Low, Effort.High] });
		expect(merged.thinking).toEqual(staticBuilt.thinking);
		expect(merged.headers).toEqual({ "X-Bundled": "yes" });
		expect(merged.input).toEqual(["text", "image"]);
	});
});

describe("an overlay row that declares a reasoning surface is authoritative for it", () => {
	it("replaces the bundled declaration and re-bakes the thinking surface", async () => {
		const staticRow = spec("probe-surface", {
			reasoning: true,
			reasoningOptions: { efforts: [Effort.Low, Effort.High] },
		});
		const overlayRow = spec("probe-surface", {
			reasoning: true,
			reasoningOptions: { efforts: [Effort.Minimal] },
		});
		const { models } = await refreshWithOverlay([staticRow], [overlayRow]);
		const merged = byId(models, "probe-surface");

		expect(merged.reasoningOptions).toEqual({ efforts: [Effort.Minimal] });
		expect(merged.thinking).toEqual(buildModel(overlayRow).thinking);
	});
});

describe("a poisoned overlay row is rejected and reported, not merged", () => {
	it("drops the bad row, keeps the good rows, and names id and field once", async () => {
		const staticRow = spec("probe-base", {
			cost: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
			contextWindow: 200_000,
			maxTokens: 8192,
		});
		const goodOverlayRow = spec("probe-new", { contextWindow: 128_000 });
		// The poisoned row targets the SAME id as the bundled row: if it
		// reached the merge it would clobber the bundled row's facts.
		const poisoned = { ...spec("probe-base"), cost: { input: 1, output: 2, cacheWrite: 3 } };

		const { models, failures } = await refreshWithOverlay([staticRow], [goodOverlayRow, poisoned]);

		// The good overlay row merged in.
		expect(byId(models, "probe-new").contextWindow).toBe(128_000);
		// The bundled row the poisoned row targeted is byte-for-byte the static build.
		expect(byId(models, "probe-base")).toEqual(buildModel(staticRow));
		// One payload failure names the count, the id, and the disqualifying field.
		const payloadFailures = failures.filter(failure => failure.stage === "payload");
		expect(payloadFailures).toHaveLength(1);
		expect(payloadFailures[0]?.detail).toContain("1 models.dev models rejected");
		expect(payloadFailures[0]?.detail).toContain("probe-base (cost.cacheRead)");
	});
});
