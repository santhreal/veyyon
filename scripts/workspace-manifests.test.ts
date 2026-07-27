/**
 * The workspace manifest contract: one version, one pin per shared dependency.
 *
 * WHY THIS SUITE EXISTS. Cargo lets a workspace member opt out of
 * `[workspace.package]` and `[workspace.dependencies]` silently, and three
 * crates here did: `veyyon-uu-diff`, `veyyon-uu-grep` and `veyyon-uutils-ctx`
 * carried their own versions (0.8.0 and 0.1.0 against the workspace's 1.0.37),
 * their own `clap`, `ignore`, `globset`, `libc` and `grep-*` pins, and package
 * names spelled with underscores while every other crate and every directory
 * used hyphens. The skew was not theoretical. `veyyon-uu-grep` declared
 * `serde_json = "1"` where the workspace declares it with `preserve_order`, and
 * because feature unification depends on which crates are in the build, the JSON
 * summary record that builtin prints had one key order in a single-crate build
 * and another in a workspace build.
 *
 * A `cargo build` cannot fail on any of that, so these tests read the manifests
 * as data and assert the contract directly. Each one names the failure it
 * prevents rather than restating the rule.
 */
import { describe, expect, it } from "bun:test";
import {
	firstPartyCrateDirs,
	pinsItsOwnVersion,
	readCrateManifest,
	workspaceDependencyNames,
} from "./workspace-manifests";

/** Crates that shared dependencies with the workspace before they were folded in. */
const FOLDED_IN = ["veyyon-uu-diff", "veyyon-uu-grep", "veyyon-uutils-ctx"];

describe("every first-party crate inherits the workspace version", () => {
	/**
	 * The version skew itself. A crate on its own version stays on it through
	 * every workspace bump, and nothing reports that: `cargo metadata` resolves,
	 * the build passes, and the release carries two version numbers.
	 */
	it("declares version.workspace = true and never a literal", () => {
		const offenders = firstPartyCrateDirs()
			.map(readCrateManifest)
			.filter(crate => crate.version !== "workspace = true")
			.map(crate => `${crate.dir} pins ${crate.version}`);

		expect(offenders).toEqual([]);
	});

	/**
	 * The three crates that were outside, checked BY NAME so the test above cannot
	 * pass by finding no crates at all. This is the non-vacuity guard for the
	 * whole suite: a broken directory scan or a parser that returns nothing would
	 * make every other assertion here trivially true.
	 */
	it("includes the three crates this contract was written for", () => {
		for (const dir of FOLDED_IN) {
			const crate = readCrateManifest(dir);
			expect(crate.version).toBe("workspace = true");
		}
	});
});

describe("a package name matches its directory", () => {
	/**
	 * `veyyon_uu_grep` in a directory called `veyyon-uu-grep` is not a style nit:
	 * it is what forced `fuzz/Cargo.toml` to carry a `package = "veyyon_uu_grep"`
	 * remap, and it means `cargo test -p veyyon-uu-grep` fails with "did not match
	 * any packages" for anybody who spells the crate the way the tree does.
	 */
	it("uses the hyphenated directory name as the package name", () => {
		const mismatched = firstPartyCrateDirs()
			.map(readCrateManifest)
			.filter(crate => crate.name !== crate.dir)
			.map(crate => `${crate.dir} is packaged as ${crate.name}`);

		expect(mismatched).toEqual([]);
	});
});

describe("a shared dependency is pinned in one place", () => {
	/**
	 * The `serde_json` bug generalized. Any dependency the root declares must be
	 * inherited rather than re-declared, because a local copy is free to specify a
	 * different version OR a different feature set, and the feature half is the
	 * one that changes behaviour without changing a version number anywhere.
	 */
	it("inherits every dependency the root workspace declares", () => {
		const shared = workspaceDependencyNames();
		const offenders: string[] = [];
		for (const dir of firstPartyCrateDirs()) {
			const crate = readCrateManifest(dir);
			for (const [name, declaration] of crate.dependencies) {
				if (shared.has(name) && pinsItsOwnVersion(declaration)) {
					offenders.push(`${crate.dir} re-declares ${name} as ${declaration.trim()}`);
				}
			}
		}

		expect(offenders).toEqual([]);
	});

	/**
	 * Adding a feature on top of the inherited pin is allowed, and this pins that
	 * it is: `veyyon-uu-diff` needs clap's `wrap_help` where the workspace asks
	 * only for `derive`. The version still comes from one place, which is the
	 * property that matters, so a rule that banned the whole shape would push the
	 * crate back to its own pin and lose more than it gained.
	 */
	it("allows extra features on top of an inherited pin", () => {
		const clap = readCrateManifest("veyyon-uu-diff").dependencies.get("clap");

		expect(clap).toBeDefined();
		expect(clap).toContain("wrap_help");
		expect(pinsItsOwnVersion(clap ?? "")).toBe(false);
	});

	/**
	 * The predicate itself, on both shapes it must separate. It is the only piece
	 * of judgment in this file, and a mistake in it would silently pass every
	 * offender in the test above.
	 */
	it("tells an inherited pin from a local one", () => {
		expect(pinsItsOwnVersion(".workspace = true")).toBe(false);
		expect(pinsItsOwnVersion(' = { workspace = true, features = ["x"] }')).toBe(false);
		expect(pinsItsOwnVersion(' = "0.4"')).toBe(true);
		expect(pinsItsOwnVersion(' = { version = "4", features = ["derive"] }')).toBe(true);
	});
});

describe("an internal crate is reachable as a workspace dependency", () => {
	/**
	 * A path dep spelled out in each consumer is the same duplication one level
	 * up: three consumers, three `{ path = "../x" }` strings, and no single place
	 * to change when the crate moves. Every first-party crate that another crate
	 * depends on has an entry under `[workspace.dependencies]`, so a consumer says
	 * `x.workspace = true` and nothing else.
	 */
	it("lists every internally depended-on crate under [workspace.dependencies]", () => {
		const declared = workspaceDependencyNames();
		const dirs = new Set(firstPartyCrateDirs());
		const missing = new Set<string>();
		for (const dir of dirs) {
			for (const name of readCrateManifest(dir).dependencies.keys()) {
				if (dirs.has(name) && !declared.has(name)) missing.add(name);
			}
		}

		expect([...missing].sort()).toEqual([]);
	});

	/**
	 * And the three folded-in crates are among them, by name, for the same
	 * non-vacuity reason as above.
	 */
	it("includes the three folded-in crates", () => {
		const declared = workspaceDependencyNames();
		for (const name of FOLDED_IN) {
			expect(declared.has(name)).toBe(true);
		}
	});
});
