/**
 * WHY: `veyyon plugin link <path>` threw `EISDIR` whenever the plugin was
 * already present as a real directory — the ordinary state after installing it
 * from npm or a marketplace, and exactly the state a developer is in when they
 * switch to a local checkout. `link` open-coded its own cleanup with a bare
 * `fs.promises.unlink(linkPath)`, which is only correct for a symlink or a file.
 *
 * THE CLASS THIS CLOSES: two owners for "remove the plugin's presence on disk"
 * that disagree about what that presence can be. A plugin occupies its
 * `node_modules` slot as one of three shapes — a symlink (linked), a real
 * directory (npm or marketplace install), or a plain file (a truncated or
 * hand-made leftover) — and `PluginManager` already had a method that handles
 * all three. `link` now calls it instead of duplicating it, so the shapes are
 * swept here at every removal path rather than at the one that was reported.
 *
 * `SHAPES` is the sweep: adding a fourth on-disk shape means adding a builder
 * here, and every case below runs against all of them.
 *
 * WHAT IT DOES NOT CATCH: a link path that exists but cannot be removed —
 * a permission failure or a Windows open-handle lock — still surfaces the raw
 * errno, which is the intended behaviour but is not exercised here.
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

function mockBun(): void {
	vi.spyOn(Bun, "spawn").mockImplementation(((first: unknown, options?: unknown) => {
		if (!Array.isArray(first) || first[0] !== "bun") {
			return (realBunSpawn as unknown as (cmd: unknown, options?: unknown) => Subprocess)(first, options);
		}
		return {
			pid: 1,
			stdout: new Response("").body,
			stderr: new Response("").body,
			exited: Promise.resolve(0),
		} as Subprocess;
	}) as typeof Bun.spawn);
}

/**
 * Every shape a plugin's `node_modules` slot can already hold when a link is
 * attempted. Each builder leaves something at `slot` that must be replaced.
 */
const SHAPES: Record<string, (slot: string) => Promise<void>> = {
	"a real directory an npm install left behind": async slot => {
		await fs.mkdir(slot, { recursive: true });
		await Bun.write(path.join(slot, "package.json"), JSON.stringify({ name: "linked-plugin", version: "0.9.0" }));
		await Bun.write(path.join(slot, "dist", "index.js"), "module.exports = {};\n");
	},
	"a symlink to an older checkout": async slot => {
		const stale = `${slot}-stale-source`;
		await fs.mkdir(stale, { recursive: true });
		await fs.symlink(stale, slot);
	},
	"a plain file left by a truncated install": async slot => {
		await Bun.write(slot, "not a package\n");
	},
};

describe("linking a plugin over an existing install replaces it", () => {
	let tmpRoot: string;
	let pluginsNodeModules: string;
	let sourceDir: string;
	let scopedSourceDir: string;

	async function writePluginSource(dir: string, name: string): Promise<void> {
		await fs.mkdir(dir, { recursive: true });
		await Bun.write(
			path.join(dir, "package.json"),
			JSON.stringify({ name, version: "1.0.0", veyyon: { version: "1.0.0" } }, null, 2),
		);
	}

	beforeEach(async () => {
		tmpRoot = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-plugin-relink-"));
		const pluginsDir = path.join(tmpRoot, "plugins");
		pluginsNodeModules = path.join(pluginsDir, "node_modules");
		await fs.mkdir(pluginsNodeModules, { recursive: true });

		sourceDir = path.join(tmpRoot, "src-plugin");
		scopedSourceDir = path.join(tmpRoot, "src-scoped-plugin");
		await writePluginSource(sourceDir, "linked-plugin");
		await writePluginSource(scopedSourceDir, "@acme/linked-plugin");

		vi.spyOn(piUtils, "getPluginsDir").mockReturnValue(pluginsDir);
		vi.spyOn(piUtils, "getPluginsNodeModules").mockReturnValue(pluginsNodeModules);
		vi.spyOn(piUtils, "getPluginsPackageJson").mockReturnValue(path.join(pluginsDir, "package.json"));
		vi.spyOn(piUtils, "getPluginsLockfile").mockReturnValue(path.join(tmpRoot, "veyyon-plugins.lock.json"));
		vi.spyOn(piUtils, "getProjectDir").mockReturnValue(tmpRoot);
		vi.spyOn(piUtils, "getProjectPluginOverridesPath").mockReturnValue(path.join(tmpRoot, "plugin-overrides.json"));
		mockBun();
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		await removeWithRetries(tmpRoot);
	});

	// The defect: the directory row threw EISDIR. The other rows are the shapes
	// that already worked and must keep working now that one owner handles all three.
	for (const [shape, build] of Object.entries(SHAPES)) {
		test(`replaces ${shape} with a symlink to the new source`, async () => {
			const slot = path.join(pluginsNodeModules, "linked-plugin");
			await build(slot);

			const result = await new PluginManager(tmpRoot).link(sourceDir);

			expect(result.name).toBe("linked-plugin");
			expect((await fs.lstat(slot)).isSymbolicLink()).toBe(true);
			expect(await fs.readlink(slot)).toBe(sourceDir);
			// The replacement is total: nothing of the previous occupant survives,
			// so the new source's manifest is what resolves through the slot.
			expect(JSON.parse(await fs.readFile(path.join(slot, "package.json"), "utf8")).version).toBe("1.0.0");
		});

		test(`replaces ${shape} for a scoped package`, async () => {
			const slot = path.join(pluginsNodeModules, "@acme", "linked-plugin");
			await fs.mkdir(path.dirname(slot), { recursive: true });
			await build(slot);

			const result = await new PluginManager(tmpRoot).link(scopedSourceDir);

			expect(result.name).toBe("@acme/linked-plugin");
			expect((await fs.lstat(slot)).isSymbolicLink()).toBe(true);
			expect(await fs.readlink(slot)).toBe(scopedSourceDir);
		});

		test(`uninstall still clears ${shape} after it was linked over`, async () => {
			const slot = path.join(pluginsNodeModules, "linked-plugin");
			await build(slot);

			const mgr = new PluginManager(tmpRoot);
			await mgr.link(sourceDir);
			await mgr.uninstall("linked-plugin");

			await expect(fs.lstat(slot)).rejects.toThrow();
			expect((await mgr.list()).map(plugin => plugin.name)).not.toContain("linked-plugin");
		});
	}

	test("links into an empty slot without needing anything removed first", async () => {
		const slot = path.join(pluginsNodeModules, "linked-plugin");

		await new PluginManager(tmpRoot).link(sourceDir);

		expect((await fs.lstat(slot)).isSymbolicLink()).toBe(true);
		expect(await fs.readlink(slot)).toBe(sourceDir);
	});

	test("relinking the same source twice is idempotent", async () => {
		const slot = path.join(pluginsNodeModules, "linked-plugin");
		const mgr = new PluginManager(tmpRoot);

		await mgr.link(sourceDir);
		await mgr.link(sourceDir);

		expect(await fs.readlink(slot)).toBe(sourceDir);
	});
});
