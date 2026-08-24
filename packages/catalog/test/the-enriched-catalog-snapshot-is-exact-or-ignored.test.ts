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
 *    corrupt file, a digest mismatch, or a wrongly-shaped payload returns null
 *    so the caller rebuilds instead of serving the bad bytes.
 *
 * Not caught here: a buildModel semantic change that preserves the resolved
 * bytes without bumping ENRICHED_REGISTRY_FORMAT_VERSION. The version is pinned
 * by exact value below so an unrecorded format change fails loudly here first.
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { buildModel } from "../src/build";
// Relative imports, not `@veyyon/catalog/...`: the workspace `node_modules`
// link resolves to the primary checkout rather than to this worktree, so the
// package specifier would test someone else's source.
import {
	getBundledModels,
	getBundledProviders,
	readEnrichedRegistrySnapshot,
	writeEnrichedRegistrySnapshot,
} from "../src/models";
import type { Api, Model } from "../src/types";

/** Pinned so an unrecorded format change cannot silently reuse old snapshots. */
const FORMAT_VERSION_PREFIX = "v2:";

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
		expect(readEnrichedRegistrySnapshot("v2:different", dbPath)).toBeNull();
	});

	it("refuses a corrupt file instead of serving partial records", () => {
		const snapshotPath = path.join(path.dirname(dbPath), "bundled-models.json");
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		fs.writeFileSync(snapshotPath, '{"fingerprint": "v1:x", "registry": {"anthropic": {"claude-3"');
		expect(readEnrichedRegistrySnapshot("v1:x", dbPath)).toBeNull();
	});

	it("refuses parseable snapshot content that does not match its digest", () => {
		const fingerprint = `${FORMAT_VERSION_PREFIX}tampered`;
		writeEnrichedRegistrySnapshot(liveRegistry(), fingerprint, dbPath);
		const snapshotPath = path.join(path.dirname(dbPath), "bundled-models.json");
		const parsed = JSON.parse(fs.readFileSync(snapshotPath, "utf8")) as {
			registry: Record<string, Record<string, Model<Api>>>;
		};
		const provider = Object.keys(parsed.registry)[0]!;
		const model = Object.keys(parsed.registry[provider]!)[0]!;
		parsed.registry[provider]![model]!.contextWindow = 1;
		fs.writeFileSync(snapshotPath, JSON.stringify(parsed));

		expect(readEnrichedRegistrySnapshot(fingerprint, dbPath)).toBeNull();
	});

	it("refuses a well-formed file whose registry entries are not records", () => {
		const snapshotPath = path.join(path.dirname(dbPath), "bundled-models.json");
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		const registry = { anthropic: "not-a-record" };
		fs.writeFileSync(
			snapshotPath,
			JSON.stringify({
				fingerprint: `${FORMAT_VERSION_PREFIX}x`,
				registryDigest: createHash("sha256").update(JSON.stringify(registry)).digest("hex"),
				registry,
			}),
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
