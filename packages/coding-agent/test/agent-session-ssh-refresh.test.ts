import { afterEach, beforeEach, describe, expect, it, spyOn } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { reset as resetCapabilities } from "@veyyon/coding-agent/capability";
import { type SSHHost, sshCapability } from "@veyyon/coding-agent/capability/ssh";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadCapability } from "@veyyon/coding-agent/discovery";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { addSSHHost, removeSSHHost, updateSSHHost } from "@veyyon/coding-agent/ssh/config-writer";
import * as connectionManager from "@veyyon/coding-agent/ssh/connection-manager";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { loadSshTool } from "@veyyon/coding-agent/tools/ssh";
import {
	captureDirOverrides,
	type DirOverridesSnapshot,
	getSSHConfigPath,
	restoreDirOverrides,
	setAgentDir,
	TempDir,
} from "@veyyon/utils";

function createModel(): Model<"openai-responses"> {
	return buildModel({
		id: "mock",
		name: "mock",
		api: "openai-responses",
		provider: "openai",
		baseUrl: "https://example.invalid",
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 8192,
		maxTokens: 2048,
	});
}

/**
 * SSH hosts are read from the loading PROFILE's `ssh.json` and nowhere else.
 *
 * This suite used to write `<cwd>/.veyyon/ssh.json` and assert the tool picked
 * it up, which was a green test defending the defect: a repository could name
 * the machines the ssh tool connects to. It now writes the profile file, so it
 * still measures the refresh mechanics, and the last case pins the removal.
 */
