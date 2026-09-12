import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import * as compactionModule from "@veyyon/agent-core/compaction";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { loadExtensions } from "@veyyon/coding-agent/extensibility/extensions/loader";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { getProjectAgentDir, TempDir } from "@veyyon/utils";

/**
 * WHY THIS SUITE EXISTS.
 *
 * `#runAutoCompaction` reaches a branch where `prepareCompaction` returns nothing:
 * there is no cut point, so the pass commits no compaction. That branch reported a
 * dead end for every non-idle trigger, which conflates two opposite states:
 *
 *   - wedged: nothing can be cut AND the context is still over the bar. The
 *     operator must start a fresh session or move to a larger window, which is
 *     what `compactionDeadEndWarning()` says.
 *   - finished: nothing is left to cut BECAUSE an earlier pass in this turn already
 *     created headroom (a rescue tier dropped images, pruning dropped a stale tool
 *     result, the dedup pass elided a repeat). The session is healthy.
 *
 * Reporting the second as the first tells the operator to abandon a session moments
 * after maintenance succeeded, and it also blocks automatic continuation. It
 * surfaced as an order-dependent failure in the progress-guard suite, where a second
 * threshold pass over an already-rescued branch emitted the warning; the race
 * decided only whether the second pass landed before the assertion, never whether
 * the warning was correct.
 *
 * The contract pinned here is the discriminator, not the race: at the no-preparation
 * branch, residual context decides. Both arms drive the real `AgentSession`
 * auto-compaction path with the same stubbed `prepareCompaction`, so the only
 * variable between them is how much context is left.
 *
 * WHAT IT DOES NOT CATCH. It fixes `prepareCompaction` to nothing rather than
 * building a branch with no cut point, so it does not defend the cut-point search
 * itself; and it says nothing about the other two warning sites (the success tail
 * and the failed-compaction tail), which measure the same bar through their own
 * code and are covered by `agent-session-auto-compaction-progress-guard.test.ts`.
 */
describe("nothing to compact", () => {
	let tempDir: TempDir;
	let session: AgentSession;
	let sessionManager: SessionManager;
	let authStorage: AuthStorage;

	const NOTICE_SOURCE = "compaction";
	const NO_PROGRESS_FRAGMENT = "Compaction freed too little context to make progress";
	const CONTEXT_WINDOW = 200_000;

	beforeEach(async () => {
		tempDir = TempDir.createSync("@pi-nothing-to-compact-");

		// The pass must reach its own tail without an LLM call, exactly as the
		// progress-guard suite arranges it.
		const extensionsDir = path.join(getProjectAgentDir(tempDir.path()), "extensions");
		fs.mkdirSync(extensionsDir, { recursive: true });
		const extensionPath = path.join(extensionsDir, "compaction-short-circuit.ts");
		fs.writeFileSync(
			extensionPath,
			[
				"export default function(pi) {",
				'\tpi.on("session_before_compact", async (event) => {',
				"\t\treturn {",
				"\t\t\tcompaction: {",
				'\t\t\t\tsummary: "compacted",',
				"\t\t\t\tshortSummary: undefined,",
				"\t\t\t\tfirstKeptEntryId: event.preparation.firstKeptEntryId,",
				"\t\t\t\ttokensBefore: event.preparation.tokensBefore,",
				"\t\t\t\tdetails: {},",
				"\t\t\t},",
				"\t\t};",
				"\t});",
				"}",
			].join("\n"),
		);

		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		const modelRegistry = new ModelRegistry(authStorage);
		sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

		const extensionsResult = await loadExtensions([extensionPath], tempDir.path(), undefined, undefined, {
			configuredPaths: [extensionPath],
		});
		const extensionRunner = new ExtensionRunner(
			extensionsResult.extensions,
			extensionsResult.runtime,
			tempDir.path(),
			sessionManager,
			modelRegistry,
		);

		const bundled = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!bundled) throw new Error("Expected built-in anthropic model to exist");
		const model = { ...bundled, contextWindow: CONTEXT_WINDOW, maxTokens: 64_000 };

		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
		});

		sessionManager.appendMessage({ role: "user", content: "hello", timestamp: Date.now() });

		session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.autoContinue": true }),
			modelRegistry,
			extensionRunner,
		});
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			authStorage?.close();
			await tempDir?.remove();
			vi.restoreAllMocks();
		}
	});

	/** A turn billed high enough to trip the threshold check. */
	function highUsageAssistant() {
		return {
			role: "assistant" as const,
			content: [{ type: "text" as const, text: "Done." }],
			api: "anthropic-messages" as const,
			provider: "anthropic" as const,
			model: "claude-sonnet-4-5",
			stopReason: "stop" as const,
			usage: {
				input: 190_000,
				output: 1_000,
				cacheRead: 0,
				cacheWrite: 0,
				totalTokens: 191_000,
				cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
			},
			timestamp: Date.now(),
		};
	}

	/**
	 * Run one threshold-triggered auto-compaction pass that finds nothing to
	 * prepare, with `residualTokens` left in the context when the tail measures it.
	 */
	async function runNoOpPass(residualTokens: number) {
		vi.spyOn(session.agent, "continue").mockResolvedValue();
		vi.spyOn(session.agent, "prompt").mockResolvedValue(undefined as never);
		vi.spyOn(session, "getContextUsage").mockReturnValue({
			tokens: residualTokens,
			contextWindow: CONTEXT_WINDOW,
			percent: (residualTokens / CONTEXT_WINDOW) * 100,
		});
		vi.spyOn(compactionModule, "prepareCompaction").mockReturnValue(undefined);

		const notices: { level: string; message: string; source?: string }[] = [];
		session.subscribe(event => {
			if (event.type === "notice") {
				notices.push({ level: event.level, message: event.message, source: event.source });
			}
		});

		const { promise: compactionDone, resolve: onCompactionDone } = Promise.withResolvers<void>();
		session.subscribe(event => {
			if (event.type === "auto_compaction_end") onCompactionDone();
		});

		const assistantMsg = highUsageAssistant();
		session.agent.emitExternalEvent({ type: "message_end", message: assistantMsg });
		session.agent.emitExternalEvent({ type: "agent_end", messages: [assistantMsg] });

		await compactionDone;
		await session.waitForIdle();

		return notices.filter(n => n.source === NOTICE_SOURCE && n.message.includes(NO_PROGRESS_FRAGMENT));
	}

	it("is a dead end while the context is still over the recovery band", async () => {
		// 190k of a 200k window: nothing can be cut and the session cannot send
		// another request. This is the state the warning was written for.
		const noProgress = await runNoOpPass(190_000);

		expect(noProgress.length).toBe(1);
		expect(noProgress[0].level).toBe("warning");
	});

	it("is not a dead end once the context sits under the recovery band", async () => {
		// 1k of a 200k window: there is nothing left to cut because an earlier pass
		// already freed the context, so the pass must stay silent rather than tell
		// the operator to abandon a healthy session.
		const noProgress = await runNoOpPass(1_000);

		expect(noProgress.map(n => n.message)).toEqual([]);
	});
});
