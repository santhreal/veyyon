import { describe, expect, it } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Locks the tarball-install smoke (`scripts/install-tests/run-ci.sh`) against the
 * two drift bugs that silently gated EVERY release on 2026-07-23 (see BACKLOG
 * ARGOT-1 / PREPACK-1). `install_methods` is a hard dependency of
 * `release_binary`, so a break here means no GitHub release can cut — and both
 * bugs were invisible to the rest of the suite because nothing asserted the
 * smoke's hand-kept package lists stayed in sync with the real manifests.
 *
 * The smoke reproduces the published npm topology: it packs every workspace
 * package coding-agent depends on, writes bun `overrides` pointing each dep at
 * its tarball (the version under test is not on the registry), `bun add`s them,
 * and runs `veyyon --smoke-test`. Three hand-maintained lists must therefore
 * agree with coding-agent's actual dependency closure. These tests derive the
 * closure from the manifests and fail loudly, naming the offending package, when
 * a list drifts.
 */

const repoRoot = path.resolve(import.meta.dir, "..");
const packagesDir = path.join(repoRoot, "packages");
const runCiPath = path.join(repoRoot, "scripts", "install-tests", "run-ci.sh");

interface Manifest {
	name: string;
	dependencies?: Record<string, string>;
	optionalDependencies?: Record<string, string>;
	scripts?: Record<string, string>;
	bin?: Record<string, string>;
}

function readManifest(dir: string): Manifest {
	return JSON.parse(fs.readFileSync(path.join(packagesDir, dir, "package.json"), "utf8")) as Manifest;
}

/** name -> manifest for every workspace package under packages/. */
function workspaceManifests(): Map<string, Manifest> {
	const byName = new Map<string, Manifest>();
	for (const dir of fs.readdirSync(packagesDir)) {
		const pkgJson = path.join(packagesDir, dir, "package.json");
		if (!fs.existsSync(pkgJson)) continue;
		const manifest = readManifest(dir);
		byName.set(manifest.name, manifest);
	}
	return byName;
}

/**
 * The set of workspace packages coding-agent pulls in transitively through a
 * workspace-topology protocol. A dep counts when its spec is `workspace:*` or
 * `catalog:` AND its name resolves to a package in this repo — those are the
 * ones bun cannot fetch from the public registry at the version under test, so
 * the smoke must pack and override each. Third-party `catalog:` pins (smol-toml
 * and friends) are excluded: they resolve from npm normally.
 */
function codingAgentWorkspaceClosure(): Set<string> {
	const byName = workspaceManifests();
	const isWorkspaceName = (name: string) => byName.has(name);
	const directWorkspaceDeps = (name: string): string[] => {
		const manifest = byName.get(name);
		if (!manifest) return [];
		const all = { ...manifest.dependencies, ...manifest.optionalDependencies };
		return Object.entries(all)
			.filter(([dep, spec]) => {
				const s = String(spec);
				return (s.startsWith("workspace") || s.startsWith("catalog")) && isWorkspaceName(dep);
			})
			.map(([dep]) => dep);
	};

	const seen = new Set<string>();
	const stack = ["@veyyon/coding-agent"];
	while (stack.length > 0) {
		const current = stack.pop() as string;
		for (const dep of directWorkspaceDeps(current)) {
			if (!seen.has(dep)) {
				seen.add(dep);
				stack.push(dep);
			}
		}
	}
	// coding-agent is the root, not a dep of itself.
	seen.delete("@veyyon/coding-agent");
	return seen;
}

/** Keys of the `pkg.overrides = { ... }` object literal written by run-ci.sh. */
function overrideEntries(runCi: string): Array<{ name: string; tgzVar: string }> {
	const block = runCi.match(/pkg\.overrides\s*=\s*\{([\s\S]*?)\};/);
	if (!block) throw new Error("Could not find `pkg.overrides = { ... }` in run-ci.sh");
	const entries: Array<{ name: string; tgzVar: string }> = [];
	for (const line of block[1].split("\n")) {
		// '@veyyon/agent-core': '$agent_tgz'   |   'argot': '$argot_tgz'
		const m = line.match(/'([^']+)'\s*:\s*'\$([A-Za-z0-9_]+)'/);
		if (m) entries.push({ name: m[1], tgzVar: m[2] });
	}
	return entries;
}

