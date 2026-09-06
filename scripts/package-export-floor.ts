/**
 * Public export floor ledger parser, validator, factorer, and expander.
 *
 * Reads approved exported names from an immutable Git reference (PINNED_BASELINE_COMMIT /
 * APPROVED_EXPORT_BASELINE_COMMIT = "de0ccbf5a571d9de1285cb4dddeff1cc23f882aa") and applies sparse
 * explicit additions, eliminating thousands of lines of repeated exported identifier lists while
 * guaranteeing exact byte/semantic identity of the approved export floor.
 */

import { REPO_ROOT, readGitFileText } from "./git-baseline";

/**
 * Pinned approved baseline commit that contains the pre-deduplication export baseline ledger.
 */
export const APPROVED_EXPORT_BASELINE_COMMIT = "de0ccbf5a571d9de1285cb4dddeff1cc23f882aa";

export const EXPORT_FLOOR_SCHEMA_VERSION = 2;

export const BASELINE_FILE_PATH = "scripts/package-exports-baseline.json";

export interface ReferencedExportFloor {
	includes: string[];
	names: string[];
}

export type ExportFloorEntry = string[] | ReferencedExportFloor;

export interface ExportFloorAdditions {
	exports?: Record<string, ExportFloorEntry>;
}

export interface ExportFloorLedger {
	schemaVersion: number;
	generatedFrom: string;
	additions?: ExportFloorAdditions;
}

export interface FactoredExportFloorLedger {
	schemaVersion: number;
	exports: Record<string, ExportFloorEntry>;
}

export interface GenerateExportFloorOptions {
	immutableBase: Readonly<Record<string, readonly string[]>>;
	approvedFloor?: Readonly<Record<string, readonly string[]>>;
	currentSurface: Readonly<Record<string, readonly string[]>>;
}

function isStringArray(value: unknown): value is string[] {
	return Array.isArray(value) && value.every(item => typeof item === "string") && new Set(value).size === value.length;
}

function isReferencedExportFloor(value: unknown): value is ReferencedExportFloor {
	if (!value || typeof value !== "object" || Array.isArray(value)) return false;
	const keys = Object.keys(value);
	if (keys.length !== 2 || !("includes" in value) || !("names" in value)) return false;
	return isStringArray(value.includes) && isStringArray(value.names);
}

export function validateExportFloorEntry(specifier: string, entry: unknown): asserts entry is ExportFloorEntry {
	if (isStringArray(entry) || isReferencedExportFloor(entry)) return;
	throw new Error(`Invalid export floor: ${specifier}`);
}

export function validateExportFloorLedger(raw: unknown): ExportFloorLedger {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Export floor schema is stale or invalid; regenerate the approved export baseline");
	}
	if (!("schemaVersion" in raw) || raw.schemaVersion !== EXPORT_FLOOR_SCHEMA_VERSION) {
		const version = "schemaVersion" in raw ? raw.schemaVersion : undefined;
		throw new Error(
			`Export floor schema is stale or invalid (expected version ${EXPORT_FLOOR_SCHEMA_VERSION}, got ${typeof version === "number" || typeof version === "string" ? String(version) : "unversioned"}); regenerate the approved export baseline`,
		);
	}
	if (!("generatedFrom" in raw) || typeof raw.generatedFrom !== "string" || raw.generatedFrom.trim() === "") {
		throw new Error("Export floor ledger is missing generatedFrom commit hash");
	}
	if (raw.generatedFrom !== APPROVED_EXPORT_BASELINE_COMMIT) {
		throw new Error(
			`Export floor ledger generatedFrom commit mismatch: expected approved baseline ${APPROVED_EXPORT_BASELINE_COMMIT}, got ${raw.generatedFrom}`,
		);
	}
	if ("additions" in raw && raw.additions !== undefined) {
		const additions = raw.additions;
		if (additions === null || typeof additions !== "object" || Array.isArray(additions)) {
			throw new Error("Export floor ledger additions must be an object");
		}
		if ("exports" in additions && additions.exports !== undefined) {
			const exportsMap = additions.exports;
			if (exportsMap === null || typeof exportsMap !== "object" || Array.isArray(exportsMap)) {
				throw new Error("Export floor additions.exports must be an object");
			}
			for (const [specifier, entry] of Object.entries(exportsMap)) {
				validateExportFloorEntry(specifier, entry);
			}
		}
	}
	return raw as ExportFloorLedger;
}

