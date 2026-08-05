import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { SUPERSEDED_NOTICE, USELESS_NOTICE } from "@veyyon/agent-core/compaction/pruning";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * The per-turn stale-result pass (`#pruneStaleToolResults`) and the
 * threshold-time overflow prune (`#pruneToolOutputs`) are the only production
 * callers of `pruneSupersededToolResults`/`pruneToolOutputs`. Commit fbb73be9
 * ("feat(cache): make blocking on a rejected cache an opt-in setting") deleted
 * both methods and both call sites as collateral while touching an unrelated
 * setting, which left `compaction.supersedeReads` and `compaction.dropUseless`
 * defaulting to true and controlling nothing, and left docs/compaction.md
 * describing two passes that never ran. These tests observe the passes firing
 * end to end through the real session, and pin both settings in both positions
 * so an accidental unwiring goes red again instead of silently degrading.
 *
 * The persistence contract is the original one: after a prune fires, rebuilding
 * the session from disk yields the same message content as the live agent
 * state. `/fork`, `/tan` and resume read the file, and a divergent prefix
 * cold-misses the provider prompt cache the parent populated.
 */
describe("AgentSession per-turn prune", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	const BIG_CALL_ID = "call-big-useless";
	const OLD_READ_ID = "call-read-old";
	const NEW_READ_ID = "call-read-new";
	const READ_PATH = "src/app.ts";
	const OLD_READ_TEXT = `stale file body\n${"line of source\n".repeat(400)}`;
	const NEW_READ_TEXT = "fresh file body";
	const USELESS_TEXT = "match line\n".repeat(20000);

	const usageZero = {
		input: 0,
		output: 0,
		cacheRead: 0,
		cacheWrite: 0,
		totalTokens: 0,
		cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
	};

	function assistantCall(id: string, name: string, args: Record<string, unknown>, timestamp: number) {
		return {
			role: "assistant" as const,
			content: [{ type: "toolCall" as const, id, name, arguments: args }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "toolUse" as const,
			usage: usageZero,
			timestamp,
		};
	}

	async function startSession(overrides: Record<string, unknown>): Promise<void> {
		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };
		const modelRegistry = new ModelRegistry(authStorage);
		const agent = new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } });
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.enabled": false,
				"compaction.dropUseless": true,
				"compaction.supersedeReads": true,
				...overrides,
			}),
			modelRegistry,
		});
		session.agent.replaceMessages(session.buildDisplaySessionContext().messages);
	}

	/** Seed one big result the grep tool flagged contextually useless. */
	function seedUselessResult(now: number): void {
		sessionManager.appendMessage({
			role: "user",
			content: "Investigate every module of the project.",
			timestamp: now - 200,
		});
		sessionManager.appendMessage(assistantCall(BIG_CALL_ID, "grep", { pattern: "TODO" }, now - 180));
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: BIG_CALL_ID,
			toolName: "grep",
			content: [{ type: "text", text: USELESS_TEXT }],
			isError: false,
			useless: true,
			timestamp: now - 170,
		});
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "text", text: "Nothing relevant found; moving on." }],
			api: "anthropic-messages",
			provider: "anthropic",
			model: "claude-sonnet-4-5",
			stopReason: "stop",
			usage: usageZero,
			timestamp: now - 160,
		});
	}

	/** Seed two reads of the same path: the older one is superseded by the newer. */
	function seedSupersededRead(now: number): void {
		sessionManager.appendMessage({ role: "user", content: "Read the app twice.", timestamp: now - 200 });
		sessionManager.appendMessage(assistantCall(OLD_READ_ID, "read", { path: READ_PATH }, now - 180));
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: OLD_READ_ID,
			toolName: "read",
			content: [{ type: "text", text: OLD_READ_TEXT }],
			isError: false,
			timestamp: now - 170,
		});
		sessionManager.appendMessage(assistantCall(NEW_READ_ID, "read", { path: READ_PATH }, now - 160));
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: NEW_READ_ID,
			toolName: "read",
			content: [{ type: "text", text: NEW_READ_TEXT }],
			isError: false,
			timestamp: now - 150,
		});
	}

	/** Drive one completed turn so `#checkCompaction` (and the prune passes) runs. */
	async function runTurn(): Promise<void> {
		const finalAssistant = {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Continuing." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 100,
				output: 10,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 110,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
		session.agent.emitExternalEvent({ type: "message_end", message: finalAssistant });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [finalAssistant] });
		await session.waitForIdle();
	}

	/**
	 * Text of one tool result in the LIVE agent state. Returned as
	 * `{ length, head }` so a failing assertion prints a bounded diff: the
	 * un-pruned fixtures are 220 KB and 6 KB, and a `toBe` on the whole body
	 * dumps every byte into the test log.
	 */
	function liveResult(toolCallId: string): { length: number; head: string } {
		const message = session.agent.state.messages.find(
			candidate => candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
		);
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
			throw new Error(`Expected tool result ${toolCallId} in live agent state`);
		}
		const block = message.content.find(item => item.type === "text");
		if (block?.type !== "text") throw new Error(`Expected text content on tool result ${toolCallId}`);
		return { length: block.text.length, head: block.text.slice(0, 120) };
	}

	/** Same tool result, read back from the persisted session file. */
	async function rebuiltResult(toolCallId: string): Promise<{ length: number; head: string; count: number }> {
		await sessionManager.flush();
		const sessionFile = sessionManager.getSessionFile();
		if (!sessionFile) throw new Error("Expected a persisted session file");
		const reloaded = await SessionManager.open(sessionFile, tempDir.path());
		const messages = reloaded.buildSessionContext().messages;
		const message = messages.find(
			candidate => candidate.role === "toolResult" && candidate.toolCallId === toolCallId,
		);
		if (message?.role !== "toolResult" || !Array.isArray(message.content)) {
			throw new Error(`Expected tool result ${toolCallId} in the from-disk rebuild`);
		}
		const block = message.content.find(item => item.type === "text");
		if (block?.type !== "text") throw new Error(`Expected text content on tool result ${toolCallId}`);
		return { length: block.text.length, head: block.text.slice(0, 120), count: messages.length };
	}

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-prune-persistence-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	it("persists the pruned rewrite so a from-disk rebuild matches the live context", async () => {
		seedUselessResult(Date.now());
		await startSession({});
		await runTurn();

		// The per-turn pass rewrote the live context…
		expect(liveResult(BIG_CALL_ID)).toEqual({ length: USELESS_NOTICE.length, head: USELESS_NOTICE });

		// …and the persisted file rebuilds to the SAME content (fork/resume read
		// this file; a divergent prefix cold-misses the provider cache). The pass
		// blanks in place, so the rebuild still holds all five messages and the
		// tool call keeps its paired result.
		const rebuilt = await rebuiltResult(BIG_CALL_ID);
		expect(rebuilt).toEqual({ length: USELESS_NOTICE.length, head: USELESS_NOTICE, count: 5 });
	});

	it("compaction.dropUseless=false leaves the useless result at full length", async () => {
		seedUselessResult(Date.now());
		await startSession({ "compaction.dropUseless": false });
		await runTurn();

		expect(liveResult(BIG_CALL_ID)).toEqual({ length: USELESS_TEXT.length, head: USELESS_TEXT.slice(0, 120) });
		const rebuilt = await rebuiltResult(BIG_CALL_ID);
		expect(rebuilt.length).toBe(USELESS_TEXT.length);
		expect(rebuilt.count).toBe(5);
	});

	it("compaction.supersedeReads=true blanks the older read and keeps the newer one verbatim", async () => {
		seedSupersededRead(Date.now());
		await startSession({});
		await runTurn();

		expect(liveResult(OLD_READ_ID)).toEqual({ length: SUPERSEDED_NOTICE.length, head: SUPERSEDED_NOTICE });
		expect(liveResult(NEW_READ_ID)).toEqual({ length: NEW_READ_TEXT.length, head: NEW_READ_TEXT });

		// Blanked in place: the pairing is intact and no message disappeared
		// (user + 2 calls + 2 results + the turn's final assistant).
		const rebuilt = await rebuiltResult(OLD_READ_ID);
		expect(rebuilt).toEqual({ length: SUPERSEDED_NOTICE.length, head: SUPERSEDED_NOTICE, count: 6 });
	});

	it("compaction.supersedeReads=false leaves the older read at full length", async () => {
		seedSupersededRead(Date.now());
		await startSession({ "compaction.supersedeReads": false });
		await runTurn();

		expect(liveResult(OLD_READ_ID)).toEqual({ length: OLD_READ_TEXT.length, head: OLD_READ_TEXT.slice(0, 120) });
		const rebuilt = await rebuiltResult(OLD_READ_ID);
		expect(rebuilt.length).toBe(OLD_READ_TEXT.length);
		expect(rebuilt.count).toBe(6);
	});
});
