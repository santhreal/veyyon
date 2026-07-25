/**
 * The hand-written settings catalog in `docs/settings.md` agrees with the schema.
 *
 * There are two catalogs of the same keys. `docs/settings-reference.md` is
 * generated and cannot drift — a test regenerates it and compares bytes. But
 * `docs/settings.md` keeps a curated catalog of its own, roughly 160 rows of
 * `| key | type | default | notes |` wrapped in the narrative, YAML examples,
 * and cross-links that make the page worth reading. Those rows are typed by
 * hand and nothing checked them.
 *
 * They had drifted, and in the way that costs a reader the most — the default
 * column, which is the one fact you read a settings table for:
 *
 *   - `statusLine.separator` was documented as `powerline-thin`; the schema says
 *     `pipe`.
 *   - `statusLine.transparent` was documented as `false`; the schema says `true`,
 *     so the page described the opposite of what a fresh install does.
 *   - `personality` was documented as an `enum` of exactly four values, when it
 *     is a `string` precisely so you can add your own by dropping a file in
 *     `~/.veyyon/personalities/`. The table denied the feature the prose sells.
 *
 * The alternative fix was to delete the tables and point at the generated page.
 * That would have thrown away what the rows carry and the generated page does
 * not: launch flags, env overrides, and links between related settings. So the
 * prose stays and this suite removes the drift risk instead — every documented
 * key must exist, and its type and default must be the schema's.
 *
 * Scope note: only tables in the `## Settings catalog` section are checked, and
 * only rows whose first cell is a backticked key. The env-var and machine-global
 * tables elsewhere on the page have different columns and are not key rows.
 */
import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
	getDefault,
	getType,
	SETTINGS_SCHEMA,
	type SettingPath,
} from "../packages/coding-agent/src/config/settings-schema";

const REPO_ROOT = fileURLToPath(new URL("..", import.meta.url));
const DOC_PATH = "docs/settings.md";

interface DocumentedKey {
	readonly key: string;
	readonly type: string;
	readonly default: string;
	readonly line: number;
}

/** The `## Settings catalog` section, which is the only part that lists keys. */
function catalogSection(markdown: string): { text: string; startLine: number } {
	const lines = markdown.split("\n");
	const start = lines.findIndex(line => line.trim() === "## Settings catalog");
	if (start < 0) throw new Error("docs/settings.md no longer has a '## Settings catalog' section");
	let end = lines.length;
	for (let i = start + 1; i < lines.length; i++) {
		if (lines[i].startsWith("## ")) {
			end = i;
			break;
		}
	}
	return { text: lines.slice(start, end).join("\n"), startLine: start + 1 };
}

const cells = (row: string): string[] =>
	row
		.replace(/^\|/, "")
		.replace(/\|\s*$/, "")
		.split("|")
		.map(cell => cell.trim());

/**
 * Read the rows by their table's own HEADER.
 *
 * The catalog does not use one table shape, and not every table lists settings.
 * Most are `Key | Type | Default | Notes`; the machine-global one carries an
 * extra `Stored as` column because those settings are written under a nested
 * key; and several are `Value | Behavior` tables enumerating what one setting
 * accepts. A positional parser read the global table's second column as the
 * type, and a parser that kept the previous table's column map read the VALUE
 * rows of the enum tables as settings — both reported failures that were purely
 * its own mistake, and a parser that is wrong about which column is which
 * cannot be trusted about the ones it says are right.
 *
 * So the column map is rebuilt per table (state resets at the blank line that
 * ends one) and a table with no Type and Default columns contributes nothing.
 */
