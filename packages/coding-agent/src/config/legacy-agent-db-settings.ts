/**
 * The one reader of the `settings` table in `agent.db`.
 *
 * That table is where installs before config.yml kept their settings. Nothing
 * writes it any more, and only the migration in `Settings` reads it, exactly
 * once, on a run that finds no config.yml. `AgentStorage` used to expose it,
 * which is why `config/settings` imported the session storage layer, and why
 * every reader of a setting — including the launch card, which reads settings
 * before the runtime graph exists — evaluated `bun:sqlite` and the SQLite
 * credential store first.
 *
 * So the read lives here instead, in the layer that owns the migration, and
 * opens the file itself: read-only, no schema work, no statements kept alive.
 * A run whose config.yml exists never calls it and never touches the database.
 */

import { Database } from "bun:sqlite";
import * as fs from "node:fs";
import { getAgentDbPath } from "@veyyon/utils/dirs";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";

/** One row of the legacy `settings` table: a setting path and its JSON value. */
interface LegacySettingRow {
	key: string;
	value: string;
}

/**
 * Settings persisted by a pre-config.yml install, or null when there are none.
 *
 * Null covers every shape of "nothing to migrate": no database file, no
 * `settings` table, an empty table, or a file this process cannot read. A
 * malformed value is dropped with a warning rather than failing the migration,
 * because the alternative is a first run that cannot start.
 */
export function readLegacyAgentDbSettings(agentDir: string): Record<string, unknown> | null {
	const dbPath = getAgentDbPath(agentDir);
	if (!fs.existsSync(dbPath)) return null;

	let db: Database | undefined;
	try {
		db = new Database(dbPath, { readonly: true });
		const rows = db.prepare("SELECT key, value FROM settings").all() as LegacySettingRow[];
		if (rows.length === 0) return null;
		const settings: Record<string, unknown> = {};
		for (const row of rows) {
			try {
				settings[row.key] = JSON.parse(row.value) as unknown;
			} catch (error) {
				logger.warn("Settings: legacy agent.db value is not JSON, dropping it", {
					key: row.key,
					error: errorMessage(error),
				});
			}
		}
		return settings;
	} catch (error) {
		// A table that was never created reads as an error here, and so does a
		// database another process holds. Both mean the same thing to a
		// migration: this install has no legacy settings to carry forward.
		logger.debug("Settings: no legacy settings readable from agent.db", {
			path: dbPath,
			error: errorMessage(error),
		});
		return null;
	} finally {
		db?.close();
	}
}
