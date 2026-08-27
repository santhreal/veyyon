/**
 * Inline dynamic imports hide startup dependencies and break compile-time module graph analysis.
 * This gate bounds runtime dynamic imports to an explicit shrink-only baseline and prevents dynamic type imports.
 * It does not measure whether imported modules are executed after loading.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Project, SyntaxKind } from "ts-morph";
import { existingOnly } from "./check-doc-links";

const REPO_ROOT = path.resolve(import.meta.dir, "..");
const BASELINE_FILE = path.join(REPO_ROOT, "scripts", "data", "dynamic-import-boundaries.txt");

/**
 * Lazy boundaries exist deliberately to keep heavy module subgraphs (such as TUI panels,
 * scrapers, AI provider registries, and tool implementations) out of initial startup.
 * Stored in scripts/data/dynamic-import-boundaries.txt because the list holds over a hundred files.
 */
function loadBaseline(): string[] {
	const text = fs.readFileSync(BASELINE_FILE, "utf-8");
	return text
		.split("\n")
		.map(line => line.trim())
		.filter(line => line.length > 0 && !line.startsWith("#"))
		.sort();
}

function trackedSourceFiles(): string[] {
	const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", "packages", "scripts", "proof", "website"], {
		cwd: REPO_ROOT,
	});
	if (!listed.success) {
		throw new Error(`git ls-files failed: ${new TextDecoder().decode(listed.stderr)}`);
	}
	const raw = new TextDecoder().decode(listed.stdout).split("\0").filter(Boolean);
	return existingOnly(
		REPO_ROOT,
		raw.filter(f => (f.endsWith(".ts") || f.endsWith(".tsx")) && !f.endsWith(".d.ts")),
	).sort();
}

interface ScanResult {
	readonly scannedCount: number;
	readonly dynamicFiles: string[];
	readonly typeFiles: string[];
}

function sweepTrackedImports(): ScanResult {
	const files = trackedSourceFiles();
	const project = new Project({ useInMemoryFileSystem: true });
	const dynamicFiles = new Set<string>();
	const typeFiles = new Set<string>();

	for (const relPath of files) {
		const fullPath = path.join(REPO_ROOT, relPath);
		const text = fs.readFileSync(fullPath, "utf-8");
		if (!/\bimport\s*\(/.test(text)) continue;

		const sourceFile = project.createSourceFile("probe.tsx", text, { overwrite: true });

		const callExpressions = sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression);
		for (const call of callExpressions) {
			if (call.getExpression().getKind() === SyntaxKind.ImportKeyword) {
				dynamicFiles.add(relPath);
			}
		}

		const importTypes = sourceFile.getDescendantsOfKind(SyntaxKind.ImportType);
		for (const _it of importTypes) {
			typeFiles.add(relPath);
		}

		project.removeSourceFile(sourceFile);
	}

	return {
		scannedCount: files.length,
		dynamicFiles: Array.from(dynamicFiles).sort(),
		typeFiles: Array.from(typeFiles).sort(),
	};
}

describe("module import boundaries", () => {
	const scan = sweepTrackedImports();
	const baseline = loadBaseline();

	it("guards against a vacuous scan", () => {
		expect(scan.scannedCount).toBeGreaterThan(1000);
		expect(scan.dynamicFiles).toContain("packages/coding-agent/src/tools/index.ts");
		expect(baseline).toContain("packages/coding-agent/src/tools/index.ts");
	});

	it("restricts dynamic imports to the shrink-only baseline", () => {
		const unexpected = scan.dynamicFiles.filter(f => !baseline.includes(f));
		const stale = baseline.filter(f => !scan.dynamicFiles.includes(f));

		const message = [
			unexpected.length > 0
				? `New dynamic import files found. Move imports to the top of the file: ${unexpected.join(", ")}`
				: "",
			stale.length > 0
				? `Files no longer contain dynamic imports. Remove them from scripts/data/dynamic-import-boundaries.txt to shrink the baseline: ${stale.join(", ")}`
				: "",
		]
			.filter(Boolean)
			.join("\n");

		expect(scan.dynamicFiles, message).toEqual(baseline);
	});

	it("forbids dynamic imports in type positions", () => {
		const message =
			scan.typeFiles.length > 0
				? `Dynamic imports in type positions are forbidden. Use top-level 'import type' instead: ${scan.typeFiles.join(", ")}`
				: "";
		expect(scan.typeFiles, message).toEqual([]);
	});
});
