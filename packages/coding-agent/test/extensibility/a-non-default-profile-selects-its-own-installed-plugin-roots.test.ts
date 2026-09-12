/**
 * WHY THIS SUITE EXISTS:
 *
 * A session rooted in a non-default profile (e.g. `agentDir = .../profiles/named/agent`)
 * must discover and load only THAT profile's installed plugins (`.../profiles/named/plugins`),
 * and the active profile's plugins (`.../profiles/active/plugins`) must NEVER leak in.
 *
 * Confirmed defect: `discoverExtensionPaths` invoked `getAllPluginExtensionPaths(cwd)`
 * without passing the profile's plugin root (`agentDir ? pluginsRootFor(agentDir) : undefined`),
 * while `discoverCustomToolPaths` passed it. Furthermore, `getAllPluginHookPaths`,
 * `getAllPluginCommandPaths`, and `getAllPluginExtensionPaths` lacked support for passing
 * an explicit `pluginsRoot` or options object.
 *
 * WHAT THIS SUITE COVERS:
 * 1. `discoverExtensionPaths` and `discoverAndLoadExtensions` with non-default profile roots.
 * 2. `getAllPluginExtensionPaths`, `getAllPluginToolPaths`, `getAllPluginHookPaths`, and
 *    `getAllPluginCommandPaths` with explicit pluginsRoot strings and options objects.
 * 3. Custom tool path discovery and skills, rules, prompts, slash commands, and MCP capabilities.
 * 4. Project plugin precedence over profile plugins.
 * 5. Disabled states (lockfile, project overrides, and item-level disabledExtensionIds).
 * 6. Default/missing root behavior and alternating profile switches without stale cache bleed.
 *
 * WHAT IT DOES NOT CATCH:
 * Hook and custom-tool execution, or external network package installation.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { type MCPServer, mcpCapability } from "@veyyon/coding-agent/discovery/capability/mcp";
import { type Prompt, promptCapability } from "@veyyon/coding-agent/discovery/capability/prompt";
import { type Rule, ruleCapability } from "@veyyon/coding-agent/discovery/capability/rule";
import { type DiscoveredSkill, skillCapability } from "@veyyon/coding-agent/discovery/capability/skill";
import { type SlashCommand, slashCommandCapability } from "@veyyon/coding-agent/discovery/capability/slash-command";
import { pluginsRootFor } from "@veyyon/coding-agent/discovery/helpers";
import { discoverCustomToolPaths } from "@veyyon/coding-agent/extensibility/custom-tools";
import { discoverAndLoadExtensions, discoverExtensionPaths } from "@veyyon/coding-agent/extensibility/extensions";
import {
	getAllPluginCommandPaths,
	getAllPluginExtensionPaths,
	getAllPluginHookPaths,
	getAllPluginToolPaths,
} from "@veyyon/coding-agent/extensibility/plugins/loader";
import { discoverExtensions } from "@veyyon/coding-agent/session/factory-extensions";
import { useContextScopeFixture } from "../helpers/context-scope-fixture";

const fixture = useContextScopeFixture("two-profile-plugins-");

interface PluginFiles {
	name: string;
	extensions?: string[];
	tools?: string[];
	hooks?: string[];
	commands?: string[];
	features?: Record<string, { extensions?: string[]; tools?: string[]; default?: boolean }>;
}

function installSyntheticPlugin(
	f: { writeFile(filePath: string, content: string): string },
	pluginsRoot: string,
	manifest: PluginFiles,
	enabled = true,
): { dir: string; files: Record<string, string[]> } {
	const pluginDir = path.join(pluginsRoot, "node_modules", manifest.name);
	const writtenFiles: Record<string, string[]> = {
		extensions: [],
		tools: [],
		hooks: [],
		commands: [],
	};

	// 1. package.json in pluginsRoot declaring dependency
	const rootPkgPath = path.join(pluginsRoot, "package.json");
	let rootDeps: Record<string, string> = {};
	try {
		if (fs.existsSync(rootPkgPath)) {
			rootDeps = JSON.parse(fs.readFileSync(rootPkgPath, "utf8")).dependencies ?? {};
		}
	} catch {
		// ignore
	}
	rootDeps[manifest.name] = "1.0.0";
	f.writeFile(rootPkgPath, JSON.stringify({ dependencies: rootDeps }, null, 2));

	// 2. veyyon-plugins.lock.json in pluginsRoot
	const lockPath = path.join(pluginsRoot, "veyyon-plugins.lock.json");
	let lockPlugins: Record<string, unknown> = {};
	try {
		if (fs.existsSync(lockPath)) {
			lockPlugins = JSON.parse(fs.readFileSync(lockPath, "utf8")).plugins ?? {};
		}
	} catch {
		// ignore
	}
	lockPlugins[manifest.name] = { enabled };
	f.writeFile(lockPath, JSON.stringify({ version: 1, plugins: lockPlugins }, null, 2));

	// 3. Plugin files
	if (manifest.extensions) {
		for (const rel of manifest.extensions) {
			const abs = f.writeFile(
				path.join(pluginDir, rel),
				`export default () => ({ name: "${manifest.name}-${rel}" });\n`,
			);
			writtenFiles.extensions.push(abs);
		}
	}
	if (manifest.tools) {
		for (const rel of manifest.tools) {
			const abs = f.writeFile(
				path.join(pluginDir, rel),
				`export default { name: "${manifest.name}-${rel}", description: "tool", run: async () => ({}) };\n`,
			);
			writtenFiles.tools.push(abs);
		}
	}
	if (manifest.hooks) {
		for (const rel of manifest.hooks) {
			const abs = f.writeFile(
				path.join(pluginDir, rel),
				`export default (pi) => { pi.on("preToolUse", () => {}); };\n`,
			);
			writtenFiles.hooks.push(abs);
		}
	}
	if (manifest.commands) {
		for (const rel of manifest.commands) {
			const abs = f.writeFile(
				path.join(pluginDir, rel),
				`export default { name: "${manifest.name}-${rel}", run: async () => {} };\n`,
			);
			writtenFiles.commands.push(abs);
		}
	}

	// 4. Plugin package.json
	f.writeFile(
		path.join(pluginDir, "package.json"),
		JSON.stringify(
			{
				name: manifest.name,
				version: "1.0.0",
				veyyon: {
					...(manifest.extensions && { extensions: manifest.extensions }),
					...(manifest.tools && { tools: manifest.tools }),
					...(manifest.hooks && { hooks: manifest.hooks }),
					...(manifest.commands && { commands: manifest.commands }),
					...(manifest.features && { features: manifest.features }),
				},
			},
			null,
			2,
		),
	);

	return { dir: pluginDir, files: writtenFiles };
}

describe("Non-default profiles consistently isolate installed plugin roots", () => {
	test("discoverExtensionPaths returns only the named profile's plugin extensions, not the active profile's", async () => {
		const f = fixture("ext-profile-active");
		const namedAgentDir = f.agentDirFor("ext-profile-named");

		const activePluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
		const namedPluginsRoot = path.join(path.dirname(namedAgentDir), "plugins");

		const activePlugin = installSyntheticPlugin(f, activePluginsRoot, {
			name: "active-plugin-pkg",
			extensions: ["active-ext.ts"],
		});
		const namedPlugin = installSyntheticPlugin(f, namedPluginsRoot, {
			name: "named-plugin-pkg",
			extensions: ["named-ext.ts"],
		});

		// 1. Discovery without agentDir resolves process-active profile's plugins
		const defaulted = await discoverExtensionPaths([], f.cwd);
		expect(defaulted).toContain(activePlugin.files.extensions[0]!);
		expect(defaulted).not.toContain(namedPlugin.files.extensions[0]!);

		// 2. Discovery with namedAgentDir MUST resolve named profile's plugins and NOT active profile's
		f.resetCaches();
		const named = await discoverExtensionPaths([], f.cwd, undefined, namedAgentDir);
		expect(named).toContain(namedPlugin.files.extensions[0]!);
		expect(named).not.toContain(activePlugin.files.extensions[0]!);
	});

	test("getAllPlugin*Paths helpers resolve the named pluginsRoot and accept both string and options", async () => {
		const f = fixture("helpers-active");
		const namedAgentDir = f.agentDirFor("helpers-named");

		const activePluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
		const namedPluginsRoot = path.join(path.dirname(namedAgentDir), "plugins");

		const activePlugin = installSyntheticPlugin(f, activePluginsRoot, {
			name: "active-all-cap",
			extensions: ["active-ext.ts"],
			tools: ["active-tool.ts"],
			hooks: ["active-hook.ts"],
			commands: ["active-cmd.ts"],
		});
		const namedPlugin = installSyntheticPlugin(f, namedPluginsRoot, {
			name: "named-all-cap",
			extensions: ["named-ext.ts"],
			tools: ["named-tool.ts"],
			hooks: ["named-hook.ts"],
			commands: ["named-cmd.ts"],
		});

		const namedRoot = pluginsRootFor(namedAgentDir);
		expect(namedRoot).toBe(namedPluginsRoot);

		// String argument
		expect(await getAllPluginExtensionPaths(f.cwd, namedRoot)).toEqual(namedPlugin.files.extensions);
		expect(await getAllPluginToolPaths(f.cwd, namedRoot)).toEqual(namedPlugin.files.tools);
		expect(await getAllPluginHookPaths(f.cwd, namedRoot)).toEqual(namedPlugin.files.hooks);
		expect(await getAllPluginCommandPaths(f.cwd, namedRoot)).toEqual(namedPlugin.files.commands);

		// Options object argument
		expect(await getAllPluginExtensionPaths(f.cwd, { pluginsRoot: namedRoot })).toEqual(namedPlugin.files.extensions);
		expect(await getAllPluginToolPaths(f.cwd, { pluginsRoot: namedRoot })).toEqual(namedPlugin.files.tools);
		expect(await getAllPluginHookPaths(f.cwd, { pluginsRoot: namedRoot })).toEqual(namedPlugin.files.hooks);
		expect(await getAllPluginCommandPaths(f.cwd, { pluginsRoot: namedRoot })).toEqual(namedPlugin.files.commands);

		// Default (active profile)
		expect(await getAllPluginExtensionPaths(f.cwd)).toEqual(activePlugin.files.extensions);
		expect(await getAllPluginToolPaths(f.cwd)).toEqual(activePlugin.files.tools);
		expect(await getAllPluginHookPaths(f.cwd)).toEqual(activePlugin.files.hooks);
		expect(await getAllPluginCommandPaths(f.cwd)).toEqual(activePlugin.files.commands);
	});

	test("discoverCustomToolPaths returns only the named profile's plugin tools", async () => {
		const f = fixture("tool-paths-active");
		const namedAgentDir = f.agentDirFor("tool-paths-named");

		const activePluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
		const namedPluginsRoot = path.join(path.dirname(namedAgentDir), "plugins");

		const activePlugin = installSyntheticPlugin(f, activePluginsRoot, {
			name: "active-tool-pkg",
			tools: ["active-tool.ts"],
		});
		const namedPlugin = installSyntheticPlugin(f, namedPluginsRoot, {
			name: "named-tool-pkg",
			tools: ["named-tool.ts"],
		});

		const defaulted = await discoverCustomToolPaths([], f.cwd);
		const defaultedPaths = defaulted.map(t => t.path);
		expect(defaultedPaths).toContain(activePlugin.files.tools[0]!);
		expect(defaultedPaths).not.toContain(namedPlugin.files.tools[0]!);

		f.resetCaches();
		const named = await discoverCustomToolPaths([], f.cwd, namedAgentDir);
		const namedPaths = named.map(t => t.path);
		expect(namedPaths).toContain(namedPlugin.files.tools[0]!);
		expect(namedPaths).not.toContain(activePlugin.files.tools[0]!);
	});

	test("project plugin precedence shadows user profile plugins across profiles", async () => {
		const f = fixture("project-shadow-active");
		const namedAgentDir = f.agentDirFor("project-shadow-named");

		const activePluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
		const namedPluginsRoot = path.join(path.dirname(namedAgentDir), "plugins");
		const projectPluginsRoot = path.join(f.repoRoot, ".veyyon", "plugins");

		// User profiles each have "shared-pkg" with their own files
		installSyntheticPlugin(f, activePluginsRoot, {
			name: "shared-pkg",
			extensions: ["active-shared.ts"],
		});
		installSyntheticPlugin(f, namedPluginsRoot, {
			name: "shared-pkg",
			extensions: ["named-shared.ts"],
		});

		// Project root has "shared-pkg" with project files
		const projectPlugin = installSyntheticPlugin(f, projectPluginsRoot, {
			name: "shared-pkg",
			extensions: ["project-shared.ts"],
		});

		// Project plugin must shadow user plugin for both active and named profiles
		const defaultedExts = await getAllPluginExtensionPaths(f.cwd);
		expect(defaultedExts).toEqual(projectPlugin.files.extensions);

		const namedExts = await getAllPluginExtensionPaths(f.cwd, pluginsRootFor(namedAgentDir));
		expect(namedExts).toEqual(projectPlugin.files.extensions);
	});

	test("disabled plugin in lockfile or project overrides is excluded in named profile", async () => {
		const f = fixture("disabled-plugins-active");
		const namedAgentDir = f.agentDirFor("disabled-plugins-named");

		const namedPluginsRoot = path.join(path.dirname(namedAgentDir), "plugins");

		// 1. Disabled in lockfile
		installSyntheticPlugin(
			f,
			namedPluginsRoot,
			{
				name: "lockfile-disabled-pkg",
				extensions: ["disabled-ext.ts"],
			},
			false, // enabled = false
		);

		// 2. Enabled in lockfile, but disabled in project overrides
		installSyntheticPlugin(
			f,
			namedPluginsRoot,
			{
				name: "project-override-disabled-pkg",
				extensions: ["override-disabled-ext.ts"],
			},
			true,
		);
		f.writeFile(
			path.join(f.cwd, ".veyyon", "plugin-overrides.json"),
			JSON.stringify({ disabled: ["project-override-disabled-pkg"] }),
		);

		// 3. Normal enabled plugin
		const enabledPlugin = installSyntheticPlugin(
			f,
			namedPluginsRoot,
			{
				name: "normal-enabled-pkg",
				extensions: ["normal-ext.ts"],
			},
			true,
		);

		const namedExts = await getAllPluginExtensionPaths(f.cwd, pluginsRootFor(namedAgentDir));
		expect(namedExts).toEqual(enabledPlugin.files.extensions);

		// Also check discoverExtensionPaths with item-level disabledExtensionIds
		const discovered = await discoverExtensionPaths([], f.cwd, ["extension-module:normal-ext"], namedAgentDir);
		expect(discovered).toEqual([]);
	});

	test("switching profiles repeatedly does not bleed cached plugin paths across profiles", async () => {
		const f = fixture("cache-switch-active");
		const profileBAgentDir = f.agentDirFor("cache-switch-b");
		const profileCAgentDir = f.agentDirFor("cache-switch-c");

		const pluginsRootA = path.join(path.dirname(f.agentDir), "plugins");
		const pluginsRootB = path.join(path.dirname(profileBAgentDir), "plugins");
		const pluginsRootC = path.join(path.dirname(profileCAgentDir), "plugins");

		const pluginA = installSyntheticPlugin(f, pluginsRootA, {
			name: "plugin-a",
			extensions: ["ext-a.ts"],
		});
		const pluginB = installSyntheticPlugin(f, pluginsRootB, {
			name: "plugin-b",
			extensions: ["ext-b.ts"],
		});
		const pluginC = installSyntheticPlugin(f, pluginsRootC, {
			name: "plugin-c",
			extensions: ["ext-c.ts"],
		});

		// Sequential interleaved calls without clearing caches in between
		expect(await getAllPluginExtensionPaths(f.cwd)).toEqual(pluginA.files.extensions);
		expect(await getAllPluginExtensionPaths(f.cwd, pluginsRootFor(profileBAgentDir))).toEqual(
			pluginB.files.extensions,
		);
		expect(await getAllPluginExtensionPaths(f.cwd, pluginsRootFor(profileCAgentDir))).toEqual(
			pluginC.files.extensions,
		);
		expect(await getAllPluginExtensionPaths(f.cwd)).toEqual(pluginA.files.extensions);
		expect(await getAllPluginExtensionPaths(f.cwd, pluginsRootFor(profileBAgentDir))).toEqual(
			pluginB.files.extensions,
		);
	});

	test("missing or empty plugins root degrades gracefully to empty array", async () => {
		const f = fixture("empty-plugins-active");
		const emptyAgentDir = f.agentDirFor("empty-plugins-named");

		// Non-existent plugins directory
		const exts = await getAllPluginExtensionPaths(f.cwd, pluginsRootFor(emptyAgentDir));
		expect(exts).toEqual([]);

		const tools = await getAllPluginToolPaths(f.cwd, pluginsRootFor(emptyAgentDir));
		expect(tools).toEqual([]);

		const hooks = await getAllPluginHookPaths(f.cwd, pluginsRootFor(emptyAgentDir));
		expect(hooks).toEqual([]);

		const commands = await getAllPluginCommandPaths(f.cwd, pluginsRootFor(emptyAgentDir));
		expect(commands).toEqual([]);
	});

	test("discoverAndLoadExtensions and discoverExtensions load only the named profile's extensions", async () => {
		const f = fixture("load-ext-active");
		const namedAgentDir = f.agentDirFor("load-ext-named");

		const activePluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
		const namedPluginsRoot = path.join(path.dirname(namedAgentDir), "plugins");

		const activePlugin = installSyntheticPlugin(f, activePluginsRoot, {
			name: "active-load-pkg",
			extensions: ["active-main.ts"],
		});
		const namedPlugin = installSyntheticPlugin(f, namedPluginsRoot, {
			name: "named-load-pkg",
			extensions: ["named-main.ts"],
		});

		// 1. discoverAndLoadExtensions with namedAgentDir
		const namedLoaded = await discoverAndLoadExtensions([], f.cwd, undefined, undefined, namedAgentDir);
		expect(namedLoaded.errors).toEqual([]);
		expect(namedLoaded.extensions.map(e => e.path)).toEqual(namedPlugin.files.extensions);

		// 2. discoverExtensions with namedAgentDir
		f.resetCaches();
		const sdkLoaded = await discoverExtensions(f.cwd, namedAgentDir);
		expect(sdkLoaded.errors).toEqual([]);
		expect(sdkLoaded.extensions.map(e => e.path)).toEqual(namedPlugin.files.extensions);

		// 3. discoverExtensions without namedAgentDir (active profile)
		f.resetCaches();
		const activeLoaded = await discoverExtensions(f.cwd);
		expect(activeLoaded.errors).toEqual([]);
		expect(activeLoaded.extensions.map(e => e.path)).toEqual(activePlugin.files.extensions);
	});

	test("capability registry enumerates plugin-contributed items for the named profile", async () => {
		const f = fixture("cap-registry-active");
		const namedAgentDir = f.agentDirFor("cap-registry-named");

		const activePluginsRoot = path.join(path.dirname(f.agentDir), "plugins");
		const namedPluginsRoot = path.join(path.dirname(namedAgentDir), "plugins");

		// Active profile plugin package with sub-directories
		const activePluginDir = path.join(activePluginsRoot, "node_modules", "active-full-pkg");
		installSyntheticPlugin(f, activePluginsRoot, { name: "active-full-pkg" });
		f.writeFile(
			path.join(activePluginDir, "skills", "active-skill", "SKILL.md"),
			"---\nname: active-skill\ndescription: active\n---\nbody\n",
		);
		f.writeFile(
			path.join(activePluginDir, "rules", "active-rule.md"),
			"---\nname: active-rule\ndescription: active\n---\nbody\n",
		);
		f.writeFile(path.join(activePluginDir, "prompts", "active-prompt.md"), "prompt body\n");
		f.writeFile(path.join(activePluginDir, "commands", "active-slash.md"), "command body\n");
		f.writeFile(
			path.join(activePluginDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { "active-mcp": { command: "node" } } }),
		);

		// Named profile plugin package with sub-directories
		const namedPluginDir = path.join(namedPluginsRoot, "node_modules", "named-full-pkg");
		installSyntheticPlugin(f, namedPluginsRoot, { name: "named-full-pkg" });
		f.writeFile(
			path.join(namedPluginDir, "skills", "named-skill", "SKILL.md"),
			"---\nname: named-skill\ndescription: named\n---\nbody\n",
		);
		f.writeFile(
			path.join(namedPluginDir, "rules", "named-rule.md"),
			"---\nname: named-rule\ndescription: named\n---\nbody\n",
		);
		f.writeFile(path.join(namedPluginDir, "prompts", "named-prompt.md"), "prompt body\n");
		f.writeFile(path.join(namedPluginDir, "commands", "named-slash.md"), "command body\n");
		f.writeFile(
			path.join(namedPluginDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { "named-mcp": { command: "node" } } }),
		);

		// Query capabilities with namedAgentDir
		const skills = await loadCapability<DiscoveredSkill>(skillCapability.id, { cwd: f.cwd, agentDir: namedAgentDir });
		expect(skills.items.map(i => i.name)).toContain("named-skill");
		expect(skills.items.map(i => i.name)).not.toContain("active-skill");

		const rules = await loadCapability<Rule>(ruleCapability.id, { cwd: f.cwd, agentDir: namedAgentDir });
		expect(rules.items.map(i => i.name)).toContain("named-rule");
		expect(rules.items.map(i => i.name)).not.toContain("active-rule");

		const prompts = await loadCapability<Prompt>(promptCapability.id, { cwd: f.cwd, agentDir: namedAgentDir });
		expect(prompts.items.map(i => i.name)).toContain("named-prompt");
		expect(prompts.items.map(i => i.name)).not.toContain("active-prompt");

		const slashCmds = await loadCapability<SlashCommand>(slashCommandCapability.id, {
			cwd: f.cwd,
			agentDir: namedAgentDir,
		});
		expect(slashCmds.items.map(i => i.name)).toContain("named-slash");
		expect(slashCmds.items.map(i => i.name)).not.toContain("active-slash");

		const mcps = await loadCapability<MCPServer>(mcpCapability.id, { cwd: f.cwd, agentDir: namedAgentDir });
		expect(mcps.items.map(i => i.name)).toContain("named-mcp");
		expect(mcps.items.map(i => i.name)).not.toContain("active-mcp");
	});
});
