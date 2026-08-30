/**
 * AGENTS.md documents every workspace member, and ARCHITECTURE.md carries no duplicate table.
 *
 * WHY THIS SUITE EXISTS. Workspace tables drift when members are added or renamed without updating
 * documentation. This suite enforces that AGENTS.md describes every workspace member while
 * ARCHITECTURE.md refers to that single table. It does not check internal module exports or validate
 * the prose descriptions.
 *
 * WHY THE ROOTS ARE DERIVED. This gate used to name `packages/` and `crates/` literally, in two
 * copies of every cell. That held while those were the only two workspace roots, and stopped holding
 * the moment `contracts/` was added: a contract package could ship with no row and nothing would
 * fail, because the gate was looking somewhere else. So the roots come from the workspace manifests
 * themselves, via `scripts/workspace-layout.ts`, and every cell loops over whatever that returns.
 * Adding `plugins/*` or `hosts/*` to either manifest makes this suite demand rows for them with no
 * edit here.
 *
 * A literal, non-glob workspace entry (`python/veybot/web`) is a single member rather than a root and
 * is not covered: it is a build target for a client, not a first-party library, and the table has
 * never listed it. That is the gap this suite leaves.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { REPO_ROOT as repoRoot, type WorkspaceRoot, workspaceRoots } from "./workspace-layout";

/**
 * Shared TypeScript config living beside the packages it configures. One per TypeScript root.
 * Not a member, and the table must not grow a row for it.
 */
const NOT_A_PACKAGE: ReadonlySet<string> = new Set(["tsconfig.workspace.json"]);

/**
 * Vendored third-party code in the Cargo workspace (brush-core, brush-builtins, uutils crates, jaq).
 * Excluded from the first-party workspace documentation requirement.
 */
const NOT_A_CRATE: ReadonlySet<string> = new Set(["vendor"]);

/**
 * Entries under a root that are deliberately not members.
 *
 * Keyed by manifest rather than by directory name, so a new TypeScript root inherits the exemption
 * for the shared config it will also carry instead of failing on its first day.
 */
function exemptions(root: WorkspaceRoot): ReadonlySet<string> {
	return root.manifest === "Cargo.toml" ? NOT_A_CRATE : NOT_A_PACKAGE;
}

/** Member directory names under a root, by the presence of the root's manifest file. */
function memberNames(root: WorkspaceRoot): string[] {
	const full = path.join(repoRoot, root.directory);
	const names: string[] = [];
	for (const entry of readdirSync(full, { withFileTypes: true })) {
		if (exemptions(root).has(entry.name)) continue;
		if (!existsSync(path.join(full, entry.name, root.manifest))) continue;
		names.push(entry.name);
	}
	return names.sort();
}

/** Members a markdown table documents, keyed by the root directory each row names. */
function documentedMembers(file: string): Map<string, string[]> {
	const text = readFileSync(path.join(repoRoot, file), "utf-8");
	const byRoot = new Map<string, Set<string>>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("|")) continue;
		const firstCell = line.split("|")[1] ?? "";
		const hit = firstCell.match(/`([A-Za-z0-9._-]+)\/([A-Za-z0-9._-]+)`/);
		if (!hit?.[1] || !hit[2]) continue;
		const existing = byRoot.get(hit[1]) ?? new Set<string>();
		existing.add(hit[2]);
		byRoot.set(hit[1], existing);
	}
	return new Map([...byRoot].map(([root, names]) => [root, [...names].sort()]));
}

/** Documented members under one root, or none. */
function documentedUnder(file: string, directory: string): string[] {
	return documentedMembers(file).get(directory) ?? [];
}

const roots = workspaceRoots();

describe("workspace member coverage in AGENTS.md", () => {
	/**
	 * Anti-vacuity. Every cell below iterates `roots`, so a manifest this suite could not
	 * parse would leave the list empty and pass while documenting nothing. The named roots
	 * are the ones that exist today; the count floor is what makes a NEW root arrive
	 * covered rather than ignored.
	 */
	it("derives the workspace roots from the manifests that declare them", () => {
		const directories = roots.map(root => root.directory);
		expect(directories).toContain("contracts");
		expect(directories).toContain("packages");
		expect(directories).toContain("crates");
		expect(roots.length).toBeGreaterThanOrEqual(3);
	});

	it("finds members under every root on disk", () => {
		for (const root of roots) {
			expect(memberNames(root).length, `members under ${root.directory}/`).toBeGreaterThan(0);
		}
		expect(memberNames({ directory: "packages", manifest: "package.json" })).toContain("coding-agent");
		expect(memberNames({ directory: "crates", manifest: "Cargo.toml" })).toContain("veyyon-natives");
		expect(memberNames({ directory: "contracts", manifest: "package.json" })).toContain("wire");
	});

	it("AGENTS.md has a row for every workspace member", () => {
		const missing: string[] = [];
		for (const root of roots) {
			const documented = documentedUnder("AGENTS.md", root.directory);
			for (const name of memberNames(root)) {
				if (!documented.includes(name)) missing.push(`${root.directory}/${name}`);
			}
		}
		expect(missing, "add a row to the table in AGENTS.md").toEqual([]);
	});

	it("AGENTS.md has no row for a member that does not exist", () => {
		const stale: string[] = [];
		for (const root of roots) {
			const present = memberNames(root);
			for (const name of documentedUnder("AGENTS.md", root.directory)) {
				if (!present.includes(name)) stale.push(`${root.directory}/${name}`);
			}
		}
		expect(stale, "remove the stale row from AGENTS.md").toEqual([]);
	});

	it("keeps shared config and vendored entries out of AGENTS.md", () => {
		for (const root of roots) {
			const documented = documentedUnder("AGENTS.md", root.directory);
			for (const exempt of exemptions(root)) {
				expect(documented, `${root.directory}/${exempt} is not a member`).not.toContain(exempt);
			}
		}
	});

	it("has no entry under any root that is neither a member nor exempt", () => {
		const unexplained: string[] = [];
		for (const root of roots) {
			const full = path.join(repoRoot, root.directory);
			for (const entry of readdirSync(full, { withFileTypes: true })) {
				if (exemptions(root).has(entry.name)) continue;
				if (existsSync(path.join(full, entry.name, root.manifest))) continue;
				unexplained.push(`${root.directory}/${entry.name}`);
			}
		}
		expect(unexplained, "an entry under a workspace root with no manifest and no exemption").toEqual([]);
	});

	it("names an existing manifest path for every documented member in AGENTS.md", () => {
		for (const root of roots) {
			for (const name of documentedUnder("AGENTS.md", root.directory)) {
				const manifest = path.join(repoRoot, root.directory, name, root.manifest);
				expect(existsSync(manifest), `${root.directory}/${name}/${root.manifest}`).toBe(true);
			}
		}
	});

	it("ARCHITECTURE.md carries no member table, preventing duplication", () => {
		for (const root of roots) {
			expect(
				documentedUnder("ARCHITECTURE.md", root.directory),
				`ARCHITECTURE.md should not duplicate ${root.directory} rows`,
			).toEqual([]);
		}
	});
});
