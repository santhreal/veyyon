import * as fs from "node:fs";
import * as path from "node:path";
import { isRecord } from "@veyyon/utils";

/**
 * Regression / contract corpus loader.
 *
 * Each case is a named product contract with exact expects. Cases live as JSON
 * under `test/corpus/**`. A case is invalid if it lacks id, contract, surface,
 * or expect — shape-only rows are rejected at load time so theater cannot enter
 * the corpus silently.
 */

export interface CorpusCase {
	/** Stable id (issue slug or short contract name). */
	id: string;
	/** One-sentence product contract this row locks. */
	contract: string;
	/** Dispatch key for the runner (e.g. list-limit, match-line-format). */
	surface: string;
	/** Optional tags for filtering (adversarial, regression, negative). */
	tags?: string[];
	/** Surface-specific input payload. */
	input: unknown;
	/** Surface-specific exact expectation. */
	expect: unknown;
}

export interface LoadedCorpus {
	file: string;
	cases: CorpusCase[];
}

function validateCase(raw: unknown, file: string, index: number): CorpusCase {
	if (!isRecord(raw)) {
		throw new Error(`${file}[${index}]: case must be an object`);
	}
	const id = raw.id;
	const contract = raw.contract;
	const surface = raw.surface;
	if (typeof id !== "string" || id.length === 0) {
		throw new Error(`${file}[${index}]: id must be a non-empty string`);
	}
	if (typeof contract !== "string" || contract.length < 12) {
		throw new Error(`${file}[${index}] (${id}): contract must be a real one-sentence product rule`);
	}
	if (typeof surface !== "string" || surface.length === 0) {
		throw new Error(`${file}[${index}] (${id}): surface is required`);
	}
	if (!("expect" in raw) || raw.expect === undefined) {
		throw new Error(`${file}[${index}] (${id}): expect is required (no shape-only rows)`);
	}
	if (!("input" in raw)) {
		throw new Error(`${file}[${index}] (${id}): input is required`);
	}
	const tags = raw.tags;
	if (tags !== undefined && (!Array.isArray(tags) || !tags.every(t => typeof t === "string"))) {
		throw new Error(`${file}[${index}] (${id}): tags must be string[] when present`);
	}
	return {
		id,
		contract,
		surface,
		tags: tags as string[] | undefined,
		input: raw.input,
		expect: raw.expect,
	};
}

/** Load a single JSON file: either `{ "cases": [...] }` or a bare array. */
export function loadCorpusFile(filePath: string): LoadedCorpus {
	const text = fs.readFileSync(filePath, "utf8");
	const parsed: unknown = JSON.parse(text);
	let rows: unknown[];
	if (Array.isArray(parsed)) {
		rows = parsed;
	} else if (isRecord(parsed) && Array.isArray(parsed.cases)) {
		rows = parsed.cases;
	} else {
		throw new Error(`${filePath}: root must be an array or { cases: [] }`);
	}
	if (rows.length === 0) {
		throw new Error(`${filePath}: corpus file must contain at least one case`);
	}
	const cases = rows.map((row, i) => validateCase(row, filePath, i));
	const ids = new Set<string>();
	for (const c of cases) {
		if (ids.has(c.id)) throw new Error(`${filePath}: duplicate case id ${c.id}`);
		ids.add(c.id);
	}
	return { file: filePath, cases };
}

/** Load every `*.json` under a directory (non-recursive by default). */
export function loadCorpusDir(dirPath: string, recursive = false): LoadedCorpus[] {
	if (!fs.existsSync(dirPath)) return [];
	const out: LoadedCorpus[] = [];
	const entries = fs.readdirSync(dirPath, { withFileTypes: true });
	for (const ent of entries) {
		const full = path.join(dirPath, ent.name);
		if (ent.isDirectory() && recursive) {
			out.push(...loadCorpusDir(full, true));
			continue;
		}
		if (ent.isFile() && ent.name.endsWith(".json")) {
			out.push(loadCorpusFile(full));
		}
	}
	return out;
}

/** Flatten all cases with source file for diagnostics. */
export function flattenCorpus(dirPath: string, recursive = true): Array<CorpusCase & { file: string }> {
	const loaded = loadCorpusDir(dirPath, recursive);
	const flat: Array<CorpusCase & { file: string }> = [];
	for (const pack of loaded) {
		for (const c of pack.cases) {
			flat.push({ ...c, file: pack.file });
		}
	}
	return flat;
}
