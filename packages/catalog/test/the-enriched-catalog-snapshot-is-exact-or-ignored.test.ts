/**
 * The enriched-catalog snapshot (`bundled-models.json`) stores RESOLVED model
 * records, so its failure modes are silent wrongness rather than crashes: a
 * stale snapshot serves capabilities the previous buildModel produced, and a
 * corrupt one serves whatever bytes survived. This suite closes that class at
 * the snapshot boundary:
 *
 *  - exactness: a round-trip reproduces every provider, id, insertion order
 *    and field of what the build path produced;
 *  - refusal: a mismatched fingerprint (catalog upgrade or format bump), a
 *    corrupt file, or a wrongly-shaped payload returns null so the caller
 *    rebuilds instead of serving the bad bytes.
 *
 * Not caught here: a buildModel change that keeps the same shape but changes
 * semantics without bumping ENRICHED_REGISTRY_FORMAT_VERSION. The version is
 * pinned by exact value below so an unrecorded change fails loudly here first.
 */
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { buildModel } from "../src/build";
// Relative imports, not `@veyyon/catalog/...`: the workspace `node_modules`
// link resolves to the primary checkout rather than to this worktree, so the
// package specifier would test someone else's source.
import { readEnrichedRegistrySnapshot, writeEnrichedRegistrySnapshot } from "../src/models";
import { getBundledModels, getBundledProviders } from "../src/models";
import type { Api, Model } from "../src/types";

/** Pinned so an unrecorded format change cannot silently reuse old snapshots. */
const FORMAT_VERSION_PREFIX = "v1:";

describe("the enriched catalog snapshot is exact or ignored", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-bundled-registry-snapshot-"));
		dbPath = path.join(tempDir, "models.db");
	});
	afterEach(() => {
		fs.rmSync(tempDir, { recursive: true, force: true });
	});

	function liveRegistry(): Map<string, Map<string, Model<Api>>> {
		const registry = new Map<string, Map<string, Model<Api>>>();
		for (const provider of getBundledProviders()) {
			const models = new Map<string, Model<Api>>();
			for (const model of getBundledModels(provider)) models.set(model.id, model);
			registry.set(provider, models);
		}
		return registry;
	}

	it("round-trips the full catalog exactly: every provider, id, order and field", () => {
		const registry = liveRegistry();
		writeEnrichedRegistrySnapshot(registry, `${FORMAT_VERSION_PREFIX}test`, dbPath);

		const restored = readEnrichedRegistrySnapshot(`${FORMAT_VERSION_PREFIX}test`, dbPath);
		expect(restored).not.toBeNull();
		expect(Array.from(restored!.keys())).toEqual(Array.from(registry.keys()));
		for (const [provider, models] of registry) {
			const restoredModels = restored!.get(provider);
			expect(Array.from(restoredModels!.keys())).toEqual(Array.from(models.keys()));
			for (const [id, model] of models) {
				expect(restoredModels!.get(id)).toEqual(model);
			}
		}
	});

	it("refuses a snapshot whose fingerprint names another catalog or format", () => {
		writeEnrichedRegistrySnapshot(liveRegistry(), `${FORMAT_VERSION_PREFIX}test`, dbPath);
		expect(readEnrichedRegistrySnapshot("v1:different", dbPath)).toBeNull();
	});

	it("refuses a corrupt file instead of serving partial records", () => {
		const snapshotPath = path.join(path.dirname(dbPath), "bundled-models.json");
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		fs.writeFileSync(
			snapshotPath,
			"{\"fingerprint\": \"v1:x\", \"registry\": {\"anthropic\": {\"claude-3\"",
		);
		expect(readEnrichedRegistrySnapshot("v1:x", dbPath)).toBeNull();
	});

	it("refuses a well-formed file whose registry entries are not records", () => {
		const snapshotPath = path.join(path.dirname(dbPath), "bundled-models.json");
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		fs.writeFileSync(
			snapshotPath,
			JSON.stringify({ fingerprint: `${FORMAT_VERSION_PREFIX}x`, registry: { anthropic: "not-a-record" } }),
		);
		expect(readEnrichedRegistrySnapshot(`${FORMAT_VERSION_PREFIX}x`, dbPath)).toBeNull();
	});

	it("serves records indistinguishable from what buildModel produces for the same spec", () => {
		const spec = {
			id: "snapshot-fidelity-check",
			name: "Snapshot Fidelity Check",
			provider: "anthropic",
			api: "anthropic-messages" as const,
			baseUrl: "https://api.anthropic.com",
			reasoning: true,
			input: ["text"],
			cost: { input: 1, output: 2, cacheRead: 0, cacheWrite: 0 },
			contextWindow: 200_000,
			maxTokens: 8_192,
		};
		const built = buildModel(spec as never) as Model<"anthropic-messages">;
		const registry = new Map([["anthropic", new Map([[built.id, built]])]]);
		writeEnrichedRegistrySnapshot(registry, `${FORMAT_VERSION_PREFIX}fidelity`, dbPath);
		const restored = readEnrichedRegistrySnapshot(`${FORMAT_VERSION_PREFIX}fidelity`, dbPath);
		expect(restored?.get("anthropic")?.get(built.id)).toEqual(built);
	});
});