export function readApprovedExportBaseline(
	commit: string = APPROVED_EXPORT_BASELINE_COMMIT,
	repoRoot: string = REPO_ROOT,
): Record<string, string[]> {
	const text = readGitFileText(BASELINE_FILE_PATH, commit, repoRoot);
	if (!text) {
		throw new Error(`Failed to read approved export baseline from commit ${commit}:${BASELINE_FILE_PATH}`);
	}
	const parsed: unknown = JSON.parse(text);
	if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
		throw new Error(`Approved export baseline at ${commit} is not a valid JSON object`);
	}
	const result: Record<string, string[]> = {};
	for (const [specifier, names] of Object.entries(parsed)) {
		if (!isStringArray(names)) {
			throw new Error(`Approved export baseline at ${commit} contains invalid entry for ${specifier}`);
		}
		result[specifier] = [...names].sort();
	}
	return result;
}

function mergeEntry(baseEntry: string[] | undefined, additionEntry: ExportFloorEntry): ExportFloorEntry {
	if (!baseEntry) {
		return additionEntry;
	}
	if (isStringArray(additionEntry)) {
		return [...new Set([...baseEntry, ...additionEntry])].sort();
	}
	return {
		includes: [...new Set(additionEntry.includes)].sort(),
		names: [...new Set([...baseEntry, ...additionEntry.names])].sort(),
	};
}

function expandResolvedRows(rows: Record<string, unknown>): Record<string, string[]> {
	const resolved = new Map<string, string[]>();
	const active = new Set<string>();

	function expand(specifier: string): string[] {
		const cached = resolved.get(specifier);
		if (cached) return cached;
		if (!Object.hasOwn(rows, specifier)) throw new Error(`Missing export floor reference: ${specifier}`);
		if (active.has(specifier)) throw new Error(`Cyclic export floor reference: ${specifier}`);
		active.add(specifier);
		const row = rows[specifier];
		validateExportFloorEntry(specifier, row);
		let names: string[];
		if (isStringArray(row)) {
			names = row;
		} else {
			names = [...row.names, ...row.includes.flatMap(expand)];
		}
		const result = [...new Set(names)].sort();
		resolved.set(specifier, result);
		active.delete(specifier);
		return result;
	}

	return Object.fromEntries(Object.keys(rows).map(specifier => [specifier, expand(specifier)]));
}

/** Expand references between approved export sets. */
export function expandExportFloor(
	raw: unknown,
	repoRoot: string = REPO_ROOT,
	baseFloorOverride?: Record<string, string[]>,
): Record<string, string[]> {
	if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
		throw new Error("Export floor schema is stale or invalid; regenerate the approved export baseline");
	}

	if ("generatedFrom" in raw) {
		const ledger = validateExportFloorLedger(raw);
		const baseExports = baseFloorOverride ?? readApprovedExportBaseline(ledger.generatedFrom, repoRoot);
		const additions = ledger.additions?.exports;
		if (!additions || Object.keys(additions).length === 0) {
			return Object.fromEntries(Object.entries(baseExports).map(([k, v]) => [k, [...v].sort()]));
		}
		const merged: Record<string, ExportFloorEntry> = { ...baseExports };
		for (const [specifier, entry] of Object.entries(additions)) {
			merged[specifier] = mergeEntry(baseExports[specifier], entry);
		}
		return expandResolvedRows(merged);
	}

	if ("exports" in raw) {
		if (!("schemaVersion" in raw) || raw.schemaVersion !== EXPORT_FLOOR_SCHEMA_VERSION) {
			throw new Error("Export floor schema is stale or invalid; regenerate the approved export baseline");
		}
		const entries = raw.exports;
		if (entries === null || typeof entries !== "object" || Array.isArray(entries)) {
			throw new Error("Export floors must be an object");
		}
		for (const [specifier, entry] of Object.entries(entries)) {
			validateExportFloorEntry(specifier, entry);
		}
		return expandResolvedRows(entries as Record<string, unknown>);
	}
	throw new Error("Export floor schema is stale or invalid; regenerate the approved export baseline");
}

