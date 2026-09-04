/**
 * AGENTS.md documents every workspace member, and ARCHITECTURE.md carries no duplicate table.
 *
 * WHY THIS SUITE EXISTS. Workspace tables drift when members are added or renamed without updating
 * documentation. This suite enforces that AGENTS.md describes every workspace member while
 * ARCHITECTURE.md refers to that single table. It does not check internal module exports or validate
 * the prose descriptions.
 *
 * WHY THE MEMBERS ARE RESOLVED. This gate used to name `packages/` and `crates/` literally, then read
 * the two root directories out of the manifests and list what sat inside each. Both forms assumed a
 * member is a directory one level under a root, which stopped being true when the Rust tree moved to
 * `natives/` grouped by purpose: `natives/search/glob` is two levels down, and `natives/shell` and
 * `tests/conformance` are declared as literal paths, so a root listing returns the group directories
 * and never reaches a crate at all. It would not have failed — it would have demanded rows for
 * `natives/search` and passed once they existed, documenting nothing that ships.
 *
 * So the member list comes from `scripts/workspace-layout.ts`, which expands each manifest's member
 * patterns against the filesystem and returns what the package managers themselves resolve. A member
 * at any depth, declared by a glob or by a literal path, arrives covered. Adding `plugins/*` or
 * `hosts/terminal/*` to either manifest makes this suite demand rows for them with no edit here.
 *
 * WHAT IT DOES NOT CATCH. It compares paths and rows, never prose: a row whose description is wrong,
 * stale, or describes a different member reads as covered.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import * as path from "node:path";
import { memberTopLevels, REPO_ROOT as repoRoot, workspaceMembers } from "./workspace-layout";

/** Every manifest that makes a directory a workspace member. */
const MANIFESTS: readonly string[] = ["package.json", "Cargo.toml"];

/**
 * Directory names a member sweep never descends into.
 *
 * `node_modules` and `target` hold installed and compiled third-party manifests by the thousand, and
 * neither is part of this workspace.
 */
const NEVER_A_MEMBER: ReadonlySet<string> = new Set(["node_modules", "target", "dist", ".git"]);

/**
 * Workspace members the table deliberately does not list, each with the reason.
 *
 * Pinned as paths rather than counted, and asserted to be real members below, so a stale entry fails
 * instead of quietly exempting nothing. A member absent from both this map and the table fails: that
 * is what makes a new member arrive documented.
 */
const UNDOCUMENTED: ReadonlyMap<string, string> = new Map([
	[
		"python/veybot/web",
		"A build target for the Python client's web assets rather than a first-party library, and the table has never listed it.",
	],
]);

/** Vendored third-party code: a workspace member the workspace does not own and does not document. */
function isVendored(directory: string): boolean {
	return directory.split("/").includes("vendor");
}

const members = workspaceMembers();
const firstParty = members.filter(member => !isVendored(member.directory));
const documentable = firstParty.filter(member => !UNDOCUMENTED.has(member.directory));

/**
 * Member paths a markdown table documents.
 *
 * A row counts only when its first cell is exactly one backticked path, which is the shape every row
 * of the member table has. A cell holding prose, or a command, or two spans, is not a member row.
 *
 * A member path may be one segment. It could not be until `kernel` became a workspace member at the
 * repository root: the pattern required a slash, so a root member was documented and still read as
 * undocumented. The relaxation adds exactly one match across both files, which is that row.
 */
function documentedMembers(file: string): string[] {
	const text = readFileSync(path.join(repoRoot, file), "utf-8");
	const documented = new Set<string>();
	for (const line of text.split("\n")) {
		if (!line.startsWith("|")) continue;
		const firstCell = (line.split("|")[1] ?? "").trim();
		const hit = firstCell.match(/^`([A-Za-z0-9._-]+(?:\/[A-Za-z0-9._-]+)*)`$/);
		if (!hit?.[1]) continue;
		documented.add(hit[1]);
	}
	return [...documented].sort();
}

/** Every directory under `directory` that holds a workspace manifest, without descending into one. */
function manifestDirectories(directory: string, found: string[]): string[] {
	const full = path.join(repoRoot, directory);
	if (!existsSync(full)) return found;
	for (const entry of readdirSync(full, { withFileTypes: true })) {
		if (!entry.isDirectory() || NEVER_A_MEMBER.has(entry.name)) continue;
		const child = `${directory}/${entry.name}`;
		if (MANIFESTS.some(manifest => existsSync(path.join(repoRoot, child, manifest)))) {
			found.push(child);
			continue;
		}
		manifestDirectories(child, found);
	}
	return found;
}

