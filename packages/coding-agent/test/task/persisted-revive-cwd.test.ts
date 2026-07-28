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

async function writeProjectSecretPolicy(cwd: string, enabled: boolean): Promise<void> {
	const projectAgentDir = getProjectAgentDir(cwd);
	await fs.mkdir(projectAgentDir, { recursive: true });
	await fs.writeFile(path.join(projectAgentDir, "settings.json"), JSON.stringify({ secrets: { enabled } }));
}

it("reopens a reusable persisted reviver at the child's latest cwd and project policy", async () => {
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
			tools: ["yield"],
			spawns: "",
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

		// Parent B revives child A: parent project policy must not leak into A.
		revived = await revive!();
		expect(revived.sessionManager.getCwd()).toBe(projectA);
		expect(revived.secretsEnabled).toBe(true);
		expect(parent.sessionManager.getCwd()).toBe(projectB);
		expect(parent.secretsEnabled).toBe(false);

		// Negative twin: same-cwd does not rescope the child.
		await revived.setCwd(projectA);
		expect(revived.sessionManager.getCwd()).toBe(projectA);
		expect(revived.secretsEnabled).toBe(true);

		// A live child move adopts B's project policy without mutating its parent.
		await revived.setCwd(projectB);
		expect(revived.sessionManager.getCwd()).toBe(projectB);
		expect(revived.secretsEnabled).toBe(false);
		expect(parent.sessionManager.getCwd()).toBe(projectB);
		await revived.dispose();
		revived = undefined;

		// Reuse the same closure after the persisted A→B move. It must re-peek and
		// re-open rather than retaining the factory-time A header/settings.
		revived = await revive!();
		expect(revived.sessionManager.getCwd()).toBe(projectB);
		expect(revived.secretsEnabled).toBe(false);
	} finally {
		await revived?.dispose();
		await parent?.dispose();
		authStorage?.close();
		await root.remove();
	}
});
