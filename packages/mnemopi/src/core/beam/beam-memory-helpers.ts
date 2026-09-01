import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { ftsWeight, importanceWeight, maxEpisodeChars, proactiveLinkingEnabled, vectorWeight } from "../../config";
import { hasPendingMigration, migrate as migrateTriplestoreSplit } from "../migrations/e6-triplestore-split";
import type { BeamConfig, BeamMemoryOptions } from "./types";

export const DEFAULT_CONFIG: BeamConfig = {
	workingMemoryLimit: 1000,
	workingMemoryTtlHours: 24,
	recencyHalflifeHours: 72,
	vecWeight: 0.5,
	ftsWeight: 0.3,
	importanceWeight: 0.2,
	useCloud: false,
	localLlmEnabled: false,
	maxEpisodeChars: 100_000,
	proactiveLinking: false,
};

export function normalizeConfig(options: BeamMemoryOptions): BeamConfig {
	const configured = options.config ?? {};
	const useCloud = options.useCloud ?? configured.useCloud ?? DEFAULT_CONFIG.useCloud;
	const proactiveLinking = options.proactiveLinking ?? configured.proactiveLinking ?? proactiveLinkingEnabled({});
	return {
		workingMemoryLimit: configured.workingMemoryLimit ?? DEFAULT_CONFIG.workingMemoryLimit,
		workingMemoryTtlHours: configured.workingMemoryTtlHours ?? DEFAULT_CONFIG.workingMemoryTtlHours,
		recencyHalflifeHours: configured.recencyHalflifeHours ?? DEFAULT_CONFIG.recencyHalflifeHours,
		vecWeight: configured.vecWeight ?? vectorWeight(),
		ftsWeight: configured.ftsWeight ?? ftsWeight(),
		importanceWeight: configured.importanceWeight ?? importanceWeight(),
		useCloud,
		localLlmEnabled: configured.localLlmEnabled ?? DEFAULT_CONFIG.localLlmEnabled,
		maxEpisodeChars: configured.maxEpisodeChars ?? maxEpisodeChars(),
		proactiveLinking,
	};
}
export function autoMigrateAnnotations(db: Database, dbPath: string | undefined): void {
	if (dbPath === undefined || dbPath === ":memory:" || !existsSync(dbPath)) return;
	if (!hasPendingMigration(db)) return;
	if (process.env.MNEMOPI_AUTO_MIGRATE === "0") {
		const row = db
			.query(
				"SELECT COUNT(*) AS count FROM triples WHERE predicate IN ('mentions', 'fact', 'occurred_on', 'has_source')",
			)
			.get() as { count: number };
		console.warn(
			`MNEMOPI_AUTO_MIGRATE=0: ${row.count} annotation rows pending; run scripts/migrate_triplestore_split.py manually.`,
		);
		return;
	}
	migrateTriplestoreSplit({ dbPath, dryRun: false, backup: true, logFn: () => {} });
}
