/**
 * The workspace roots are read from the manifests, not from a list somebody keeps.
 *
 * WHY THIS SUITE EXISTS. `scripts/workspace-layout.ts` is the one answer to "where are the workspace
 * members", and three coverage gates depend on it being right. It replaced a literal `packages/` and
 * `crates/` in each of them, which is what let a third root (`contracts/`) appear and be covered by
 * none of the three while all three stayed green.
 *
 * THE DEFECT CLASS. A parser that silently returns less than the manifest declares. That is worse
 * than a crash: every gate downstream sweeps a smaller tree and passes. So the cells below pin what
 * the parser must find, what it must exclude and why, rather than only that it returns something.
 *
 * WHAT IT DOES NOT CATCH. A root declared in the manifest whose directory does not exist, which is a
 * broken workspace the package manager itself rejects, and a member excluded by a glob more specific
 * than `<dir>/*`, which this repository does not use.
 */

import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
	globbedRoots,
	REPO_ROOT,
	rustRootDirectories,
	typeScriptRootDirectories,
	workspaceRoots,
} from "./workspace-layout";

const PACKAGE_LIST = /"packages"\s*:\s*\[([^\]]*)\]/;
const CARGO_MEMBERS = /members\s*=\s*\[([^\]]*)\]/;

describe("the workspace roots come from the manifests", () => {
	it("reads every TypeScript root the root package.json declares", () => {
		// Named, not counted: a parser that found one root and dropped two would satisfy a count.
		const roots = typeScriptRootDirectories();
		expect(roots).toContain("contracts");
		expect(roots).toContain("packages");
	});

	it("reads the Rust root the Cargo workspace declares", () => {
		expect(rustRootDirectories()).toEqual(["crates"]);
	});

	it("pairs each root with the manifest that identifies a member there", () => {
		const roots = workspaceRoots();
		const contracts = roots.find(root => root.directory === "contracts");
		const crates = roots.find(root => root.directory === "crates");
		expect(contracts?.manifest).toBe("package.json");
		expect(crates?.manifest).toBe("Cargo.toml");
	});

	/**
	 * A prefix glob names a root. The Cargo workspace declares `crates/veyyon-*`, never `crates/*`, so
	 * a rule that recognised only a trailing `/*` reported no Rust root at all -- and every gate
	 * downstream then swept the TypeScript roots, passed, and covered no crate.
	 */
	it("reports the directory a prefix glob sweeps, not only a trailing wildcard", () => {
		expect(globbedRoots('members = ["crates/veyyon-*"]', CARGO_MEMBERS)).toEqual(["crates"]);
	});

	/**
	 * The two exclusions, asserted as behaviour rather than trusted from the source. `crates/vendor/*`
	 * is vendored third-party code inside an existing root, and `python/veybot/web` is a single member
	 * rather than a directory of them. Reporting either as a root would make every downstream gate
	 * demand documentation rows and test buckets for things that are not first-party members.
	 */
	it("does not report a nested glob as a root", () => {
		expect(globbedRoots('members = ["crates/veyyon-*", "crates/vendor/*"]', CARGO_MEMBERS)).toEqual(["crates"]);
		expect(rustRootDirectories()).not.toContain("vendor");
		expect(rustRootDirectories()).not.toContain("crates/vendor");
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
});
