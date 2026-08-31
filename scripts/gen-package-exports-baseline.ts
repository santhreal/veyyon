/**
 * Regenerates `scripts/package-exports-baseline.json` — the committed snapshot of
 * every publishable package's public value exports. The companion test
 * `a-package-exports-its-public-surface.test.ts` fails when a name in the baseline
 * is no longer exported.
 *
 * Run after intentionally adding or removing a public export:
 *
 *   bun run scripts/gen-package-exports-baseline.ts
 */

import * as fs from "node:fs";
import * as path from "node:path";

const PACKAGES: Record<string, string> = {
	"@veyyon/ai": "@veyyon/ai",
	"@veyyon/catalog": "@veyyon/catalog",
	"@veyyon/utils": "@veyyon/utils",
	"@veyyon/tui": "@veyyon/tui",
	"@veyyon/agent-core": "@veyyon/agent-core",
	"@veyyon/wire": "@veyyon/wire",
	argot: "argot",
	"@veyyon/hashline": "@veyyon/hashline",
	"@veyyon/mnemopi": "@veyyon/mnemopi",
	"@veyyon/tool-render": "@veyyon/tool-render",
	"@veyyon/stats": "@veyyon/stats",
	"@veyyon/coding-agent": "@veyyon/coding-agent",
};

const baseline: Record<string, string[]> = {};

for (const [label, spec] of Object.entries(PACKAGES)) {
	try {
		// Dynamic import: the specifier is runtime-selected from the package table.
		const mod = await import(spec);
		baseline[label] = Object.keys(mod).sort();
		console.log(`${label}: ${baseline[label].length} exports`);
	} catch (e) {
		console.error(`${label}: FAILED - ${(e as Error).message}`);
	}
}

const outPath = path.resolve(import.meta.dir, "package-exports-baseline.json");
fs.writeFileSync(outPath, `${JSON.stringify(baseline, null, 2)}\n`);
console.log(`\nWrote baseline to ${outPath}`);
