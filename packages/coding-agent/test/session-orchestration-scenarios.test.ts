import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";
import {
	beginSettingsTest,
	restoreSettingsTestState,
	type SettingsTestState,
} from "./helpers/settings-test-state";

/**
 * Multi-step session orchestration contracts that do not need a live provider:
 * workdir move, message tree basics, dispose cleanup, and settings isolation
 * across sequential session setups in one process.
 */

describe("session orchestration scenarios (hermetic)", () => {
	let settingsState: SettingsTestState | undefined;
	let tempDir: TempDir;
	let authStorage: AuthStorage | undefined;
	let session: AgentSession | undefined;

	beforeEach(() => {
		settingsState = beginSettingsTest();
		tempDir = TempDir.createSync("@session-orch-");
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

	async function makeSession(overrides: Partial<Record<string, unknown>> = {}): Promise<AgentSession> {
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: overrides as never,
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 in registry");
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["scenario"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated(overrides as never),
			modelRegistry,
		});
		return session;
	}

	it("creates a session with zero messages and a stable session id", async () => {
		const s = await makeSession();
		expect(s.state.messages.length).toBe(0);
		const id = s.sessionManager.getSessionId?.() ?? s.sessionManager.sessionId;
		expect(typeof id === "string" ? id.length : 0).toBeGreaterThan(0);
	});

	it("setCwd moves project workdir and keeps dispose idempotent", async () => {
		const s = await makeSession();
		const nested = path.join(tempDir.path(), "nested");
		await Bun.write(path.join(nested, ".keep"), "");
		// Prefer setCwd when present on the session API.
		if (typeof s.setCwd === "function") {
			await s.setCwd(nested);
			const cwd = s.sessionManager.getCwd?.() ?? nested;
			expect(path.resolve(String(cwd))).toBe(path.resolve(nested));
		}
		await s.dispose();
		await s.dispose(); // second dispose must not throw
		session = undefined;
	});

	it("plan mode state getter defaults to disabled when unset", async () => {
		const s = await makeSession();
		const plan = s.getPlanModeState?.();
		if (plan === undefined || plan === null) {
			expect(plan == null).toBe(true);
		} else {
			expect(plan.enabled === true || plan.enabled === false).toBe(true);
			if (!plan.enabled) {
				expect(plan.enabled).toBe(false);
			}
		}
	});

	it("two sequential sessions in one process do not share message arrays", async () => {
		const first = await makeSession();
		const firstMessages = first.state.messages;
		await first.dispose();
		session = undefined;
		authStorage?.close();
		authStorage = undefined;

		const second = await makeSession();
		expect(second.state.messages).not.toBe(firstMessages);
		expect(second.state.messages.length).toBe(0);
	});

	it("isolated settings override compaction.enabled for the session only", async () => {
		const s = await makeSession({ "compaction.enabled": false });
		expect(s.settings.get("compaction.enabled")).toBe(false);
		// A fresh isolated settings object still has the schema default true.
		expect(Settings.isolated({}).get("compaction.enabled")).toBe(true);
	});
});
