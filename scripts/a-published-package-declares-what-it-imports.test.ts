/**
 * A publishable package's manifest names every workspace package its SHIPPED source imports.
 *
 * WHY THIS SUITE EXISTS. `@veyyon/hashline` published `prompts/registry`, which imports
 * `definePromptRegistry` from `@veyyon/utils`, while declaring `@veyyon/utils` under
 * `devDependencies` only. Inside this workspace that resolves: every package is linked into one
 * `node_modules` regardless of which manifest asked for it, so the type check passes, the tests
 * pass, and the import works from the first day it is written. It breaks for the only person who
 * ever sees it, an installer outside the workspace, whose package manager reads the manifest,
 * skips dev dependencies, and hands them a module that cannot resolve its own import.
 *
 * That is a defect no in-repo behavior test can reach, because the thing that is wrong is the
 * manifest rather than the code, and the workspace layout is exactly what hides it. It is the
 * packaging class AGENTS.md names as the legitimate use for an existence check.
 *
 * Scoped to `@veyyon/*` on purpose. Third-party dependency truth is a different question with
 * different rules (hoisting, transitive availability, `@types/*`), and answering it here would
 * make the suite noisy enough to be turned off.
 */

import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Glob } from "bun";
import { moduleSpecifiersIn } from "@veyyon/utils/module-reach";

const PACKAGES = path.resolve(import.meta.dir, "..", "packages");

interface Manifest {
	name?: string;
	private?: boolean;
	dependencies?: Record<string, string>;
	peerDependencies?: Record<string, string>;
	devDependencies?: Record<string, string>;
}

/** The workspace package name a specifier belongs to, or undefined for anything else. */
function workspacePackageOf(specifier: string): string | undefined {
	if (!specifier.startsWith("@veyyon/")) return undefined;
	const [scope, name] = specifier.split("/");
	return scope && name ? `${scope}/${name}` : undefined;
}

/** Publishable packages only: a private one is never installed from a registry. */
function publishablePackages(): Array<{ dir: string; manifest: Manifest }> {
	const found: Array<{ dir: string; manifest: Manifest }> = [];
	for (const entry of fs.readdirSync(PACKAGES, { withFileTypes: true })) {
		if (!entry.isDirectory()) continue;
		const manifestPath = path.join(PACKAGES, entry.name, "package.json");
		if (!fs.existsSync(manifestPath)) continue;
		const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Manifest;
		if (manifest.private || !manifest.name) continue;
		found.push({ dir: path.join(PACKAGES, entry.name), manifest });
	}
	return found;
}

/**
 * Shipped source: `src/`, minus tests and fixtures. A test file may import anything it likes from
 * a dev dependency, which is what dev dependencies are.
 */
function shippedSources(dir: string): string[] {
	const src = path.join(dir, "src");
	if (!fs.existsSync(src)) return [];
	const files: string[] = [];
	for (const rel of new Glob("**/*.{ts,tsx,js}").scanSync(src)) {
		if (/\.(test|spec)\.[tj]sx?$/.test(rel)) continue;
		if (rel.split(path.sep).includes("__tests__")) continue;
		files.push(path.join(src, rel));
	}
	return files;
}

describe("every publishable package declares the workspace packages it imports", () => {
	const packages = publishablePackages();

	// Non-vacuity: the walk has to find packages and sources, or an empty scan reports success.
	it("finds publishable packages with shipped source to scan", () => {
		expect(packages.length).toBeGreaterThan(3);
		const scanned = packages.reduce((total, pkg) => total + shippedSources(pkg.dir).length, 0);
		expect(scanned).toBeGreaterThan(100);
	});

	it("has no shipped import of a workspace package the manifest leaves undeclared", () => {
		const offenders: string[] = [];
		for (const { dir, manifest } of packages) {
			const declared = new Set([
				...Object.keys(manifest.dependencies ?? {}),
				...Object.keys(manifest.peerDependencies ?? {}),
			]);
			for (const file of shippedSources(dir)) {
				for (const specifier of moduleSpecifiersIn(fs.readFileSync(file, "utf8"))) {
					const pkg = workspacePackageOf(specifier);
					if (!pkg || pkg === manifest.name || declared.has(pkg)) continue;
					const where = Object.keys(manifest.devDependencies ?? {}).includes(pkg)
						? "only a devDependency"
						: "not declared at all";
					offenders.push(`${manifest.name}: ${path.relative(dir, file)} imports ${pkg}, ${where}`);
				}
			}
		}

		expect([...new Set(offenders)].sort()).toEqual([]);
	});
});
