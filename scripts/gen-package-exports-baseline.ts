/**
 * Regenerate the public-export baseline `a-package-exports-its-public-surface.test.ts` reads.
 *
 * The baseline is the floor of every publishable member's value surface: one row per declared
 * import specifier, holding the names that specifier exported when the row was written. Adding an
 * export raises the floor here; removing one is what the gate refuses.
 *
 *   bun run scripts/gen-package-exports-baseline.ts
 *
 * Commit the result with the change that moved the surface.
 */

import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { exportedNames, gatedSpecifiers } from "./package-exports-surface";
import { REPO_ROOT } from "./workspace-layout";

const BASELINE_PATH = join(REPO_ROOT, "scripts", "package-exports-baseline.json");

const baseline: Record<string, string[]> = {};
const failed: string[] = [];
for (const specifier of gatedSpecifiers()) {
	try {
		baseline[specifier] = await exportedNames(specifier);
	} catch (error) {
		failed.push(`${specifier}: ${error instanceof Error ? error.message : String(error)}`);
	}
}

if (failed.length > 0) {
	process.stderr.write(`${failed.length} specifier(s) did not import:\n${failed.map(row => `  ${row}`).join("\n")}\n`);
	process.exit(1);
}

writeFileSync(BASELINE_PATH, `${JSON.stringify(baseline, null, "\t")}\n`);
const total = Object.values(baseline).reduce((sum, names) => sum + names.length, 0);
process.stdout.write(`Wrote ${Object.keys(baseline).length} specifiers, ${total} exported names.\n`);
