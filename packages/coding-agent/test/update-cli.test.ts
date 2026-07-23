import { afterEach, describe, expect, it, spyOn, vi } from "bun:test";
import * as nodeFs from "node:fs";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearAutoUpdateFailure,
	readAutoUpdateState,
	recordAutoUpdateFailure,
} from "@veyyon/coding-agent/cli/auto-update-state";
import * as pluginCli from "@veyyon/coding-agent/cli/plugin-cli";
import * as updateCli from "@veyyon/coding-agent/cli/update-cli";
import {
	buildBunInstallArgs,
	buildHomebrewUpdateArgs,
	buildMiseForceInstallArgs,
	buildMiseUpgradeArgs,
	buildNpmInstallArgs,
	pruneBunInstallCache,
	replaceBinaryForUpdate,
	resolveBunGlobalNodeModulesDirFromLocations,
	resolveUpdateMethodForTest,
	sweepStaleBackups,
} from "@veyyon/coding-agent/cli/update-cli";
import Update from "@veyyon/coding-agent/commands/update";
import { removeWithRetries } from "@veyyon/utils";
import type { CliConfig } from "@veyyon/utils/cli";

const tempDirs: string[] = [];

async function makeTempDir(): Promise<string> {
	const dir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-update-test-"));
	tempDirs.push(dir);
	return dir;
}

afterEach(async () => {
	vi.restoreAllMocks();
	await Promise.all(tempDirs.splice(0).map(dir => removeWithRetries(dir)));
});
const TEST_CONFIG: CliConfig = {
	bin: "veyyon",
	version: "0.0.0-test",
	commands: new Map(),
};

/**
 * Version discovery is the link that broke install-then-update: the shipped
 * binary is fetched from GitHub Releases by `install.sh`, but the self-updater
 * used to ask the npm registry, which has no `@veyyon/coding-agent` package and
 * never will (Veyyon ships GitHub-only). A binary installed from GitHub could
 * therefore never see a newer version. These tests lock the source to the
 * GitHub Releases API — the same catalog `install.sh` reads — and prove it fails
 * loudly rather than silently returning a stale or empty answer (Law 10).
 */
describe("getLatestRelease reads GitHub Releases, not npm", () => {
	function mockFetch(response: Response): { calls: Array<{ url: string; init?: RequestInit }> } {
		const calls: Array<{ url: string; init?: RequestInit }> = [];
		const impl = (async (input: string | URL | Request, init?: RequestInit) => {
			calls.push({ url: String(input), init });
			return response;
		}) as unknown as typeof fetch;
		spyOn(globalThis, "fetch").mockImplementation(impl);
		return { calls };
	}

	it("queries the GitHub releases/latest endpoint for santhreal/veyyon with a User-Agent", async () => {
		const { calls } = mockFetch(new Response(JSON.stringify({ tag_name: "v1.2.3" }), { status: 200 }));

		const release = await updateCli.getLatestRelease(1000);

		expect(release).toEqual({ tag: "v1.2.3", version: "1.2.3" });
		expect(calls).toHaveLength(1);
		expect(calls[0]?.url).toBe("https://api.github.com/repos/santhreal/veyyon/releases/latest");
		expect(calls[0]?.url).not.toContain("registry.npmjs.org");
		const headers = calls[0]?.init?.headers as Record<string, string> | undefined;
		expect(headers?.["User-Agent"]).toContain("veyyon");
	});

	it("normalizes a tag published without a leading v", async () => {
		mockFetch(new Response(JSON.stringify({ tag_name: "2.0.0" }), { status: 200 }));

		expect(await updateCli.getLatestRelease(1000)).toEqual({ tag: "v2.0.0", version: "2.0.0" });
	});

	it("throws loudly on 404 (draft/untagged release is not a published release), never a silent default", async () => {
		mockFetch(new Response("Not Found", { status: 404, statusText: "Not Found" }));

		await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/no published GitHub release yet/);
	});

	it("throws with a retry hint when GitHub rate-limits (403/429)", async () => {
		mockFetch(new Response("", { status: 403, statusText: "Forbidden" }));

		await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/rate-limiting this address/);
	});

	it("refuses a release whose tag is not a usable semver instead of guessing", async () => {
		mockFetch(new Response(JSON.stringify({ tag_name: "nightly" }), { status: 200 }));

		await expect(updateCli.getLatestRelease(1000)).rejects.toThrow(/unusable tag/);
	});
});

