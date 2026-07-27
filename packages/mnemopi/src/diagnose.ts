import type { Database } from "bun:sqlite";
import { existsSync } from "node:fs";
import { dirname } from "node:path";
import { errorMessage } from "@veyyon/utils/type-guards";
import { dataDir as configuredDataDir, dbPath as configuredDbPath } from "./config";
import type { Env } from "./util/env";
// `initBeam` is declared in `core/beam/schema.ts`, which reaches one module. Reaching it through
// `core/beam` instead means importing the memory engine, 402 modules, to run a schema check.
import { initBeam } from "./core/beam/schema";
import { closeQuietly, openDatabase } from "./db";
import { toUtcIso } from "./util/datetime";
import { tableExists } from "./util/sqlite";

export interface DiagnosticEntry {
	readonly ts: string;
	readonly category: string;
	readonly check: string;
	readonly status: string;
	readonly detail?: string;
}

export interface DiagnosticSummary {
	readonly checks_total: number;
	readonly checks_passed: number;
	readonly checks_failed: number;
	readonly key_findings: string[];
	readonly entries: DiagnosticEntry[];
	readonly database: string;
}

export interface DiagnosticOptions {
	readonly db?: Database;
	readonly dbPath?: string;
	readonly dataDir?: string;
	readonly initialize?: boolean;
	readonly env?: Env;
}

type CountRow = { count: number };
type IntegrityRow = { integrity_check: string };
type ColumnRow = { name: string };

const REQUIRED_TABLES = [
	"working_memory",
	"episodic_memory",
	"scratchpad",
	"fts_working",
	"fts_episodes",
	"memoria_facts",
	"memoria_timelines",
	"memoria_kg",
	"memoria_instructions",
	"memoria_preferences",
	"consolidation_log",
	"annotations",
	"triples",
] as const;

const REQUIRED_COLUMNS: Readonly<Record<string, readonly string[]>> = {
	working_memory: ["id", "content", "source", "timestamp", "session_id", "importance"],
	episodic_memory: ["id", "content", "source", "timestamp", "session_id", "importance"],
	scratchpad: ["id", "content", "session_id"],
	triples: ["id", "subject", "predicate", "object"],
	annotations: ["id", "memory_id", "kind", "value"],
};

function tableColumns(db: Database, table: string): Set<string> {
	return new Set((db.query(`PRAGMA table_info(${table})`).all() as ColumnRow[]).map(row => row.name));
}

function safeCount(db: Database, table: string): number | null {
	if (!tableExists(db, table)) return null;
	return (db.query(`SELECT COUNT(*) AS count FROM ${table}`).get() as CountRow).count;
}

function safeEnv(env: Env, name: string): string {
	return env[name] ? "set" : "unset";
}

/**
 * The two knobs worth reporting even when they are unset, because "unset" is the answer an
 * operator is usually looking for: a database in an unexpected place and a vector encoding
 * that is not the one they configured are both explained by an absent variable.
 */
const ALWAYS_REPORTED = ["MNEMOPI_DATA_DIR", "MNEMOPI_VEC_TYPE"] as const;

/**
 * Names whose value is never printed, matched case-insensitively. `MNEMOPI_LLM_API_KEY` is
 * the credential that exists today, and the pattern is deliberately broader than that one
 * name so a credential added later is redacted by default rather than by someone
 * remembering to come back here.
 */
const SECRET_NAME_PATTERN = /KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i;

/**
 * Every `MNEMOPI_*` variable the operator has actually set, with its value.
 *
 * Enumerated from the environment rather than from a list of names, for two reasons. A
 * list here would be a second copy of every name `config.ts` already spells, and it would
 * report only the variables someone remembered to add: mnemopi reads around sixty and
 * `diagnose` reported two of them, so an operator debugging a knob that appeared to do
 * nothing had nowhere to look. Enumerating also surfaces a misspelled name, which is the
 * case that otherwise looks identical to a knob that does not work.
 */
