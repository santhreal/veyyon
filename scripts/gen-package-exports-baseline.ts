/**
 * Regenerate the public-export baseline `a-package-exports-its-public-surface.test.ts` reads.
 *
 * The baseline is the floor of every publishable member's value surface: an immutable Git
 * reference to the approved baseline commit (de0ccbf5a571d9de1285cb4dddeff1cc23f882aa) plus sparse
 * explicit additions for newly introduced specifiers or exported names. Adding an export raises
 * the floor here; removing one is what the gate refuses.
 *
 *   bun run scripts/gen-package-exports-baseline.ts
 *
 * Commit the result with the change that moved the surface.
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	APPROVED_EXPORT_BASELINE_COMMIT,
	BASELINE_FILE_PATH,
	computeExportFloorLedger,
	type ExportFloorLedger,
	expandExportFloor,
	readApprovedExportBaseline,
} from "./package-export-floor";
import { exportedNames, gatedSpecifiers } from "./package-exports-surface";
import { REPO_ROOT } from "./workspace-layout";

const BASELINE_PATH = join(REPO_ROOT, BASELINE_FILE_PATH);

const baseFloor = readApprovedExportBaseline(APPROVED_EXPORT_BASELINE_COMMIT, REPO_ROOT);
let existingApprovedFloor: Record<string, string[]> = baseFloor;
if (existsSync(BASELINE_PATH)) {
	try {
		existingApprovedFloor = expandExportFloor(JSON.parse(readFileSync(BASELINE_PATH, "utf8")), REPO_ROOT);
	} catch (error) {
		process.stderr.write(
			`Failed to expand existing approved export baseline from ${BASELINE_PATH}: ${error instanceof Error ? error.message : String(error)}\n`,
		);
		process.exit(1);
	}
}

const currentSurface: Record<string, string[]> = {};
const failed: string[] = [];

for (const specifier of gatedSpecifiers()) {
	try {
		currentSurface[specifier] = await exportedNames(specifier);
	} catch (error) {
		failed.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (failed.length > 0) {
	process.stderr.write(`${failed.length} specifier(s) did not import:\n${failed.map(row => `  ${row}`).join("\n")}\n`);
	process.exit(1);
}

let ledger: ExportFloorLedger;
try {
	ledger = computeExportFloorLedger({
		immutableBase: baseFloor,
		approvedFloor: existingApprovedFloor,
		currentSurface,
	});
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}

writeFileSync(BASELINE_PATH, `${JSON.stringify(ledger, null, "\t")}\n`);
const additionsCount = Object.keys(ledger.additions?.exports ?? {}).length;
const totalSpecifiers = Object.keys(currentSurface).length;
const totalNames = Object.values(currentSurface).reduce((sum, names) => sum + names.length, 0);
process.stdout.write(
	`Wrote export floor ledger referencing ${APPROVED_EXPORT_BASELINE_COMMIT} with ${additionsCount} addition entries. Total protected surface: ${totalSpecifiers} specifiers, ${totalNames} exported names.\n`,
);