describe("update command plugin dispatch", () => {
	it("routes -l to plugin upgrade instead of the app updater", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["-l"], TEST_CONFIG);
		await command.run();

		expect(pluginSpy).toHaveBeenCalledWith({ action: "upgrade", args: [], flags: {} });
		expect(updateSpy).not.toHaveBeenCalled();
	});

	it("keeps normal update flags on the app updater path", async () => {
		const pluginSpy = spyOn(pluginCli, "runPluginCommand").mockResolvedValue(undefined);
		const updateSpy = spyOn(updateCli, "runUpdateCommand").mockResolvedValue(undefined);

		const command = new Update(["--check", "--force"], TEST_CONFIG);
		await command.run();

		expect(updateSpy).toHaveBeenCalledWith({ force: true, check: true });
		expect(pluginSpy).not.toHaveBeenCalled();
	});
});

describe("update-cli install target detection", () => {
	it("uses bun update when prioritized veyyon is inside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.bun/bin/veyyon", "/Users/test/.bun/bin");

		expect(method).toBe("bun");
	});

	it("uses npm update when prioritized veyyon is inside an npm global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.npm-global/bin/veyyon", undefined, {
			npmBinDir: "/Users/test/.npm-global/bin",
		});

		expect(method).toBe("npm");
	});

	it("uses npm update for Windows npm command shims even when no package-manager bin dirs were detected", () => {
		const method = resolveUpdateMethodForTest("C:\\Users\\test\\AppData\\Roaming\\npm\\veyyon.cmd", undefined);

		expect(method).toBe("npm");
	});

	it("uses binary update when prioritized veyyon is outside bun global bin", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/veyyon", "/Users/test/.bun/bin");

		expect(method).toBe("binary");
	});

	it("uses binary update when bun global bin cannot be resolved", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/bin/veyyon", undefined);

		expect(method).toBe("binary");
	});

	it("uses Homebrew update when prioritized veyyon resolves into the Homebrew formula", async () => {
		const dir = await makeTempDir();
		const prefix = path.join(dir, "opt", "veyyon");
		const linkedBin = path.join(dir, "bin");
		await fs.mkdir(path.join(prefix, "bin"), { recursive: true });
		await fs.mkdir(linkedBin, { recursive: true });
		await Bun.write(path.join(prefix, "bin", "veyyon"), "binary");
		await fs.symlink(path.join(prefix, "bin", "veyyon"), path.join(linkedBin, "veyyon"));

		const method = resolveUpdateMethodForTest(path.join(linkedBin, "veyyon"), "/Users/test/.bun/bin", {
			homebrewPrefix: prefix,
		});

		expect(method).toBe("brew");
	});

	it("uses mise update when prioritized veyyon is in an active mise bin path", () => {
		const method = resolveUpdateMethodForTest(
			"/Users/test/.local/share/mise/installs/github-santhreal-veyyon/latest/bin/veyyon",
			undefined,
			{
				miseBinDirs: ["/Users/test/.local/share/mise/installs/github-santhreal-veyyon/latest/bin"],
			},
		);

		expect(method).toBe("mise");
	});

	it("uses mise update when prioritized veyyon is a mise shim", () => {
		const method = resolveUpdateMethodForTest("/Users/test/.local/share/mise/shims/veyyon", undefined, {
			miseDataDir: "/Users/test/.local/share/mise",
		});

		expect(method).toBe("mise");
	});
});

