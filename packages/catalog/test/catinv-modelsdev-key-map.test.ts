/**
 * WHY: the models.dev -> veyyon provider key map is one table read by BOTH the
 * bundle generator (`scripts/generate-models.ts`) and the runtime overlay
 * (`src/modelsdev-overlay.ts`), so a single bad row poisons the shipped bundle
 * and the live enrichment path at once. The failure modes this pins:
 *
 *  1. A duplicate `modelsDevKey` makes two descriptors scrape the same
 *     upstream section, emitting the same models stamped with two provider
 *     ids; a duplicate `providerId` merges two upstream sections into one
 *     provider, where same-id rows clobber each other in the generator output.
 *  2. A descriptor whose `providerId` never lands in the bundled catalog
 *     means the mapping produced nothing at generation time — the provider's
 *     entire catalog slice silently missing from fresh installs.
 *  3. A copy-pasted `providerId`/`modelsDevKey` pair (the classic edit when
 *     adding a provider: `moonshotai` -> `moonshot` is the rename every new
 *     entry is copied from) stamps rows with the wrong provider or reads the
 *     wrong upstream section, and nothing downstream notices because the rows
 *     are well-formed.
 *
 * Existing coverage pins individual descriptors (deepseek, azure, vertex,
 * opencode) one at a time; nothing guarded the table AS a map. These are
 * sweeps: every assertion ranges over all descriptors and fails listing every
 * offender.
 */
import { describe, expect, it } from "bun:test";
import MODELS from "@veyyon/catalog/models.json" with { type: "json" };
import { MODELS_DEV_PROVIDER_DESCRIPTORS, mapModelsDevToModels } from "@veyyon/catalog/provider-models/openai-compat";

function duplicates(values: readonly string[]): string[] {
	const seen: Record<string, true> = {};
	const dupes: Record<string, true> = {};
	for (const value of values) {
		if (seen[value] === true) dupes[value] = true;
		seen[value] = true;
	}
	return Object.keys(dupes);
}

describe("the models.dev provider key map is total and injective", () => {
	it("maps no two descriptors from the same models.dev section", () => {
		// Enrich-only OAuth twins share their API-key twin's section by design;
		// the exact set is pinned below.
		const nonTwin = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(d => d.enrichOnly !== true);
		expect(duplicates(nonTwin.map(d => d.modelsDevKey))).toEqual([]);
	});

	// The one sanctioned exception to injectivity: OAuth twin descriptors read
	// the API-key twin's section (`xai` -> `xai-oauth` and friends) to carry its
	// declared reasoning surfaces onto live-discovered rows. They are
	// `enrichOnly`, so they emit no standalone rows and cannot produce the
	// duplicate-stamping failure above. The set is pinned by exact equality: a
	// NEW twin turns this red until its pair is recorded here.
	it("shares sections only across the recorded enrich-only twins", () => {
		const twins = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(d => d.enrichOnly === true).map(
			d => `${d.modelsDevKey} -> ${d.providerId}`,
		);
		const nonTwin = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(d => d.enrichOnly !== true);
		expect(twins.sort()).toEqual([
			"google -> google-antigravity",
			"google -> google-gemini-cli",
			"openai -> openai-codex",
			"xai -> xai-oauth",
		]);
		expect(duplicates(nonTwin.map(d => d.modelsDevKey))).toEqual([]);
	});

	it("maps no two descriptors into the same veyyon provider", () => {
		expect(duplicates(MODELS_DEV_PROVIDER_DESCRIPTORS.map(d => d.providerId))).toEqual([]);
	});

	it("lands every descriptor's providerId as a section in the bundled catalog", () => {
		const sections: Record<string, true> = {};
		for (const key of Object.keys(MODELS)) sections[key] = true;
		const offenders = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(d => sections[d.providerId] !== true).map(
			d => `${d.modelsDevKey} -> ${d.providerId}`,
		);
		expect(offenders).toEqual([]);
	});
});

describe("the key map stamps rows with the mapped provider", () => {
	/**
	 * A probe model every descriptor's default filter accepts (`tool_call:
	 * true`). Descriptors with custom filter/transform/resolution hooks are
	 * pinned per-hook elsewhere (azure, vertex, coreweave, opencode, copilot);
	 * here they only have to honor the one universal rule: every row a
	 * descriptor emits carries ITS providerId.
	 */
	function probePayload(modelsDevKey: string): Record<string, unknown> {
		return {
			[modelsDevKey]: {
				models: {
					"probe-model": {
						name: "Probe",
						tool_call: true,
						reasoning: false,
						cost: { input: 1, output: 2 },
						limit: { context: 8192, output: 1024 },
						modalities: { input: ["text"] },
					},
				},
			},
		};
	}

	it("every row a descriptor emits is stamped with that descriptor's providerId", () => {
		const offenders = MODELS_DEV_PROVIDER_DESCRIPTORS.flatMap(desc =>
			mapModelsDevToModels(probePayload(desc.modelsDevKey), [desc])
				.filter(row => row.provider !== desc.providerId)
				.map(row => `${desc.modelsDevKey}: emitted provider=${row.provider}, expected ${desc.providerId}`),
		);
		expect(offenders).toEqual([]);
	});

	it("every hookless descriptor reads its own section: one probe in, one row out", () => {
		// If `modelsDevKey` stopped matching the key the mapper looks up, the
		// section reads as absent and the provider's whole catalog maps to
		// nothing — exactly what a copy-paste rename produces.
		const offenders = MODELS_DEV_PROVIDER_DESCRIPTORS.filter(
			desc => !(desc.filterModel || desc.transformModel || desc.resolveApi),
		).flatMap(desc => {
			const rows = mapModelsDevToModels(probePayload(desc.modelsDevKey), [desc]);
			if (rows.length !== 1 || rows[0]?.id !== "probe-model") {
				return [`${desc.modelsDevKey} -> ${desc.providerId}: probe yielded ${rows.length} rows`];
			}
			return [];
		});
		expect(offenders).toEqual([]);
	});

	it("renames the models.dev moonshotai section to the moonshot provider", () => {
		// The named instance of the copy-paste class: models.dev catalogs
		// Moonshot AI as `moonshotai`; veyyon's provider id is `moonshot`.
		const rows = mapModelsDevToModels(probePayload("moonshotai"), MODELS_DEV_PROVIDER_DESCRIPTORS);
		expect(rows.map(row => row.provider)).toEqual(["moonshot"]);
	});
});
