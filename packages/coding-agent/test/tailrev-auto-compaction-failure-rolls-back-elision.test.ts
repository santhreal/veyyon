/**
 * WHY: the AUTO compaction path elides the same way the manual one does —
 * `prepareCompaction` replaces over-budget tool results on the live branch
 * with pointerless markers before any summarizer runs, and the originals
 * survive only on the preparation until `#persistCompactionTailElisions`
 * (after `appendCompaction`). Every failure path in `#runAutoCompaction`
 * between those two points — every candidate failing, a mid-pass abort, a
 * hook cancel — must roll the elision back, or the branch keeps a dead
 * marker: `prunedAt` blocks re-elision, the next summarizer sees marker
 * text, and the next rewriteEntries persists the pointerless marker over
 * the last copy of the output.
 *
 * This suite drives the real auto path (`runIdleCompaction`) with the real
 * prepareCompaction and the summarizer stubbed at the module seam
 * (`vi.spyOn(compactionModule, "compact")`, the same seam
 * agent-session-handoff.test.ts uses), and asserts the branch is
 * byte-identical after each failure shape.
 *
 * Mutation gate: drop the rollback from the `#runAutoCompaction` catch (or
 * from the aborted-after-summary return) and the matching test fails.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

const HUGE = "x".repeat(40_000);

const usage = () => ({
	input: 1000,
	output: 100,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 1100,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

describe("a failed auto-compaction must roll its tail elisions back", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-tailrev-auto-rollback-");
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic/claude-sonnet-4-5 to exist");
		const model = { ...bundled, contextWindow: 200_000, maxTokens: 64_000 };

		// Six small turns to summarize away, then a final turn whose one tool
		// result dwarfs the keep-recent budget, so elideTailToolResults fires.
		for (let i = 0; i < 6; i++) {
			sessionManager.appendMessage({ role: "user", content: `old question ${i}`, timestamp: Date.now() });
			sessionManager.appendMessage({
				role: "assistant",
				content: [{ type: "text", text: `old answer ${i}` }],
				api: model.api,
				provider: "anthropic",
				model: model.id,
				stopReason: "stop",
				usage: usage(),
				timestamp: Date.now(),
			});
		}
		sessionManager.appendMessage({ role: "user", content: "read the big file", timestamp: Date.now() });
		sessionManager.appendMessage({
			role: "assistant",
			content: [{ type: "toolCall", id: "call-big", name: "read", arguments: { path: "big.txt" } }],
			api: model.api,
			provider: "anthropic",
			model: model.id,
			stopReason: "toolUse",
			usage: usage(),
			timestamp: Date.now(),
		});
		sessionManager.appendMessage({
			role: "toolResult",
			toolCallId: "call-big",
			toolName: "read",
			content: [{ type: "text", text: HUGE }],
			isError: false,
			timestamp: Date.now(),
		});

		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});
		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({
				"compaction.keepRecentTokens": 200,
				// The local summarizer is the path under test; remote has its own suite.
				"compaction.remote": false,
				// No retry backoff: every candidate fails once, fast.
				"retry.enabled": false,
			}),
			modelRegistry,
		});
	});

	afterEach(async () => {
		vi.restoreAllMocks();
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
		}
	});

	function expectBranchIntact(): void {
		const branchJson = JSON.stringify(sessionManager.getBranch());
		// The original tool output must still be on the branch, and no
		// pointerless marker may remain.
		expect(branchJson).toContain(HUGE);
		expect(branchJson).not.toContain("output elided by compaction");
		// A failed pass owns no compaction entry.
		expect(sessionManager.getBranch().filter(e => e.type === "compaction")).toHaveLength(0);
	}

	it("restores the branch byte-identically when every summarizer candidate fails", async () => {
		const before = JSON.stringify(sessionManager.getBranch());
		const compactSpy = vi.spyOn(compactionModule, "compact").mockRejectedValue(new Error("summarizer down"));

		await session.runIdleCompaction();

		// The summarizer really ran (so the elision really happened first).
		expect(compactSpy).toHaveBeenCalled();
		expectBranchIntact();
		expect(JSON.stringify(sessionManager.getBranch())).toBe(before);
	});

	it("restores the branch byte-identically when the pass is aborted after summarization", async () => {
		const before = JSON.stringify(sessionManager.getBranch());
		const firstKeptEntryId = sessionManager.getBranch()[0]!.id;
		const compactSpy = vi.spyOn(compactionModule, "compact").mockImplementation(async () => {
			// The abort lands while the summary is in flight; the result arrives
			// anyway, so the pass dies at the aborted-check AFTER the candidate
			// loop — a different failure path than the catch above.
			session.abortCompaction();
			return {
				summary: "SUMMARY-TEXT",
				shortSummary: undefined,
				firstKeptEntryId,
				tokensBefore: 100,
				details: {},
				preserveData: undefined,
			};
		});

		await session.runIdleCompaction();

		expect(compactSpy).toHaveBeenCalled();
		expectBranchIntact();
		expect(JSON.stringify(sessionManager.getBranch())).toBe(before);
	});
});
