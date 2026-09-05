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
import * as child_process from "node:child_process";
import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { writeJsonSnapshotSync } from "@veyyon/utils/json-snapshot";
import { buildModel } from "../src/build";
// Relative imports, not `@veyyon/catalog/...`: the workspace `node_modules`
// link resolves to the primary checkout rather than to this worktree, so the
// package specifier would test someone else's source.
import {
	enrichedRegistryFingerprint,
	getBundledModels,
	getBundledProviders,
	setEnrichedRegistrySnapshotStore,
} from "../src/models";
import { createEnrichedRegistrySnapshotStore } from "../src/registry-snapshot";
import type { Api, Model } from "../src/types";

/** Pinned so an unrecorded format change cannot silently reuse old snapshots. */
const FORMAT_VERSION_PREFIX = "v4:";

function writeEnrichedRegistrySnapshot(
	registry: Map<string, Map<string, Model<Api>>>,
	fingerprint: string,
	dbPath: string,
): void {
	createEnrichedRegistrySnapshotStore(dbPath).write(registry, fingerprint);
}

function readEnrichedRegistrySnapshot(
	fingerprint: string,
	dbPath: string,
): Map<string, Map<string, Model<Api>>> | null {
	return createEnrichedRegistrySnapshotStore(dbPath).read(fingerprint);
}

