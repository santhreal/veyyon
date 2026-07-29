import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { SecretObfuscator } from "@veyyon/coding-agent/secrets/obfuscator";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { BuildSessionContextOptions, SessionContext } from "@veyyon/coding-agent/session/session-context";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * Regression for issue #3846: in-TUI `/resume` rebuilt the *previous*
 * session's display context before switching files. That call expands persisted
 * legacy compaction archives and `openaiRemoteCompaction.replacementHistory` payloads
 * into messages, which can OOM on huge pre-fix sessions even though the loader
 * itself streams. The previous context is only needed for same-session reloads
 * (where `#didSessionMessagesChange` compares against the freshly rebuilt one);
 * different-session switches MUST skip that work.
 */
describe("AgentSession.switchSession previous-context build", () => {
	let sharedDir: TempDir;
	let authStorage: AuthStorage;
	let modelRegistry: ModelRegistry;
	let model: Model;
	const tempDirs: TempDir[] = [];
	const sessions: AgentSession[] = [];

	beforeAll(async () => {
		sharedDir = TempDir.createSync("@pi-switch-prev-ctx-shared-");
		authStorage = await AuthStorage.create(path.join(sharedDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		modelRegistry = new ModelRegistry(authStorage);
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		model = bundled;
	});

	afterAll(async () => {
		authStorage.close();
		try {
			await sharedDir.remove();
		} catch {}
	});

	afterEach(async () => {
		while (sessions.length > 0) {
			await sessions.pop()?.dispose();
		}
		for (const dir of tempDirs.splice(0)) {
			try {
				await dir.remove();
			} catch {}
		}
	});

	function buildSession(tempDir: TempDir): { session: AgentSession; sessionManager: SessionManager } {
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});
		sessions.push(session);
		return { session, sessionManager };
	}

	/** Wrap `sessionManager.buildSessionContext` so each call's caller-visible
	 *  state (the manager's currently-loaded session file) is recorded in
	 *  invocation order. The constructor itself calls `buildSessionContext`
	 *  once; spying *after* construction means only switchSession-driven calls
	 *  are observed. */
	function instrumentBuildSessionContext(sessionManager: SessionManager): {
		calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }>;
		restore: () => void;
	} {
		const calls: Array<{ sessionFile: string | undefined; transcript: boolean | undefined }> = [];
		const original = sessionManager.buildSessionContext.bind(sessionManager);
		const patched = (options?: BuildSessionContextOptions): SessionContext => {
			calls.push({ sessionFile: sessionManager.getSessionFile(), transcript: options?.transcript });
			return original(options);
		};
		sessionManager.buildSessionContext = patched as SessionManager["buildSessionContext"];
		return {
			calls,
			restore: () => {
				sessionManager.buildSessionContext = original;
			},
		};
	}

	it("skips building the previous display context when switching to a different session", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-different-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "previous", timestamp: 1 });
		await sessionManager.flush();
		const previousSessionFile = sessionManager.getSessionFile();
		expect(previousSessionFile).toBeString();

		const otherManager = SessionManager.create(tempDir.path(), tempDir.path());
		otherManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await otherManager.flush();
		const targetSessionFile = otherManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		expect(targetSessionFile).not.toBe(previousSessionFile);
		await otherManager.close();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(targetSessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(targetSessionFile);
		} finally {
			restore();
		}

		// The previous session's display context MUST NOT be materialized. Only
		// the new target context (post-`setSessionFile`) should be built.
		expect(calls).toEqual([{ sessionFile: targetSessionFile!, transcript: undefined }]);
	});

	it("builds the previous display context for same-session reloads", async () => {
		const tempDir = TempDir.createSync("@pi-switch-prev-ctx-reload-");
		tempDirs.push(tempDir);

		const { session, sessionManager } = buildSession(tempDir);
		sessionManager.appendMessage({ role: "user", content: "current", timestamp: 1 });
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		expect(sessionFile).toBeString();

		const { calls, restore } = instrumentBuildSessionContext(sessionManager);
		try {
			const switched = await session.switchSession(sessionFile!);
			expect(switched).toBe(true);
			expect(session.sessionFile).toBe(sessionFile);
		} finally {
			restore();
		}

		// Same-session reload must snapshot the pre-reload context so
		// `#didSessionMessagesChange` can detect rollback edits.
		expect(calls).toEqual([
			{ sessionFile: sessionFile!, transcript: undefined },
			{ sessionFile: sessionFile!, transcript: undefined },
		]);
	});

	/** A cross-project switch must install the destination redactor before replaying its transcript. */
	it("re-scopes the secret runtime before adopting a cross-project transcript", async () => {
		const tempDir = TempDir.createSync("@pi-switch-secret-scope-");
		tempDirs.push(tempDir);
		const projectA = path.join(tempDir.path(), "project-a");
		const projectB = path.join(tempDir.path(), "project-b");
		await Promise.all([fs.mkdir(projectA, { recursive: true }), fs.mkdir(projectB, { recursive: true })]);

		const sessionManager = SessionManager.create(projectA, path.join(tempDir.path(), "sessions-a"));
		sessionManager.appendMessage({ role: "user", content: "source", timestamp: 1 });
		await sessionManager.flush();

		const targetManager = SessionManager.create(projectB, path.join(tempDir.path(), "sessions-b"));
		targetManager.appendMessage({ role: "user", content: "target", timestamp: 2 });
		await targetManager.ensureOnDisk();
		await targetManager.flush();
		expect(targetManager.getHeader()?.cwd).toBe(projectB);
		const targetSessionFile = targetManager.getSessionFile();
		expect(targetSessionFile).toBeString();
		const persistedHeader = (await fs.readFile(targetSessionFile!, "utf8"))
			.trim()
			.split("\n")
			.map(line => JSON.parse(line) as { type?: string; cwd?: string })
			.find(entry => entry.type === "session");
		if (persistedHeader === undefined) throw new Error("target session header was not persisted");
		expect(persistedHeader.cwd).toBe(projectB);
		await targetManager.close();

		const sourceObfuscator = new SecretObfuscator([
			{ type: "plain", origin: "config", name: "SOURCE_TOKEN", content: "source-project-secret-12345" },
		]);
		const targetObfuscator = new SecretObfuscator([
			{ type: "plain", origin: "config", name: "TARGET_TOKEN", content: "target-project-secret-67890" },
		]);
		const refreshedCwds: string[] = [];
		const agent = new Agent({
			initialState: {
				model,
				systemPrompt: ["Test"],
				tools: [],
				messages: [],
			},
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
			obfuscator: sourceObfuscator,
			refreshSecretRuntime: async cwd => {
				refreshedCwds.push(cwd);
				return cwd === projectB ? targetObfuscator : sourceObfuscator;
			},
			isSubagent: true,
		});
		sessions.push(session);

		expect(await session.switchSession(targetSessionFile!)).toBe(true);
		expect(session.sessionManager.getCwd()).toBe(projectB);
		expect(refreshedCwds).toEqual([projectB]);
		expect(session.obfuscator?.hasNamedSecret("SOURCE_TOKEN")).toBe(false);
		expect(session.obfuscator?.deobfuscate("#TARGET_TOKEN#")).toBe("target-project-secret-67890");
	});
});
