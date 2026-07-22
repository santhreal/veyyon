import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { WriteTool } from "@veyyon/coding-agent/tools/write";
import { TempDir } from "@veyyon/utils";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./helpers/settings-test-state";

/**
 * Multi-step session scenarios: sequential tool use against one session,
 * plan-mode gate mid-session, dispose cleanup, and settings isolation across
 * two sessions. No live provider — tools and session state only.
 */

describe("session multi-step adversarial", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@session-multi-");
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

	async function makeSession(overrides: Record<string, unknown> = {}): Promise<AgentSession> {
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: {
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				...overrides,
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
					systemPrompt: ["multi-step"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: manager,
			settings: Settings.isolated({
				"lsp.formatOnWrite": false,
				"lsp.diagnosticsOnWrite": false,
				...overrides,
			} as never),
			modelRegistry,
		});
		return session;
	}

	it("write then overwrite then read-back: second write wins on disk", async () => {
		const s = await makeSession();
		const filePath = path.join(tempDir.path(), "chain.ts");
		// Build a ToolSession-shaped object from session fields.
		const toolSession = {
			cwd: tempDir.path(),
			hasUI: false,
			getSessionFile: () => s.sessionManager.getSessionFile?.() ?? null,
			getSessionSpawns: () => "*",
			getArtifactsDir: () => path.join(tempDir.path(), "artifacts"),
			allocateOutputArtifact: async () => ({
				id: "x",
				path: path.join(tempDir.path(), "x.log"),
			}),
			settings: s.settings,
			enableLsp: false,
			getPlanModeState: () => ({ enabled: false }),
		};
		const write = new WriteTool(toolSession as never);
		await write.execute("c1", { path: filePath, content: "v1\n" });
		expect(await Bun.file(filePath).text()).toBe("v1\n");
		await write.execute("c2", { path: filePath, content: "v2\nfinal\n" });
		expect(await Bun.file(filePath).text()).toBe("v2\nfinal\n");
	});

	it("plan mode mid-session blocks tree write after a successful write", async () => {
		const s = await makeSession();
		const filePath = path.join(tempDir.path(), "gated.ts");
		let planEnabled = false;
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
		await write.execute("p1", { path: filePath, content: "ok\n" });
		expect(await Bun.file(filePath).text()).toBe("ok\n");

		planEnabled = true;
		await expect(write.execute("p2", { path: filePath, content: "blocked\n" })).rejects.toThrow(
			/working tree is read-only/i,
		);
		// Prior content must survive the failed plan-mode write.
		expect(await Bun.file(filePath).text()).toBe("ok\n");
	});

	it("dispose is idempotent and leaves written files on disk", async () => {
		const s = await makeSession();
		const filePath = path.join(tempDir.path(), "keep.ts");
		await Bun.write(filePath, "survive\n");
		await s.dispose();
		await s.dispose();
		session = undefined;
		expect(await Bun.file(filePath).text()).toBe("survive\n");
	});

	it("two sessions do not share settings override state", async () => {
		const first = await makeSession({ "compaction.enabled": false });
		expect(first.settings.get("compaction.enabled")).toBe(false);
		await first.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;

		const second = await makeSession({});
		expect(second.settings.get("compaction.enabled")).toBe(true);
	});

	it("creates nested parent dirs on write when missing", async () => {
		const s = await makeSession();
		const nested = path.join(tempDir.path(), "a", "b", "c.ts");
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
			getPlanModeState: () => ({ enabled: false }),
		};
		const write = new WriteTool(toolSession as never);
		await write.execute("n1", { path: nested, content: "nested\n" });
		expect(await Bun.file(nested).text()).toBe("nested\n");
		const st = await fs.stat(path.dirname(nested));
		expect(st.isDirectory()).toBe(true);
	});

	it("write A then write B leaves both files with exact independent content", async () => {
		const s = await makeSession();
		const a = path.join(tempDir.path(), "a.ts");
		const b = path.join(tempDir.path(), "b.ts");
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
			getPlanModeState: () => ({ enabled: false }),
		};
		const write = new WriteTool(toolSession as never);
		await write.execute("ab1", { path: a, content: "file-a\n" });
		await write.execute("ab2", { path: b, content: "file-b\n" });
		expect(await Bun.file(a).text()).toBe("file-a\n");
		expect(await Bun.file(b).text()).toBe("file-b\n");
	});

	it("plan mode can be toggled off again allowing a subsequent tree write", async () => {
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
		await expect(write.execute("t1", { path: filePath, content: "blocked\n" })).rejects.toThrow(
			/working tree is read-only/i,
		);
		planEnabled = false;
		await write.execute("t2", { path: filePath, content: "allowed\n" });
		expect(await Bun.file(filePath).text()).toBe("allowed\n");
	});

	it("unicode multi-file write chain preserves exact codepoints on both files", async () => {
		const s = await makeSession();
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
			getPlanModeState: () => ({ enabled: false }),
		};
		const write = new WriteTool(toolSession as never);
		const jp = path.join(tempDir.path(), "日本語.ts");
		const emoji = path.join(tempDir.path(), "emoji.ts");
		await write.execute("u1", { path: jp, content: "const 値 = 1;\n" });
		await write.execute("u2", { path: emoji, content: "const x = '🙂';\n" });
		expect(await Bun.file(jp).text()).toBe("const 値 = 1;\n");
		expect(await Bun.file(emoji).text()).toBe("const x = '🙂';\n");
	});
});
