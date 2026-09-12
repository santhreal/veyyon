/**
 * The public-export floor `a-package-exports-its-public-surface.test.ts` reads and
 * `gen-package-exports-baseline.ts` regenerates: one sorted name list per published specifier.
 * The floor only grows. The generator refuses a current surface that drops a specifier or a name.
 *
 * The natives version sentinel (`__veyyonNativesV1_4_1`) is the one export whose name changes on
 * every release, so a floor that pinned it would shrink on every bump. It is not a floor member: the
 * generator drops it and the reader rejects a baseline that holds one. The native bucket pins the
 * sentinel against the package version instead.
 */

import { assertObject, isStringArray, sortRecordArrays } from "./ledger-schema";

export const EXPORT_FLOOR_SCHEMA_VERSION = 4;
export const BASELINE_FILE_PATH = "scripts/package-exports-baseline.json";

const VERSION_SENTINEL = /^__veyyonNativesV\d/;

/** True for the natives version sentinel export, which no floor may pin. */
export function isVersionSentinelExport(name: string): boolean {
	return VERSION_SENTINEL.test(name);
}

export interface ExportFloorLedger {
	readonly schemaVersion: number;
	readonly exports: Readonly<Record<string, string[]>>;
}

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

export function readExportFloor(raw: unknown): Record<string, string[]> {
	const ledger = assertObject(raw, "Export floor schema is stale or invalid; regenerate the export baseline");
	if (ledger.schemaVersion !== EXPORT_FLOOR_SCHEMA_VERSION) {
		throw new Error(
			`Export floor schema is stale or invalid (expected version ${EXPORT_FLOOR_SCHEMA_VERSION}, got ${ledger.schemaVersion ?? "unversioned"}); regenerate the export baseline`,
		);
	}
	const entries = assertObject(ledger.exports, "Export floors must be an object");
	for (const [specifier, names] of Object.entries(entries)) {
		if (!isStringArray(names) || names.some(name => !IDENTIFIER.test(name))) {
			throw new Error(`Export floor for ${specifier} must be a list of distinct identifier names`);
		}
		const sentinel = names.find(isVersionSentinelExport);
		if (sentinel !== undefined) {
			throw new Error(
				`Export floor for ${specifier} pins the version sentinel ${sentinel}, which moves on every release; regenerate the export baseline`,
			);
		}
	}
	return sortRecordArrays(entries as Record<string, string[]>);
}

export function computeExportFloorLedger(
	floor: Readonly<Record<string, readonly string[]>>,
	currentSurface: Readonly<Record<string, readonly string[]>>,
): ExportFloorLedger {
	const removedSpecifiers: string[] = [];
	const missingNames: string[] = [];
	for (const [specifier, names] of Object.entries(floor)) {
		const currentNames = currentSurface[specifier];
		if (!currentNames) {
			removedSpecifiers.push(specifier);
			continue;
		}
		const currentSet = new Set(currentNames);
		for (const name of names) {
			if (!currentSet.has(name)) missingNames.push(`${specifier}: missing approved export "${name}"`);
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
	const merged: Record<string, string[]> = {};
	for (const [specifier, currentNames] of Object.entries(currentSurface)) {
		merged[specifier] = [
			...new Set([...(floor[specifier] ?? []), ...currentNames.filter(name => !isVersionSentinelExport(name))]),
		];
	}
	return { schemaVersion: EXPORT_FLOOR_SCHEMA_VERSION, exports: sortRecordArrays(merged) };
}
