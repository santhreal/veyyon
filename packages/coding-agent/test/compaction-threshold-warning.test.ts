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
 * What the compaction-threshold notice may say, and when it may say it.
 *
 * Two false notices have shipped from this one predicate. The first fired at
 * EQUALITY (a 256000 threshold on a 256k window) and called it "larger than this
 * model's context window", which was not true. The second was worse: it fired for
 * a 256000 threshold on a 200k model, told the operator it was "compacting at
 * 200k", and advised them to lower the amount. The number was arithmetically
 * right and behaviourally nonsense, because the resolver capped an oversized
 * amount at `window - 1` and a trigger inside the reserve can never fire. The
 * operator's explicit threshold had quietly turned proactive compaction off, and
 * the notice reported that as normal operation.
 *
 * The contract now: an absolute amount is capped at the AUTO point (window minus
 * reserve), which is the largest trigger a request can reach; the notice fires
 * only when the configured amount is strictly past that point; it is `info`,
 * because a model-independent amount is a legal choice that a larger model still
 * honors in full; and its numbers name the real trigger.
 *
 * These tests drive the real session path (agent_end -> #checkCompaction ->
 * #noticeCompactionThresholdClamp -> emitNotice) with a turn whose usage sits
 * below every threshold under test, so no compaction runs and the notices are the
 * only observable. The 200k window and the unset reserve put the auto point at
 * 170k: reserve = max(15% of 200k, 16384) = 30k.
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

	it("stays silent at the reachable auto point", async () => {
		// The boundary itself: nothing was taken away, so there is nothing to say.
		await createSession("170000");
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

	it("reports the cap once, as info, with the trigger it actually uses", async () => {
		await createSession("300000");
		const notices = collectCompactionNotices();

		await emitModestTurn();

		// 170k is the real trigger, displayed the way the status line rounds token
		// counts; the configured amount is quoted raw so the operator can match it
		// against their config.
		expect(notices).toEqual([
			{
				level: "info",
				message:
					"The compaction threshold (300000 tokens) is more than a 200000-token model can reach, so this session compacts at 170k (fixed 300k, capped to the most a 200k-window model can reach). A model with a larger window uses the full amount.",
			},
		]);
	});

	it("reports a threshold equal to the window, because the reserve puts it out of reach", async () => {
		// The old suite asserted SILENCE here, on the theory that equality is not
		// "larger than the window". The window was the wrong ceiling: a trigger at
		// 200k on a 200k model never fires.
		await createSession(String(WINDOW));
		const notices = collectCompactionNotices();

		await emitModestTurn();

		expect(notices).toEqual([
			{
				level: "info",
				message:
					"The compaction threshold (200000 tokens) is more than a 200000-token model can reach, so this session compacts at 170k (fixed 200k, capped to the most a 200k-window model can reach). A model with a larger window uses the full amount.",
			},
		]);
	});
});
