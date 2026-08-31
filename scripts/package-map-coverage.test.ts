/**
 * AGENTS.md documents every workspace package and crate, and ARCHITECTURE.md carries no duplicate table.
 *
 * WHY THIS SUITE EXISTS. Workspace tables drift when packages or crates are added or renamed without updating documentation.
 * This suite enforces that AGENTS.md describes every workspace member while ARCHITECTURE.md refers to that single table.
 * It does not check internal module exports or validate the prose descriptions.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

const NOT_A_PACKAGE: ReadonlySet<string> = new Set(["tsconfig.workspace.json"]);

/**
 * Vendored third-party code in the Cargo workspace (brush-core, brush-builtins, uutils crates, jaq).
 * Excluded from the first-party workspace documentation requirement.
 */
const NOT_A_CRATE: ReadonlySet<string> = new Set(["vendor"]);

function packageDirNames(): string[] {
	const packagesDir = path.join(repoRoot, "packages");
	const names: string[] = [];
	for (const entry of readdirSync(packagesDir, { withFileTypes: true })) {
		if (NOT_A_PACKAGE.has(entry.name)) continue;
		if (!existsSync(path.join(packagesDir, entry.name, "package.json"))) continue;
		names.push(entry.name);
	}
	return names.sort();
}

function crateDirNames(): string[] {
	const cratesDir = path.join(repoRoot, "crates");
	const names: string[] = [];
	for (const entry of readdirSync(cratesDir, { withFileTypes: true })) {
		if (NOT_A_CRATE.has(entry.name)) continue;
		if (!existsSync(path.join(cratesDir, entry.name, "Cargo.toml"))) continue;
		names.push(entry.name);
	}
	return names.sort();
}

function documentedMembers(file: string): { packages: string[]; crates: string[] } {
	const text = readFileSync(path.join(repoRoot, file), "utf-8");
	const packages = new Set<string>();
	const crates = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("|")) continue;
		const firstCell = line.split("|")[1] ?? "";
		const pkgMatch = firstCell.match(/`packages\/([A-Za-z0-9._-]+)`/);
		if (pkgMatch?.[1]) packages.add(pkgMatch[1]);
		const crateMatch = firstCell.match(/`crates\/([A-Za-z0-9._-]+)`/);
		if (crateMatch?.[1]) crates.add(crateMatch[1]);
	}
	return {
		packages: [...packages].sort(),
		crates: [...crates].sort(),
	};
}

const packages = packageDirNames();
const crates = crateDirNames();

describe("workspace member coverage in AGENTS.md", () => {
	it("finds packages and crates on disk", () => {
		expect(packages.length).toBeGreaterThan(10);
		expect(packages).toContain("coding-agent");
		expect(packages).toContain("utils");

		expect(crates.length).toBeGreaterThan(10);
		expect(crates).toContain("veyyon-natives");
		expect(crates).toContain("veyyon-conformance");
	});

	it("AGENTS.md has a row for every workspace package", () => {
		const documented = documentedMembers("AGENTS.md").packages;
		const missing = packages.filter(name => !documented.includes(name));
		expect(missing, "add a row to the table in AGENTS.md").toEqual([]);
	});

	it("AGENTS.md has no row for a package that does not exist", () => {
		const documented = documentedMembers("AGENTS.md").packages;
		const stale = documented.filter(name => !packages.includes(name));
		expect(stale, "remove stale package row from AGENTS.md").toEqual([]);
	});

	it("AGENTS.md has a row for every workspace crate", () => {
		const documented = documentedMembers("AGENTS.md").crates;
		const missing = crates.filter(name => !documented.includes(name));
		expect(missing, "add a row to the table in AGENTS.md").toEqual([]);
	});

	it("AGENTS.md has no row for a crate that does not exist", () => {
		const documented = documentedMembers("AGENTS.md").crates;
		const stale = documented.filter(name => !crates.includes(name));
		expect(stale, "remove stale crate row from AGENTS.md").toEqual([]);
	});

	it("keeps non-package and vendored entries out of AGENTS.md", () => {
		const doc = documentedMembers("AGENTS.md");
		expect(doc.packages).not.toContain("tsconfig.workspace.json");
		expect(doc.crates).not.toContain("vendor");
	});

	it("has no entry under packages/ or crates/ that is unmanaged or unexempted", () => {
		const packagesDir = path.join(repoRoot, "packages");
		const unexplainedPackages = readdirSync(packagesDir, { withFileTypes: true })
			.filter(entry => !NOT_A_PACKAGE.has(entry.name))
			.filter(entry => !existsSync(path.join(packagesDir, entry.name, "package.json")))
			.map(entry => entry.name);
		expect(unexplainedPackages, "unexplained entry under packages/").toEqual([]);

		const cratesDir = path.join(repoRoot, "crates");
		const unexplainedCrates = readdirSync(cratesDir, { withFileTypes: true })
			.filter(entry => !NOT_A_CRATE.has(entry.name))
			.filter(entry => !existsSync(path.join(cratesDir, entry.name, "Cargo.toml")))
			.map(entry => entry.name);
		expect(unexplainedCrates, "unexplained entry under crates/").toEqual([]);
	});

	it("names an existing manifest path for every documented member in AGENTS.md", () => {
		const doc = documentedMembers("AGENTS.md");
		for (const name of doc.packages) {
			expect(existsSync(path.join(repoRoot, "packages", name, "package.json")), `packages/${name}`).toBe(true);
		}
		for (const name of doc.crates) {
			expect(existsSync(path.join(repoRoot, "crates", name, "Cargo.toml")), `crates/${name}`).toBe(true);
		}
	});

	it("ARCHITECTURE.md carries no member table, preventing duplication", () => {
		const doc = documentedMembers("ARCHITECTURE.md");
		expect(doc.packages, "ARCHITECTURE.md should not duplicate package rows").toEqual([]);
		expect(doc.crates, "ARCHITECTURE.md should not duplicate crate rows").toEqual([]);
	});
});