/** Reuse complete approved subpath floors only when they are subsets of the package floor. */
export function factorExportFloor(
	baseline: Readonly<Record<string, readonly string[]>>,
	immutableBase?: Readonly<Record<string, readonly string[]>>,
): FactoredExportFloorLedger {
	const entries: Record<string, ExportFloorEntry> = {};
	for (const [specifier, names] of Object.entries(baseline)) {
		const sortedNames = [...new Set(names)].sort();
		const remaining = new Set(sortedNames);
		const included: string[] = [];
		const candidates = Object.keys(baseline)
			.filter(
				candidate =>
					candidate.startsWith(`${specifier}/`) &&
					(immutableBase?.[candidate]?.length ?? 0) === 0 &&
					baseline[candidate].every(name => remaining.has(name)),
			)
			.sort((left, right) => baseline[right].length - baseline[left].length || left.localeCompare(right));
		for (const candidate of candidates) {
			const contribution = baseline[candidate].filter(name => remaining.has(name));
			if (contribution.length <= 1) continue;
			included.push(candidate);
			for (const name of contribution) remaining.delete(name);
		}
		// A reference object adds six structural rows beyond the plain array representation.
		entries[specifier] =
			sortedNames.length > remaining.size + included.length + 6
				? { includes: included.sort(), names: [...remaining].sort() }
				: sortedNames;
	}
	return { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: entries };
}

/**
 * Pure generator logic: validates that current surface does not shrink approved export floor
 * and computes sparse additions against immutable baseline.
 */
export function computeExportFloorLedger({
	immutableBase,
	approvedFloor,
	currentSurface,
}: GenerateExportFloorOptions): ExportFloorLedger {
	const floorToCheck = approvedFloor ?? immutableBase;
	const removedSpecifiers: string[] = [];
	const missingNames: string[] = [];

	for (const [specifier, names] of Object.entries(floorToCheck)) {
		const currentNames = currentSurface[specifier];
		if (!currentNames) {
			removedSpecifiers.push(specifier);
			continue;
		}
		const currentSet = new Set(currentNames);
		for (const name of names) {
			if (!currentSet.has(name)) {
				missingNames.push(`${specifier}: missing approved export "${name}"`);
			}
		}
	}

	if (removedSpecifiers.length > 0 || missingNames.length > 0) {
		throw new Error(
			`Refusing to generate baseline: removing approved exports shrinks the public surface floor.\n` +
				(removedSpecifiers.length > 0
					? `  Removed specifiers:\n${removedSpecifiers.map(s => `    - ${s}`).join("\n")}\n`
					: "") +
				(missingNames.length > 0
					? `  Missing exported names:\n${missingNames.map(m => `    - ${m}`).join("\n")}\n`
					: ""),
		);
	}

	const addedExports: Record<string, string[]> = {};
	for (const [specifier, currentNames] of Object.entries(currentSurface)) {
		const currentSorted = [...new Set(currentNames)].sort();
		const baseNames = immutableBase[specifier];
		if (!baseNames) {
			addedExports[specifier] = currentSorted;
		} else {
			const baseSet = new Set(baseNames);
			const newNames = currentSorted.filter(name => !baseSet.has(name));
			if (newNames.length > 0) {
				addedExports[specifier] = newNames;
			}
		}
	}

	// References expand the entire included floor, not only its sparse additions.
	const additionsExports = factorExportFloor(addedExports, immutableBase).exports;

	return {
		schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION,
		generatedFrom: APPROVED_EXPORT_BASELINE_COMMIT,
		...(Object.keys(additionsExports).length > 0 ? { additions: { exports: additionsExports } } : { additions: {} }),
	};
}
