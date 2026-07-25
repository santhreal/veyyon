/**
 * Regression for the source-install native-addon brick (user-hit 2026-07-24).
 *
 * The bug: veyyon has three install methods that stage the native `.node` in
 * DIFFERENT places — the compiled/standalone binary extracts into the per-version
 * cache (`~/.veyyon/natives/<version>/`), the Windows update path stages into that
 * same cache, and a source install writes into `packages/natives/native/`. The
 * `~/.veyyon/src` source tree is a COPIED tree (no git), so a re-sync drops the
 * gitignored `native/*.node`; if `ensure` is not re-run, `native/` is empty. On
 * that machine the loader's source branch only ever probed `native/` and the exec
 * dir, NEVER the per-version cache — so it died at boot with a resolve-error dump
 * even though a valid, version-matched binary sat in the cache a prior standalone
 * install had left there. "The install and update mechanisms are not at all
 * consistent" — two writers, one reader that ignored one of them.
 *
 * The fix, pinned here: `resolveLoaderCandidates` treats the per-version cache as
 * a TRAILING fallback on the source/node_modules path (in-tree build still wins),
 * and `buildHelpMessage` stops pointing users at a `bun install @veyyon/natives`
 * package that does not exist, naming the real remediations instead.
 */
import { describe, expect, it } from "bun:test";
import * as path from "node:path";
import { buildHelpMessage, getAddonFilenames, resolveLoaderCandidates } from "../native/loader-state.js";

const posixSourceNativeDir = "/home/u/.veyyon/src/packages/natives/native";
const versionedDir = "/home/u/.veyyon/natives/1.0.37";
const modernNames = getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "modern" });

describe("source-install native cache fallback", () => {
	it("probes the per-version cache after the in-tree build on a source install", () => {
		// The exact failing shape: a non-compiled, non-staging (source) load. The
		// cache path MUST appear so a synced tree with an empty `native/` still finds
		// the standalone install's cached binary, and it MUST come after the in-tree
		// path so a fresh local build is never shadowed by a stale cache copy.
		const candidates = resolveLoaderCandidates({
			addonFilenames: modernNames,
			isCompiledBinary: false,
			stageFromNodeModules: false,
			nativeDir: posixSourceNativeDir,
			execDir: "/home/u/.bun/bin",
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});

		const inTreeModern = path.join(posixSourceNativeDir, "veyyon_natives.linux-x64-modern.node");
		const cachedModern = path.join(versionedDir, "veyyon_natives.linux-x64-modern.node");
		const cachedBaseline = path.join(versionedDir, "veyyon_natives.linux-x64-baseline.node");

		expect(candidates).toContain(inTreeModern);
		expect(candidates).toContain(cachedModern);
		expect(candidates).toContain(cachedBaseline);
		expect(candidates.indexOf(inTreeModern)).toBeLessThan(candidates.indexOf(cachedModern));
	});

	it("keeps every requested variant filename reachable in the cache", () => {
		// A machine whose CPU resolves to `modern` still lists the baseline cache
		// path (the modern getAddonFilenames list includes baseline as its ABI-safe
		// fallback), so a cache holding only the baseline binary still loads.
		const candidates = resolveLoaderCandidates({
			addonFilenames: modernNames,
			isCompiledBinary: false,
			stageFromNodeModules: false,
			nativeDir: posixSourceNativeDir,
			execDir: "/home/u/.bun/bin",
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});
		for (const name of modernNames) {
			expect(candidates).toContain(path.join(versionedDir, name));
		}
	});

	it("still probes the compiled cache FIRST for a compiled binary (unchanged)", () => {
		// The reconciliation must not regress the compiled path: its extracted cache
		// copy is authoritative and has to be tried before any in-tree leftover.
		const candidates = resolveLoaderCandidates({
			addonFilenames: modernNames,
			isCompiledBinary: true,
			stageFromNodeModules: false,
			nativeDir: posixSourceNativeDir,
			execDir: "/home/u/.bun/bin",
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});
		const cachedModern = path.join(versionedDir, "veyyon_natives.linux-x64-modern.node");
		const inTreeModern = path.join(posixSourceNativeDir, "veyyon_natives.linux-x64-modern.node");
		expect(candidates.indexOf(cachedModern)).toBeLessThan(candidates.indexOf(inTreeModern));
	});

	it("never duplicates a path when the source native dir equals the exec dir", () => {
		// De-dup contract: a standalone layout where the native dir and exec dir
		// coincide must not list the same candidate twice (wasted require probes).
		const sameDir = "/home/u/.veyyon/bin";
		const candidates = resolveLoaderCandidates({
			addonFilenames: modernNames,
			isCompiledBinary: false,
			stageFromNodeModules: false,
			nativeDir: sameDir,
			execDir: sameDir,
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});
		expect(new Set(candidates).size).toBe(candidates.length);
	});
});

describe("native load-failure help message", () => {
	it("does not point users at a nonexistent `bun install @veyyon/natives` package", () => {
		// veyyon's addon is a built artifact, never a registry package. The old text
		// told a bricked user to `bun install @veyyon/natives`, which cannot work and
		// wasted their time — the exact frustration behind the 2026-07-24 report.
		const help = buildHelpMessage({ isCompiledBinary: false, addonFilenames: modernNames, versionedDir });
		expect(help).not.toContain("bun install @veyyon/natives");
		expect(help.toLowerCase()).not.toContain("npm/bun");
	});

	it("names the real remediations for a source install", () => {
		// The honest fixes, in lock-step with scripts/ensure-native.ts: re-provision
		// from the release, build locally, or reinstall the standalone binary.
		const help = buildHelpMessage({ isCompiledBinary: false, addonFilenames: modernNames, versionedDir });
		expect(help).toContain("bun --cwd=packages/natives run ensure");
		expect(help).toContain("bun --cwd=packages/natives run build");
		expect(help).toContain("curl -fsSL https://get.veyyon.dev | sh");
	});
});