describe("the enriched catalog snapshot is exact or ignored", () => {
	let tempDir = "";
	let dbPath = "";

	beforeEach(() => {
		tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "pi-catalog-bundled-registry-snapshot-"));
		dbPath = path.join(tempDir, "models.db");
	});
	afterEach(() => {
		setEnrichedRegistrySnapshotStore(undefined);
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
		expect(readEnrichedRegistrySnapshot(`${FORMAT_VERSION_PREFIX}different`, dbPath)).toBeNull();
	});

	it("rejects the previous resolved format even when catalog bytes are unchanged", () => {
		const current = enrichedRegistryFingerprint();
		writeEnrichedRegistrySnapshot(liveRegistry(), current.replace(/^v4:/, "v3:"), dbPath);
		expect(readEnrichedRegistrySnapshot(current, dbPath)).toBeNull();
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
		const bytes = fs.readFileSync(snapshotPath, "utf8");
		const split = bytes.indexOf("\n");
		const registry = JSON.parse(bytes.slice(split + 1)) as Record<string, Record<string, Model<Api>>>;
		const provider = Object.keys(registry)[0]!;
		const model = Object.keys(registry[provider]!)[0]!;
		registry[provider]![model]!.contextWindow = 1;
		fs.writeFileSync(snapshotPath, `${bytes.slice(0, split)}\n${JSON.stringify(registry)}`);

		expect(readEnrichedRegistrySnapshot(fingerprint, dbPath)).toBeNull();
	});

	it("refuses a well-formed file whose registry entries are not records", () => {
		const snapshotPath = path.join(path.dirname(dbPath), "bundled-models.json");
		fs.mkdirSync(path.dirname(snapshotPath), { recursive: true });
		const registry = { anthropic: "not-a-record" };
		writeJsonSnapshotSync(snapshotPath, `${FORMAT_VERSION_PREFIX}x`, registry);
		expect(readEnrichedRegistrySnapshot(`${FORMAT_VERSION_PREFIX}x`, dbPath)).toBeNull();
	});

	it("rejects the retired v2 object envelope with a valid old digest", () => {
		const registry = { example: {} };
		fs.writeFileSync(
			path.join(path.dirname(dbPath), "bundled-models.json"),
			JSON.stringify({
				fingerprint: "v2:test",
				registryDigest: createHash("sha256").update(JSON.stringify(registry)).digest("hex"),
				registry,
			}),
		);
		expect(readEnrichedRegistrySnapshot("v2:test", dbPath)).toBeNull();
		expect(readEnrichedRegistrySnapshot(`${FORMAT_VERSION_PREFIX}test`, dbPath)).toBeNull();
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

	it("stamps every snapshot with the recorded format version", () => {
		// The prefix the refusal cases above rely on is the one the product writes,
		// so a format bump that skips the version fails here rather than serving
		// records built under retired rules.
		expect(enrichedRegistryFingerprint().startsWith(FORMAT_VERSION_PREFIX)).toBe(true);
	});

	it("restores catalog models from an existing disk snapshot in a cold process", () => {
		const registry = liveRegistry();
		const fingerprint = enrichedRegistryFingerprint();
		writeEnrichedRegistrySnapshot(registry, fingerprint, dbPath);
		const snapshotPath = path.join(tempDir, "bundled-models.json");
		expect(fs.existsSync(snapshotPath)).toBe(true);

		const script = `
			import * as path from "node:path";
			import { setEnrichedRegistrySnapshotStore, getBundledModel, getBundledProviders } from "./src/models";
			import { createEnrichedRegistrySnapshotStore } from "./src/registry-snapshot";

			const dbPath = process.argv[1];
			const store = createEnrichedRegistrySnapshotStore(dbPath);
			setEnrichedRegistrySnapshotStore(store);

			const model = getBundledModel("anthropic", "claude-3-5-sonnet-20241022");
			const providers = getBundledProviders();

			process.stdout.write(JSON.stringify({
				modelId: model?.id,
				provider: model?.provider,
				contextWindow: model?.contextWindow,
				hasAnthropic: providers.includes("anthropic"),
				hasOpenai: providers.includes("openai"),
			}));
		`;

		const stdout = child_process.execFileSync(process.execPath, ["-e", script, dbPath], {
			cwd: path.resolve(__dirname, ".."),
			encoding: "utf8",
		});

		const result = JSON.parse(stdout);
		expect(result).toEqual({
			modelId: "claude-3-5-sonnet-20241022",
			provider: "anthropic",
			contextWindow: 200000,
			hasAnthropic: true,
			hasOpenai: true,
		});
	});

	it("rejects a stale snapshot in a cold process, rebuilds fresh models, and rewrites snapshot", () => {
		const snapshotPath = path.join(tempDir, "bundled-models.json");
		fs.writeFileSync(
			snapshotPath,
			JSON.stringify({
				fingerprint: "v3:stale",
				registry: {},
			}),
		);

		const script = `
			import * as path from "node:path";
			import { setEnrichedRegistrySnapshotStore, getBundledModel, enrichedRegistryFingerprint } from "./src/models";
			import { createEnrichedRegistrySnapshotStore } from "./src/registry-snapshot";

			const dbPath = process.argv[1];
			const store = createEnrichedRegistrySnapshotStore(dbPath);
			setEnrichedRegistrySnapshotStore(store);

			const model = getBundledModel("anthropic", "claude-3-5-sonnet-20241022");

			process.stdout.write(JSON.stringify({
				modelId: model?.id,
				provider: model?.provider,
				contextWindow: model?.contextWindow,
			}));
		`;

		const stdout = child_process.execFileSync(process.execPath, ["-e", script, dbPath], {
			cwd: path.resolve(__dirname, ".."),
			encoding: "utf8",
		});

		const result = JSON.parse(stdout);
		expect(result).toEqual({
			modelId: "claude-3-5-sonnet-20241022",
			provider: "anthropic",
			contextWindow: 200000,
		});

		const restoredFresh = readEnrichedRegistrySnapshot(enrichedRegistryFingerprint(), dbPath);
		expect(restoredFresh).not.toBeNull();
		expect(restoredFresh?.get("anthropic")?.get("claude-3-5-sonnet-20241022")?.id).toBe("claude-3-5-sonnet-20241022");
	});

	it("preserves reference identity of pre-materialized provider maps when snapshot store is installed", () => {
		const registry = liveRegistry();
		const fingerprint = enrichedRegistryFingerprint();
		writeEnrichedRegistrySnapshot(registry, fingerprint, dbPath);

		const script = `
			import * as path from "node:path";
			import { setEnrichedRegistrySnapshotStore, getBundledModel, getBundledModels } from "./src/models";
			import { createEnrichedRegistrySnapshotStore } from "./src/registry-snapshot";
			const dbPath = process.argv[1];

			// 1. In on-demand mode (before store installation), materialize anthropic
			const preAnthropic = getBundledModel("anthropic", "claude-3-5-sonnet-20241022");

			// 2. Install snapshot store that restores
			const store = createEnrichedRegistrySnapshotStore(dbPath);
			setEnrichedRegistrySnapshotStore(store);

			// 3. Post-install lookup of anthropic must preserve the exact object reference
			const postAnthropic = getBundledModel("anthropic", "claude-3-5-sonnet-20241022");
			const isSameReference = postAnthropic === preAnthropic;

			// 4. Lookup of another provider (openai) restores from snapshot
			const openaiModel = getBundledModel("openai", "gpt-4o");

			process.stdout.write(JSON.stringify({
				isSameReference,
				preId: preAnthropic.id,
				postId: postAnthropic.id,
				openaiId: openaiModel.id,
				openaiContext: openaiModel.contextWindow,
			}));
		`;

		const stdout = child_process.execFileSync(process.execPath, ["-e", script, dbPath], {
			cwd: path.resolve(__dirname, ".."),
			encoding: "utf8",
		});

		const result = JSON.parse(stdout);
		expect(result).toEqual({
			isSameReference: true,
			preId: "claude-3-5-sonnet-20241022",
			postId: "claude-3-5-sonnet-20241022",
			openaiId: "gpt-4o",
			openaiContext: 128000,
		});
	});
});
