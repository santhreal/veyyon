import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import {
	VERIFICATION_EVIDENCE_REMINDER_TYPE,
	VerificationEvidenceLedger,
} from "@veyyon/coding-agent/session/verification-evidence-ledger";
import { TempDir } from "@veyyon/utils";

function recordEdit(ledger: VerificationEvidenceLedger, callId = "edit-1"): void {
	ledger.recordToolEnd({
		toolCallId: callId,
		toolName: "edit",
		result: { content: [], details: { path: "/repo/src/a.ts" } },
	});
}

function recordBash(
	ledger: VerificationEvidenceLedger,
	callId: string,
	options: { isError?: boolean; intent?: string } = {},
): void {
	ledger.recordToolStart({
		toolCallId: callId,
		toolName: "bash",
		args: { command: "bun test focused.test.ts" },
		intent: options.intent,
	});
	ledger.recordToolEnd({
		toolCallId: callId,
		toolName: "bash",
		result: { content: [], details: options.isError ? { exitCode: 1 } : {} },
		isError: options.isError,
	});
}

function assistantFinal(text = "Implemented the requested change."): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
}

describe("verification evidence ledger", () => {
	afterEach(() => vi.restoreAllMocks());

	/** A successful mutation without later proof must force exactly one targeted continuation. */
	it("returns one targeted continuation for an unverified mutation", () => {
		const ledger = new VerificationEvidenceLedger();
		recordEdit(ledger);

		const reminder = ledger.takeFinalizationReminder();
		expect(reminder).toContain("latest successful edit mutation");
		expect(reminder).toContain("/repo/src/a.ts");
		expect(ledger.snapshot().mutations).toEqual([{ sequence: 1, toolName: "edit", paths: ["/repo/src/a.ts"] }]);
	});

	/** A later successful proof candidate must release the finalization gate. */
	it("allows finalization after a successful post-mutation proof candidate", () => {
		const ledger = new VerificationEvidenceLedger();
		recordEdit(ledger);
		recordBash(ledger, "bash-after", { intent: "Running focused verification" });

		expect(ledger.takeFinalizationReminder()).toBeUndefined();
		expect(ledger.snapshot().proofs).toEqual([
			{ sequence: 2, mutationSequence: 1, toolName: "bash", summary: "Running focused verification" },
		]);
	});

	/** Failed and already-running pre-mutation calls must never satisfy the proof ordering contract. */
	it("does not accept failed or pre-mutation proof candidates", () => {
		const failed = new VerificationEvidenceLedger();
		recordEdit(failed);
		recordBash(failed, "bash-failed", { isError: true });
		expect(failed.takeFinalizationReminder()).toBeDefined();
		expect(failed.snapshot().proofs).toHaveLength(0);

		const stale = new VerificationEvidenceLedger();
		recordBash(stale, "bash-before");
		recordEdit(stale);
		expect(stale.takeFinalizationReminder()).toBeDefined();
		expect(stale.snapshot().proofs).toHaveLength(0);

		const overlapping = new VerificationEvidenceLedger();
		overlapping.recordToolStart({
			toolCallId: "bash-overlap",
			toolName: "bash",
			args: { command: "bun test focused.test.ts" },
		});
		recordEdit(overlapping);
		overlapping.recordToolEnd({
			toolCallId: "bash-overlap",
			toolName: "bash",
			result: { content: [], details: {} },
		});
		expect(overlapping.takeFinalizationReminder()).toBeDefined();
		expect(overlapping.snapshot().proofs).toHaveLength(0);
	});

	/** Mutation evidence must use affected paths from successful write and applied ast_edit result details. */
	it("records write and applied ast_edit paths from exact result details", () => {
		const ledger = new VerificationEvidenceLedger();
		ledger.recordToolEnd({
			toolCallId: "write-1",
			toolName: "write",
			result: { content: [], details: { resolvedPath: "/repo/new.ts" } },
		});
		ledger.recordToolEnd({
			toolCallId: "resolve-ast-1",
			toolName: "resolve",
			result: {
				content: [],
				details: {
					action: "apply",
					sourceToolName: "ast_edit",
					sourceResultDetails: {
						applied: true,
						totalReplacements: 2,
						files: ["src/a.ts", "src/b.ts"],
					},
				},
			},
		});

		expect(ledger.snapshot().mutations).toEqual([
			{ sequence: 1, toolName: "write", paths: ["/repo/new.ts"] },
			{ sequence: 2, toolName: "ast_edit", paths: ["src/a.ts", "src/b.ts"] },
		]);
	});

	/** Read-only tool activity must not arm the mutation finalization gate. */
	it("does not intervene for read-only work", () => {
		const ledger = new VerificationEvidenceLedger();
		ledger.recordToolEnd({
			toolCallId: "read-1",
			toolName: "read",
			result: { content: [], details: { path: "/repo/src/a.ts" } },
		});

		expect(ledger.takeFinalizationReminder()).toBeUndefined();
		expect(ledger.snapshot().mutations).toHaveLength(0);
	});

	/** A self-continuation cannot recurse, and a later read-only user turn cannot revive old work. */
	it("never loops on a second finish and a new read-only turn does not revive old work", () => {
		const ledger = new VerificationEvidenceLedger();
		recordEdit(ledger);

		expect(ledger.takeFinalizationReminder()).toBeDefined();
		expect(ledger.takeFinalizationReminder()).toBeUndefined();
		ledger.startUserTurn();
		expect(ledger.snapshot().mutations).toHaveLength(1);
		expect(ledger.takeFinalizationReminder()).toBeUndefined();
		recordEdit(ledger, "edit-2");
		expect(ledger.takeFinalizationReminder()).toBeDefined();
	});

	/** Restoring a ledger snapshot must retain an unverified reminder and continue proof sequencing after it. */
	it("restores pending mutation evidence and proof ordering", () => {
		const source = new VerificationEvidenceLedger();
		recordEdit(source);
		const snapshot = source.snapshot();

		const pending = new VerificationEvidenceLedger();
		pending.restore(snapshot);
		expect(pending.takeFinalizationReminder()).toContain("/repo/src/a.ts");

		const verified = new VerificationEvidenceLedger();
		verified.restore(snapshot);
		recordBash(verified, "bash-restored");
		expect(verified.takeFinalizationReminder()).toBeUndefined();
		expect(verified.snapshot().proofs[0]?.sequence).toBeGreaterThan(verified.snapshot().mutations[0]!.sequence);
	});

	/**
	 * Older snapshots did not associate a proof with a mutation. Sequence order
	 * alone cannot claim that an arbitrary later command verified the edit.
	 */
	it("keeps legacy unassociated proof evidence fail-closed after restore", () => {
		const ledger = new VerificationEvidenceLedger();
		ledger.restore({
			mutations: [{ sequence: 1, toolName: "edit", paths: ["/repo/src/a.ts"] }],
			proofs: [{ sequence: 2, toolName: "bash", summary: "unassociated legacy command" }],
			intervenedThisTurn: false,
			turnStartedAtSequence: 0,
		});

		expect(ledger.takeFinalizationReminder()).toContain("/repo/src/a.ts");
	});

	/** AgentSession must append—not replace—the final candidate, persist the reminder, and exempt subagents. */
	it("integrates at AgentSession finalization while preserving the final candidate", async () => {
		const tempDir = TempDir.createSync("@veyyon-verification-ledger-");
		const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
		let session: AgentSession | undefined;
		try {
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model");
			const agent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			});
			const sessionManager = SessionManager.create(tempDir.path(), tempDir.path());
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
			});
			const continueSpy = vi.spyOn(agent, "continue").mockResolvedValue();

			agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId: "edit-integrated",
				toolName: "edit",
				result: { content: [], details: { path: "/repo/src/integrated.ts" } },
			});
			const finalCandidate = assistantFinal();
			agent.emitExternalEvent({ type: "message_end", message: finalCandidate });
			agent.emitExternalEvent({ type: "agent_end", messages: [finalCandidate] });
			await session.waitForIdle();

			expect(continueSpy).toHaveBeenCalledTimes(1);
			expect(agent.state.messages).toContain(finalCandidate);
			expect(
				sessionManager
					.getBranch()
					.some(
						entry =>
							entry.type === "message" &&
							entry.message.role === "assistant" &&
							entry.message.content.some(
								content => content.type === "text" && content.text === "Implemented the requested change.",
							),
					),
			).toBe(true);
			expect(
				agent.state.messages.some(
					message => message.role === "custom" && message.customType === VERIFICATION_EVIDENCE_REMINDER_TYPE,
				),
			).toBe(true);
			expect(
				sessionManager
					.getBranch()
					.some(
						entry => entry.type === "custom_message" && entry.customType === VERIFICATION_EVIDENCE_REMINDER_TYPE,
					),
			).toBe(true);

			const secondCandidate = assistantFinal("Second finish.");
			agent.emitExternalEvent({ type: "message_end", message: secondCandidate });
			agent.emitExternalEvent({ type: "agent_end", messages: [secondCandidate] });
			await session.waitForIdle();
			expect(continueSpy).toHaveBeenCalledTimes(1);

			const subAgent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			});
			const subSession = new AgentSession({
				agent: subAgent,
				sessionManager: SessionManager.inMemory(),
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": false }),
				modelRegistry: new ModelRegistry(authStorage),
				isSubagent: true,
				agentKind: "sub",
			});
			try {
				const subContinueSpy = vi.spyOn(subAgent, "continue").mockResolvedValue();
				subAgent.emitExternalEvent({
					type: "tool_execution_end",
					toolCallId: "edit-subagent",
					toolName: "edit",
					result: { content: [], details: { path: "/repo/src/sub.ts" } },
				});
				const subFinal = assistantFinal("Subagent final.");
				subAgent.emitExternalEvent({ type: "message_end", message: subFinal });
				subAgent.emitExternalEvent({ type: "agent_end", messages: [subFinal] });
				await subSession.waitForIdle();
				expect(subContinueSpy).not.toHaveBeenCalled();
				expect(
					subAgent.state.messages.some(
						message => message.role === "custom" && message.customType === VERIFICATION_EVIDENCE_REMINDER_TYPE,
					),
				).toBe(false);
			} finally {
				await subSession.dispose();
			}
		} finally {
			await session?.dispose();
			authStorage.close();
			await tempDir.remove();
		}
	});
});
