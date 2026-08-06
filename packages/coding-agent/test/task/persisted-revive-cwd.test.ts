import { expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { createPersistedSubagentReviverFactory } from "@veyyon/coding-agent/task/persisted-revive";
import { getProjectAgentDir, Snowflake, TempDir } from "@veyyon/utils";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

useIsolatedConfigRoot();

/**
 * A hostile destination fixture. Neither of these files may reach the revived
 * child: a repository contributes context and no configuration. They are here
 * so that restoring the project settings scope shows up as a flipped policy
 * rather than as silence.
 */
async function writeProjectSecretPolicy(cwd: string, enabled: boolean): Promise<void> {
	const projectAgentDir = getProjectAgentDir(cwd);
	await fs.mkdir(projectAgentDir, { recursive: true });
	await fs.writeFile(path.join(projectAgentDir, "settings.json"), JSON.stringify({ secrets: { enabled } }));
}

it("reopens a reusable persisted reviver at the child's latest cwd, and at no project's policy", async () => {
	const root = TempDir.createSync("persisted-revive-cwd-");
	const projectA = path.resolve(root.join("project-a"));
	const projectB = path.resolve(root.join("project-b"));
	const agentDir = path.resolve(root.join("agent"));
	let parent: AgentSession | undefined;
	let revived: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;
	try {
		await Promise.all([
			fs.mkdir(projectA, { recursive: true }),
			fs.mkdir(projectB, { recursive: true }),
			fs.mkdir(agentDir, { recursive: true }),
		]);
		await Promise.all([writeProjectSecretPolicy(projectA, true), writeProjectSecretPolicy(projectB, false)]);

		authStorage = await AuthStorage.create(root.join("auth.db"));
		const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
		const parentSettings = await Settings.loadReadOnly({ cwd: projectB, agentDir });
		({ session: parent } = await createAgentSession({
			cwd: projectB,
			agentDir,
			sessionManager: SessionManager.inMemory(projectB),
			settings: parentSettings,
			modelRegistry,
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			skipPythonPreflight: true,
		}));
		expect(parent.sessionManager.getCwd()).toBe(projectB);
		expect(parent.secretsEnabled).toBe(false);

		const childManager = SessionManager.create(projectA, root.join("persisted-child"));
		childManager.appendSessionInit({
			systemPrompt: "Persisted child",
			task: "Check destination scope",
			tools: ["task", "yield"],
			spawns: "*",
			maxNestedSpawnDepth: 1,
		});
		childManager.appendMessage({ role: "user", content: "ready", timestamp: Date.now() });
		await childManager.ensureOnDisk();
		await childManager.flush();
		const sessionFile = childManager.getSessionFile();
		expect(sessionFile).toBeString();
		await childManager.close();

		const id = `Revive-${Snowflake.next()}`;
		const factory = createPersistedSubagentReviverFactory({
			session: parent,
			authStorage,
			modelRegistry,
			settings: parentSettings,
			enableLsp: false,
		});
		const revive = await factory({
			id,
			displayName: id,
			kind: "sub",
			parentId: MAIN_AGENT_ID,
			status: "parked",
			session: null,
			sessionFile: sessionFile!,
			createdAt: Date.now(),
			lastActivity: Date.now(),
		});
		expect(revive).toBeFunction();

		// Parent B revives child A. The child opens in A, and A's `settings.json`
		// changes nothing about it.
		revived = await revive!();
		expect(revived.sessionManager.getCwd()).toBe(projectA);
		expect(revived.secretsEnabled).toBe(parent.secretsEnabled);
		// The persisted per-agent cap must survive a cold revive. At depth one,
		// cap one retains task; dropping the persisted value would revive as a leaf.
		expect(revived.getToolByName("task")).toBeDefined();
		expect(parent.sessionManager.getCwd()).toBe(projectB);
		expect(parent.secretsEnabled).toBe(false);

		// Negative twin: same-cwd does not rescope the child.
		await revived.setCwd(projectA);
		expect(revived.sessionManager.getCwd()).toBe(projectA);
		expect(revived.secretsEnabled).toBe(parent.secretsEnabled);

		// A live move rebinds the cwd and leaves policy and the parent alone.
		await revived.setCwd(projectB);
		expect(revived.sessionManager.getCwd()).toBe(projectB);
		expect(revived.secretsEnabled).toBe(parent.secretsEnabled);
		expect(parent.sessionManager.getCwd()).toBe(projectB);
		await revived.dispose();
		revived = undefined;

		// Reuse the same closure after the persisted A→B move. It must re-peek and
		// re-open at B rather than retaining the factory-time A header.
		revived = await revive!();
		expect(revived.sessionManager.getCwd()).toBe(projectB);
		expect(revived.secretsEnabled).toBe(parent.secretsEnabled);
	} finally {
		await revived?.dispose();
		await parent?.dispose();
		authStorage?.close();
		await root.remove();
	}
});
