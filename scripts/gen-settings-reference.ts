#!/usr/bin/env bun
// Generates docs/settings-reference.md from SETTINGS_SCHEMA.
//
// Why generated: 201 of the 313 settings that a user can see and change in
// `/settings` had no documentation anywhere, because the reference table in
// docs/settings.md is written by hand and nothing failed when a new setting
// shipped undocumented. A hand-written table of 313 rows would drift the week
// after it was backfilled, so the complete reference has ONE owner — the schema
// — and this script renders it. docs/settings.md keeps the curated narrative
// (precedence, merge rules, worked examples) and links here for the full list.
//
// Run `bun scripts/gen-settings-reference.ts --write` after changing any `ui`
// block. `scripts/gen-settings-reference.test.ts` fails when the committed file
// no longer matches this generator, so the doc cannot go stale silently.

import * as fs from "node:fs";
import * as path from "node:path";
import {
	getDefault,
	getEnumValues,
	getPathsForTab,
	getType,
	getUi,
	hasUi,
	retiredBy,
	SETTING_TABS,
	SETTINGS_SCHEMA,
	type SettingPath,
	TAB_GROUPS,
	TAB_METADATA,
} from "../packages/coding-agent/src/config/settings-schema";

export const REFERENCE_DOC_PATH = "docs/settings-reference.md";

/** The header every `/settings` table carries; the row parser keys off its first cell. */
export const UI_TABLE_HEADER = "| Key | Setting | Type | Default | What it does |";

/** The header of the one table for keys that exist only in `config.yml`. */
export const CONFIG_TABLE_HEADER = "| Key | Type | Default | Notes |";

/** A default rendered as the reader will type it into `config.yml`. */
export function formatDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined || value === null) return "_(unset)_";
	if (typeof value === "boolean") return `\`${value}\``;
	if (typeof value === "number") return `\`${value}\``;
	if (typeof value === "string") return value === "" ? "_(empty)_" : `\`${value}\``;
	if (Array.isArray(value)) return value.length === 0 ? "`[]`" : `\`${JSON.stringify(value)}\``;
	const keys = Object.keys(value as Record<string, unknown>);
	return keys.length === 0 ? "`{}`" : `\`${JSON.stringify(value)}\``;
}

/** Escape the cell separator so a description with a pipe cannot break the table. */
function cell(text: string): string {
	return text.replaceAll("|", "\\|").replaceAll("\n", " ").trim();
}

function describe(pathId: SettingPath): string {
	const ui = getUi(pathId);
	if (!ui) return "";
	// Schema descriptions are written as sentences but not all end in one, and the
	// clauses below are appended as sentences, so terminate it first.
	const description = /[.!?]$/.test(ui.description.trim()) ? ui.description.trim() : `${ui.description.trim()}.`;
	const parts = [description];
	const values = getType(pathId) === "enum" ? getEnumValues(pathId) : undefined;
	if (values && values.length > 0) parts.push(`Values: ${values.map(v => `\`${v}\``).join(", ")}.`);
	const replacement = retiredBy(pathId);
	if (replacement) parts.push(`Retired: use \`${replacement}\` instead.`);
	if (ui.scope === "global") parts.push("Stored machine-wide, not per profile.");
	if (ui.advanced) parts.push("Shown under the tab's Advanced fold.");
	return cell(parts.join(" "));
}

interface Row {
	path: SettingPath;
	label: string;
	type: string;
	default: string;
	notes: string;
}

function rowsForGroup(paths: SettingPath[], group: string | undefined): Row[] {
	return paths
		.filter(p => (getUi(p)?.group ?? undefined) === group)
		.map(p => ({
			path: p,
			label: getUi(p)?.label ?? p,
			type: getType(p),
			default: formatDefault(p),
			notes: describe(p),
		}));
}

function renderTable(rows: Row[]): string[] {
	const lines = [UI_TABLE_HEADER, "|---|---|---|---|---|"];
	for (const row of rows) {
		lines.push(`| \`${row.path}\` | ${cell(row.label)} | ${row.type} | ${row.default} | ${row.notes} |`);
	}
	return lines;
}

/**
 * Keys the schema declares with no `ui` block, so `/settings` never shows them.
 *
 * They are still settable in `config.yml` and through `veyyon config set`, and
 * something in production reads every one of them, so leaving them off this page
 * made 118 real keys invisible: an operator could not find them and nothing went
 * red when a new one shipped. That is the mirror image of the omission this
 * generator was written for.
 */
export function configOnlyPaths(): SettingPath[] {
	return (Object.keys(SETTINGS_SCHEMA) as SettingPath[]).filter(p => !hasUi(p)).sort();
}

function renderConfigOnlyTable(paths: SettingPath[]): string[] {
	const lines = [CONFIG_TABLE_HEADER, "|---|---|---|---|"];
	for (const settingPath of paths) {
		const replacement = retiredBy(settingPath);
		const values = getType(settingPath) === "enum" ? getEnumValues(settingPath) : undefined;
		const notes = [
			values && values.length > 0 ? `Values: ${values.map(v => `\`${v}\``).join(", ")}.` : "",
			replacement ? `Retired: use \`${replacement}\` instead.` : "",
		]
			.filter(part => part.length > 0)
			.join(" ");
		lines.push(`| \`${settingPath}\` | ${getType(settingPath)} | ${formatDefault(settingPath)} | ${cell(notes)} |`);
	}
	return lines;
}

