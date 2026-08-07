/**
 * The models.dev overlay merge must never strip a collapsed row's effort
 * routing.
 *
 * Found in review: `mergeDynamicModel` spreads `{...existing, ...dynamic}`,
 * and `buildModel` always emits the `thinking` key — `undefined` when the
 * overlay row declares no surface. The spread therefore overwrote a static
 * collapsed row's `thinking.effortRouting` with undefined whenever models.dev
 * catalogued the family base id without declaring the members, and the
 * post-merge re-collapse could not rebuild it (the members are absent from
 * the merged list). The row lost its whole effort surface on a routine
 * overlay refresh. `resolveModelThinking` already treats a routed row's
 * surface as collapse-table-owned; the merge now follows the same rule.
 *
 * Driven through the public `createModelManager` path with an injected
 * models.dev fallback: the static list carries a collapsed row, the overlay
 * answers the same id with no declared surface, and the merged model must
 * keep its routing.
 */
import { expect, it } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Effort } from "@veyyon/catalog/effort";
import { createModelManager } from "@veyyon/catalog/model-manager";
import type { ModelSpec } from "@veyyon/catalog/types";

const COST = { input: 1, output: 1, cacheRead: 0, cacheWrite: 0 } as const;

it("keeps a collapsed row's effort routing when the overlay declares no surface for the id", async () => {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-merge-routing-"));
	try {
		const staticSpec: ModelSpec<"openai-responses"> = {
			id: "fam",
			provider: "test-provider",
			api: "openai-responses",
			name: "fam",
			baseUrl: "https://example.invalid/v1",
			reasoning: true,
			thinking: {
				mode: "effort",
				efforts: [Effort.Low, Effort.High],
				effortRouting: { low: "fam-low", high: "fam-high" },
			},
			input: ["text"],
			cost: COST,
			contextWindow: 128_000,
			maxTokens: 8_192,
		};
		// The overlay knows the id but declares no reasoning surface for it.
		const overlaySpec: ModelSpec<"openai-responses"> = {
			id: "fam",
			provider: "test-provider",
			api: "openai-responses",
			name: "fam",
			baseUrl: "https://example.invalid/v1",
			reasoning: true,
			input: ["text"],
			cost: COST,
			contextWindow: 128_000,
			maxTokens: 8_192,
		};

		const manager = createModelManager({
			providerId: "test-provider",
			staticModels: [staticSpec],
			modelsDev: {
				fetch: async () => ({}),
				map: () => [overlaySpec],
			},
			cacheDbPath: path.join(dir, "models.db"),
		});

		const { models } = await manager.refresh("online");
		const merged = models.find(model => model.id === "fam");
		expect(merged).toBeDefined();
		expect(merged?.thinking?.effortRouting).toEqual({ low: "fam-low", high: "fam-high" });
		expect(merged?.thinking?.efforts).toEqual([Effort.Low, Effort.High]);
	} finally {
		fs.rmSync(dir, { recursive: true, force: true });
	}
});
