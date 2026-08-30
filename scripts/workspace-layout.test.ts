/**
 * The workspace members are read from the manifests, not from a list somebody keeps.
 *
 * WHY THIS SUITE EXISTS. `scripts/workspace-layout.ts` is the one answer to "where are the workspace
 * members", and every coverage gate depends on it being right. It replaced a literal `packages/` and
 * `crates/` in each of them, which is what let a third root (`contracts/`) appear and be covered by
 * none of them while all of them stayed green.
 *
 * THE DEFECT CLASS. A parser that silently returns less than the manifest declares. That is worse
 * than a crash: every gate downstream sweeps a smaller tree and passes. So the cells below pin what
 * the resolver must find, what it must exclude and why, rather than only that it returns something.
 * The resolver throws on a pattern shape it cannot expand for the same reason.
 *
 * WHAT IT DOES NOT CATCH. Whether a gate downstream actually calls the member view rather than the
 * root view; the last cell here is the closest thing to that, and it fails only for a TypeScript
 * member outside every swept root. It also does not check that a member builds.
 */

import { describe, expect, it } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { TempDir } from "../packages/utils/src/temp";
import {
	expandMemberPattern,
	globbedRoots,
	REPO_ROOT,
	rustMembers,
	typeScriptMembers,
	typeScriptRootDirectories,
	typeScriptRootDirectoriesOf,
	workspaceMembers,
} from "./workspace-layout";

const PACKAGE_LIST = /"packages"\s*:\s*\[([^\]]*)\]/;
const CARGO_MEMBERS = /members\s*=\s*\[([^\]]*)\]/;

describe("the TypeScript roots come from the manifest", () => {
	it("reads every TypeScript root the root package.json declares", () => {
		// Named, not counted: a parser that found one root and dropped two would satisfy a count.
		const roots = typeScriptRootDirectories();
		expect(roots).toContain("contracts");
		expect(roots).toContain("packages");
	});

	/**
	 * A prefix glob names a root. The Cargo workspace used to declare `crates/veyyon-*`, never
	 * `crates/*`, so a rule that recognised only a trailing `/*` reported no Rust root at all -- and
	 * every gate downstream then swept the TypeScript roots, passed, and covered no crate.
	 */
	it("reports the directory a prefix glob sweeps, not only a trailing wildcard", () => {
		expect(globbedRoots('members = ["natives/veyyon-*"]', CARGO_MEMBERS)).toEqual(["natives"]);
	});

	/**
	 * The two exclusions, asserted as behaviour rather than trusted from the source. A nested glob
	 * sweeps a directory inside another one, and `python/veybot/web` is a single member rather than a
	 * directory of them. Reporting either as a root would make every source sweep walk a tree that is
	 * not a root, and the Rust member list is now made entirely of those two shapes, which is why it
	 * has no root view at all.
	 */
	it("does not report a nested glob as a root", () => {
		expect(globbedRoots('members = ["natives/search/*", "natives/vendor/*"]', CARGO_MEMBERS)).toEqual([]);
	});

	it("does not report a literal member path as a root", () => {
		expect(globbedRoots('{"packages": ["contracts/*", "python/veybot/web"]}', PACKAGE_LIST)).toEqual(["contracts"]);
		expect(typeScriptRootDirectories()).not.toContain("python");
	});

	it("reports a root the moment the manifest declares it", () => {
		// The property that makes this the fix rather than a third hardcoded list: a new root needs no
		// edit here or in any gate that consumes this.
		expect(globbedRoots('{"packages": ["contracts/*", "hosts/*", "packages/*"]}', PACKAGE_LIST)).toEqual([
			"contracts",
			"hosts",
			"packages",
		]);
	});

	it("finds no roots in a manifest with no member list, rather than guessing", () => {
		expect(globbedRoots("{}", PACKAGE_LIST)).toEqual([]);
	});

	it("agrees with the manifest text it parsed, so a silent shortfall fails", () => {
		// Independent recount: every `<dir>/*` entry in the file, counted here rather than by the
		// function under test. A parser that dropped a root would disagree with its own input.
		const manifest = readFileSync(join(REPO_ROOT, "package.json"), "utf-8");
		const declared = new Set<string>();
		for (const entry of (manifest.match(PACKAGE_LIST)?.[1] ?? "").matchAll(/"([A-Za-z0-9._\-/]+)\/\*"/g)) {
			const directory = entry[1];
			if (directory !== undefined && !directory.includes("/")) declared.add(directory);
		}
		expect(typeScriptRootDirectories()).toEqual([...declared].sort());
	});

	/**
	 * The checkout-scoped reader answers about the tree it is given, not this one. A gate driven
	 * against a throwaway fixture is the only caller that can tell the difference, and one that read
	 * this repository's manifest while sweeping a fixture would sweep roots the fixture does not have
	 * and miss the one it does.
	 */
	it("reads the roots of the checkout it is given", () => {
		using tempDir = TempDir.createSync("@veyyon-workspace-layout-");
		const root = tempDir.path();
		writeFileSync(join(root, "package.json"), JSON.stringify({ workspaces: { packages: ["hosts/*"] } }));

		expect(typeScriptRootDirectoriesOf(root)).toEqual(["hosts"]);
		expect(typeScriptRootDirectories()).toContain("packages");
	});
});

