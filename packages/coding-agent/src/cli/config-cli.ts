/**
 * Config CLI command handlers.
 *
 * Handles `veyyon config <command>` subcommands for managing settings.
 * Uses the settings schema as the source of truth for available settings.
 */

import { APP_NAME, getAgentDir, isRecord, nearestNames } from "@veyyon/utils";
import chalk from "chalk";
import {
	getDefault,
	getEnumValues,
	getType,
	getUi,
	type SettingPath,
	Settings,
	type SettingValue,
	settings,
	validateProviderMaxInFlightRequests,
} from "../config/settings";
import { isSettingPath, retiredBy, SETTINGS_SCHEMA } from "../config/settings-schema";
import { theme } from "../modes/theme/theme";
import { initXdg } from "./commands/init-xdg";

// =============================================================================
// Types
// =============================================================================

export type ConfigAction = "list" | "get" | "set" | "reset" | "path" | "init-xdg";

export interface ConfigCommandArgs {
	action: ConfigAction;
	key?: string;
	value?: string;
	flags: {
		json?: boolean;
	};
}
// =============================================================================
// Setting Filtering
// =============================================================================

type CliSettingDef = {
	path: SettingPath;
	type: string;
	description: string;
	tab: string;
	/** The key that replaced this one, when it is superseded. See `retiredBy`. */
	retiredBy?: string;
};

const ALL_SETTING_PATHS = Object.keys(SETTINGS_SCHEMA) as SettingPath[];

/** Find setting definition by path */
function findSettingDef(path: string): CliSettingDef | undefined {
	if (!isSettingPath(path)) return undefined;
	const key = path;
	const ui = getUi(key);
	return {
		path: key,
		type: getType(key),
		description: ui?.description ?? "",
		tab: ui?.tab ?? "internal",
		retiredBy: retiredBy(key),
	};
}

/**
 * Setting paths a user probably meant when `key` matched nothing, best first.
 *
 * "Unknown setting" plus "run config list" is a poor answer when the schema has
 * hundreds of paths: the list is far too long to scan, and the usual cause is a
 * one-character slip or the wrong capitalization. Naming the near misses turns a
 * dead end into a fix the user can paste.
 *
 * Ranked by how likely the confusion is, not by string distance alone. A path
 * that differs only in case comes first, since that is a spelling of the same
 * intent. Then paths containing what was typed, which covers a remembered leaf
 * name with the wrong group ("autoUpdate" for "startup.autoUpdate"). Then close
 * edits, which covers a typo.
 */
export function suggestSettingPaths(key: string, limit = 3): string[] {
	return nearestNames(key, Object.keys(SETTINGS_SCHEMA), limit);
}

/**
 * Report a key that matches no setting, naming near misses when there are any.
 *
 * One owner for the message so `get`, `set`, and `reset` cannot drift into
 * helping by different rules.
 */
function reportUnknownSetting(key: string): void {
	console.error(chalk.red(`Unknown setting: ${key}`));
	const suggestions = suggestSettingPaths(key);
	if (suggestions.length > 0) {
		console.error(chalk.dim("\nDid you mean:"));
		for (const suggestion of suggestions) {
			console.error(chalk.dim(`  ${suggestion}`));
		}
	}
	console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
}

/** Get available values for a setting */
function getSettingValues(def: CliSettingDef): readonly string[] | undefined {
	if (def.type === "enum") {
		return getEnumValues(def.path);
	}
	return undefined;
}

/** Canonical action list; the `config` command's options validation imports this. */
export const CONFIG_ACTIONS: ConfigAction[] = ["list", "get", "set", "reset", "path", "init-xdg"];

// =============================================================================
// Value Formatting
// =============================================================================

function formatValue(value: unknown): string {
	if (value === undefined || value === null) {
		return chalk.dim("(not set)");
	}
	if (typeof value === "boolean") {
		return value ? chalk.green("true") : chalk.red("false");
	}
	if (typeof value === "number") {
		return chalk.cyan(String(value));
	}
	if (typeof value === "string") {
		return chalk.yellow(value);
	}
	if (Array.isArray(value) || typeof value === "object") {
		try {
			return chalk.yellow(JSON.stringify(value));
		} catch {
			return chalk.yellow(String(value));
		}
	}
	return chalk.yellow(String(value));
}