/** The whole document, deterministic in the schema alone. */
export function renderReference(): string {
	const lines = [
		"# Settings reference",
		"",
		"Every setting the schema declares: the ones `/settings` shows, grouped as that screen groups them, then the ones that exist only in a configuration file.",
		"",
		"This page is generated by `scripts/gen-settings-reference.ts`. Edit the `ui` block on the setting in `packages/coding-agent/src/config/settings-domains/`, then run `bun scripts/gen-settings-reference.ts --write`. Do not edit this file by hand: a test compares it against the generator and fails when the two disagree.",
		"",
		"Read [Settings](./settings.md) first for where settings live, how precedence and merging work, and how to read and write them. The tables here are grouped exactly as the `/settings` tabs are, so a row you find in the UI is the row you find here.",
		"",
		"Set any of these keys in `config.yml` with the dotted path shown in the first column, or from the command line:",
		"",
		"```bash",
		"veyyon config set tui.tight true",
		"veyyon config get compaction.threshold",
		"```",
		"",
	];

	let total = 0;
	for (const tab of SETTING_TABS) {
		const paths = getPathsForTab(tab);
		if (paths.length === 0) continue;
		lines.push(`## ${TAB_METADATA[tab].label}`, "");
		const ungrouped = rowsForGroup(paths, undefined);
		if (ungrouped.length > 0) {
			lines.push(...renderTable(ungrouped), "");
			total += ungrouped.length;
		}
		for (const group of TAB_GROUPS[tab]) {
			const rows = rowsForGroup(paths, group);
			if (rows.length === 0) continue;
			lines.push(`### ${group}`, "", ...renderTable(rows), "");
			total += rows.length;
		}
	}

	// A setting whose `ui.group` is not listed in TAB_GROUPS belongs to no section
	// the loop above visits, so it would be dropped from the page while every count
	// still looked right. Refuse rather than ship a reference that quietly omits a
	// row an operator can see in `/settings`.
	const rendered = schemaUiPaths().length;
	if (total !== rendered) {
		const documented = documentedPaths(lines.join("\n"));
		const dropped = schemaUiPaths().filter(p => !documented.has(p));
		throw new Error(
			`settings reference would omit ${dropped.length} setting(s): ${dropped.join(", ")}. ` +
				`Each one declares a ui.group that is not listed in TAB_GROUPS for its tab; ` +
				`add the group to TAB_GROUPS in settings-schema.ts, or correct the group name on the setting.`,
		);
	}

	const configOnly = configOnlyPaths();
	lines.push(
		"## Configuration file only",
		"",
		"These keys are not in `/settings`. Some are state veyyon writes for itself (a schema version, an onboarding marker), some are credentials that belong in a secret store rather than on a settings screen, and the rest are shapes a selector cannot edit, such as a table of patterns. All of them are read by production code, all of them are valid in `config.yml`, and all of them can be set with `veyyon config set`.",
		"",
		...renderConfigOnlyTable(configOnly),
		"",
	);

	// The two sections partition the schema: a key with a `ui` block is on a tab,
	// a key without one is below, and nothing is in both or in neither. Stated as
	// an assertion because the point of this page is that a new key cannot be
	// invisible, and a partition that silently loses a key would restore exactly
	// that.
	const documentedAll = documentedPaths(lines.join("\n"));
	const schemaPaths = Object.keys(SETTINGS_SCHEMA) as SettingPath[];
	const missing = schemaPaths.filter(p => !documentedAll.has(p));
	if (missing.length > 0) {
		throw new Error(`settings reference would omit ${missing.length} schema key(s): ${missing.join(", ")}.`);
	}

	lines.push(
		`${total} settings in /settings, ${configOnly.length} configuration-file keys, ${total + configOnly.length} in all.`,
		"",
	);
	return lines.join("\n");
}

/** Every documented path, for the coverage assertion in the test. */
export function documentedPaths(markdown: string): Set<string> {
	const paths = new Set<string>();
	for (const line of markdown.split("\n")) {
		const match = line.match(/^\| `([^`]+)` \|/);
		if (match) paths.add(match[1]);
	}
	return paths;
}

export function schemaUiPaths(): SettingPath[] {
	return SETTING_TABS.flatMap(tab => getPathsForTab(tab));
}

if (import.meta.main) {
	const root = path.resolve(import.meta.dirname, "..");
	const target = path.join(root, REFERENCE_DOC_PATH);
	const rendered = renderReference();
	if (process.argv.includes("--write")) {
		fs.writeFileSync(target, rendered);
		console.log(
			`wrote ${REFERENCE_DOC_PATH} (${schemaUiPaths().length} in /settings, ${configOnlyPaths().length} config-file only)`,
		);
	} else {
		const current = fs.existsSync(target) ? fs.readFileSync(target, "utf-8") : "";
		if (current === rendered) {
			console.log(`${REFERENCE_DOC_PATH} is up to date`);
		} else {
			console.error(`${REFERENCE_DOC_PATH} is stale; run: bun scripts/gen-settings-reference.ts --write`);
			process.exit(1);
		}
	}
}
