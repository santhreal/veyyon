/**
 * GRAN-3: a session records an effective-settings snapshot — the complete
 * resolved config that governed the run — so it can be backtested reproducibly.
 *
 * Why this suite exists:
 *   The session recorded model/thinking/tier/mode CHANGES but never the FULL
 *   effective settings that governed a run (compaction strategy, reserve tokens,
 *   advisor/subagent config, tool config, every Tier-A knob). A backtest could not
 *   reproduce behavior because the config that produced it was not in the record.
 *   The user named this a co-equal pillar: "the session file AND the settings for
 *   the levels of richness." A `settings_snapshot` entry captures every resolved
 *   setting keyed by dotted path at session start.
 *
 * The contract these tests lock in:
 *   - `Settings.getEffectiveSnapshot()` returns every setting resolved to its
 *     effective value, including configured overrides.
 *   - `appendSettingsSnapshot` persists a `settings_snapshot` (kind "full") that
 *     round-trips through a fresh reload with EXACT values.
 *   - A NEW session created through `createAgentSession` records exactly one
 *     `settings_snapshot` carrying a known configured value; a RESUMED session
 *     does not append a second.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import type { SettingsSnapshotEntry } from "@veyyon/coding-agent/session/session-entries";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const KNOWN_PATH = "task.maxConcurrency";
const KNOWN_VALUE = 7;

function assistantMessage(text: string) {
	const model = getBundledModel("anthropic", "claude-sonnet-4-5");
	if (!model) throw new Error("Expected built-in anthropic model to exist");
	return {
		role: "assistant" as const,
		content: [{ type: "text" as const, text }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		usage: {
			input: 0,
			output: 0,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 0,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		stopReason: "stop" as const,
		timestamp: Date.now(),
	};
}

function snapshotEntries(entries: readonly { type: string }[]): SettingsSnapshotEntry[] {
	return entries.filter((e): e is SettingsSnapshotEntry => e.type === "settings_snapshot");
}

describe("GRAN-3: effective-settings snapshot", () => {
	const tempDirs: TempDir[] = [];
	function tmp(prefix: string): string {
		const dir = TempDir.createSync(prefix);
		tempDirs.push(dir);
		return dir.path();
	}
	afterEach(() => {
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	it("getEffectiveSnapshot resolves every setting and reflects configured overrides", () => {
		const settings = Settings.isolated({ [KNOWN_PATH]: KNOWN_VALUE });
		const snap = settings.getEffectiveSnapshot();
		expect(snap[KNOWN_PATH]).toBe(KNOWN_VALUE);
		// A complete config dump, not a handful of keys.
		expect(Object.keys(snap).length).toBeGreaterThan(100);
		// Keys are sorted for stable, diffable output.
		const keys = Object.keys(snap);
		expect(keys).toEqual([...keys].sort());
	});

	it("round-trips a full settings_snapshot through a fresh reload with exact values", async () => {
		const cwd = tmp("gran3-unit-cwd-");
		const sessionDir = path.join(cwd, "sessions");
		const manager = SessionManager.create(cwd, sessionDir);
		const sessionFile = manager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file path");

		const settings = Settings.isolated({ [KNOWN_PATH]: KNOWN_VALUE });
		manager.appendMessage(assistantMessage("configured run"));
		manager.appendSettingsSnapshot(settings.getEffectiveSnapshot());
		manager.flushSync();
		await manager.close();

		const reopened = await SessionManager.open(sessionFile, sessionDir);
		const snaps = snapshotEntries(reopened.getEntries());
		expect(snaps).toHaveLength(1);
		expect(snaps[0]!.kind).toBe("full");
		expect(snaps[0]!.values[KNOWN_PATH]).toBe(KNOWN_VALUE);
		await reopened.close();
	});

	describe("wired into session creation", () => {
		let sharedDir: TempDir;
		let authStorage: AuthStorage;
		let modelRegistry: ModelRegistry;

		beforeAll(async () => {
			sharedDir = TempDir.createSync("gran3-shared-");
			authStorage = await AuthStorage.create(path.join(sharedDir.path(), "auth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir.path(), "models.yml"));
		});
		afterAll(() => {
			authStorage.close();
			sharedDir.removeSync();
		});

		function baseOptions(cwd: string, sessionManager: SessionManager) {
			return {
				cwd,
				agentDir: cwd,
				authStorage,
				modelRegistry,
				sessionManager,
				settings: Settings.isolated({ [KNOWN_PATH]: KNOWN_VALUE }),
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			};
		}

		it("a new session records exactly one snapshot carrying the configured value; resume adds none", async () => {
			const cwd = tmp("gran3-wired-cwd-");
			const sessionDir = path.join(cwd, "sessions");
			const manager = SessionManager.create(cwd, sessionDir);
			const sessionFile = manager.getSessionFile();
			if (!sessionFile) throw new Error("Expected a persisted session file path");

			const first = await createAgentSession(baseOptions(cwd, manager));
			manager.appendMessage(assistantMessage("first turn"));
			manager.flushSync();
			await first.session.dispose();

			const afterCreate = await SessionManager.open(sessionFile, sessionDir);
			const created = snapshotEntries(afterCreate.getEntries());
			expect(created).toHaveLength(1);
			expect(created[0]!.kind).toBe("full");
			expect(created[0]!.values[KNOWN_PATH]).toBe(KNOWN_VALUE);
			await afterCreate.close();

			// Resume the persisted session — no second snapshot is written.
			const resumeManager = await SessionManager.open(sessionFile, sessionDir);
			const resumed = await createAgentSession(baseOptions(cwd, resumeManager));
			resumeManager.appendMessage(assistantMessage("second turn"));
			resumeManager.flushSync();
			await resumed.session.dispose();

			const reopened = await SessionManager.open(sessionFile, sessionDir);
			expect(snapshotEntries(reopened.getEntries())).toHaveLength(1);
			await reopened.close();
		});
	});
});
