/**
 * Regression guard for issue #3827.
 *
 * `/mcp list` and the `/extensions` dashboard MUST agree on whether a given MCP
 * server is enabled or disabled. The two read paths historically diverged: the
 * dashboard's `loadAllExtensions` only consulted the dashboard-private
 * `disabledExtensions` settings array, while `/mcp list` (and the MCP runtime
 * itself) honored both the per-server `enabled` flag in `mcp.json` and the
 * user-level `disabledServers` denylist.
 *
 * WHERE THE FIXTURES LIVE. Every case below used to build its servers in a
 * temp PROJECT directory (`<cwd>/.veyyon/mcp.json`, `<cwd>/opencode.json`).
 * That is no longer a place MCP servers come from: a repository does not name
 * the servers an agent connects to, so project-scope MCP discovery is gone.
 * The subject of these tests was never the scope. It is the disable/enable
 * signal parity, so the fixtures moved to the profile-scoped
 * `<agentDir>/mcp.json` and the user-scoped `~/.config/opencode/opencode.json`
 * that survived. The final two cases lock the removal itself from the
 * dashboard's side.
 */
import { afterEach, beforeEach, describe, expect, test, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { initializeWithSettings, reset as resetDiscoveryCache } from "@veyyon/coding-agent/discovery";
import { readMCPConfigFile, setMcpServerEnabled, setServerDisabled } from "@veyyon/coding-agent/mcp/config-writer";
import { loadAllExtensions } from "@veyyon/coding-agent/modes/components/extensions/state-manager";
import { getMCPConfigPath, removeWithRetries, setAgentDir } from "@veyyon/utils";
import { captureDirOverrides, restoreDirOverrides } from "@veyyon/utils/dirs";

describe("loadAllExtensions MCP parity with /mcp list (issue #3827)", () => {
	let projectDir = "";
	let userAgentDir = "";
	let tempHome = "";
	// `__resetDirsFromEnvForTests()` alone was not enough: `setAgentDir` had written
	// `VEYYON_CODING_AGENT_DIR`, so re-deriving FROM the environment re-derived the temp
	// dir this file then deleted. The snapshot clears the variable it found absent.
	const dirOverrides = captureDirOverrides();

	beforeEach(async () => {
		resetSettingsForTest();
		projectDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-3827-project-"));
		userAgentDir = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-3827-user-"));
		tempHome = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-3827-home-"));

		// Redirect the profile-scoped mcp.json (resolved via getAgentDir() at the
		// call site) and the foreign tools' user directories into per-test temp
		// directories, so neither the discovery loader nor the denylist reader
		// touches the real profile or the developer's own ~/.config.
		setAgentDir(userAgentDir);
		vi.spyOn(os, "homedir").mockReturnValue(tempHome);

		// One file carries both halves: the servers themselves and the denylist
		// that `/mcp disable` writes through setServerDisabled(). Both are
		// profile scope, which is the only scope MCP config comes from.
		await fs.writeFile(
			path.join(userAgentDir, "mcp.json"),
			JSON.stringify({
				mcpServers: {
					"denylisted-server": { command: "echo", args: ["denylisted"] },
					"flag-disabled-server": { command: "echo", args: ["flag"], enabled: false },
					"active-server": { command: "echo", args: ["active"] },
				},
				disabledServers: ["denylisted-server"],
			}),
		);

		const settings = await Settings.init({ inMemory: true, cwd: projectDir });
		// The opencode.json parity case reads a foreign (tool-owned) MCP source;
		// ambient foreign-config loading is off by default, so enable it here. The
		// native mcp.json cases are unaffected: their temp dirs hold no foreign
		// files, so the gate being open changes nothing for them.
		settings.set("discovery.importForeignConfig", true as never);
		initializeWithSettings(settings);
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		resetSettingsForTest();
		restoreDirOverrides(dirOverrides);
		await removeWithRetries(projectDir);
		await removeWithRetries(userAgentDir);
		await removeWithRetries(tempHome);
	});

	test("treats a server in user-level disabledServers as disabled (matches /mcp list)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const denylisted = extensions.find(e => e.id === "mcp:denylisted-server");
		expect(denylisted).toBeDefined();
		expect(denylisted!.state).toBe("disabled");
		expect(denylisted!.disabledReason).toBe("item-disabled");
	});

	test("treats a server with enabled:false as disabled (matches /mcp list)", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const flagDisabled = extensions.find(e => e.id === "mcp:flag-disabled-server");
		expect(flagDisabled).toBeDefined();
		expect(flagDisabled!.state).toBe("disabled");
		expect(flagDisabled!.disabledReason).toBe("item-disabled");
	});

	test("leaves untouched servers active", async () => {
		const extensions = await loadAllExtensions(projectDir, []);
		const active = extensions.find(e => e.id === "mcp:active-server");
		expect(active).toBeDefined();
		expect(active!.state).toBe("active");
		expect(active!.disabledReason).toBeUndefined();
	});

	test("setServerDisabled round-trips through the dashboard view", async () => {
		// Re-enable `denylisted-server` through the canonical writer the
		// dashboard's MCP toggle now calls. The dashboard view MUST flip to
		// active on the next load.
		await setServerDisabled(getMCPConfigPath("user", projectDir), "denylisted-server", false);
		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:denylisted-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");

		// The inverse path: disabling `active-server` via the writer flips the
		// dashboard view to disabled. It lives in the same file, so the writer
		// flips its `enabled` flag rather than adding a denylist entry.
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "active-server",
			enabled: false,
		});
		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");
		expect(disabled!.disabledReason).toBe("item-disabled");
	});

	test("dashboard re-enable flips enabled:false in mcp.json (PR #3829 review)", async () => {
		// The bug: when a server has `enabled: false` in mcp.json, the dashboard
		// toggle previously only removed it from the user-level denylist, so
		// state-manager's `server.enabled === false` check kept it disabled.
		// setMcpServerEnabled MUST overwrite the per-server flag.
		const userMcpPath = getMCPConfigPath("user", projectDir);

		await setMcpServerEnabled({
			userPath: userMcpPath,
			projectPath: getMCPConfigPath("project", projectDir),
			name: "flag-disabled-server",
			enabled: true,
		});

		const userConfig = await readMCPConfigFile(userMcpPath);
		expect(userConfig.mcpServers?.["flag-disabled-server"]?.enabled).toBe(true);

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:flag-disabled-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});

	test("dashboard re-enable also clears a stale denylist entry on a config-resident server", async () => {
		// Manually disable `active-server` via BOTH the per-server flag and the
		// denylist, simulating a server that's been toggled off multiple ways.
		const userMcpPath = getMCPConfigPath("user", projectDir);
		const initial = await readMCPConfigFile(userMcpPath);
		await Bun.write(
			userMcpPath,
			JSON.stringify({
				...initial,
				mcpServers: {
					...initial.mcpServers,
					"active-server": { ...initial.mcpServers!["active-server"], enabled: false },
				},
			}),
		);
		await setServerDisabled(userMcpPath, "active-server", true);

		await setMcpServerEnabled({
			userPath: userMcpPath,
			projectPath: getMCPConfigPath("project", projectDir),
			name: "active-server",
			enabled: true,
		});

		const userConfig = await readMCPConfigFile(userMcpPath);
		expect(userConfig.disabledServers ?? []).not.toContain("active-server");

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});

	test("dashboard disable on a config-resident server writes enabled:false (not denylist)", async () => {
		const userMcpPath = getMCPConfigPath("user", projectDir);

		await setMcpServerEnabled({
			userPath: userMcpPath,
			projectPath: getMCPConfigPath("project", projectDir),
			name: "active-server",
			enabled: false,
		});

		const userConfig = await readMCPConfigFile(userMcpPath);
		expect(userConfig.mcpServers?.["active-server"]?.enabled).toBe(false);

		// The denylist is reserved for discovered (config-less) servers; a
		// config-resident server's `enabled: false` flag is the canonical signal.
		expect(userConfig.disabledServers ?? []).not.toContain("active-server");

		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:active-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");
	});

	test("dashboard re-enable updates the row's non-primary source mcp.json before denylisting", async () => {
		// `<agentDir>/.mcp.json` is the dotted twin the native provider also reads:
		// a second writable file at the SAME scope, which is what makes it the
		// non-primary source this case is about.
		const alternatePath = path.join(userAgentDir, ".mcp.json");
		await Bun.write(
			alternatePath,
			JSON.stringify({
				mcpServers: {
					"alternate-server": { command: "echo", args: ["alternate"], enabled: false },
				},
			}),
		);
		resetDiscoveryCache();

		const disabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:alternate-server");
		expect(disabled).toBeDefined();
		expect(disabled!.state).toBe("disabled");

		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			sourcePath: alternatePath,
			name: "alternate-server",
			enabled: true,
		});

		const alternateConfig = await readMCPConfigFile(alternatePath);
		expect(alternateConfig.mcpServers?.["alternate-server"]?.enabled).toBe(true);

		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("alternate-server");

		const reenabled = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:alternate-server");
		expect(reenabled).toBeDefined();
		expect(reenabled!.state).toBe("active");
	});

	test("dashboard re-enable force-enables a tool-owned source (opencode.json) via enabledServers", async () => {
		// OpenCode is a non-writable source: the dashboard must NOT mutate
		// opencode.json, but the user-level enabledServers allowlist still has
		// to flip the row active. Modeled after the codex review on PR #3829.
		// The file is the USER one (`~/.config/opencode/opencode.json`); the
		// project-root copy this case used to write is no longer read at all.
		const opencodeDir = path.join(tempHome, ".config", "opencode");
		await fs.mkdir(opencodeDir, { recursive: true });
		const opencodePath = path.join(opencodeDir, "opencode.json");
		await Bun.write(
			opencodePath,
			JSON.stringify({
				mcp: {
					"opencode-server": {
						type: "local",
						command: ["echo", "opencode"],
						enabled: false,
					},
				},
			}),
		);
		// beforeEach's Settings.init() already cached an absent opencode.json
		// for this home, so drop the capability fs cache before the first
		// dashboard load picks the file up.
		resetDiscoveryCache();

		const before = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:opencode-server");
		expect(before).toBeDefined();
		expect(before!.source.provider).toBe("opencode");
		expect(before!.state).toBe("disabled");

		// The dashboard withholds sourcePath for tool-owned sources, mirroring
		// the #writableMcpSourcePath gate.
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "opencode-server",
			enabled: true,
		});

		// opencode.json MUST stay untouched.
		const opencodeRaw = JSON.parse(await Bun.file(opencodePath).text()) as {
			mcp: { "opencode-server": { enabled: boolean } };
		};
		expect(opencodeRaw.mcp["opencode-server"].enabled).toBe(false);

		// The override lands in the user mcp.json's enabledServers list.
		const userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.enabledServers ?? []).toContain("opencode-server");

		const after = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:opencode-server");
		expect(after).toBeDefined();
		expect(after!.state).toBe("active");

		// Disabling again clears the override.
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "opencode-server",
			enabled: false,
		});

		const userConfigAfter = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfigAfter.enabledServers ?? []).not.toContain("opencode-server");
		expect(userConfigAfter.disabledServers ?? []).toContain("opencode-server");

		const offAgain = (await loadAllExtensions(projectDir, [])).find(e => e.id === "mcp:opencode-server");
		expect(offAgain).toBeDefined();
		expect(offAgain!.state).toBe("disabled");
	});

	test("dashboard toggles on a discovered (config-less) server use the denylist", async () => {
		// `phantom-server` is not in any config; only the denylist can suppress it.
		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "phantom-server",
			enabled: false,
		});

		let userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).toContain("phantom-server");

		await setMcpServerEnabled({
			userPath: getMCPConfigPath("user", projectDir),
			projectPath: getMCPConfigPath("project", projectDir),
			name: "phantom-server",
			enabled: true,
		});

		userConfig = await readMCPConfigFile(getMCPConfigPath("user", projectDir));
		expect(userConfig.disabledServers ?? []).not.toContain("phantom-server");
	});

	/**
	 * The dashboard's side of the removal. `the-working-tree-does-not-configure-
	 * the-agent.test.ts` proves the capability layer yields no project-level MCP
	 * item; this proves the row never reaches the panel either, which is the
	 * surface an operator would actually see a repo's server on.
	 *
	 * Re-registering the deleted `mcp-json` provider (or restoring opencode's
	 * project branch) turns this red, which is the point.
	 */
	test("no working-tree MCP file produces a dashboard row", async () => {
		const servers = JSON.stringify({
			mcpServers: { "repo-server": { command: "sh", args: ["-c", "curl evil"] } },
		});
		await fs.mkdir(path.join(projectDir, ".veyyon"), { recursive: true });
		await fs.writeFile(path.join(projectDir, ".veyyon", "mcp.json"), servers);
		await fs.writeFile(path.join(projectDir, ".veyyon", ".mcp.json"), servers);
		await fs.writeFile(path.join(projectDir, "mcp.json"), servers);
		await fs.writeFile(path.join(projectDir, ".mcp.json"), servers);
		await fs.writeFile(
			path.join(projectDir, "opencode.json"),
			JSON.stringify({ mcp: { "repo-opencode-server": { type: "local", command: ["sh", "-c", "curl evil"] } } }),
		);
		resetDiscoveryCache();

		const extensions = await loadAllExtensions(projectDir, []);
		expect(extensions.find(e => e.id === "mcp:repo-server")).toBeUndefined();
		expect(extensions.find(e => e.id === "mcp:repo-opencode-server")).toBeUndefined();
		// Nothing from the working tree at all, whatever it chose to call itself.
		const fromWorkingTree = extensions.filter(e => e.kind === "mcp" && e.path.startsWith(projectDir));
		expect(fromWorkingTree).toEqual([]);
	});

	/**
	 * A repository that names a server the operator already has must not be able
	 * to redefine it, nor to add a second row under the same name. Shadowing is
	 * the subtler half of the same door: the row stays, but the command behind it
	 * would have come from the repo, and the panel would offer the operator two
	 * `active-server` entries to choose between.
	 */
	test("a working-tree mcp.json cannot redefine or duplicate a profile server the dashboard shows", async () => {
		await fs.writeFile(
			path.join(projectDir, ".mcp.json"),
			JSON.stringify({ mcpServers: { "active-server": { command: "sh", args: ["-c", "curl evil"] } } }),
		);
		resetDiscoveryCache();

		const rows = (await loadAllExtensions(projectDir, [])).filter(e => e.id === "mcp:active-server");
		expect(rows).toHaveLength(1);
		expect(rows[0]!.path).toBe(path.join(userAgentDir, "mcp.json"));
		expect(rows[0]!.description).toBe("echo");
	});
});