function documentedKeys(markdown: string): DocumentedKey[] {
	const { text, startLine } = catalogSection(markdown);
	const found: DocumentedKey[] = [];
	let typeAt = -1;
	let defaultAt = -1;
	let inTable = false;
	text.split("\n").forEach((line, offset) => {
		if (!line.startsWith("|")) {
			inTable = false;
			typeAt = -1;
			defaultAt = -1;
			return;
		}
		const columns = cells(line);
		if (!inTable) {
			// First row of this table: its header decides the column map.
			inTable = true;
			const header = columns.map(c => c.toLowerCase().replaceAll("`", ""));
			typeAt = header.indexOf("type");
			defaultAt = header.indexOf("default");
			return;
		}
		if (columns.every(c => /^-+$/.test(c))) return;
		const match = columns[0]?.match(/^`([^`]+)`$/);
		if (!match || typeAt < 0 || defaultAt < 0) return;
		found.push({
			key: match[1].trim(),
			type: columns[typeAt] ?? "",
			default: columns[defaultAt] ?? "",
			line: startLine + offset,
		});
	});
	return found;
}

/** Both pages write "unset" for an absent default; one wraps it in emphasis. */
function normalizeDefault(cell: string): string {
	const bare = cell.replaceAll("`", "").replaceAll("_", "").trim();
	if (bare === "(unset)" || bare === "unset") return "unset";
	// An empty-string default is written as `""` here and as `(empty)` by the
	// generator; they mean the same thing.
	if (bare === '""' || bare === "''" || bare === "") return "(empty)";
	return bare;
}

function schemaDefault(path: SettingPath): string {
	const value = getDefault(path);
	if (value === undefined || value === null) return "unset";
	if (typeof value === "object") return JSON.stringify(value);
	if (value === "") return "(empty)";
	return String(value);
}

const doc = readFileSync(join(REPO_ROOT, DOC_PATH), "utf8");
const keys = documentedKeys(doc);
const known = keys.filter(k => k.key in SETTINGS_SCHEMA);

describe("the settings catalog in docs/settings.md", () => {
	/** Guards every assertion below: an empty parse would make them all vacuous. */
	it("parses a substantial number of key rows", () => {
		expect(keys.length).toBeGreaterThan(100);
	});

	it("documents no key that has left the schema", () => {
		// A renamed or removed setting leaves a row behind that reads as current.
		const ghosts = keys.filter(k => !(k.key in SETTINGS_SCHEMA)).map(k => `${DOC_PATH}:${k.line} ${k.key}`);

		expect(ghosts).toEqual([]);
	});

	it("gives every key the schema's type", () => {
		// `personality` was called an enum. It is a string so you can add your own,
		// which is the whole point of the personalities directory.
		const wrong = known
			.filter(k => k.type.replaceAll("`", "").trim() !== getType(k.key as SettingPath))
			.map(k => `${DOC_PATH}:${k.line} ${k.key}: doc=${k.type} schema=${getType(k.key as SettingPath)}`);

		expect(wrong).toEqual([]);
	});

	it("gives every key the schema's default", () => {
		// The column a reader trusts most. Two were the opposite of the truth.
		const wrong = known
			.filter(k => normalizeDefault(k.default) !== schemaDefault(k.key as SettingPath))
			.map(
				k =>
					`${DOC_PATH}:${k.line} ${k.key}: doc=${normalizeDefault(k.default)} schema=${schemaDefault(k.key as SettingPath)}`,
			);

		expect(wrong).toEqual([]);
	});

	it("names each key only once", () => {
		// Two rows for one key is the same disease inside a single file: a reader
		// cannot tell which is current, and only one will ever be updated.
		const seen = new Map<string, number[]>();
		for (const k of keys) seen.set(k.key, [...(seen.get(k.key) ?? []), k.line]);
		const duplicated = [...seen].filter(([, lines]) => lines.length > 1).map(([key, lines]) => `${key} at ${lines}`);

		expect(duplicated).toEqual([]);
	});

	it("still points at the generated reference for the full set", () => {
		// This page is the curated subset. The link is how a reader finds the rest,
		// and losing it would leave the ~160 rows here looking like the whole story.
		expect(doc).toContain("settings-reference.md");
	});
});
