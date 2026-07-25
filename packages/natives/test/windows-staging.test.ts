/**
 * Regression for the Windows `bun install -g` update path: when an `omp`
 * process is running, bun cannot overwrite a locked
 * `node_modules/@veyyon/natives/native/veyyon_natives.win32-x64.node` during
 * package update and silently keeps the old binary next to the new ESM
 * wrapper. The next launch then throws `<sym> is not a function` deep inside
 * tool execution (see Discord report, 2026-05-14).
 *
 * The fix has two halves, both pinned by this test:
 *   1. The loader stages `nativeDir/<filename>.node` → `versionedDir/<filename>.node`
 *      (per-package-version cache under `~/.veyyon/natives/<version>/`) so the
 *      running process holds its OS-level handle on a path bun is never asked
 *      to overwrite. Gated to Windows + node_modules installs + non-compiled
 *      mode by `shouldStageNodeModulesAddon`.
 *   2. `resolveLoaderCandidates` puts the staged path ahead of the
 *      `node_modules` path so subsequent updates land in node_modules without
 *      contention.
 *
 * Both behaviors are off in workspace dev (`bun --cwd=packages/natives run
 * build`) and on non-Windows so the regular path is unchanged.
 */
import { describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	cleanupStaleNativeVersions,
	getAddonFilenames,
	resolveLoaderCandidates,
	shouldStageNodeModulesAddon,
} from "../native/loader-state.js";
import packageJson from "../package.json" with { type: "json" };

const winNodeModulesNativeDir = "C:\\Users\\Admin\\node_modules\\@oh-my-pi\\veyyon-natives\\native";
const winWorkspaceNativeDir = "C:\\Users\\Admin\\dev\\oh-my-pi\\packages\\natives\\native";
const posixNodeModulesNativeDir = "/home/u/proj/node_modules/@veyyon/natives/native";