describe("AgentSession SSH tool refresh", () => {
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];
	let configPath: string;
	let dirOverrides: DirOverridesSnapshot;

	beforeEach(() => {
		const agentHome = TempDir.createSync("@pi-ssh-agent-");
		tempDirs.push(agentHome);
		dirOverrides = captureDirOverrides();
		setAgentDir(agentHome.path());
		configPath = getSSHConfigPath();
		fs.mkdirSync(path.dirname(configPath), { recursive: true });
	});

	afterEach(async () => {
		for (const session of sessions.splice(0)) {
			await session.dispose();
		}
		restoreDirOverrides(dirOverrides);
		for (const tempDir of tempDirs.splice(0)) {
			tempDir.removeSync();
		}
		resetCapabilities();
	});

	function createSession(
		cwd: string,
		initialTools: AgentTool[] = [],
		registryTools = initialTools,
		options?: { reloadSshTool?: () => Promise<AgentTool | null>; requestedToolNames?: ReadonlySet<string> },
	): AgentSession {
		const settings = Settings.isolated({ "compaction.enabled": false });
		const sessionManager = SessionManager.inMemory(cwd);
		const toolSession: ToolSession = {
			cwd,
			hasUI: false,
			settings,
			getSessionFile: () => sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => "*",
		};
		const toolRegistry = new Map(registryTools.map(tool => [tool.name, tool]));
		const agent = new Agent({
			initialState: {
				model: createModel(),
				systemPrompt: ["initial"],
				tools: initialTools,
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings,
			modelRegistry: {} as never,
			toolRegistry,
			reloadSshTool:
				options?.reloadSshTool ?? (async () => (await loadSshTool(toolSession)) as unknown as AgentTool | null),
			requestedToolNames: options?.requestedToolNames,
			rebuildSystemPrompt: async (toolNames, tools) => ({
				systemPrompt: toolNames.map(name => `${name}:${tools.get(name)?.description ?? ""}`),
			}),
		});
		sessions.push(session);
		return session;
	}

	it("adds the ssh tool after a first host is written over a cached missing config", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		const preWrite = await loadCapability<SSHHost>(sshCapability.id, { cwd });
		expect(preWrite.items).toHaveLength(0);

		const session = createSession(cwd);
		await addSSHHost(configPath, "staging", { host: "192.0.2.10" });
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("staging (192.0.2.10)");
		expect(session.agent.state.systemPrompt.join("\n")).toContain("staging (192.0.2.10)");
	});

	it("removes ssh from registry and active tools when the last host is removed", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		await addSSHHost(configPath, "prod", { host: "203.0.113.9" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		const session = createSession(cwd, [sshTool as unknown as AgentTool]);
		await removeSSHHost(configPath, "prod");
		await session.refreshSshTool();

		expect(session.getAllToolNames()).not.toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
	});

	it("does not activate an existing inactive ssh tool during reload refresh", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		await addSSHHost(configPath, "dev", { host: "192.0.2.20" });
		const sshTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(sshTool).not.toBeNull();

		await addSSHHost(configPath, "dev2", { host: "192.0.2.21" });
		const session = createSession(cwd, [], [sshTool as unknown as AgentTool]);
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
		expect(session.getToolByName("ssh")?.description).toContain("dev2 (192.0.2.21)");
	});

	it("reloads ssh from the session's current cwd after move", async () => {
		const oldProject = TempDir.createSync("@pi-ssh-refresh-old-");
		const newProject = TempDir.createSync("@pi-ssh-refresh-new-");
		tempDirs.push(oldProject, newProject);
		await SessionManager.inMemory(oldProject.path()).moveTo?.(newProject.path());
		await addSSHHost(configPath, "moved", { host: "198.51.100.8" });
		const movedTool = await loadSshTool({
			cwd: newProject.path(),
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(movedTool).not.toBeNull();

		const refreshedSession = createSession(oldProject.path(), [], [], {
			reloadSshTool: async () => movedTool as unknown as AgentTool,
		});
		await refreshedSession.refreshSshTool({ activateIfAvailable: true });

		expect(refreshedSession.getAllToolNames()).toContain("ssh");
		expect(refreshedSession.getToolByName("ssh")?.description).toContain("moved (198.51.100.8)");
	});

	it("invalidates cached host metadata before rebuilding descriptions when a host config changes", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		await addSSHHost(configPath, "prod", { host: "203.0.113.9" });
		const initialTool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: Settings.isolated({ "compaction.enabled": false }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(initialTool).not.toBeNull();
		const session = createSession(cwd, [initialTool as unknown as AgentTool]);

		const invalidateSpy = spyOn(connectionManager, "invalidateHostMetadata").mockResolvedValue(undefined);
		await updateSSHHost(configPath, "prod", { host: "203.0.113.10" });
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(invalidateSpy).toHaveBeenNthCalledWith(1, new Set(["prod"]));
		expect(session.getToolByName("ssh")?.description).toContain("prod (203.0.113.10)");
	});

	it("invalidates newly added host names before rebuilding the ssh tool", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		await addSSHHost(configPath, "fresh", { host: "203.0.113.11" });
		const session = createSession(cwd);
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getToolByName("ssh")?.description).toContain("fresh (203.0.113.11)");
		expect(session.getToolByName("ssh")?.description).toContain("fresh (203.0.113.11)");
	});

	it("does not activate ssh when it was excluded from the requested tool allowlist", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();
		const blockedTool: AgentTool = {
			name: "ssh",
			label: "SSH",
			description: "blocked",
			parameters: { type: "object", properties: {} },
			strict: true,
			execute: async () => ({ content: [{ type: "text", text: "" }] }),
		};

		await addSSHHost(configPath, "hidden", { host: "203.0.113.12" });
		const session = createSession(cwd, [], [blockedTool], {
			reloadSshTool: async () => blockedTool,
			requestedToolNames: new Set(["read"]),
		});
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).toContain("ssh");
		expect(session.getActiveToolNames()).not.toContain("ssh");
	});

	it("ignores an ssh.json checked into the working tree", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		// All three candidates a repository could once supply.
		for (const relative of [path.join(".veyyon", "ssh.json"), "ssh.json", ".ssh.json"]) {
			const repoFile = path.join(cwd, relative);
			fs.mkdirSync(path.dirname(repoFile), { recursive: true });
			await addSSHHost(repoFile, "from-the-repo", { host: "hostile.invalid" });
		}

		const session = createSession(cwd);
		await session.refreshSshTool({ activateIfAvailable: true });

		expect(session.getAllToolNames()).not.toContain("ssh");

		const discovered = await loadCapability<SSHHost>(sshCapability.id, { cwd });
		expect(discovered.all.map(host => host.name)).not.toContain("from-the-repo");
	});

	/**
	 * The other direction, and the defect that pointed the opposite way: the user
	 * scope used to resolve `getAgentDir()` (the PROCESS-BOOTED profile) no matter
	 * which profile the caller was loading for, so a host running a session for a
	 * non-active profile handed the model the booted profile's machines. The
	 * loading agent dir is the whole answer to "whose ssh.json", so it is asserted
	 * at both doors: the capability, and the tool the model actually calls.
	 */
	it("gives a session loading for a non-active profile its own hosts, not the booted profile's", async () => {
		const tempDir = TempDir.createSync("@pi-ssh-refresh-");
		tempDirs.push(tempDir);
		const cwd = tempDir.path();

		const otherProfile = TempDir.createSync("@pi-ssh-other-profile-");
		tempDirs.push(otherProfile);
		const otherAgentDir = otherProfile.path();

		await addSSHHost(configPath, "booted-profile-host", { host: "192.0.2.71" });
		await addSSHHost(getSSHConfigPath(otherAgentDir), "other-profile-host", { host: "192.0.2.72" });

		const discovered = await loadCapability<SSHHost>(sshCapability.id, { cwd, agentDir: otherAgentDir });
		expect(discovered.all.map(host => `${host.name} ${host.host}`)).toEqual(["other-profile-host 192.0.2.72"]);

		resetCapabilities();
		const tool = await loadSshTool({
			cwd,
			hasUI: false,
			settings: await Settings.loadReadOnly({ cwd, agentDir: otherAgentDir }),
			getSessionSpawns: () => "*",
			getSessionFile: () => null,
		});
		expect(tool?.description).toContain("other-profile-host (192.0.2.72)");
		expect(tool?.description).not.toContain("booted-profile-host");
	});
});
