/**
 * WHY: a plugin installed from a local path could never be removed. `link`
 * registers a plugin as a node_modules symlink plus an entry in the runtime
 * config, and writes no `plugins/package.json#dependencies` entry — but
 * `uninstall` gated on `dependencies` alone, so it answered "Plugin <name> is not
 * installed" for a plugin `list` was showing and whose tools were loading.
 * `disable` was the only recourse, and it leaves the plugin listed and on disk.
 *
 * THE CLASS THIS CLOSES: two surfaces disagreeing about what "installed" means.
 * `list` counts the union of `dependencies` and the runtime config's `plugins`
 * map; every other lifecycle verb must count the same set, or it is unreachable
 * for whichever install route it forgot. These cases pin the union at each verb
 * and sweep both install routes, so a verb that regresses to reading one source
 * fails here rather than stranding an install route.
 *
 * WHAT IT DOES NOT CATCH: `bun uninstall` is mocked, so the npm route proves
 * veyyon spawns it and clears runtime state, not that bun removes the package.
 * It also does not cover marketplace-scoped installs, which carry their own
 * registry and are removed through `MarketplaceManager`.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { PluginManager } from "@veyyon/coding-agent/extensibility/plugins/manager";
import * as piUtils from "@veyyon/utils";
import { removeWithRetries } from "@veyyon/utils";
import type { Subprocess } from "bun";

const realBunSpawn = Bun.spawn;

/** Argv of every `bun …` the manager spawned during a case. */
let spawned: string[][];

function mockBun(exitCode = 0): void {
	vi.spyOn(Bun, "spawn").mockImplementation(((first: unknown, options?: unknown) => {
		if (!Array.isArray(first) || first[0] !== "bun") {
			return (realBunSpawn as unknown as (cmd: unknown, options?: unknown) => Subprocess)(first, options);
		}
		spawned.push(first as string[]);
		return {
			pid: 1,
			stdout: new Response("").body,
			stderr: new Response("").body,
			exited: Promise.resolve(exitCode),
		} as Subprocess;
	}) as typeof Bun.spawn);
}

describe("a linked plugin can be uninstalled", () => {
	let tmpRoot: string;
	let pluginsDir: string;
	let pluginsNodeModules: string;
	let pluginsPkgJson: string;
	let sourceDir: string;

	beforeEach(async () => {
		spawned = [];
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-plugin-unlink-"));
		pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		pluginsPkgJson = path.join(pluginsDir, "package.json");
		await fs.mkdir(pluginsNodeModules, { recursive: true });

		// A real plugin source tree for `link` to point at.
		sourceDir = path.join(tmpRoot, "src-plugin");
		await fs.mkdir(sourceDir, { recursive: true });
		await Bun.write(
			path.join(sourceDir, "package.json"),
			JSON.stringify({ name: "linked-plugin", version: "1.0.0", veyyon: { version: "1.0.0" } }, null, 2),
		);

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(pluginsPkgJson);
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "veyyon-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	// The defect: the verb refused the plugin outright.
	test("uninstall accepts a linked plugin that list reports as installed", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);
		await mgr.link(sourceDir);

		expect((await mgr.list()).map(p => p.name)).toContain("linked-plugin");
		await mgr.uninstall("linked-plugin");
		expect((await mgr.list()).map(p => p.name)).not.toContain("linked-plugin");
	});

	test("uninstall removes the node_modules symlink a link created", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);
		await mgr.link(sourceDir);

		const linkPath = path.join(pluginsNodeModules, "linked-plugin");
		expect((await fs.lstat(linkPath)).isSymbolicLink()).toBe(true);

		await mgr.uninstall("linked-plugin");
		await expect(fs.lstat(linkPath)).rejects.toThrow();
	});

	test("uninstall leaves the linked plugin's own source tree alone", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);
		await mgr.link(sourceDir);
		await mgr.uninstall("linked-plugin");

		// Removing a link must never delete the directory it pointed at: that is the
		// operator's working copy, not veyyon's to destroy.
		expect(await Bun.file(path.join(sourceDir, "package.json")).exists()).toBe(true);
	});

	test("uninstall clears a linked plugin's runtime state and settings", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);
		await mgr.link(sourceDir);
		await mgr.setPluginSetting("linked-plugin", "level", "b");

		await mgr.uninstall("linked-plugin");

		// A name reused by a later install must not inherit the old settings.
		expect(await mgr.getPluginSettings("linked-plugin")).toEqual({});
	});

	test("uninstall never spawns bun for a linked plugin", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);
		await mgr.link(sourceDir);
		spawned = [];

		await mgr.uninstall("linked-plugin");

		// `bun uninstall` exits 0 having done nothing when there is no dependency
		// entry, which is how a "successful" uninstall used to leave the link behind.
		expect(spawned.filter(cmd => cmd[1] === "uninstall")).toEqual([]);
	});

	test("uninstall still spawns bun for a dependency-installed plugin", async () => {
		mockBun();
		await Bun.write(
			pluginsPkgJson,
			JSON.stringify({ name: "veyyon-plugins", private: true, dependencies: { "npm-plugin": "^1.0.0" } }, null, 2),
		);
		const mgr = new PluginManager(tmpRoot);
		await mgr.uninstall("npm-plugin");

		expect(spawned.some(cmd => cmd[0] === "bun" && cmd[1] === "uninstall" && cmd[2] === "npm-plugin")).toBe(true);
	});

	test("uninstall still rejects a name that is in neither source", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);

		await expect(mgr.uninstall("never-installed")).rejects.toThrow(/is not installed/);
		expect(spawned.filter(cmd => cmd[1] === "uninstall")).toEqual([]);
	});

	test("doctor does not claim an empty profile while a linked plugin is loaded", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);
		await mgr.link(sourceDir);

		const manifestCheck = (await mgr.doctor()).find(c => c.name === "package_manifest");
		// `link` writes no package.json, so the manifest is legitimately absent —
		// but reporting "no plugins installed" contradicts the plugin check below it.
		expect(manifestCheck?.message).not.toContain("no plugins installed");
		expect(manifestCheck?.message).toContain("1 linked plugin");
	});

	test("doctor still reports an empty profile when nothing is installed", async () => {
		mockBun();
		const mgr = new PluginManager(tmpRoot);

		const manifestCheck = (await mgr.doctor()).find(c => c.name === "package_manifest");
		expect(manifestCheck?.message).toContain("no plugins installed");
	});
});
