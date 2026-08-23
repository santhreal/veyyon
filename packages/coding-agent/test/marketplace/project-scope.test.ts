/**
 * Tests for project-scope registry resolution contracts.
 *
 * resolveActiveProjectRegistryPath: walk-up, .git fallback, null return, canonical path.
 * listClaudePluginRoots: project entries shadow user entries for same plugin ID.
 *
 * Note: helpers.ts imports @veyyon/natives (Rust addon via glob).
 * This file imports from helpers.ts directly — the native addon IS present in the
 * test environment (verified: `bun run import-helpers.ts` succeeds).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import {
	clearClaudePluginRootsCache,
	listClaudePluginRoots,
	resolveActiveProjectRegistryPath,
} from "@veyyon/coding-agent/discovery/helpers";
import type { InstalledPluginEntry } from "@veyyon/coding-agent/extensibility/plugins/marketplace";
import {
	addInstalledPlugin,
	buildPluginId,
	readInstalledPluginsRegistry,
	writeInstalledPluginsRegistry,
} from "@veyyon/coding-agent/extensibility/plugins/marketplace";
import {
	canonicalProjectRoot,
	describeProjectExecutable,
	ProjectTrust,
} from "@veyyon/coding-agent/security/project-trust";
import { removeSyncWithRetries } from "@veyyon/utils";
import { CONFIG_DIR_NAME, getPluginsDir } from "@veyyon/utils/dirs";

// ── Fixtures ──────────────────────────────────────────────────────────────────

function makeEntry(installPath: string, scope: InstalledPluginEntry["scope"] = "user"): InstalledPluginEntry {
	return {
		scope,
		installPath,
		version: "1.0.0",
		installedAt: "2025-01-01T00:00:00.000Z",
		lastUpdated: "2025-01-01T00:00:00.000Z",
	};
}

// ── resolveActiveProjectRegistryPath ─────────────────────────────────────────

describe("resolveActiveProjectRegistryPath", () => {
	let tmpDir: string;

	beforeEach(() => {
		tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-proj-scope-"));
	});

	afterEach(() => {
		vi.restoreAllMocks();
		removeSyncWithRetries(tmpDir);
	});

	it("walk-up finds nearest .veyyon/ directory", async () => {
		// Layout: tmpDir/.veyyon/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must climb from cwd → sub → tmpDir and find .veyyon/ there.
		fs.mkdirSync(path.join(tmpDir, CONFIG_DIR_NAME), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, CONFIG_DIR_NAME, "plugins", "installed_plugins.json"));
	});

	it("walk-up stops at the nearest .veyyon/ — does not skip to a more distant one", async () => {
		// Layout: tmpDir/.veyyon/   +   tmpDir/sub/.veyyon/   +   tmpDir/sub/nested/  (cwd)
		// Resolver must stop at tmpDir/sub/.veyyon/, not climb further to tmpDir/.veyyon/.
		fs.mkdirSync(path.join(tmpDir, CONFIG_DIR_NAME), { recursive: true });
		fs.mkdirSync(path.join(tmpDir, "sub", CONFIG_DIR_NAME), { recursive: true });
		const cwd = path.join(tmpDir, "sub", "nested");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, "sub", CONFIG_DIR_NAME, "plugins", "installed_plugins.json"));
	});

	it("falls back to .git root when no .veyyon/ exists", async () => {
		// Layout: tmpDir/.git/   +   tmpDir/sub/  (cwd)
		// No .veyyon/ anywhere → second pass finds .git/ at tmpDir.
		// Returned path is relative to the .git root, not .git itself.
		fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
		const cwd = path.join(tmpDir, "sub");
		fs.mkdirSync(cwd, { recursive: true });

		const result = await resolveActiveProjectRegistryPath(cwd);

		expect(result).toBe(path.join(tmpDir, CONFIG_DIR_NAME, "plugins", "installed_plugins.json"));
	});

	it("returns null when neither .veyyon/ nor .git/ found anywhere in the tree", async () => {
		// Start at the filesystem root — guaranteed to have no .veyyon/ or .git/ ancestors.
		const result = await resolveActiveProjectRegistryPath(path.sep);

		expect(result).toBeNull();
	});

	it("does not treat ~/.git as a project root (pass-2 home-dir guard)", async () => {
		// Simulate a dotfiles repo managed with a bare-git technique: ~/.git exists.
		// resolveActiveProjectRegistryPath must NOT return ~/.veyyon/.../installed_plugins.json.
		const homeDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-proj-scope-home-"));
		vi.spyOn(os, "homedir").mockReturnValue(homeDir);
		const fakeHomeGit = path.join(homeDir, ".git");
		await fs.promises.mkdir(fakeHomeGit, { recursive: true });
		const cwd = path.join(homeDir, "work");
		await fs.promises.mkdir(cwd, { recursive: true });
		try {
			const result = await resolveActiveProjectRegistryPath(cwd);
			const homeOmpPath = path.join(homeDir, CONFIG_DIR_NAME, "plugins", "installed_plugins.json");
			expect(result).not.toBe(homeOmpPath);
			expect(result).toBeNull();
		} finally {
			removeSyncWithRetries(homeDir);
		}
	});

	it("canonical path — /repo and /repo/src resolve to the same registry file", async () => {
		// Both sub-directories of the same project must produce identical paths.
		fs.mkdirSync(path.join(tmpDir, CONFIG_DIR_NAME), { recursive: true });
		const src = path.join(tmpDir, "src");
		fs.mkdirSync(src, { recursive: true });

		const fromRoot = await resolveActiveProjectRegistryPath(tmpDir);
		const fromSrc = await resolveActiveProjectRegistryPath(src);

		expect(fromRoot).not.toBeNull();
		expect(fromRoot).toBe(fromSrc);
	});
});

// ── listClaudePluginRoots: project shadows user ───────────────────────────────

describe("listClaudePluginRoots — project shadows user", () => {
	let tmpHome: string;
	let tmpProject: string;
	/** Profile directory the trust decision is recorded in and read back from. */
	let tmpAgentDir: string;
	/** Path where listClaudePluginRoots reads the user Veyyon registry. */
	let userRegPath: string;
	/** Path where listClaudePluginRoots reads the project registry (resolved from tmpProject). */
	let projectRegPath: string;

	beforeEach(() => {
		tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-shadow-home-"));
		tmpProject = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-shadow-proj-"));
		tmpAgentDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-shadow-agent-"));

		// Create .veyyon/ in project so resolveActiveProjectRegistryPath finds it.
		fs.mkdirSync(path.join(tmpProject, CONFIG_DIR_NAME, "plugins"), { recursive: true });

		// The user registry is read from the ACTIVE PROFILE's plugins dir, which is where
		// the marketplace writer puts it — not `<home>/.veyyon/plugins`. Writing it anywhere
		// else leaves no user entry to shadow, and the shadowing assertion below then holds
		// for a registry that was never loaded.
		userRegPath = path.join(getPluginsDir(tmpHome), "installed_plugins.json");
		fs.mkdirSync(path.dirname(userRegPath), { recursive: true });

		projectRegPath = path.join(tmpProject, CONFIG_DIR_NAME, "plugins", "installed_plugins.json");
	});

	afterEach(() => {
		// Cache is keyed by home:projectPath — must clear between tests.
		clearClaudePluginRootsCache();
		removeSyncWithRetries(tmpHome);
		removeSyncWithRetries(tmpProject);
		removeSyncWithRetries(tmpAgentDir);
	});

	/** Both registries carry the same plugin ID, at different install paths. */
	async function writeBothRegistries(pluginId: string): Promise<void> {
		let userReg = await readInstalledPluginsRegistry(userRegPath);
		userReg = addInstalledPlugin(userReg, pluginId, makeEntry("/user/install/shared-plugin"));
		await writeInstalledPluginsRegistry(userRegPath, userReg);

		let projReg = await readInstalledPluginsRegistry(projectRegPath);
		projReg = addInstalledPlugin(projReg, pluginId, makeEntry("/project/install/shared-plugin", "project"));
		await writeInstalledPluginsRegistry(projectRegPath, projReg);
	}

	/** Record the operator's approval of the project registry file's exact bytes. */
	async function trustProjectRegistry(): Promise<void> {
		const canonicalRoot = await canonicalProjectRoot(tmpProject);
		const executable = await describeProjectExecutable(projectRegPath, canonicalRoot);
		if (!executable) throw new Error("Expected the project registry to be readable");
		const trust = await ProjectTrust.load(tmpAgentDir);
		await trust.trust(canonicalRoot, [executable]);
	}

	it("project entry shadows user entry when plugin IDs match", async () => {
		const pluginId = buildPluginId("shared-plugin", "test-mkt");
		await writeBothRegistries(pluginId);
		await trustProjectRegistry();

		const { roots } = await listClaudePluginRoots(tmpHome, tmpProject, undefined, tmpAgentDir);
		const matching = roots.filter(r => r.id === pluginId);

		// Exactly one entry survives — the user entry is suppressed.
		expect(matching).toHaveLength(1);
		expect(matching[0]?.path).toBe("/project/install/shared-plugin");
		expect(matching[0]?.scope).toBe("project");
	});

	it("keeps the user entry and reports a refusal when the project registry is not trusted", async () => {
		const pluginId = buildPluginId("shared-plugin", "test-mkt");
		await writeBothRegistries(pluginId);

		const { roots, warnings } = await listClaudePluginRoots(tmpHome, tmpProject, undefined, tmpAgentDir);
		const matching = roots.filter(r => r.id === pluginId);

		// The project entry names install paths, so an undecided project supplies none of
		// them; the user's own entry is untouched by that refusal.
		expect(matching).toHaveLength(1);
		expect(matching[0]?.path).toBe("/user/install/shared-plugin");
		expect(matching[0]?.scope).toBe("user");
		expect(warnings.some(warning => warning.includes("plugins"))).toBe(true);
	});
});