describe("update-cli package manager commands", () => {
	it("targets the Homebrew tap formula and switches to reinstall for forced updates", () => {
		expect(buildHomebrewUpdateArgs(false)).toEqual(["upgrade", "santhreal/tap/veyyon"]);
		expect(buildHomebrewUpdateArgs(true)).toEqual(["reinstall", "santhreal/tap/veyyon"]);
	});

	it("targets the mise GitHub backend tool and force-reinstalls the checked version when requested", () => {
		expect(buildMiseUpgradeArgs()).toEqual(["upgrade", "github:santhreal/veyyon", "--bump"]);
		expect(buildMiseForceInstallArgs("15.10.5")).toEqual(["install", "--force", "github:santhreal/veyyon@15.10.5"]);
	});

	it("pins npm package installs to the official registry and the checked native package versions", () => {
		const args = buildNpmInstallArgs("16.3.15", "win32-x64");

		expect(args.slice(0, 2)).toEqual(["install", "-g"]);
		expect(args).toContain("--registry=https://registry.npmjs.org/");
		expect(args).toContain("@veyyon/coding-agent@16.3.15");
		expect(args).toContain("@veyyon/natives@16.3.15");
		expect(args).toContain("@veyyon/natives-win32-x64@16.3.15");
	});
});

describe("update-cli bun install command", () => {
	it("pins the official npm registry and bypasses the manifest cache so a stale mirror or snapshot cannot mask a freshly published version", () => {
		// Regression: veyyon queries https://registry.npmjs.org/<pkg>/latest directly.
		// The install MUST hit the same registry, otherwise:
		//   - a lagging mirror (corp proxy, Taobao, …) rejects the version with
		//     `No version matching "X" (but package exists)`,
		//   - or bun's local manifest snapshot does the same when the user's bun
		//     is already pointed at the official registry but its cache predates
		//     the release.
		// See https://github.com/can1357/oh-my-pi/issues/1686.
		const args = buildBunInstallArgs("15.7.6", "linux-x64");
		expect(args.slice(0, 5)).toEqual([
			"install",
			"-g",
			"--no-cache",
			"--registry=https://registry.npmjs.org/",
			"@veyyon/coding-agent@15.7.6",
		]);
	});

	it("pins the native addon core and the platform-specific leaf to the same version so the loader sentinel cannot drift on supported tags", () => {
		// Regression: bun install -g <pkg>@<v> would update only the top-level
		// package, leaving @veyyon/natives and @veyyon/natives-<tag>
		// at their previous version. The next launch then loaded a stale .node
		// file and aborted at validateLoadedBindings with `The .node file on
		// disk is from a different release than this loader`. See
		// https://github.com/can1357/oh-my-pi/issues/1824.
		for (const tag of ["linux-x64", "linux-arm64", "darwin-x64", "darwin-arm64", "win32-x64"]) {
			const args = buildBunInstallArgs("15.9.0", tag);
			expect(args).toContain("@veyyon/natives@15.9.0");
			expect(args).toContain(`@veyyon/natives-${tag}@15.9.0`);
		}
	});

	it("omits the leaf on unsupported platform tags so an EBADPLATFORM swap does not mask the underlying `no matching version` error", () => {
		// Defensive: an unsupported tag (e.g. linux-arm32) still installs the
		// core natives package — which will fail at module load if the platform
		// truly is unsupported — but we never request a leaf the release
		// pipeline doesn't publish, otherwise bun aborts with EBADPLATFORM
		// and hides the real diagnostic from `loadNative`'s aggregated error.
		const args = buildBunInstallArgs("15.9.0", "linux-arm");
		expect(args).toContain("@veyyon/natives@15.9.0");
		expect(args.some(arg => arg.startsWith("@veyyon/natives-"))).toBe(false);
	});

	it("derives global node_modules from supported bun global locations", () => {
		expect(resolveBunGlobalNodeModulesDirFromLocations(path.join("home", ".bun", "bin"), undefined)).toBe(
			path.join("home", ".bun", "install", "global", "node_modules"),
		);
		expect(
			resolveBunGlobalNodeModulesDirFromLocations(undefined, path.join("home", ".bun", "install", "cache")),
		).toBe(path.join("home", ".bun", "install", "global", "node_modules"));
	});
});