function configuredEnvOverrides(env: Env): Array<readonly [name: string, value: string]> {
	const always = new Set<string>(ALWAYS_REPORTED);
	const found: Array<readonly [string, string]> = [];
	for (const name of Object.keys(env).sort()) {
		if (!name.startsWith("MNEMOPI_") || always.has(name)) continue;
		const value = env[name];
		if (value === undefined || value === "") continue;
		found.push([name, reportedValue(name, value)]);
	}
	return found;
}

/** The one place that decides whether a variable's value may be printed. */
function reportedValue(name: string, value: string | undefined): string {
	if (value === undefined || value === "") return "";
	return SECRET_NAME_PATTERN.test(name) ? "(redacted)" : value;
}

function passStatus(status: string): boolean {
	return status === "OK" || status === "YES" || status === "set" || status === "0";
}

function failStatus(status: string): boolean {
	return status === "MISSING" || status === "NO" || status === "ERROR" || status === "FAIL";
}

export function inspectDatabase(options: DiagnosticOptions = {}): DiagnosticSummary {
	const path = options.dbPath ?? configuredDbPath();
	const entries: DiagnosticEntry[] = [];
	const log = (category: string, check: string, status: string, detail = ""): void => {
		entries.push({ ts: toUtcIso(), category, check, status, detail });
	};

	log("env", "bun_version", Bun.version);
	log("env", "platform", `${process.platform}-${process.arch}`);
	const env = options.env ?? process.env;
	for (const name of ALWAYS_REPORTED) log("env", name, safeEnv(env, name), reportedValue(name, env[name]));
	for (const [name, value] of configuredEnvOverrides(env)) log("env", name, "set", value);
	log("db", "db_path", "OK", path);
	log("db", "data_dir", "OK", options.dataDir ?? configuredDataDir());
	log("db", "data_dir_parent", existsSync(dirname(path)) ? "OK" : "MISSING", dirname(path));

	let db = options.db;
	let owned = false;
	try {
		if (!db) {
			db = openDatabase(path);
			owned = true;
		}
		if (options.initialize !== false) initBeam(db);

		const integrity = db.query("PRAGMA integrity_check").get() as IntegrityRow;
		log("db", "integrity_check", integrity.integrity_check === "ok" ? "OK" : "FAIL", integrity.integrity_check);

		for (const table of REQUIRED_TABLES) {
			log("schema", `table:${table}`, tableExists(db, table) ? "OK" : "MISSING");
		}
		for (const table in REQUIRED_COLUMNS) {
			if (!tableExists(db, table)) continue;
			const columns = REQUIRED_COLUMNS[table];
			if (!columns) continue;
			const present = tableColumns(db, table);
			const missing = columns.filter(column => !present.has(column));
			log(
				"schema",
				`columns:${table}`,
				missing.length === 0 ? "OK" : "MISSING",
				missing.length === 0 ? `${present.size} columns` : `missing=${missing.join(",")}`,
			);
		}

		for (const table of ["working_memory", "episodic_memory", "scratchpad", "triples", "annotations"] as const) {
			const count = safeCount(db, table);
			log("db", `${table}_count`, count === null ? "MISSING" : String(count));
		}
	} catch (error) {
		log("db", "open_or_inspect", "ERROR", errorMessage(error));
	} finally {
		if (owned) closeQuietly(db);
	}

	const keyFindings: string[] = [];
	for (const entry of entries) {
		if (entry.status === "MISSING") keyFindings.push(`${entry.check} missing`);
		else if (entry.status === "FAIL" || entry.status === "ERROR") {
			keyFindings.push(`${entry.check}: ${entry.detail ?? entry.status}`);
		}
	}

	return {
		checks_total: entries.length,
		checks_passed: entries.filter(entry => passStatus(entry.status) || /^\d+$/.test(entry.status)).length,
		checks_failed: entries.filter(entry => failStatus(entry.status)).length,
		key_findings: keyFindings,
		entries,
		database: path,
	};
}

export function runDiagnostics(options: DiagnosticOptions = {}): DiagnosticSummary {
	return inspectDatabase(options);
}
if (import.meta.main) {
	const summary = runDiagnostics();
	console.log(JSON.stringify(summary, null, 2));
	process.exit(summary.checks_failed === 0 ? 0 : 1);
}
