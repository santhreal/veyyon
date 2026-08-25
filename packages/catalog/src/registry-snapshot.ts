import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync, errorMessage, getModelDbPath, logger } from "@veyyon/utils";
import type { EnrichedRegistrySnapshotStore } from "./models";
import type { Api, Model } from "./types";
import { isRecord } from "./utils";

/**
 * On-disk store for the enriched bundled registry, kept out of `models.ts` so
 * the filesystem and the logger stay off every module graph that reads the
 * catalog. `models.ts` owns the format version through the fingerprint it
 * passes in; this module only proves that a payload is the one that fingerprint
 * produced.
 *
 * A miss is normal and costs a rebuild: the build path produces the same
 * records, so an absent, stale, altered or unreadable snapshot is discarded
 * rather than repaired.
 */
export function createEnrichedRegistrySnapshotStore(dbPath?: string): EnrichedRegistrySnapshotStore {
	const snapshotPath = path.join(path.dirname(dbPath ?? getModelDbPath()), "bundled-models.json");
	return {
		read(fingerprint) {
			try {
				const parsed: unknown = JSON.parse(fs.readFileSync(snapshotPath, "utf8"));
				if (
					!isRecord(parsed) ||
					parsed.fingerprint !== fingerprint ||
					typeof parsed.registryDigest !== "string" ||
					!isRecord(parsed.registry)
				) {
					return null;
				}
				// The fingerprint says which inputs produced the payload; the digest
				// says the payload is still what they produced. A plain JSON file
				// beside a database is editable by anything on the machine.
				const registryDigest = createHash("sha256").update(JSON.stringify(parsed.registry)).digest("hex");
				if (registryDigest !== parsed.registryDigest) return null;
				const registry = new Map<string, Map<string, Model<Api>>>();
				for (const [provider, models] of Object.entries(parsed.registry)) {
					if (!isRecord(models)) return null;
					registry.set(provider, new Map(Object.entries(models) as Array<[string, Model<Api>]>));
				}
				return registry;
			} catch {
				return null;
			}
		},
		write(registry, fingerprint) {
			try {
				const persistedRegistry = Object.fromEntries(
					Array.from(registry, ([provider, models]) => [provider, Object.fromEntries(models)]),
				);
				atomicWriteFileSync(
					snapshotPath,
					JSON.stringify({
						fingerprint,
						registryDigest: createHash("sha256").update(JSON.stringify(persistedRegistry)).digest("hex"),
						registry: persistedRegistry,
					}),
				);
			} catch (error) {
				logger.debug("Bundled model registry snapshot not written", { error: errorMessage(error) });
			}
		},
	};
}
