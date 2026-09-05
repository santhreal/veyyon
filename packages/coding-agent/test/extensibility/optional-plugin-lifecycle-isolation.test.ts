/**
 * WHY THIS SUITE EXISTS:
 *
 * Plugins and their contributions (tools, hooks, extensions, commands, features, settings)
 * are strictly optional:
 *   1. A disabled plugin (via lockfile `enabled: false` or project override `disabled: [...]`)
 *      must NEVER be imported or executed, and its absence must not damage unrelated contributions.
 *   2. A missing plugin on disk (ENOENT) or a plugin declaring a missing entry point must be handled
 *      gracefully without crashing discovery or aborting unrelated plugins.
 *   3. A load failure in one plugin (syntax error, missing export, throwing factory) must record a
 *      diagnostic error while preserving all other healthy plugins' registrations.
 *   4. Feature selection (`enabledFeatures: null` vs `string[]` vs project overrides) and settings
 *      merging must honor precedence without cross-plugin pollution.
 *
 * WHAT IT DOES NOT CATCH:
 * External git network clones or package manager downloads.
 */

import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { clearClaudePluginRootsCache } from "@veyyon/coding-agent/discovery/helpers";
import { loadCustomTools } from "@veyyon/coding-agent/extensibility/custom-tools/loader";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { loadHooks } from "@veyyon/coding-agent/extensibility/hooks/loader";
import {
	getAllPluginExtensionPaths,
	getAllPluginHookPaths,
	getAllPluginToolPaths,
	getEnabledPlugins,
	getPluginSettings,
} from "@veyyon/coding-agent/extensibility/plugins/loader";
import { normalizeToolEventInput, resolveToolEventInput } from "@veyyon/coding-agent/extensibility/tool-event-input";
import { getPluginsDir, removeSyncWithRetries, setAgentDir, TempDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

// Global tracking to verify whether an implementation module was imported/executed
declare global {
	var __pluginExecutionEvidence: Set<string> | undefined;
}

describe("Optional Plugin Lifecycle & Isolation", () => {
	let projectDir: TempDir;
	let tempHome = "";
	let homedirSpy: { mockRestore(): void } | undefined;
	const dirOverrides = captureDirOverrides();
	const xdgVars = ["XDG_DATA_HOME", "XDG_STATE_HOME", "XDG_CACHE_HOME"] as const;
	const originalXdg = new Map<string, string | undefined>();
	beforeEach(() => {
		clearClaudePluginRootsCache();
		globalThis.__pluginExecutionEvidence = new Set<string>();
		projectDir = TempDir.createSync("@pi-plugin-isolation-");
		tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "pi-plugin-isolation-home-"));
		for (const key of xdgVars) {
			originalXdg.set(key, process.env[key]);
			delete process.env[key];
		}
		homedirSpy = spyOn(os, "homedir").mockReturnValue(tempHome);
		setAgentDir(path.join(tempHome, ".veyyon", "agent"));
	});

	afterEach(() => {
		projectDir.removeSync();
		homedirSpy?.mockRestore();
		homedirSpy = undefined;
		for (const [key, value] of originalXdg) {
			if (value === undefined) delete process.env[key];
			else process.env[key] = value;
		}
		originalXdg.clear();
		restoreDirOverrides(dirOverrides);
		removeSyncWithRetries(tempHome);
		globalThis.__pluginExecutionEvidence?.clear();
		globalThis.__pluginExecutionEvidence = undefined;
		clearClaudePluginRootsCache();
	});
	function setupPlugin(name: string, manifest: Record<string, unknown>, files: Record<string, string>): void {
		const pluginsRoot = getPluginsDir();
		const pluginDir = path.join(pluginsRoot, "node_modules", name);
		fs.mkdirSync(pluginDir, { recursive: true });

		fs.writeFileSync(
			path.join(pluginDir, "package.json"),
			JSON.stringify({
				name,
				version: "1.0.0",
				veyyon: manifest,
			}),
		);

		for (const [relPath, content] of Object.entries(files)) {
			const fullPath = path.join(pluginDir, relPath);
			fs.mkdirSync(path.dirname(fullPath), { recursive: true });
			fs.writeFileSync(fullPath, content);
		}
	}

	function writePluginsLockfile(
		plugins: Record<string, { version: string; enabled: boolean; enabledFeatures: string[] | null }>,
		settings: Record<string, Record<string, unknown>> = {},
	): void {
		const pluginsRoot = getPluginsDir();
		fs.mkdirSync(pluginsRoot, { recursive: true });
		fs.writeFileSync(
			path.join(pluginsRoot, "veyyon-plugins.lock.json"),
			JSON.stringify({
				plugins,
				settings,
			}),
		);
		clearClaudePluginRootsCache();
	}

	it("disabled plugin is NEVER imported and unrelated enabled plugins load normally", async () => {
		// Plugin A: Disabled globally in lockfile. If imported, it records evidence in global tracker.
		setupPlugin(
			"@test/disabled-plugin",
			{
				tools: "./src/tool.ts",
				extensions: ["./src/ext.ts"],
			},
			{
				"src/tool.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/disabled-plugin:tool");
					export default api => ({
						name: "disabled_tool",
						description: "Should not be loaded",
						parameters: api.typebox.Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "bad" }] }),
					});
				`,
				"src/ext.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/disabled-plugin:ext");
					export default api => {
						api.registerCommand("disabled-cmd", { handler: async () => {} });
					};
				`,
			},
		);

		// Plugin B: Enabled.
		setupPlugin(
			"@test/enabled-plugin",
			{
				tools: "./src/tool.ts",
				extensions: ["./src/ext.ts"],
			},
			{
				"src/tool.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/enabled-plugin:tool");
					export default api => ({
						name: "enabled_tool",
						description: "Active tool",
						parameters: api.typebox.Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
				`,
				"src/ext.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/enabled-plugin:ext");
					export default api => {
						api.registerCommand("enabled-cmd", { handler: async () => {} });
					};
				`,
			},
		);

		// Persist lockfile disabling A and enabling B
		writePluginsLockfile({
			"@test/disabled-plugin": { version: "1.0.0", enabled: false, enabledFeatures: null },
			"@test/enabled-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
		});

		const enabled = await getEnabledPlugins(projectDir.path());
		expect(enabled.map(p => p.name)).toEqual(["@test/enabled-plugin"]);

		const toolPaths = await getAllPluginToolPaths(projectDir.path());
		expect(toolPaths.some(p => p.includes("disabled-plugin"))).toBe(false);
		expect(toolPaths.some(p => p.includes("enabled-plugin"))).toBe(true);

		const extPaths = await getAllPluginExtensionPaths(projectDir.path());
		expect(extPaths.some(p => p.includes("disabled-plugin"))).toBe(false);
		expect(extPaths.some(p => p.includes("enabled-plugin"))).toBe(true);

		// Load extensions
		const loadedExts = await loadExtensions(extPaths, projectDir.path());
		expect(loadedExts.errors).toHaveLength(0);
		expect(loadedExts.extensions).toHaveLength(1);
		expect(loadedExts.extensions[0]?.commands.has("enabled-cmd")).toBe(true);

		// Crucial verification: disabled plugin files were NEVER evaluated
		expect(globalThis.__pluginExecutionEvidence?.has("@test/disabled-plugin:tool")).toBe(false);
		expect(globalThis.__pluginExecutionEvidence?.has("@test/disabled-plugin:ext")).toBe(false);
		expect(globalThis.__pluginExecutionEvidence?.has("@test/enabled-plugin:ext")).toBe(true);
	});

	it("project overrides disable plugins and take precedence over global runtime config", async () => {
		setupPlugin(
			"@test/project-disabled",
			{ extensions: ["./src/ext.ts"] },
			{
				"src/ext.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/project-disabled");
					export default api => {};
				`,
			},
		);
		setupPlugin(
			"@test/project-enabled",
			{ extensions: ["./src/ext.ts"] },
			{
				"src/ext.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/project-enabled");
					export default api => {
						api.registerCommand("proj-enabled-cmd", { handler: async () => {} });
					};
				`,
			},
		);

		// Globally both are enabled
		writePluginsLockfile({
			"@test/project-disabled": { version: "1.0.0", enabled: true, enabledFeatures: null },
			"@test/project-enabled": { version: "1.0.0", enabled: true, enabledFeatures: null },
		});

		// Project override disables @test/project-disabled
		const projConfigDir = path.join(projectDir.path(), ".veyyon");
		fs.mkdirSync(projConfigDir, { recursive: true });
		fs.writeFileSync(
			path.join(projConfigDir, "plugin-overrides.json"),
			JSON.stringify({
				disabled: ["@test/project-disabled"],
			}),
		);

		const enabled = await getEnabledPlugins(projectDir.path());
		expect(enabled.map(p => p.name)).toEqual(["@test/project-enabled"]);

		const extPaths = await getAllPluginExtensionPaths(projectDir.path());
		expect(extPaths.some(p => p.includes("project-disabled"))).toBe(false);
		expect(extPaths.some(p => p.includes("project-enabled"))).toBe(true);

		await loadExtensions(extPaths, projectDir.path());
		expect(globalThis.__pluginExecutionEvidence?.has("@test/project-disabled")).toBe(false);
		expect(globalThis.__pluginExecutionEvidence?.has("@test/project-enabled")).toBe(true);
	});

	it("missing plugin on disk (ENOENT) is skipped cleanly without corrupting other plugins", async () => {
		// Plugin exists in lockfile but directory does not exist on disk
		writePluginsLockfile({
			"@test/ghost-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
			"@test/real-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
		});

		setupPlugin(
			"@test/real-plugin",
			{ extensions: ["./src/ext.ts"] },
			{
				"src/ext.ts": `export default api => { api.registerCommand("real-cmd", { handler: async () => {} }); };`,
			},
		);

		const enabled = await getEnabledPlugins(projectDir.path());
		expect(enabled.map(p => p.name)).toEqual(["@test/real-plugin"]);

		const extPaths = await getAllPluginExtensionPaths(projectDir.path());
		expect(extPaths).toHaveLength(1);
		expect(extPaths[0]?.includes("real-plugin")).toBe(true);
	});

	it("plugin load error in one plugin records error and leaves other plugins intact", async () => {
		setupPlugin(
			"@test/broken-plugin",
			{ extensions: ["./src/broken.ts"] },
			{
				"src/broken.ts": `throw new Error("Syntax or runtime initialization error in broken plugin");`,
			},
		);
		setupPlugin(
			"@test/healthy-plugin",
			{ extensions: ["./src/healthy.ts"] },
			{
				"src/healthy.ts": `export default api => { api.registerCommand("healthy-cmd", { handler: async () => {} }); };`,
			},
		);

		writePluginsLockfile({
			"@test/broken-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
			"@test/healthy-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
		});

		const extPaths = await getAllPluginExtensionPaths(projectDir.path());
		expect(extPaths).toHaveLength(2);

		const loadResult = await loadExtensions(extPaths, projectDir.path());

		// Broken plugin is reported as an error
		expect(loadResult.errors).toHaveLength(1);
		expect(loadResult.errors[0]?.path).toContain("broken.ts");
		expect(loadResult.errors[0]?.error).toContain("Syntax or runtime initialization error in broken plugin");

		// Healthy plugin is loaded and its commands registered
		expect(loadResult.extensions).toHaveLength(1);
		expect(loadResult.extensions[0]?.commands.has("healthy-cmd")).toBe(true);
	});

	it("feature selection resolves defaults vs explicit features vs project overrides", async () => {
		setupPlugin(
			"@test/feature-plugin",
			{
				features: {
					search: { default: true, extensions: ["./src/search.ts"] },
					experimental: { default: false, extensions: ["./src/exp.ts"] },
				},
			},
			{
				"src/search.ts": `export default api => { api.registerCommand("search-cmd", { handler: async () => {} }); };`,
				"src/exp.ts": `export default api => { api.registerCommand("exp-cmd", { handler: async () => {} }); };`,
			},
		);

		// Case 1: enabledFeatures === null -> default: true is included ("search"), default: false omitted
		writePluginsLockfile({
			"@test/feature-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null },
		});
		let extPaths = await getAllPluginExtensionPaths(projectDir.path());
		expect(extPaths.some(p => p.includes("search.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("exp.ts"))).toBe(false);

		// Case 2: enabledFeatures === ["experimental"]
		writePluginsLockfile({
			"@test/feature-plugin": { version: "1.0.0", enabled: true, enabledFeatures: ["experimental"] },
		});
		extPaths = await getAllPluginExtensionPaths(projectDir.path());
		expect(extPaths.some(p => p.includes("search.ts"))).toBe(false);
		expect(extPaths.some(p => p.includes("exp.ts"))).toBe(true);

		// Case 3: Project override overrides lockfile features
		const projConfigDir = path.join(projectDir.path(), ".veyyon");
		fs.mkdirSync(projConfigDir, { recursive: true });
		fs.writeFileSync(
			path.join(projConfigDir, "plugin-overrides.json"),
			JSON.stringify({
				features: { "@test/feature-plugin": ["search", "experimental"] },
			}),
		);
		clearClaudePluginRootsCache();
		extPaths = await getAllPluginExtensionPaths(projectDir.path());
		expect(extPaths.some(p => p.includes("search.ts"))).toBe(true);
		expect(extPaths.some(p => p.includes("exp.ts"))).toBe(true);
	});

	it("plugin settings merges global runtime config and project overrides", async () => {
		writePluginsLockfile(
			{ "@test/configured-plugin": { version: "1.0.0", enabled: true, enabledFeatures: null } },
			{ "@test/configured-plugin": { timeout: 5000, theme: "dark" } },
		);

		const projConfigDir = path.join(projectDir.path(), ".veyyon");
		fs.mkdirSync(projConfigDir, { recursive: true });
		fs.writeFileSync(
			path.join(projConfigDir, "plugin-overrides.json"),
			JSON.stringify({
				settings: { "@test/configured-plugin": { theme: "light", retries: 3 } },
			}),
		);

		const resolvedSettings = await getPluginSettings("@test/configured-plugin", projectDir.path());
		expect(resolvedSettings).toEqual({
			timeout: 5000,
			theme: "light",
			retries: 3,
		});
	});

	it("disabled tool and hook plugins are never imported and enabled tools/hooks load cleanly", async () => {
		setupPlugin(
			"@test/disabled-tool-hook",
			{
				tools: "./src/tool.ts",
				hooks: "./src/hook.ts",
			},
			{
				"src/tool.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/disabled-tool-hook:tool");
					export default api => ({
						name: "bad_tool",
						description: "Should not load",
						parameters: api.typebox.Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "err" }] }),
					});
				`,
				"src/hook.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/disabled-tool-hook:hook");
					export default api => { api.on("session_start", async () => {}); };
				`,
			},
		);

		setupPlugin(
			"@test/enabled-tool-hook",
			{
				tools: "./src/tool.ts",
				hooks: "./src/hook.ts",
			},
			{
				"src/tool.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/enabled-tool-hook:tool");
					export default api => ({
						name: "good_tool",
						description: "Active good tool",
						parameters: api.typebox.Type.Object({}),
						execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
					});
				`,
				"src/hook.ts": `
					globalThis.__pluginExecutionEvidence?.add("@test/enabled-tool-hook:hook");
					export default api => { api.on("session_start", async () => {}); };
				`,
			},
		);

		writePluginsLockfile({
			"@test/disabled-tool-hook": { version: "1.0.0", enabled: false, enabledFeatures: null },
			"@test/enabled-tool-hook": { version: "1.0.0", enabled: true, enabledFeatures: null },
		});

		const toolPaths = await getAllPluginToolPaths(projectDir.path());
		expect(toolPaths.some(p => p.includes("disabled-tool-hook"))).toBe(false);
		expect(toolPaths.some(p => p.includes("enabled-tool-hook"))).toBe(true);

		const loadedTools = await loadCustomTools(
			toolPaths.map(p => ({ path: p })),
			projectDir.path(),
			[],
		);
		expect(loadedTools.tools.map(t => t.tool.name)).toEqual(["good_tool"]);
		expect(loadedTools.errors).toHaveLength(0);

		const hookPaths = await getAllPluginHookPaths(projectDir.path());
		expect(hookPaths.some(p => p.includes("disabled-tool-hook"))).toBe(false);
		expect(hookPaths.some(p => p.includes("enabled-tool-hook"))).toBe(true);

		const loadedHooks = await loadHooks(hookPaths, projectDir.path());
		expect(loadedHooks.hooks).toHaveLength(1);
		expect(loadedHooks.errors).toHaveLength(0);

		expect(globalThis.__pluginExecutionEvidence?.has("@test/disabled-tool-hook:tool")).toBe(false);
		expect(globalThis.__pluginExecutionEvidence?.has("@test/disabled-tool-hook:hook")).toBe(false);
		expect(globalThis.__pluginExecutionEvidence?.has("@test/enabled-tool-hook:tool")).toBe(true);
		expect(globalThis.__pluginExecutionEvidence?.has("@test/enabled-tool-hook:hook")).toBe(true);
	});

	it("normalizes tool event inputs for edit tool hashline paths without affecting execution", () => {
		const singleInput = { input: "¶src/file.ts#1A2B\nSWAP 1.=1:\n+new content" };
		const normSingle = normalizeToolEventInput("edit", singleInput);
		expect(normSingle.path).toBe("src/file.ts");
		expect(normSingle.paths).toEqual(["src/file.ts"]);

		const multiInput = { input: "¶src/a.ts#1111\nSWAP 1.=1:\n+a\n¶src/b.ts#2222\nSWAP 1.=1:\n+b" };
		const normMulti = normalizeToolEventInput("edit", multiInput);
		expect(normMulti.path).toBeUndefined();
		expect(normMulti.paths).toEqual(["src/a.ts", "src/b.ts"]);

		const directPathInput = { _path: "src/direct.ts" };
		const normDirect = normalizeToolEventInput("edit", directPathInput);
		expect(normDirect.path).toBe("src/direct.ts");

		const otherInput = { input: "¶src/file.ts#1A2B" };
		expect(normalizeToolEventInput("bash", otherInput)).toEqual(otherInput);
	});

	it("resolves tool event input correctly for edit and non-edit tools", () => {
		const nonEditInput = { input: "foo" };
		expect(resolveToolEventInput({ name: "bash" }, nonEditInput)).toBe(nonEditInput);

		const editWithoutResolver = { name: "edit" };
		expect(resolveToolEventInput(editWithoutResolver, nonEditInput)).toBe(nonEditInput);

		const editWithResolver = {
			name: "edit",
			resolveEventInput: (val: string) => val.toUpperCase(),
		};
		const modified = resolveToolEventInput(editWithResolver, { input: "hello", other: 123 });
		expect(modified).toEqual({ input: "HELLO", other: 123 });

		const modifiedUnderscore = resolveToolEventInput(editWithResolver, { _input: "world" });
		expect(modifiedUnderscore).toEqual({ _input: "WORLD" });

		const sameInput = { input: "SAME" };
		const identityResolver = { name: "edit", resolveEventInput: (val: string) => val };
		expect(resolveToolEventInput(identityResolver, sameInput)).toBe(sameInput);
	});
});
