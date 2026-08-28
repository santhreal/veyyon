/**
 * A renderer-defect test lives in `@veyyon/render-oracle` and nowhere else.
 *
 * WHY THIS SUITE EXISTS. Renderer defects — a hole in the viewport, a stranded composer, a row that
 * blanks for one frame, a tmux passthrough that never wraps — were chased for months in tests spread
 * across `tui` and `coding-agent`. The same defect got a fresh test in whichever package the person
 * was standing in, so a class was closed in one copy and left open in another, and no single place
 * said what a defect even looks like. Consolidating them into one package only helps for as long as
 * the next one is added there too, and nothing about writing a renderer test prompts anybody to pick
 * a package. The prompt has to be a failing check in the same change.
 *
 * WHAT SEPARATES A RENDERER TEST FROM AN APPLICATION TEST. Not the terminal. `VirtualTerminal`,
 * `settleFrames` and `StressRenderScheduler` are a harness: dozens of application suites drive a real
 * terminal to assert application behavior, and those belong where their subject lives. What marks a
 * test as a renderer-defect test is that it asks a **detector** whether what was painted is a defect.
 * The detectors are the modules under `src/detect/`, and this suite derives their exported symbols
 * from the barrel at run time rather than hardcoding a list that would go stale in silence.
 *
 * WHY THERE IS AN ALLOWLIST AT ALL. The package is agnostic of what is being rendered; that is the
 * property that lets it be published and reused. A check that needs an application module therefore
 * cannot move into it, and the four files below each construct coding-agent's own composer and theme.
 * They are pinned by exact equality, so a fifth file joining them turns this red until someone records
 * why it cannot live in the package.
 *
 * WHAT THIS DOES NOT CATCH. A renderer test that reimplements a detector inline instead of importing
 * one is invisible here. That is the same defect as duplicating a detector, and the ≤500-line and
 * no-duplicate-logic rules are what stand against it.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");
const packagesDir = path.join(repoRoot, "packages");
const oraclePackageDir = path.join(packagesDir, "render-oracle");
const PACKAGE_SPECIFIER = "@veyyon/render-oracle";

/**
 * Files outside the package that may import a detector, each because it needs an application module
 * the package must not depend on. Paths are repo-relative and compared by exact equality.
 */
const ALLOWED_OUTSIDE_THE_PACKAGE: ReadonlyMap<string, string> = new Map([
	[
		"packages/coding-agent/test/a-repaint-never-leaves-a-second-composer-behind.test.ts",
		"Builds coding-agent's composer and calls initTheme, so the frame it inspects only exists in the application.",
	],
	[
		"packages/coding-agent/test/every-composer-check-inspects-real-frame-data.test.ts",
		"Sweeps every composer guarantee against coding-agent's own rendered frames.",
	],
	[
		"packages/coding-agent/test/helpers/composer-oracle-runner.ts",
		"The application-side runner that feeds coding-agent frames to the composer oracles.",
	],
	[
		"packages/coding-agent/test/the-composer-owns-the-bottom-rows-and-appears-once.test.ts",
		"Asserts coding-agent's composer placement against its own rendered frames.",
	],
]);

/** Every `./detect/...` module the barrel re-exports. */
function detectModulePaths(): string[] {
	const barrel = readFileSync(path.join(oraclePackageDir, "src/index.ts"), "utf8");
	const modules: string[] = [];
	for (const match of barrel.matchAll(/export \* from "\.\/(detect\/[\w-]+)"/g)) {
		modules.push(match[1] as string);
	}
	return modules;
}

/** Names exported by the detector modules — the surface that marks a consumer as a renderer test. */
function detectorSymbols(): Set<string> {
	const symbols = new Set<string>();
	for (const moduleId of detectModulePaths()) {
		const source = readFileSync(path.join(oraclePackageDir, "src", `${moduleId}.ts`), "utf8");
		for (const match of source.matchAll(
			/^export (?:declare )?(?:abstract class|const|class|function|type|interface|enum)\s+(\w+)/gm,
		)) {
			symbols.add(match[1] as string);
		}
	}
	return symbols;
}

/** Every TypeScript file under `packages/`, excluding the oracle package itself and dependencies. */
function typeScriptFilesOutsideThePackage(): string[] {
	const found: string[] = [];
	const walk = (dir: string): void => {
		// Dirents rather than a stat per entry: `deepswe-bench/repo-cache` carries checked-out
		// repositories whose dangling symlinks make `statSync` throw ENOENT mid-scan.
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			const name = entry.name;
			if (name === "node_modules" || name === "dist" || name === ".git" || name === "repo-cache") {
				continue;
			}
			const full = path.join(dir, name);
			if (entry.isDirectory()) {
				if (full === oraclePackageDir) continue;
				walk(full);
				continue;
			}
			if (!entry.isFile()) continue;
			if (name.endsWith(".ts") || name.endsWith(".tsx")) found.push(full);
		}
	};
	walk(packagesDir);
	return found;
}

/** Named bindings a file imports from the package specifier, `type` modifiers stripped. */
function importedNames(source: string): Set<string> {
	const names = new Set<string>();
	const pattern = new RegExp(String.raw`import\s*(?:type\s*)?\{([^}]*)\}\s*from\s*"${PACKAGE_SPECIFIER}"`, "gs");
	for (const match of source.matchAll(pattern)) {
		for (const raw of (match[1] as string).split(",")) {
			const name = raw
				.trim()
				.replace(/^type\s+/, "")
				.split(/\s+as\s+/)[0]
				?.trim();
			if (name) names.add(name);
		}
	}
	return names;
}

describe("renderer tests live in the render-oracle package", () => {
	it("derives a non-empty detector surface, so the check cannot pass by finding nothing", () => {
		const modules = detectModulePaths();
		expect(modules.length).toBeGreaterThan(0);
		expect(detectorSymbols().size).toBeGreaterThan(0);
	});

	it("names no allowlisted file that has been moved or deleted", () => {
		const missing = [...ALLOWED_OUTSIDE_THE_PACKAGE.keys()].filter(
			relative => !existsSync(path.join(repoRoot, relative)),
		);
		expect(missing).toEqual([]);
	});

	it("has no file outside the package importing a detector, beyond the recorded exceptions", () => {
		const symbols = detectorSymbols();
		const offenders: string[] = [];
		for (const file of typeScriptFilesOutsideThePackage()) {
			const used = importedNames(readFileSync(file, "utf8"));
			let importsDetector = false;
			for (const name of used) {
				if (symbols.has(name)) {
					importsDetector = true;
					break;
				}
			}
			if (importsDetector) offenders.push(path.relative(repoRoot, file));
		}
		expect(offenders.sort()).toEqual([...ALLOWED_OUTSIDE_THE_PACKAGE.keys()].sort());
	});
});