function getTypeDisplay(def: CliSettingDef): string {
	const values = getSettingValues(def);
	if (values && values.length > 0) {
		return `(${values.join("|")})`;
	}
	switch (def.type) {
		case "boolean":
			return "(boolean)";
		case "number":
			return "(number)";
		case "array":
			return "(array)";
		case "record":
			return "(record)";
		default:
			return "(string)";
	}
}

// =============================================================================
// Schema-Driven Value Parsing
// =============================================================================

function parseAndSetValue(path: SettingPath, rawValue: string): void {
	const schemaType = getType(path);
	let parsedValue: unknown;

	const trimmed = rawValue.trim();
	switch (schemaType) {
		case "boolean": {
			const lower = trimmed.toLowerCase();
			if (["true", "1", "yes", "on"].includes(lower)) parsedValue = true;
			else if (["false", "0", "no", "off"].includes(lower)) parsedValue = false;
			else throw new Error(`Invalid boolean value: ${rawValue}. Use true/false, yes/no, on/off, or 1/0`);
			break;
		}
		case "number":
			parsedValue = Number(trimmed);
			if (!Number.isFinite(parsedValue)) throw new Error(`Invalid number: ${rawValue}`);
			break;
		case "enum": {
			const valid = getEnumValues(path);
			if (valid && !valid.includes(trimmed)) {
				throw new Error(`Invalid value: ${rawValue}. Valid values: ${valid.join(", ")}`);
			}
			parsedValue = trimmed;
			break;
		}
		case "array": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			if (!Array.isArray(parsed)) {
				throw new Error(`Invalid array JSON: ${rawValue}`);
			}
			parsedValue = parsed;
			break;
		}
		case "record": {
			let parsed: unknown;
			try {
				parsed = JSON.parse(trimmed);
			} catch {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			if (!isRecord(parsed)) {
				throw new Error(`Invalid record JSON: ${rawValue}`);
			}
			if (path === "providers.maxInFlightRequests") {
				parsed = validateProviderMaxInFlightRequests(parsed);
			}
			parsedValue = parsed;
			break;
		}
		default:
			parsedValue = trimmed;
	}

	settings.set(path, parsedValue as SettingValue<typeof path>);
}

// =============================================================================
// Command Handlers
// =============================================================================

export async function runConfigCommand(cmd: ConfigCommandArgs): Promise<void> {
	await Settings.init();

	switch (cmd.action) {
		case "list":
			await handleList(cmd.flags);
			break;
		case "get":
			handleGet(cmd.key, cmd.flags);
			break;
		case "set":
			await handleSet(cmd.key, cmd.value, cmd.flags);
			break;
		case "reset":
			await handleReset(cmd.key, cmd.flags);
			break;
		case "path":
			handlePath();
			break;
		case "init-xdg":
			await initXdg();
			break;
	}
}

async function writeStdout(text: string): Promise<void> {
	const pending = Promise.withResolvers<void>();
	process.stdout.write(text, error => {
		if (error) {
			pending.reject(error);
			return;
		}
		pending.resolve();
	});
	await pending.promise;
}

async function handleList(flags: { json?: boolean }): Promise<void> {
	// A superseded key is still readable and settable, so an existing config keeps
	// working, but it is not something to CHOOSE — listing it beside the key that
	// replaced it is the confusion the supersession was meant to end. `config get`
	// on one still works and names the replacement.
	const defs = ALL_SETTING_PATHS.map(path => findSettingDef(path)).filter(
		(def): def is CliSettingDef => !!def && !def.retiredBy,
	);

	if (flags.json) {
		const result: Record<string, { value: unknown; type: string; description: string }> = {};
		for (const def of defs) {
			result[def.path] = {
				// `?? null` so unset settings still serialize a `value` key (JSON.stringify drops undefined).
				value: settings.get(def.path) ?? null,
				type: def.type,
				description: def.description,
			};
		}
		await writeStdout(`${JSON.stringify(result, null, 2)}\n`);
		return;
	}

	console.log(chalk.bold("Settings:\n"));

	const groups: Record<string, CliSettingDef[]> = {};
	for (const def of defs) {
		if (!groups[def.tab]) {
			groups[def.tab] = [];
		}
		groups[def.tab].push(def);
	}

	const sortedGroups = Object.keys(groups).sort((a, b) => {
		if (a === "config") return -1;
		if (b === "config") return 1;
		return a.localeCompare(b);
	});

	for (const group of sortedGroups) {
		console.log(chalk.bold.blue(`[${group}]`));
		for (const def of groups[group]) {
			const value = settings.get(def.path);
			const valueStr = formatValue(value);
			const typeStr = getTypeDisplay(def);
			console.log(`  ${chalk.white(def.path)} = ${valueStr} ${chalk.dim(typeStr)}`);
		}
		console.log("");
	}
}