describe("workspace member coverage in AGENTS.md", () => {
	/**
	 * Anti-vacuity. Every cell below iterates the resolved member list, so a manifest this suite could
	 * not parse would leave it empty and pass while documenting nothing. The named members are the ones
	 * that exist today, one per shape the resolver has to handle: a one-level glob, a two-level glob, a
	 * literal path, and a Rust member outside `packages/`.
	 */
	it("resolves the workspace members from the manifests that declare them", () => {
		const directories = members.map(member => member.directory);
		expect(directories).toContain("packages/coding-agent");
		expect(directories).toContain("contracts/wire");
		expect(directories).toContain("natives/bridge/addon");
		expect(directories).toContain("natives/search/glob");
		expect(directories).toContain("natives/shell");
		expect(directories).toContain("tests/conformance");
		expect(directories).toContain("python/veybot/web");
		expect(members.length).toBeGreaterThanOrEqual(30);
	});

	/**
	 * Every top-level directory holding a member is swept by the undeclared-manifest cell below. A new
	 * root the member list reaches is covered with no edit here; this cell is what goes red if the
	 * derivation ever narrows back to a named list.
	 */
	it("sweeps every top-level directory the member list reaches", () => {
		expect(memberTopLevels()).toEqual([
			"contracts",
			"hosts",
			"kernel",
			"natives",
			"packages",
			"plugins",
			"python",
			"tests",
		]);
	});

	it("AGENTS.md has a row for every workspace member", () => {
		const documented = documentedMembers("AGENTS.md");
		const missing = documentable.filter(member => !documented.includes(member.directory));
		expect(
			missing.map(member => member.directory),
			"add a row to the table in AGENTS.md",
		).toEqual([]);
	});

	it("AGENTS.md has no row for a member that does not exist", () => {
		const present = new Set(firstParty.map(member => member.directory));
		const stale = documentedMembers("AGENTS.md").filter(documented => !present.has(documented));
		expect(stale, "remove the stale row from AGENTS.md").toEqual([]);
	});

	it("names an existing manifest path for every documented member in AGENTS.md", () => {
		const byDirectory = new Map(members.map(member => [member.directory, member.manifest]));
		for (const documented of documentedMembers("AGENTS.md")) {
			const manifest = byDirectory.get(documented);
			expect(manifest, `${documented} is documented but is not a workspace member`).toBeDefined();
			expect(existsSync(path.join(repoRoot, documented, manifest ?? "")), `${documented}/${manifest}`).toBe(true);
		}
	});

	/**
	 * A directory holding a manifest that no member list resolves to is a member nothing reaches: it is
	 * not documented here, not type-checked, and not tested, and every one of those gates reads green
	 * because each asks the manifests what to cover. The sweep skips a member's own subtree, so it walks
	 * the group directories and stops, and it is what turns a crate added under `natives/search/` but
	 * left out of `members` into a red gate.
	 */
	it("has no manifest under a member directory that the workspace does not declare", () => {
		const declared = new Set(members.map(member => member.directory));
		const undeclared: string[] = [];
		for (const top of memberTopLevels()) {
			for (const directory of manifestDirectories(top, [])) {
				if (declared.has(directory) || isVendored(directory)) continue;
				undeclared.push(directory);
			}
		}
		expect(undeclared, "declare it in package.json or Cargo.toml, or move it out of the workspace").toEqual([]);
	});

	it("exempts from documentation only members that exist", () => {
		const present = new Set(members.map(member => member.directory));
		for (const [directory, reason] of UNDOCUMENTED) {
			expect(present.has(directory), `${directory} is exempt from the table but is not a member`).toBe(true);
			expect(reason.length, `${directory} needs a reason`).toBeGreaterThan(20);
		}
	});

	it("keeps vendored crates out of AGENTS.md", () => {
		const vendored = members.filter(member => isVendored(member.directory));
		expect(vendored.length, "the vendored tree resolved to no members").toBeGreaterThan(0);
		const documented = documentedMembers("AGENTS.md");
		for (const member of vendored) {
			expect(documented, `${member.directory} is vendored third-party code`).not.toContain(member.directory);
		}
	});

	it("ARCHITECTURE.md carries no member table, preventing duplication", () => {
		const documented = documentedMembers("ARCHITECTURE.md");
		const duplicated = documented.filter(entry => members.some(member => member.directory === entry));
		expect(duplicated, "ARCHITECTURE.md should refer to the table in AGENTS.md").toEqual([]);
	});
});
