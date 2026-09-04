/**
 * Inline dynamic imports hide startup dependencies and break compile-time module graph analysis.
 * This gate bounds runtime dynamic imports to an explicit shrink-only baseline, prevents dynamic
 * type imports, and requires every relative `import("...")` specifier to name a file that is there.
 * A leftover path after a directory move compiled and only 404'd at first use.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Node, Project, SyntaxKind } from "ts-morph";
import { existingOnly } from "./check-doc-links";
import { typeScriptMemberTopLevels } from "./workspace-layout";

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

/**
 * The scan reads every top-level directory the workspace member list resolves to, not a fixed
 * `packages` literal: a member outside it (`natives/bridge/bindings`, `contracts/view`) carries the
 * same rule, and a directory list would drop it in silence. `scripts`, `proof` and `website` are
 * tracked TypeScript that no member declares, so they are named alongside.
 */
function scannedRoots(): string[] {
	return Array.from(new Set([...typeScriptMemberTopLevels(), "scripts", "proof", "website"])).sort();
}

function trackedSourceFiles(): string[] {
	const listed = Bun.spawnSync(["git", "ls-files", "-z", "--", ...scannedRoots()], {
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

interface MissingSpecifier {
	readonly file: string;
	readonly specifier: string;
}

interface ScanResult {
	readonly scannedCount: number;
	readonly dynamicFiles: string[];
	readonly typeFiles: string[];
	readonly relativeDynamicCount: number;
	readonly missingRelative: MissingSpecifier[];
}

/**
 * The file a relative specifier names, or `undefined` when it names none.
 * Extensionless, `.js`→`.ts` (NodeNext), `index.ts` and asset forms all resolve.
 */
function resolveRelativeSpecifier(fromFile: string, specifier: string): string | undefined {
	if (!specifier.startsWith(".")) return undefined;
	const base = path.join(REPO_ROOT, fromFile, "..", specifier);
	const candidates = [`${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx"), base];
	if (specifier.endsWith(".js")) {
		const withoutJs = base.slice(0, -3);
		candidates.unshift(`${withoutJs}.ts`, `${withoutJs}.tsx`, path.join(withoutJs, "index.ts"));
	}
	for (const candidate of candidates) {
		try {
			if (fs.statSync(candidate).isFile()) return candidate;
		} catch {
			// Next candidate.
		}
	}
	return undefined;
}

function sweepTrackedImports(): ScanResult {
	const files = trackedSourceFiles();
	const project = new Project({ useInMemoryFileSystem: true });
	const dynamicFiles = new Set<string>();
	const typeFiles = new Set<string>();
	const missingRelative: MissingSpecifier[] = [];
	let relativeDynamicCount = 0;

	for (const relPath of files) {
		const fullPath = path.join(REPO_ROOT, relPath);
		const text = fs.readFileSync(fullPath, "utf-8");
		if (!/\bimport\s*\(/.test(text)) continue;

		const sourceFile = project.createSourceFile("probe.tsx", text, { overwrite: true });

		for (const call of sourceFile.getDescendantsOfKind(SyntaxKind.CallExpression)) {
			if (call.getExpression().getKind() !== SyntaxKind.ImportKeyword) continue;
			dynamicFiles.add(relPath);
			const argument = call.getArguments()[0];
			if (argument === undefined || !Node.isStringLiteral(argument)) continue;
			const specifier = argument.getLiteralText();
			if (!specifier.startsWith(".")) continue;
			relativeDynamicCount += 1;
			if (resolveRelativeSpecifier(relPath, specifier) === undefined) {
				missingRelative.push({ file: relPath, specifier });
			}
		}

		for (const _it of sourceFile.getDescendantsOfKind(SyntaxKind.ImportType)) {
			typeFiles.add(relPath);
		}

		project.removeSourceFile(sourceFile);
	}

	return {
		scannedCount: files.length,
		dynamicFiles: Array.from(dynamicFiles).sort(),
		typeFiles: Array.from(typeFiles).sort(),
		relativeDynamicCount,
		missingRelative,
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

	it("reaches a member tree that lives outside packages/", () => {
		expect(scannedRoots()).toContain("natives");
		expect(scan.dynamicFiles).toContain(
			"natives/bridge/bindings/test/a-source-tree-never-claims-to-be-compiled.test.ts",
		);
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

	it("resolves every relative dynamic import to a file that is there", () => {
		expect(scan.relativeDynamicCount).toBeGreaterThan(50);
		expect(scan.missingRelative).toEqual([]);
	});
});
