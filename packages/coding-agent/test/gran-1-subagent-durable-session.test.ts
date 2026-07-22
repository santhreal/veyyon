/**
 * GRAN-1: a subagent ALWAYS materializes a durable session file — it must never
 * run as an in-memory session that silently discards its transcript.
 *
 * Why this suite exists:
 *   Studying and backtesting a run requires every subagent's full transcript on
 *   disk ("including subagents, everything"). Two prior data-loss bugs violated
 *   that:
 *     (1) executor.ts fell back to `SessionManager.inMemory()` whenever no
 *         session file was threaded in — a silent fallback (Law 10) that lost the
 *         entire subagent record.
 *     (2) the task tool routed a fileless parent's subagent transcripts to
 *         `os.tmpdir()` and then `fs.rm`'d them, so they were GC-reaped/deleted.
 *
 * The contract these tests lock in:
 *   - `SessionManager.inMemory` is NEVER constructed on the subagent runtime path.
 *   - `SessionManager.open` is called with a DURABLE path: `<artifactsDir>/<id>.jsonl`
 *     when a parent artifacts dir is supplied, otherwise
 *     `<sessionsDir>/orphan-task-<id>.jsonl` under the durable sessions dir.
 *   - The transcript file actually lands on disk (a real, reopenable JSONL record).
 *
 * If any of these regress, a subagent run becomes unstudyable and the suite fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import path from "node:path";
import type { Api, Model } from "@veyyon/ai";
import { buildModel } from "@veyyon/catalog/build";
import { Settings } from "@veyyon/coding-agent/config/settings";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { getAgentDir, getSessionsDir, Snowflake, setAgentDir } from "@veyyon/utils";

function model(provider: string, id: string): Model<Api> {
	return buildModel({
		provider,
		id,
		name: id,
		api: "openai-completions",
		baseUrl: `https://${provider}.example.test`,
		reasoning: false,
		input: ["text"],
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
		contextWindow: 128000,
		maxTokens: 8192,
	});
}

/** A minimal session whose prompt() immediately yields, so no real model runs. */
function createYieldingSession(): AgentSession {
	const listeners: Array<(event: { type: string; [key: string]: unknown }) => void> = [];
	const session = {
		agent: { state: { systemPrompt: ["test"] } },
		state: { messages: [] },
		extensionRunner: undefined,
		sessionManager: { appendSessionInit: () => {} },
		getActiveToolNames: () => ["yield"],
		setActiveToolsByName: async () => {},
		subscribe: (listener: (event: { type: string; [key: string]: unknown }) => void) => {
			listeners.push(listener);
			return () => {};
		},
		prompt: async () => {
			for (const listener of listeners) {
				listener({
					type: "tool_execution_end",
					toolCallId: "tool-yield",
					toolName: "yield",
					result: { content: [{ type: "text", text: "Result submitted." }], details: { status: "success" } },
					isError: false,
				});
			}
		},
		waitForIdle: async () => {},
		getLastAssistantMessage: () => undefined,
		abort: async () => {},
		dispose: async () => {},
	};
	return session as unknown as AgentSession;
}

const AGENT: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };

function registry() {
	const m = model("primary", "runtime-model");
	return {
		refresh: async () => {},
		getAvailable: () => [m],
		getApiKey: async () => "test-key",
	} as never;
}

describe("GRAN-1: subagent always persists a durable session file", () => {
	let originalAgentDir: string;
	let home: string;

	beforeEach(() => {
		originalAgentDir = getAgentDir();
		home = fs.mkdtempSync(path.join(os.tmpdir(), "gran1-home-"));
		setAgentDir(home);
	});

	afterEach(() => {
		vi.restoreAllMocks();
		setAgentDir(originalAgentDir);
		fs.rmSync(home, { recursive: true, force: true });
	});

	it("never constructs an in-memory session and opens the durable orphan path when no artifacts dir is provided", async () => {
		const openSpy = vi.spyOn(SessionManager, "open");
		const inMemorySpy = vi.spyOn(SessionManager, "inMemory");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} }) as never,
		);

		const id = `orphan-${Snowflake.next()}`;
		await runSubprocess({
			cwd: home,
			agent: AGENT,
			task: "work",
			index: 0,
			id,
			settings: Settings.isolated(),
			modelRegistry: registry(),
			enableLsp: false,
		});

		// The core contract: no in-memory session, ever.
		expect(inMemorySpy).not.toHaveBeenCalled();

		// The durable path chosen is <sessionsDir>/orphan-task-<id>.jsonl.
		const expected = path.join(getSessionsDir(), `orphan-task-${id}.jsonl`);
		const openedPaths = openSpy.mock.calls.map(call => call[0]);
		expect(openedPaths).toContain(expected);

		// The transcript is a real file on disk under the durable sessions dir — not an
		// ephemeral `os.tmpdir()/veyyon-task-*` artifact that the OS or cleanup would reap.
		expect(expected.startsWith(getSessionsDir())).toBe(true);
		expect(path.basename(expected)).toBe(`orphan-task-${id}.jsonl`);
		expect(fs.existsSync(expected)).toBe(true);
	});

	it("opens <artifactsDir>/<id>.jsonl when a parent artifacts dir is provided", async () => {
		const openSpy = vi.spyOn(SessionManager, "open");
		const inMemorySpy = vi.spyOn(SessionManager, "inMemory");
		vi.spyOn(sdkModule, "createAgentSession").mockImplementation(
			async () => ({ session: createYieldingSession(), extensionsResult: {}, setToolUIContext: () => {} }) as never,
		);

		const artifactsDir = fs.mkdtempSync(path.join(os.tmpdir(), "gran1-artifacts-"));
		const id = `filed-${Snowflake.next()}`;
		try {
			await runSubprocess({
				cwd: home,
				agent: AGENT,
				task: "work",
				index: 0,
				id,
				artifactsDir,
				settings: Settings.isolated(),
				modelRegistry: registry(),
				enableLsp: false,
			});

			expect(inMemorySpy).not.toHaveBeenCalled();
			const expected = path.join(artifactsDir, `${id}.jsonl`);
			const openedPaths = openSpy.mock.calls.map(call => call[0]);
			expect(openedPaths).toContain(expected);
			expect(fs.existsSync(expected)).toBe(true);
		} finally {
			fs.rmSync(artifactsDir, { recursive: true, force: true });
		}
	});
});