describe("update-cli bun cache pruning", () => {
	it("keeps only the newest cached version for filtered global install packages", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "react", "18.3.1@@@1"), "");
		await Bun.write(path.join(dir, "react", "19.2.6@@@1"), "");
		await Bun.write(
			path.join(dir, "react@18.3.1@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "18.3.1" }),
		);
		await Bun.write(
			path.join(dir, "react@19.2.6@@@1", "package.json"),
			JSON.stringify({ name: "react", version: "19.2.6" }),
		);
		await Bun.write(path.join(dir, "@veyyon", "pi-utils", "15.7.6@@@1"), "");
		await Bun.write(path.join(dir, "@veyyon", "pi-utils", "15.8.0@@@1"), "");
		await Bun.write(
			path.join(dir, "@veyyon", "pi-utils@15.7.6@@@1", "package.json"),
			JSON.stringify({ name: "@veyyon/utils", version: "15.7.6" }),
		);
		await Bun.write(
			path.join(dir, "@veyyon", "pi-utils@15.8.0@@@1", "package.json"),
			JSON.stringify({ name: "@veyyon/utils", version: "15.8.0" }),
		);
		await Bun.write(path.join(dir, "chalk", "4.1.2@@@1"), "");
		await Bun.write(path.join(dir, "chalk", "5.6.2@@@1"), "");
		await Bun.write(
			path.join(dir, "chalk@4.1.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "4.1.2" }),
		);
		await Bun.write(
			path.join(dir, "chalk@5.6.2@@@1", "package.json"),
			JSON.stringify({ name: "chalk", version: "5.6.2" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["react", "@veyyon/utils"]));

		expect(result).toEqual({ scannedPackages: 2, removedEntries: 4 });
		expect(await Bun.file(path.join(dir, "react", "18.3.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react@18.3.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "react", "19.2.6@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "react@19.2.6@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@veyyon", "pi-utils", "15.7.6@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@veyyon", "pi-utils@15.7.6@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "@veyyon", "pi-utils", "15.8.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "@veyyon", "pi-utils@15.8.0@@@1", "package.json")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk", "4.1.2@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "chalk@4.1.2@@@1", "package.json")).exists()).toBe(true);
	});

	it("never deletes real cached versions because of an unparseable sibling directory", async () => {
		// REGRESSION: the prune loop picked "latest" with a comparator that returned
		// 0 for anything it could not parse. A directory name that is not a version
		// therefore tied with everything, and if it was iterated first it became
		// "latest" and every genuine cached version was deleted instead of it.
		// Whether your cache survived depended on readdir order.
		const dir = await makeTempDir();
		// "0-not-a-version" sorts before the real versions, so it is the entry the
		// old code would have latched onto as "latest".
		await Bun.write(path.join(dir, "pkg", "0-not-a-version@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "2.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@0-not-a-version@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "0-not-a-version" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);
		await Bun.write(
			path.join(dir, "pkg@2.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "2.0.0" }),
		);

		await pruneBunInstallCache(dir, new Set(["pkg"]));

		// The newest orderable version survives.
		expect(await Bun.file(path.join(dir, "pkg", "2.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@2.0.0@@@1", "package.json")).exists()).toBe(true);
		// The older orderable version is pruned, which is the point of the sweep.
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(false);
		// The entry we could not order is left exactly where it was: deleting on an
		// ordering that could not be computed is what caused the bug.
		expect(await Bun.file(path.join(dir, "pkg", "0-not-a-version@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@0-not-a-version@@@1", "package.json")).exists()).toBe(true);
	});

	it("prunes correctly regardless of which version is encountered first", async () => {
		// The old comparator made the outcome depend on directory iteration order.
		// Both layouts must reach the same answer.
		for (const order of [
			["1.0.0", "2.0.0"],
			["2.0.0", "1.0.0"],
		]) {
			const dir = await makeTempDir();
			for (const version of order) {
				await Bun.write(path.join(dir, "pkg", `${version}@@@1`), "");
				await Bun.write(
					path.join(dir, `pkg@${version}@@@1`, "package.json"),
					JSON.stringify({ name: "pkg", version }),
				);
			}

			await pruneBunInstallCache(dir, new Set(["pkg"]));

			expect(await Bun.file(path.join(dir, "pkg", "2.0.0@@@1")).exists()).toBe(true);
			expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(false);
		}
	});

	it("keeps a prerelease from outranking the release it precedes", async () => {
		// 2.0.0-rc.1 must not be treated as newer than 2.0.0. The comparator this
		// path used to share mis-ranked prerelease identifiers.
		const dir = await makeTempDir();
		for (const version of ["2.0.0", "2.0.0-rc.1"]) {
			await Bun.write(path.join(dir, "pkg", `${version}@@@1`), "");
			await Bun.write(
				path.join(dir, `pkg@${version}@@@1`, "package.json"),
				JSON.stringify({ name: "pkg", version }),
			);
		}

		await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(await Bun.file(path.join(dir, "pkg", "2.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg", "2.0.0-rc.1@@@1")).exists()).toBe(false);
	});

	it("keeps current registry-qualified marker entries with their materialized package", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir, new Set(["pkg"]));

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 0 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@registry.npmjs.org@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@registry.npmjs.org@@@1", "package.json")).exists()).toBe(true);
	});

	it("treats a stable release as newer than a matching prerelease", async () => {
		const dir = await makeTempDir();
		await Bun.write(path.join(dir, "pkg", "1.0.0-beta.1@@@1"), "");
		await Bun.write(path.join(dir, "pkg", "1.0.0@@@1"), "");
		await Bun.write(
			path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0-beta.1" }),
		);
		await Bun.write(
			path.join(dir, "pkg@1.0.0@@@1", "package.json"),
			JSON.stringify({ name: "pkg", version: "1.0.0" }),
		);

		const result = await pruneBunInstallCache(dir);

		expect(result).toEqual({ scannedPackages: 1, removedEntries: 2 });
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0-beta.1@@@1")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0-beta.1@@@1", "package.json")).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "pkg", "1.0.0@@@1")).exists()).toBe(true);
		expect(await Bun.file(path.join(dir, "pkg@1.0.0@@@1", "package.json")).exists()).toBe(true);
	});
});

