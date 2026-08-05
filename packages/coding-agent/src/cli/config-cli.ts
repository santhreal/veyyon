/**
 * Config CLI command handlers.
 *
 * Handles `veyyon config <command>` subcommands for managing settings.
 * Uses the settings schema as the source of truth for available settings.
 */

import { APP_NAME, getAgentDir, isRecord, nearestNames } from "@veyyon/utils";
import { renderHelpParagraph, renderHelpTable } from "@veyyon/utils/cli";
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
import { EXIT_USAGE } from "./exit-codes";

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

/**
 * Widest opening value token that can still share its key's line in `config list`.
 *
 * `renderHelpTable` puts the first wrapped line of a value inline after the key, and nothing can
 * break a token with no space in it, so a value that OPENS with a long token drags that line past
 * the terminal edge even though the rest of it wraps. Anything wider gets its own block below the
 * key instead.
 *
 * THE NUMBER IS DERIVED, NOT CHOSEN, and it is coupled to the gutter fraction passed at the one
 * call site below. The narrowest terminal the layout lays out for is 60 columns, and the gutter
 * takes `maxGutterFraction` of it, so the value column is what remains: at one half that is 30.
 * The two must move together. They did not once already: the fraction went from a third to a half
 * while this still read 40, and `compaction.model = google-antigravity/gemini-3.6-flash:high` (a
 * 40-character unbreakable value) went back over the edge at 60 columns.
 */
const INLINE_VALUE_WIDTH = 30;

/**
 * Indent for a value printed below its key rather than beside it.
 *
 * Deeper than the two spaces a key sits at, so a continuation line can never be read as a new
 * setting: `config list` output is scanned and grepped for `key =` at exactly one indent.
 */
const VALUE_BLOCK_INDENT = "      ";

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
		case "modelChain":
			// Says what it accepts rather than what it stores: both spellings are
			// valid, and "(string)" told the reader the list form was not.
			return "(model chain: pattern, or comma-separated, or a list)";
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

	// ONE table for the whole listing, not one per group: `renderHelpTable` derives its
	// gutter from the rows it is handed, so a call per group would put the value column in a
	// different place in every section. Group headers and pre-rendered value blocks ride
	// along as rows with no description, which the helper emits verbatim.
	const rows: Array<readonly [string, string]> = [];
	for (const group of sortedGroups) {
		rows.push([chalk.bold.blue(`[${group}]`), ""]);
		for (const def of groups[group]) {
			const key = `  ${chalk.white(def.path)} =`;
			const detail = `${formatValue(settings.get(def.path))} ${chalk.dim(getTypeDisplay(def))}`;
			// A long value WRAPS onto indented continuation lines; it is never truncated.
			// `bashInterceptor.patterns` serializes to ~2.3kB of JSON, and an ellipsis there
			// would be the worst possible answer: `config list` is the command an operator runs
			// to read what a setting is ACTUALLY set to, so hiding the tail defeats the only
			// reason to run it, and a half-printed regex table reads like a corrupt one. The
			// cost is lines (that one setting spills over dozens) and that a wrapped value is
			// no longer one copy-pasteable string, which is what `--json` is for.
			const [firstToken = ""] = detail.split(" ");
			if (Bun.stringWidth(firstToken) <= INLINE_VALUE_WIDTH) {
				rows.push([key, detail]);
				continue;
			}
			// The value opens with a token too long to share the key's line, so it gets its own
			// indented block instead of being jammed into the description column.
			rows.push([key, ""]);
			for (const line of renderHelpParagraph(detail, { indent: VALUE_BLOCK_INDENT })) {
				rows.push([line, ""]);
			}
		}
		rows.push(["", ""]);
	}
	// `indent: ""` because the group headers are part of the table and belong at column 0;
	// the setting rows carry their own two-space indent.
	// Half the width, not the default third. The left column here is a dotted setting path, which
	// routinely runs past thirty characters, and at a third every such key pushed its value onto a
	// second line even when the value was `true`. That grew the listing by half again in lines
	// without making one of them easier to read.
	console.log(renderHelpTable(rows, { indent: "", maxGutterFraction: 1 / 2 }).join("\n"));
}

function handleGet(key: string | undefined, flags: { json?: boolean }): void {
	if (!key) {
		console.error(chalk.red(`Usage: ${APP_NAME} config get <key>`));
		console.error(chalk.dim(`\nRun '${APP_NAME} config list' to see available keys`));
		process.exit(EXIT_USAGE);
	}

	const def = findSettingDef(key);
	if (!def) {
		reportUnknownSetting(key);
		process.exit(EXIT_USAGE);
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
		process.exit(EXIT_USAGE);
	}

	const def = findSettingDef(key);
	if (!def) {
		reportUnknownSetting(key);
		process.exit(EXIT_USAGE);
	}

	try {
		parseAndSetValue(def.path, value);
	} catch (err) {
		console.error(chalk.red(String(err)));
		process.exit(EXIT_USAGE);
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
		process.exit(EXIT_USAGE);
	}

	const def = findSettingDef(key);
	if (!def) {
		reportUnknownSetting(key);
		process.exit(EXIT_USAGE);
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
