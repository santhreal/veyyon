import { createHash } from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import { atomicWriteFileSync, errorMessage, getModelDbPath, logger } from "@veyyon/utils";
import type { EnrichedRegistrySnapshotStore } from "./models";
import type { Api, Model } from "./types";
import { isRecord } from "./utils";

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
