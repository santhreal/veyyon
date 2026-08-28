/**
 * Both package maps describe every package, and neither describes one that does not exist.
 *
 * WHY THIS SUITE EXISTS. `ARCHITECTURE.md` and `AGENTS.md` each carry a table of packages, and both
 * are read as the map of the repository — `AGENTS.md` is loaded into an agent's context, so its table
 * is what an agent believes the repository contains. Both had been written when there were nine
 * packages and never revisited: ten of the eighteen were missing from both, including every one added
 * in the last year (`argot`, `hashline`, `mnemopi`, `wire`, `tool-render`, `collab-web`,
 * `swarm-extension`, `metaharness`, `deepswe-bench`, `typescript-edit-benchmark`).
 *
 * Omission is the failure mode that does not announce itself. A missing row does not read as
 * "incomplete map", it reads as "that package is not part of this repository", so an agent looking for
 * somewhere to put a patch language writes a second one, and a person auditing the tree does not know
 * the package is there to audit. That is the same class of defect as a stale row naming a package that
 * was deleted, and both directions are asserted below.
 *
 * The check is the only thing that keeps this from happening again. Adding a package is the moment the
 * tables go stale, and nothing about adding one prompts anybody to open a markdown table, so the
 * prompt has to be a failing test in the same change.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";

const repoRoot = path.resolve(import.meta.dir, "..");

/**
 * Entries under `packages/` that are not packages.
 *
 * `tsconfig.workspace.json` is shared TypeScript configuration that sits among the packages so a
 * relative `extends` works. It has no manifest, which is how the check recognises it; the name is
 * listed here as well so a future file cannot silently join the exemption by also lacking one.
 */
const NOT_A_PACKAGE: ReadonlySet<string> = new Set(["tsconfig.workspace.json"]);

/** Directory names under `packages/` that carry a `package.json`, so they are workspace members. */
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

/**
 * Every `packages/<name>` path named in a leading table cell of the given document.
 *
 * Read from the first cell only, so a package mentioned in prose or in another row's description
 * does not count as documented. A row is the promise that the package has a stated responsibility.
 */
function documentedPackages(file: string): string[] {
	const text = readFileSync(path.join(repoRoot, file), "utf-8");
	const names = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("|")) continue;
		const firstCell = line.split("|")[1] ?? "";
		const match = firstCell.match(/`packages\/([A-Za-z0-9._-]+)`/);
		if (match?.[1]) names.add(match[1]);
	}
	return [...names].sort();
}

const MAPS = ["ARCHITECTURE.md", "AGENTS.md"] as const;
const packages = packageDirNames();

describe("the package tables", () => {
	it("finds the packages to check, so an empty scan cannot pass vacuously", () => {
		// The guard on the guard. If `packageDirNames` ever stopped matching (a layout change, a
		// bad exemption), every assertion below would pass against an empty set and this suite
		// would report coverage it never checked.
		expect(packages.length).toBeGreaterThan(10);
		expect(packages).toContain("coding-agent");
		expect(packages).toContain("utils");
	});

	for (const file of MAPS) {
		it(`${file} has a row for every package`, () => {
			const documented = documentedPackages(file);
			const missing = packages.filter(name => !documented.includes(name));

			expect(missing, `add a row to the package table in ${file}`).toEqual([]);
		});

		it(`${file} has no row for a package that does not exist`, () => {
			// The other direction. A row naming a deleted or renamed package is worse than a
			// missing one: it sends the reader to a path that is not there. `packages/lexpack`
			// became `packages/argot` while both tables named neither, which is how a rename
			// goes unnoticed.
			const documented = documentedPackages(file);
			const stale = documented.filter(name => !packages.includes(name));

			expect(stale, `remove or repoint the stale row in ${file}`).toEqual([]);
		});
	}

	it("describes the same set of packages in both maps", () => {
		// Two maps that disagree are worse than one: a reader cannot tell which is current, and
		// the wrong one is whichever they happened to open.
		expect(documentedPackages("AGENTS.md")).toEqual(documentedPackages("ARCHITECTURE.md"));
	});

	it("keeps the shared tsconfig out of both tables, since it is not a package", () => {
		// It has no manifest, no sources, and nothing to say about responsibility. Documenting it
		// as a package would be the map claiming something false.
		for (const file of MAPS) {
			expect(documentedPackages(file)).not.toContain("tsconfig.workspace.json");
		}
	});

	it("has no entry under packages/ that is neither a package nor a named exemption", () => {
		// Closes the hole in this suite's own helper. `packageDirNames` skips anything without a
		// manifest, which is how the shared tsconfig is recognised — but a silent skip means a
		// directory that lost its `package.json`, or a stray directory somebody dropped in, would
		// simply stop being checked and neither table would be asked to describe it. So the skip
		// has to be justified by name.
		const packagesDir = path.join(repoRoot, "packages");
		const unexplained = readdirSync(packagesDir, { withFileTypes: true })
			.filter(entry => !NOT_A_PACKAGE.has(entry.name))
			.filter(entry => !existsSync(path.join(packagesDir, entry.name, "package.json")))
			.map(entry => entry.name);

		expect(unexplained, "add a package.json, or name it in NOT_A_PACKAGE with a reason").toEqual([]);
	});

	it("names a path that exists for every documented package", () => {
		// Cheap and worth stating separately from the staleness test: it catches a typo in a row
		// added by hand, which staleness alone would report as an unknown package.
		for (const file of MAPS) {
			for (const name of documentedPackages(file)) {
				expect(existsSync(path.join(repoRoot, "packages", name, "package.json")), `${file}: ${name}`).toBe(true);
			}
		}
	});
});