function handleGet(key: string | undefined, flags: { json?: boolean }): void {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config get <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		reportUnknownSetting(key);
		process.exit(1);
	}

	const value = settings.get(def.path);

	if (flags.json) {
		console.log(
			JSON.stringify(
				{
					key: def.path,
					value: value ?? null,
					type: def.type,
					description: def.description,
					...(def.retiredBy ? { retiredBy: def.retiredBy } : {}),
				},
				null,
				2,
			),
		);
		return;
	}

	if (def.retiredBy) {
		console.error(chalk.yellow(`${def.path} is retired; use ${def.retiredBy} instead.`));
	}
	console.log(formatValue(value));
}

/**
 * Wait for the write and refuse to report success it did not achieve.
 *
 * `set` and `reset` used to print their green tick and exit 0 without ever waiting for the
 * debounced save, so a config path that could not be written (a read-only home, a full disk,
 * a directory left where `config.yml` belongs) produced a successful-looking command and a
 * setting that was never persisted. A script checking the exit status was told the change
 * landed. The first failure is the whole story here — a one-shot command has no retry future
 * the way a live session does — so it reports and exits non-zero (Law 10).
 */
async function persistOrExit(): Promise<void> {
	await settings.flush().catch(() => {});
	const failed = settings.lastSaveError;
	if (!failed) return;
	console.error(chalk.red(`Could not save ${failed.path}: ${failed.reason}`));
	console.error(chalk.dim("Check that the file and its directory are writable, then run the command again."));
	process.exit(1);
}

async function handleSet(key: string | undefined, value: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key || value === undefined) {
		console.error(chalk.red(`Usage: ${APP_NAME} config set <key> <value>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		reportUnknownSetting(key);
		process.exit(1);
	}

	try {
		parseAndSetValue(def.path, value);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(1);
	}

	await persistOrExit();
	const newValue = settings.get(def.path);

	if (flags.json) {
		console.log(
			JSON.stringify({ key: def.path, value: newValue, ...(def.retiredBy ? { retiredBy: def.retiredBy } : {}) }),
		);
	} else {
		console.log(chalk.green(`${theme.status.success} Set ${def.path} = ${formatValue(newValue)}`));
		if (def.retiredBy) {
			// Written, because refusing would break a script that predates the
			// supersession, but never silently: the value may be migrated away on the
			// next load, so say where it belongs now.
			console.error(chalk.yellow(`${def.path} is retired; ${def.retiredBy} is the setting that governs this now.`));
		}
	}
}

async function handleReset(key: string | undefined, flags: { json?: boolean }): Promise<void> {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config reset <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(1);
	}

	const def = findSettingDef(key);
	if (!def) {
		reportUnknownSetting(key);
		process.exit(1);
	}

	const path = def.path as SettingPath;
	// Reset REMOVES the key rather than writing the default back into the file.
	// Writing it made every reset value look explicitly configured — the config
	// then pins a default that was meant to follow the app, and a setting whose
	// default is "unset" (the sampling knobs, `compaction.modelContextWindow`)
	// would have had a materialized `undefined` written for it.
	settings.unset(path);
	await persistOrExit();
	const defaultValue = getDefault(path);

	if (flags.json) {
		console.log(JSON.stringify({ key: def.path, value: defaultValue ?? null }));
	} else {
		const shown = defaultValue === undefined ? "unset" : formatValue(defaultValue);
		console.log(chalk.green(`${theme.status.success} Reset ${def.path} to ${shown}`));
	}
}

function handlePath(): void {
	console.log(getAgentDir());
}

// =============================================================================
// Help
// =============================================================================
