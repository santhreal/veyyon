/**
 * Regenerate the public-export baseline `a-package-exports-its-public-surface.test.ts` reads.
 *
 * The baseline is the floor of every publishable member's value surface. Adding an export raises
 * the floor here; removing one is what the gate refuses.
 *
 *   bun run scripts/gen-package-exports-baseline.ts
 *
 * Commit the result with the change that moved the surface.
 */

import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
	BASELINE_FILE_PATH,
	computeExportFloorLedger,
	type ExportFloorLedger,
	readExportFloor,
} from "./package-export-floor";
import { exportedNames, gatedSpecifiers } from "./package-exports-surface";
import { REPO_ROOT } from "./workspace-layout";

const BASELINE_PATH = join(REPO_ROOT, BASELINE_FILE_PATH);

let floor: Record<string, string[]>;
try {
	floor = readExportFloor(JSON.parse(readFileSync(BASELINE_PATH, "utf8")));
} catch (error) {
	process.stderr.write(
		`Failed to read the export baseline at ${BASELINE_PATH}: ${error instanceof Error ? error.message : String(error)}\n`,
	);
	process.exit(1);
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

let next: ExportFloorLedger;
try {
	next = computeExportFloorLedger(floor, currentSurface);
} catch (error) {
	process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
	process.exit(1);
}
writeFileSync(BASELINE_PATH, `${JSON.stringify(next, null, "\t")}\n`);
const totalSpecifiers = Object.keys(next.exports).length;
const totalNames = Object.values(next.exports).reduce((sum, names) => sum + names.length, 0);
process.stdout.write(`Wrote export floor: ${totalSpecifiers} specifiers, ${totalNames} exported names.\n`);
