import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import * as path from "node:path";
import rootManifest from "../../../package.json" with { type: "json" };
import packageManifest from "../package.json" with { type: "json" };
import { fastembedRuntimeInstallPlan } from "../src/core/fastembed-runtime";

// The fastembed peer is pinned as an exact version (not `catalog:`) because
// `core/fastembed-runtime.ts` reads it to `bun install` the on-demand embedding
// runtime — including from bundles where the inlined manifest would otherwise
// carry an uninstallable `catalog:` spec (#2389). The runtime cache must keep
// fastembed's own ORT dependency intact because its native addon links against
// that exact bundled library name (#3054).
/**
 * The installed `fastembed` manifest, found by walking up for `node_modules`.
 *
 * Read off disk rather than imported: `fastembed`'s `exports` map does not publish
 * `./package.json`, so `import "fastembed/package.json"` resolves at runtime under Bun
 * but is an unresolvable module to `tsc`. The walk covers both layouts a workspace
 * install can produce (hoisted to the repo root, or local to this package), and a
 * missing manifest THROWS with the directories searched: fastembed is a devDependency
 * here, so its absence is a broken install, and a skipped assertion would leave the
 * ABI pairing unchecked while the suite still read green.
 */
function installedFastembedManifest(): { version: string; dependencies: Record<string, string> } {
	const searched: string[] = [];
	let dir = import.meta.dir;
	for (;;) {
		const candidate = path.join(dir, "node_modules", "fastembed", "package.json");
		searched.push(candidate);
		if (existsSync(candidate)) {
			return JSON.parse(readFileSync(candidate, "utf8"));
		}
		const parent = path.dirname(dir);
		if (parent === dir) break;
		dir = parent;
	}
	throw new Error(
		`fastembed is a devDependency of @veyyon/mnemopi but no installed manifest was found. Run bun install. Searched:\n${searched.join("\n")}`,
	);
}

describe("fastembed runtime version pins", () => {
	const catalog = rootManifest.workspaces.catalog;

	test("fastembed peer pin matches the workspace catalog", () => {
		expect(packageManifest.peerDependencies.fastembed).toBe(catalog.fastembed);
	});

	test("pins are exact installable versions, not catalog or range specs", () => {
		expect(packageManifest.peerDependencies.fastembed).toMatch(/^\d+\.\d+\.\d+$/);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toMatch(/^\d+\.\d+\.\d+$/);
	});

	/**
	 * The pin is read from fastembed's OWN manifest, not written here as a literal.
	 *
	 * It was a literal `"1.21.0"`, and the two drifted: the peer pin was bumped to
	 * `1.26.0` while `fastembed@2.1.0` still declares an exact
	 * `onnxruntime-node: 1.21.0`, so this test failed on committed state with nothing
	 * local to blame. That mismatch is not cosmetic. fastembed's native addon links
	 * against the ORT build it ships with, so a consumer that follows the peer advice
	 * provides a different one and the embedder fails to load at the first embed --
	 * which is the entire reason the pairing is pinned rather than left to a range.
	 *
	 * Reading fastembed's declared dependency makes the assertion about the actual
	 * pairing instead of a number somebody has to remember to update, so the next
	 * fastembed bump either agrees or fails here. It is a hard read: fastembed is a
	 * devDependency of this package, so an absent manifest is a broken install and
	 * throwing is the correct answer, not a skip.
	 */
	test("onnxruntime peer pin matches fastembed's native ABI", () => {
		const fastembed = installedFastembedManifest();
		expect(fastembed.version).toBe(packageManifest.peerDependencies.fastembed);
		expect(packageManifest.peerDependencies["onnxruntime-node"]).toBe(fastembed.dependencies["onnxruntime-node"]);
	});

	test("runtime install preserves fastembed's transitive onnxruntime pin", () => {
		const plan = fastembedRuntimeInstallPlan();
		expect(plan.install.dependencies).toEqual({
			fastembed: packageManifest.peerDependencies.fastembed,
		});
		expect(plan.install.overrides).toBeUndefined();
		expect(plan.install.trustedDependencies).toEqual(["onnxruntime-node"]);
		expect(plan.versionKey).toContain("transitive-ort");
		expect(plan.versionKey).not.toContain("forced-ort");
	});
});