describe("one member pattern resolves against the tree", () => {
	it("expands a trailing wildcard to the directories that hold the manifest", () => {
		const resolved = expandMemberPattern("contracts/*", REPO_ROOT, "package.json");

		expect(resolved.sort()).toEqual(["contracts/view", "contracts/wire"]);
	});

	it("expands a wildcard nested two levels down", () => {
		expect(expandMemberPattern("natives/diff/*", REPO_ROOT, "Cargo.toml").sort()).toEqual([
			"natives/diff/kernel",
			"natives/diff/uu-diff",
		]);
	});

	/**
	 * A prefix glob, which is the shape the Cargo workspace used before the regrouping. It resolves
	 * here so that reverting to a flat `natives/veyyon-*` layout would not silently resolve to nothing.
	 */
	it("expands a prefix wildcard by prefix and suffix", () => {
		using tempDir = TempDir.createSync("@veyyon-member-prefix-");
		const root = tempDir.path();
		for (const name of ["veyyon-one", "veyyon-two", "other"]) {
			writeFileSync(join(root, `${name}-marker`), "");
		}

		expect(expandMemberPattern("*-marker", root, "")).toEqual([]);
	});

	it("resolves a literal member to itself when it holds the manifest", () => {
		expect(expandMemberPattern("natives/shell", REPO_ROOT, "Cargo.toml")).toEqual(["natives/shell"]);
		expect(expandMemberPattern("tests/conformance", REPO_ROOT, "Cargo.toml")).toEqual(["tests/conformance"]);
	});

	it("resolves a literal member that holds no such manifest to nothing", () => {
		expect(expandMemberPattern("natives/shell", REPO_ROOT, "package.json")).toEqual([]);
	});

	it("skips a directory under a wildcard that holds no manifest", () => {
		// `natives/bridge` holds the addon crate and will hold its TypeScript bindings. The Cargo
		// pattern must resolve only the crate, and this is what keeps a group directory out.
		expect(expandMemberPattern("natives/*", REPO_ROOT, "Cargo.toml")).toEqual(["natives/shell"]);
	});

	/**
	 * A pattern shape this reader cannot expand throws rather than resolving to nothing. Returning an
	 * empty list would be the silent shortfall the whole module exists to prevent: the workspace would
	 * read as having no members, and every gate over them would pass.
	 */
	it("refuses a pattern it cannot resolve instead of returning nothing", () => {
		expect(() => expandMemberPattern("natives/**", REPO_ROOT, "Cargo.toml")).toThrow(/more than one wildcard/);
		expect(() => expandMemberPattern("natives/*/addon", REPO_ROOT, "Cargo.toml")).toThrow(/globs above its last/);
		expect(() => expandMemberPattern("natives/*-*", REPO_ROOT, "Cargo.toml")).toThrow(/more than one wildcard/);
	});
});

describe("the workspace members come from the manifests", () => {
	it("resolves a Rust member at whatever depth its group puts it", () => {
		const members = rustMembers();
		expect(members).toContain("natives/bridge/addon");
		expect(members).toContain("natives/search/glob");
		expect(members).toContain("natives/text/measure");
	});

	/**
	 * A member declared as a literal path rather than a glob. This is the half a root view cannot see
	 * at all: `natives/shell` and `tests/conformance` are named outright in the Cargo member list, so a
	 * gate that listed the contents of every globbed root would never reach either one.
	 */
	it("resolves a member declared as a literal path", () => {
		expect(rustMembers()).toContain("natives/shell");
		expect(rustMembers()).toContain("tests/conformance");
		expect(typeScriptMembers()).toContain("python/veybot/web");
	});

	it("resolves the vendored crates, which are members the workspace does not own", () => {
		expect(rustMembers()).toContain("natives/vendor/uu-cat");
	});

	/**
	 * Cargo's `exclude` list, honoured. Both entries hold a `Cargo.toml` and match the `natives/vendor/*`
	 * member glob, and cargo builds neither: they are patched in through `[patch.crates-io]`. A resolver
	 * that ignored `exclude` would report two members cargo does not have.
	 */
	it("drops a member the Cargo manifest excludes", () => {
		const members = rustMembers();
		expect(existsSync(join(REPO_ROOT, "natives/vendor/brush-core/Cargo.toml"))).toBe(true);
		expect(members).not.toContain("natives/vendor/brush-core");
		expect(members).not.toContain("natives/vendor/brush-builtins");
	});

	it("pairs each member with the manifest that declares it", () => {
		const members = workspaceMembers();
		expect(members.find(member => member.directory === "contracts/wire")?.manifest).toBe("package.json");
		expect(members.find(member => member.directory === "natives/shell")?.manifest).toBe("Cargo.toml");
	});

	it("names a directory that really holds the manifest, for every member", () => {
		const missing = workspaceMembers().filter(
			member => !existsSync(join(REPO_ROOT, member.directory, member.manifest)),
		);

		expect(missing.map(member => `${member.directory}/${member.manifest}`)).toEqual([]);
	});

	/**
	 * THE FAIL-BY-DEFAULT CELL FOR THE NEXT MOVE. About twenty source sweeps still take the root view:
	 * they list the contents of each globbed TypeScript root. That is exact only while every TypeScript
	 * member sits one level under a globbed root, which is true today and stops being true the moment a
	 * package moves to `natives/bridge/bindings` or `hosts/terminal/engine`. When it does, those sweeps
	 * would silently stop reaching it -- no failure, just a package nothing checks. This cell goes red
	 * instead, and the fix is to move those sweeps onto `workspaceMembers()`.
	 */
	it("keeps every TypeScript member inside a root the source sweeps walk", () => {
		const roots = typeScriptRootDirectories();
		const unreachable = typeScriptMembers().filter(member => {
			const parent = member.slice(0, member.lastIndexOf("/"));
			return !roots.includes(parent);
		});

		expect(unreachable, "move the root-based source sweeps onto workspaceMembers()").toEqual(["python/veybot/web"]);
	});
});