describe("update-cli binary replacement", () => {
	it("restores the previous binary when the replacement fails verification", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "broken binary");

		await expect(
			replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: false, path: targetPath }),
			}),
		).rejects.toThrow("restored previous veyyon binary");

		expect(await Bun.file(targetPath).text()).toBe("old binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});

	it("keeps the replacement only after it reports the expected version", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		await replaceBinaryForUpdate({
			targetPath,
			tempPath,
			backupPath,
			expectedVersion: "15.1.8",
			verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
		});

		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).exists()).toBe(false);
	});
});

describe("update-cli binary replacement on locked backups", () => {
	it("treats an EPERM on backup cleanup as a successful, completed update", async () => {
		// Regression: on Windows the binary moved aside during the swap is still
		// the running process image, so unlinking it throws EPERM. That cleanup
		// failure must not turn a verified swap into "Update failed" (issue #845).
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon.exe");
		const tempPath = `${targetPath}.new`;
		const backupPath = `${targetPath}.1700000000000.4242.bak`;
		await Bun.write(targetPath, "old binary");
		await Bun.write(tempPath, "new binary");

		const realUnlink = nodeFs.promises.unlink.bind(nodeFs.promises);
		const spy = spyOn(nodeFs.promises, "unlink").mockImplementation(async (p: nodeFs.PathLike) => {
			if (String(p) === backupPath) {
				const err = new Error(`EPERM: operation not permitted, unlink '${p}'`) as NodeJS.ErrnoException;
				err.code = "EPERM";
				throw err;
			}
			return realUnlink(p);
		});
		try {
			const result = await replaceBinaryForUpdate({
				targetPath,
				tempPath,
				backupPath,
				expectedVersion: "15.1.8",
				verifyInstalledVersion: async () => ({ ok: true, actual: "15.1.8", path: targetPath }),
			});
			expect(result.ok).toBe(true);
		} finally {
			spy.mockRestore();
		}

		// New binary is installed and the temp consumed even though the locked
		// backup survives; the next run's sweep reclaims it once it is unlocked.
		expect(await Bun.file(targetPath).text()).toBe("new binary");
		expect(await Bun.file(tempPath).exists()).toBe(false);
		expect(await Bun.file(backupPath).text()).toBe("old binary");
	});
});

