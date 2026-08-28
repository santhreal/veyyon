import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

// The @veyyon/utils barrel (src/index.ts) re-exports Bun-only modules — glob,
// dirs, frontmatter, stderr-guard (bun:ffi) — alongside browser-safe helpers.
// Any package whose source is bundled for the BROWSER must therefore never
// import the bare "@veyyon/utils" barrel: doing so makes the browser bundler
// resolve those Bun builtins and the build fails ("Browser build cannot import
// Bun builtin"). Browser code must deep-import the specific submodule instead,
// e.g. `import { formatCount } from "@veyyon/utils/format"`, which the package's
// "./*" export map resolves to src/format.ts without pulling the barrel.
//
// This has bitten three separate browser bundles (collab-web, the stats
// dashboard, and export/html), so this test locks the whole class: it scans
// every browser-graph source root and fails if any file bare-imports the
// barrel. Add a new browser bundle here when one appears.

const repoRoot = path.resolve(import.meta.dir, "../../..");

// Source roots that end up in a browser bundle — either the bundle entry itself
// (collab-web, stats client) or a package pulled wholesale into one (tool-render
// is bundled by collab-web, so all of its src must stay browser-safe).
const BROWSER_GRAPH_ROOTS = ["packages/collab-web/src", "packages/stats/src/client", "packages/tool-render/src"];

// A bare barrel import: `from "@veyyon/utils"` (or the single-quoted form) with
// NO trailing `/submodule`. Deep imports (`@veyyon/utils/format`) are allowed.
const BARE_BARREL_IMPORT = /from\s+["']@veyyon\/utils["']/;

function collectSourceFiles(absRoot: string): string[] {
	const out: string[] = [];
	const walk = (dir: string): void => {
		for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
			const full = path.join(dir, entry.name);
			if (entry.isDirectory()) {
				if (entry.name === "node_modules" || entry.name === "dist") continue;
				walk(full);
			} else if (/\.(ts|tsx)$/.test(entry.name)) {
				out.push(full);
			}
		}
	};
	walk(absRoot);
	return out;
}

describe("browser-graph packages never bare-import the Bun-mixed @veyyon/utils barrel", () => {
	const scanned: string[] = [];
	const offenders: string[] = [];

	for (const root of BROWSER_GRAPH_ROOTS) {
		const absRoot = path.join(repoRoot, root);
		// A missing root means the layout moved — fail loudly rather than skip,
		// so this lock can never silently stop covering a bundle.
		expect(fs.existsSync(absRoot), `browser-graph root vanished: ${root} — update BROWSER_GRAPH_ROOTS`).toBe(true);
		for (const file of collectSourceFiles(absRoot)) {
			scanned.push(file);
			const text = fs.readFileSync(file, "utf8");
			if (BARE_BARREL_IMPORT.test(text)) {
				offenders.push(path.relative(repoRoot, file));
			}
		}
	}

	it("scans a non-trivial number of files (guards against a broken glob passing vacuously)", () => {
		expect(scanned.length).toBeGreaterThan(50);
	});

	it("has zero bare-barrel imports in the browser graph", () => {
		expect(
			offenders,
			offenders.length > 0
				? `These browser-bundled files import the bare "@veyyon/utils" barrel, which pulls Bun-only ` +
						`modules (glob/dirs/frontmatter/bun:ffi) and breaks the browser build. Deep-import the ` +
						`specific submodule instead (e.g. "@veyyon/utils/format"):\n  ${offenders.join("\n  ")}`
				: undefined,
		).toEqual([]);
	});
});
