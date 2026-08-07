import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

/**
 * Regression test for the bogus compaction-threshold clamp warning.
 *
 * The resolver holds every threshold strictly below the window (the cap is
 * `window - 1`), and the session warning used to key off "the resolved value
 * is below the configured one". At EQUALITY — a 256000 threshold on a 256k
 * window — that predicate is true, so a running session printed:
 *
 *   "The configured compaction threshold (256000 tokens) is larger than this
 *    model's context window (256000); compacting at 256k (fixed 256k, capped
 *    to this model's 256k window). ..."
 *
 * "Larger than" is false at equality and the one-token cap is the below-window
 * invariant, not lost headroom, so the warning was pure noise. The contract:
 * the warning fires only when the configured amount is STRICTLY greater than
 * the window, and then its numbers must be accurate.
 *
 * These tests drive the real session path — agent_end → #checkCompaction →
 * #noticeCompactionThresholdClamp → emitNotice — with a turn whose usage sits
 * below every threshold under test, so no compaction runs and the notices are
 * the only observable.
 */

const WINDOW = 200_000;

describe("compaction threshold clamp warning", () => {
	let tempDir: TempDir | undefined;
	let session: AgentSession | undefined;
	let authStorage: AuthStorage | undefined;

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			authStorage?.close();
			authStorage = undefined;
			await tempDir?.remove();
			tempDir = undefined;
			vi.restoreAllMocks();
		}
	});

	async function createSession(threshold: string): Promise<void> {
		tempDir = TempDir.createSync("@pi-compaction-threshold-warning-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		// Pin the window: the warning text quotes it verbatim, so a catalog
		// regeneration must not shift the asserted bytes.
		const model = { ...bundled, contextWindow: WINDOW, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ compaction: { threshold } } as never),
			modelRegistry,
		});
	}

	/** Usage far below every threshold under test, so no compaction runs. */
	function modestUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 50_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 51_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/**
	 * Compaction-sourced notices, in emission order. Compared as a LIST (not a
	 * count) so a failure prints the exact unexpected messages rather than
	 * "expected 0, received 1".
	 */
	function collectCompactionNotices(): { level: string; message: string }[] {
		if (!session) throw new Error("session not created");
		const notices: { level: string; message: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice" && event.source === "compaction") {
				notices.push({ level: event.level, message: event.message });
			}
		});
		return notices;
	}

	/** Drive one successful turn through the post-agent-end compaction check. */
	async function emitModestTurn(): Promise<void> {
		if (!session) throw new Error("session not created");
		const assistantMsg = modestUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });
		// #checkCompaction is a tracked async task; waitForIdle flushes it, which
		// is what makes the "no warning" assertions below meaningful.
		await session.waitForIdle();
	}

	it("stays silent when the threshold equals the window", async () => {
		// WHY: the pre-fix predicate flagged equality as "capped", and the notice
		// claimed "larger than this model's context window" — both false. A config
		// that exactly matches the model must produce no warning.
		await createSession(String(WINDOW));
		const notices = collectCompactionNotices();

		await emitModestTurn();

		expect(notices).toEqual([]);
	});

	it("stays silent when the threshold fits inside the window", async () => {
		await createSession("150000");
		const notices = collectCompactionNotices();

		await emitModestTurn();

		expect(notices).toEqual([]);
	});

	it("warns exactly once with accurate numbers when the threshold exceeds the window", async () => {
		await createSession("300000");
		const notices = collectCompactionNotices();

		await emitModestTurn();

		// The cap resolves to window - 1 = 199999, displayed the way the status
		// line rounds token counts ("200k"); the configured amount is quoted raw.
		expect(notices).toEqual([
			{
				level: "warning",
				message:
					"The configured compaction threshold (300000 tokens) is larger than this model's context window (200000); compacting at 200k (fixed 300k, capped to this model's 200k window). Lower the amount or switch to a larger-window model to use the full value.",
			},
		]);
	});
});