describe("tarball-install smoke dependency coverage", () => {
	const runCi = fs.readFileSync(runCiPath, "utf8");

	it("packs and overrides every workspace-topology dependency of coding-agent (argot regression)", () => {
		// The exact 2026-07-23 release-gating bug: `argot` (an UNSCOPED workspace
		// package, so its 1.0.x version can never exist on the public `argot` npm
		// package) was in coding-agent's closure but absent from the override map,
		// so `bun add` resolved it from the registry and the smoke died with
		// `No version matching "<ver>" found for specifier "argot"`. This asserts
		// the real closure is fully covered and names any package that drops out.
		const closure = [...codingAgentWorkspaceClosure()].sort();
		const overrides = new Set(overrideEntries(runCi).map(e => e.name));

		// Sanity: the derivation actually found the closure, not an empty set.
		expect(closure).toContain("argot");
		expect(closure).toContain("@veyyon/natives");
		expect(closure.length).toBeGreaterThanOrEqual(11);

		const missing = closure.filter(name => !overrides.has(name));
		expect(missing).toEqual([]);
	});

	it("keeps the override map and the `bun add` list pointing at the same tarball vars", () => {
		// Every override value is a `$<name>_tgz` shell var; the same var must
		// appear in the `bun add` line. A dep overridden but not added (or vice
		// versa) means the smoke installs a registry copy or a stale pin instead
		// of the tarball under test — a silent coverage hole. Ties the two
		// hand-kept lists so neither can drift without the other.
		const entries = overrideEntries(runCi);
		const addLine = runCi.split("\n").find(l => /^\s*bun add /.test(l));
		if (!addLine) throw new Error("Could not find the `bun add` line in run-ci.sh");

		// Scope to the workspace closure: the natives leaf and coding-agent itself
		// arrive differently (optionalDependencies / the root install) and are not
		// in this invariant.
		const closure = codingAgentWorkspaceClosure();
		const closureEntries = entries.filter(e => closure.has(e.name));
		expect(closureEntries.length).toBe(closure.size);
		for (const { name, tgzVar } of closureEntries) {
			expect(addLine, `override for ${name} ($${tgzVar}) missing from \`bun add\``).toContain(`$${tgzVar}`);
		}
	});

	it("builds coding-agent's prepack bundle before packing it (dist/cli.js regression)", () => {
		// PREPACK-1: coding-agent's published `bin.veyyon` is `dist/cli.js`, built
		// only by its `prepack` (`gen:bundle`). `bun pm pack` USED to run prepack
		// but bun 1.3.x does not, so without an explicit `run gen:bundle` the
		// tarball declares the bin (and lists dist/cli.js in `files`) while the
		// file is absent, and the installed `.bin/veyyon` dangles (exit 127). This
		// asserts run-ci.sh runs gen:bundle before the coding-agent `bun pm pack`.
		const applyBinIdx = runCi.indexOf("applyPublishBin");
		expect(applyBinIdx).toBeGreaterThan(-1);
		const afterApply = runCi.slice(applyBinIdx);
		const genBundleIdx = afterApply.indexOf("run gen:bundle");
		const packIdx = afterApply.indexOf("bun pm pack");
		expect(genBundleIdx).toBeGreaterThan(-1);
		expect(packIdx).toBeGreaterThan(-1);
		// gen:bundle must come before the coding-agent pack in that block.
		expect(genBundleIdx).toBeLessThan(packIdx);
	});

	it("confirms coding-agent still resolves its bin through the prepack bundle", () => {
		// Guards the premise of the dist/cli.js test: if coding-agent's repo
		// manifest ever stops using a prepack-built bin, the gen:bundle step above
		// is no longer required and this suite should be revisited. `prepack` must
		// invoke gen:bundle, and gen:bundle must emit dist/cli.js.
		const manifest = readManifest("coding-agent");
		expect(manifest.scripts?.prepack ?? "").toContain("gen:bundle");
		const bundleScript = fs.readFileSync(path.join(packagesDir, "coding-agent", "scripts", "bundle-dist.ts"), "utf8");
		expect(bundleScript).toContain('"cli.js"');
	});
});