describe("windows native addon staging", () => {
	it("stages only on Windows node_modules installs", () => {
		// Windows + node_modules install + npm (not compiled) → stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(true);

		// Windows workspace dev: nativeDir lives outside node_modules → never stage,
		// otherwise rebuilds via `bun --cwd=packages/natives run build` would be
		// shadowed by a stale cache copy.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: false,
				nativeDir: winWorkspaceNativeDir,
			}),
		).toBe(false);

		// Windows compiled binary: the embedded-addon extractor already populates
		// versionedDir; staging from a non-existent nativeDir would race that.
		expect(
			shouldStageNodeModulesAddon({
				platform: "win32",
				isCompiledBinary: true,
				nativeDir: winNodeModulesNativeDir,
			}),
		).toBe(false);

		// Non-Windows: bun's atomic rename works fine, no need to stage.
		expect(
			shouldStageNodeModulesAddon({
				platform: "linux",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
		expect(
			shouldStageNodeModulesAddon({
				platform: "darwin",
				isCompiledBinary: false,
				nativeDir: posixNodeModulesNativeDir,
			}),
		).toBe(false);
	});

	it("prepends versionedDir candidates ahead of node_modules when staging on Windows", () => {
		const versionedDir = "C:\\Users\\Admin\\.omp\\natives\\15.0.1";
		const userDataDir = "C:\\Users\\Admin\\AppData\\Local\\omp";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "win32-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: true,
			nativeDir: winNodeModulesNativeDir,
			execDir: "C:\\Users\\Admin\\node_modules\\.bin",
			versionedDir,
			userDataDir,
		});

		const versionedBaseline = path.join(versionedDir, "veyyon_natives.win32-x64-baseline.node");
		const versionedDefault = path.join(versionedDir, "veyyon_natives.win32-x64.node");
		const nodeModulesBaseline = path.join(winNodeModulesNativeDir, "veyyon_natives.win32-x64-baseline.node");

		// Staged paths must be probed first so the running process locks the cache
		// copy and bun is free to replace the node_modules copy on next update.
		expect(candidates).toContain(versionedBaseline);
		expect(candidates).toContain(versionedDefault);
		expect(candidates.indexOf(versionedBaseline)).toBeLessThan(candidates.indexOf(nodeModulesBaseline));

		// User-data dir is reserved for compiled-binary mode — staging must not
		// quietly start probing it on npm installs (where it never contains the
		// addon anyway).
		const userDataBaseline = path.join(userDataDir, "veyyon_natives.win32-x64-baseline.node");
		expect(candidates).not.toContain(userDataBaseline);
	});

	it("probes node_modules first, then the per-version cache as a trailing fallback, when staging is off", () => {
		// The non-Windows / source / node_modules path. The in-tree (node_modules)
		// build must be tried FIRST — a rebuild there must never be shadowed by a
		// stale cache copy — but the per-version cache is now a TRAILING fallback so
		// a source-tree sync that dropped the gitignored `native/*.node` still loads
		// the binary a prior standalone install left in the cache (user-hit
		// 2026-07-24). Before this fix the cache was never probed on this path and
		// the loader bricked with a resolve-error dump.
		const versionedDir = "/home/u/.omp/natives/15.0.1";
		const candidates = resolveLoaderCandidates({
			addonFilenames: getAddonFilenames({ tag: "linux-x64", arch: "x64", variant: "baseline" }),
			isCompiledBinary: false,
			stageFromNodeModules: false,
			nativeDir: posixNodeModulesNativeDir,
			execDir: "/usr/bin",
			versionedDir,
			userDataDir: "/home/u/.local/bin",
		});

		const versionedBaseline = path.join(versionedDir, "veyyon_natives.linux-x64-baseline.node");
		const nodeModulesBaseline = path.join(posixNodeModulesNativeDir, "veyyon_natives.linux-x64-baseline.node");
		expect(candidates).toContain(nodeModulesBaseline);
		expect(candidates).toContain(versionedBaseline);
		// Order is the contract: node_modules wins, cache is the fallback.
		expect(candidates.indexOf(nodeModulesBaseline)).toBeLessThan(candidates.indexOf(versionedBaseline));
	});

	it("removes stale version directories after the current native version loads", async () => {
		const nativesDir = await fs.mkdtemp(path.join(os.tmpdir(), "omp-natives-cache-"));
		try {
			await fs.mkdir(path.join(nativesDir, "15.10.11"));
			await fs.mkdir(path.join(nativesDir, packageJson.version));
			await Bun.write(path.join(nativesDir, "README.txt"), "not a version directory");

			const pruned = cleanupStaleNativeVersions({ nativesDir, currentVersion: packageJson.version });

			// The return carries failures too now: a cache that could not be
			// removed used to be swallowed, so disk quietly never came back.
			expect(pruned.removed.map((filePath: string) => path.basename(filePath))).toEqual(["15.10.11"]);
			expect(pruned.failed).toEqual([]);
			expect((await fs.readdir(nativesDir)).sort()).toEqual(["README.txt", packageJson.version].sort());
		} finally {
			await fs.rm(nativesDir, { recursive: true, force: true });
		}
	});
});

describe("veyyon-natives version sentinel", () => {
	it("Rust `js_name` matches the package version", async () => {
		// The JS loader (`packages/natives/native/index.js`) computes its expected
		// sentinel from `package.json#version`; if the Rust source falls out of
		// sync we ship a `.node` that the loader will refuse to use. Pinning the
		// pairing here catches release-script regressions before they reach CI.
		const libRs = await Bun.file(path.join(import.meta.dir, "../../../crates/veyyon-natives/src/lib.rs")).text();
		const sentinelMatch = libRs.match(/js_name = "(__veyyonNativesV[A-Za-z0-9_]+)"/);
		expect(sentinelMatch, 'Rust sentinel `js_name = "__veyyonNativesV…"` not found in lib.rs').not.toBeNull();
		const expected = `__veyyonNativesV${packageJson.version.replace(/[^A-Za-z0-9]/g, "_")}`;
		expect(sentinelMatch?.[1]).toBe(expected);
	});
});