describe("update-cli stale backup sweep", () => {
	it("reclaims timestamped and legacy backups while leaving unrelated .bak files", async () => {
		const dir = await makeTempDir();
		const targetPath = path.join(dir, "veyyon.exe");
		await Bun.write(targetPath, "current binary");
		await Bun.write(`${targetPath}.bak`, "legacy backup");
		await Bun.write(`${targetPath}.1700000000000.4242.bak`, "timestamped backup");
		await Bun.write(`${targetPath}.1800000000000.99.bak`, "another backup");
		// Must survive: foreign basename and a non-numeric middle segment.
		await Bun.write(path.join(dir, "notes.bak"), "keep me");
		await Bun.write(`${targetPath}.config.bak`, "keep me too");

		await sweepStaleBackups(targetPath);

		expect(await Bun.file(targetPath).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1700000000000.4242.bak`).exists()).toBe(false);
		expect(await Bun.file(`${targetPath}.1800000000000.99.bak`).exists()).toBe(false);
		expect(await Bun.file(path.join(dir, "notes.bak")).exists()).toBe(true);
		expect(await Bun.file(`${targetPath}.config.bak`).exists()).toBe(true);
	});
});

describe("update-cli release-info errors", () => {
	it("404 from GitHub Releases names the URL, status, and unpublished-release hint without a doubled Error prefix", async () => {
		spyOn(globalThis, "fetch").mockResolvedValue(new Response("Not Found", { status: 404, statusText: "Not Found" }));
		const errors: string[] = [];
		spyOn(console, "error").mockImplementation((...args: unknown[]) => {
			errors.push(args.map(String).join(" "));
		});
		spyOn(console, "log").mockImplementation(() => {});
		const exitSentinel = new Error("process.exit sentinel");
		const exitSpy = spyOn(process, "exit").mockImplementation((() => {
			throw exitSentinel;
		}) as never);

		await expect(updateCli.runUpdateCommand({ force: false, check: true })).rejects.toBe(exitSentinel);

		expect(exitSpy).toHaveBeenCalledWith(1);
		const combined = errors.join("\n");
		expect(combined).toContain("Failed to check for updates");
		expect(combined).toContain("api.github.com/repos/santhreal/veyyon/releases/latest");
		expect(combined).not.toContain("registry.npmjs.org");
		expect(combined).toContain("HTTP 404");
		expect(combined).toContain("no published GitHub release yet");
		// `${err}` used to stringify the Error and double the prefix.
		expect(combined).not.toContain("Error: Failed to fetch");
	});
});

describe("runUpdateCommand fetch cancellation", () => {
	// The release-metadata check must never be able to hang forever: runUpdateCommand
	// has to arm the fetch with a timeout AbortSignal so a stalled registry connection
	// fails fast instead of freezing `veyyon update --check`. Merged from the former
	// src/cli/update-cli.test.ts so this module has a single suite.
	it("checks release metadata with a timeout signal", async () => {
		let requestSignal: AbortSignal | undefined;
		spyOn(console, "log").mockImplementation(() => {});
		const fetchStub = Object.assign(
			async (_input: string | URL | Request, init?: RequestInit | BunFetchRequestInit) => {
				requestSignal = init?.signal ?? undefined;
				return Response.json({ tag_name: "v999.0.0" });
			},
			{ preconnect: globalThis.fetch.preconnect },
		);
		spyOn(globalThis, "fetch").mockImplementation(fetchStub as never);

		await updateCli.runUpdateCommand({ force: false, check: true });

		expect(requestSignal).toBeInstanceOf(AbortSignal);
	});
});

describe("runAutoUpdate", () => {
	// runAutoUpdate is the form a running TUI session calls: unlike
	// runUpdateCommand it must never write to stdout (that would corrupt the
	// render) and never process.exit (that would kill the user's session). It
	// reports every outcome through its return value instead.
	const stubRegistry = (impl: () => Promise<Response>) => spyOn(globalThis, "fetch").mockImplementation(impl as never);

	// Every call below points the failure record and the install lock at a
	// throwaway file. Without this the suite would write a real backoff into the
	// developer's own state directory, and the recorded failure from one test
	// would suppress the install in the next one.
	const statePath = async (): Promise<string> => path.join(await makeTempDir(), "auto-update-state.json");

	afterEach(() => {
		vi.restoreAllMocks();
	});

	it("reports up-to-date when the registry has nothing newer", async () => {
		stubRegistry(async () => Response.json({ tag_name: "v1.2.3" }));

		expect(await updateCli.runAutoUpdate("1.2.3", undefined, await statePath())).toEqual({ status: "up-to-date" });
		// Strictly newer is required, so a registry that has fallen behind the
		// installed build must not trigger a downgrade install.
		expect(await updateCli.runAutoUpdate("2.0.0", undefined, await statePath())).toEqual({ status: "up-to-date" });
	});

	it("reports the registry failure instead of silently doing nothing", async () => {
		stubRegistry(async () => new Response("nope", { status: 503, statusText: "Service Unavailable" }));

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath());
		expect(outcome.status).toBe("failed");
		expect(outcome.status === "failed" && outcome.error).toContain("503");
		// No version is known when the lookup itself failed.
		expect(outcome.status === "failed" && outcome.version).toBeUndefined();
	});

	it("reports a transport error rather than throwing into the session", async () => {
		stubRegistry(async () => {
			throw new Error("getaddrinfo ENOTFOUND registry.npmjs.org");
		});

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath());
		expect(outcome).toEqual({ status: "failed", error: "getaddrinfo ENOTFOUND registry.npmjs.org" });
	});

	it("installs silently, so a live TUI frame is never corrupted", async () => {
		// The install helpers print progress ("Downloading …", "Installing update…")
		// through a reporter. Under a TUI those writes land in the middle of the
		// rendered frame, so runAutoUpdate must pass the silent one. Asserting on
		// the reporter rather than on stdout is what makes this test meaningful:
		// an earlier version only exercised the up-to-date path, which never
		// reaches an install and so could not have caught a console write.
		stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
		const install = spyOn(updateCli, "installRelease").mockResolvedValue(undefined);

		const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, await statePath());

		expect(outcome).toEqual({ status: "updated", version: "9.9.9" });
		expect(install).toHaveBeenCalledWith("9.9.9", false, updateCli.SILENT_UPDATE_REPORTER);
	});

	it("reports an install failure instead of claiming success", async () => {
		stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
		spyOn(updateCli, "installRelease").mockRejectedValue(new Error("brew exited 1"));

		expect(await updateCli.runAutoUpdate("1.0.0", undefined, await statePath())).toEqual({
			status: "failed",
			version: "9.9.9",
			error: "brew exited 1",
		});
	});

	it("does not write to stdout on the up-to-date path", async () => {
		stubRegistry(async () => Response.json({ tag_name: "v1.0.0" }));
		const write = spyOn(process.stdout, "write").mockImplementation(() => true);

		await updateCli.runAutoUpdate("1.0.0", undefined, await statePath());

		expect(write).not.toHaveBeenCalled();
	});

	describe("guards against repeating work on every launch", () => {
		it("records the failed version so the next launch can see it", async () => {
			// The record is what the backoff reads. If the failure path did not
			// write it, every launch would retry an install that cannot succeed.
			stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
			spyOn(updateCli, "installRelease").mockRejectedValue(new Error("EACCES: permission denied"));
			const state = await statePath();

			await updateCli.runAutoUpdate("1.0.0", undefined, state);

			expect(await readAutoUpdateState(state)).toEqual({
				failedVersion: "9.9.9",
				failedAtMs: expect.any(Number),
				failedError: "EACCES: permission denied",
			});
		});

		it("skips the install when that same version failed recently", async () => {
			// A machine that cannot install at all showed the same red error on
			// every launch. It now reports once and backs off, and crucially does
			// not spend a package-manager run reproducing the failure each time.
			stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
			const install = spyOn(updateCli, "installRelease").mockResolvedValue(undefined);
			const state = await statePath();
			await recordAutoUpdateFailure("9.9.9", "EACCES", state, Date.now());

			const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, state);

			expect(outcome).toEqual({ status: "skipped", version: "9.9.9", reason: "recent-failure" });
			expect(install).not.toHaveBeenCalled();
		});

		it("still installs a different version while an older failure is in its window", async () => {
			// A build that failed is not evidence the next build fails, so a new
			// release must never be held back by the previous one's cooldown.
			stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
			const install = spyOn(updateCli, "installRelease").mockResolvedValue(undefined);
			const state = await statePath();
			await recordAutoUpdateFailure("9.9.8", "bad tarball", state, Date.now());

			const outcome = await updateCli.runAutoUpdate("1.0.0", undefined, state);

			expect(outcome).toEqual({ status: "updated", version: "9.9.9" });
			expect(install).toHaveBeenCalledTimes(1);
		});

		it("clears the record after a successful install", async () => {
			// Otherwise a machine that recovered keeps a failure on disk that
			// nothing removes, and a later failure is judged against a stale one.
			stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
			spyOn(updateCli, "installRelease").mockResolvedValue(undefined);
			const state = await statePath();
			await recordAutoUpdateFailure("9.9.9", "transient", state, 1_000);

			await updateCli.runAutoUpdate("1.0.0", undefined, state);

			expect(await readAutoUpdateState(state)).toEqual({});
		});

		it("installs once when several sessions launch at the same time", async () => {
			// Opening three terminals at once used to run three concurrent
			// package-manager writes at the same binary. The lock makes the
			// losers stand down instead of racing.
			stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
			const install = spyOn(updateCli, "installRelease").mockImplementation(async () => {
				// Hold long enough that the siblings must contend for the lock.
				await Bun.sleep(30);
			});
			const state = await statePath();

			const outcomes = await Promise.all([
				updateCli.runAutoUpdate("1.0.0", undefined, state),
				updateCli.runAutoUpdate("1.0.0", undefined, state),
				updateCli.runAutoUpdate("1.0.0", undefined, state),
			]);

			expect(install).toHaveBeenCalledTimes(1);
			expect(outcomes.filter(o => o.status === "updated")).toHaveLength(1);
			expect(outcomes.filter(o => o.status === "skipped")).toHaveLength(2);
			for (const outcome of outcomes) {
				if (outcome.status === "skipped") expect(outcome.reason).toBe("another-process");
			}
		});

		it("releases the lock after an install, so the next launch is not blocked", async () => {
			// A lock left behind by a finished install would stall updates until
			// its staleness window elapsed, which is deliberately fifteen minutes.
			stubRegistry(async () => Response.json({ tag_name: "v9.9.9" }));
			spyOn(updateCli, "installRelease").mockResolvedValue(undefined);
			const state = await statePath();

			await updateCli.runAutoUpdate("1.0.0", undefined, state);
			await clearAutoUpdateFailure(state);
			const second = await updateCli.runAutoUpdate("1.0.0", undefined, state);

			expect(second).toEqual({ status: "updated", version: "9.9.9" });
		});
	});
});
