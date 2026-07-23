import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { TempDir } from "@veyyon/utils";
import { beginSettingsTest, restoreSettingsTestState, type SettingsTestState } from "../helpers/settings-test-state";

/**
 * Session-level plan mode toggle across multiple write attempts with exact disk.
 */

describe("session plan toggle write chain", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@plan-toggle-");
	});

	afterEach(async () => {
		await session?.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;
		tempDir?.removeSync();
		restoreSettingsTestState(settingsState);
		settingsState = undefined;
	});

	async function makeSession(): Promise<AgentSession> {
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: {
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
			} as never,
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5");
		const manager = SessionManager.create(tempDir.path(), tempDir.path());
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["plan-toggle"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
			} as never),
			modelRegistry,
		});
		return session;
	}

	it("plan on/off/on/off sequence: only off writes mutate the tree", async () => {
		const s = await makeSession();
		const filePath = path.join(tempDir.path(), "toggle.ts");
		let planEnabled = true;
		const toolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tempDir.path(), "artifacts"),
			allocateOutputArtifact: async () => ({
				id: "x",
				path: path.join(tempDir.path(), "x.log"),
			}),
			settings: s.settings,
			enableLsp: false,
			getPlanModeState: () =>
				planEnabled ? { enabled: true, planFilePath: "local://PLAN.md" } : { enabled: false },
		};
		const write = new WriteTool(toolSession as never);

		await expect(write.execute("1", { path: filePath, content: "v1\n" })).rejects.toThrow(
			/working tree is read-only/i,
		);
		expect(await Bun.file(filePath).exists()).toBe(false);

		planEnabled = false;
		await write.execute("2", { path: filePath, content: "v2\n" });
		expect(await Bun.file(filePath).text()).toBe("v2\n");

		planEnabled = true;
		await expect(write.execute("3", { path: filePath, content: "v3\n" })).rejects.toThrow(
			/working tree is read-only/i,
		);
		expect(await Bun.file(filePath).text()).toBe("v2\n");

		planEnabled = false;
		await write.execute("4", { path: filePath, content: "v4\n" });
		expect(await Bun.file(filePath).text()).toBe("v4\n");
	});
});
