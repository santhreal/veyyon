/**
 * A reply that hands the turn back to the user is not overwritten by an
 * autonomous continuation, whichever guard happens to be armed.
 *
 * WHY THIS SUITE EXISTS. Four guards in the `agent_end` tail can re-wake the
 * agent after it settles: an open checkpoint demanding a rewind, plan mode
 * demanding an `ask`/`resolve`, an unfinished todo board, and a mutation with no
 * proof behind it. Only the todo reminder ever asked whether the reply was a
 * question to the user, so an agent that stopped to ask something was sometimes
 * left alone and sometimes immediately continued over the top of its own
 * question, decided entirely by which guard was armed. From the outside that is
 * a session that "gets reinvoked randomly", with no user action behind it.
 *
 * WHAT CLASS THIS CLOSES. The decision has one owner:
 * `SETTLE_CONTINUATION_POLICY` in `src/session/settle-continuation.ts`. Every
 * route is enumerated from that table at run time, so a fifth guard added later
 * turns this suite red until it records an answer, and each route is also driven
 * through the real settle path with its own negative control, so a case cannot
 * pass because the guard was never armed in the first place.
 *
 * The detector is the other half. It used to test the strict last line, which
 * misses the most ordinary shape of a real question (a question followed by the
 * options it offers), so those cases are pinned here too.
 *
 * WHAT IT DOES NOT CATCH. Detection stays a heuristic over prose: a question
 * phrased so that no line reads as one still ends the turn silently. And a fifth
 * continuation that never consults the policy at all is a new caller, not a
 * regression of these four.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import type { AssistantMessage, TextContent } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession, type AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import {
	isAwaitingUserAnswer,
	mayContinueAtSettle,
	QUESTION_OPENERS,
	REQUEST_CUES,
	SETTLE_CONTINUATION_POLICY,
	type SettleContinuationRoute,
	WAITING_CUES,
} from "@veyyon/coding-agent/session/settle-continuation";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

/** A question the agent asks, followed by the options it offers. */
const QUESTION_WITH_OPTIONS = [
	"Which storage backend do you want?",
	"- SQLite: file-local, no server to run",
	"- Postgres: relational, needs a server",
].join("\n");

/** The same length of text with nothing for the user to answer. */
const PLAIN_REPORT = ["Landed the change and ran the suite.", "- edited src/a.ts", "- edited src/b.ts"].join("\n");

/**
 * Two replies in one test must not share a timestamp: the session identifies an
 * assistant message by provider, model, stop reason and timestamp, so equal
 * stamps make the second stop look like a replay of the first.
 */
let stopsBuilt = 0;

function assistantMessage(text: string): AssistantMessage {
	return {
		role: "assistant",
		content: [{ type: "text", text }],
		api: "anthropic-messages",
		provider: "anthropic",
		model: "claude-sonnet-4-5",
		stopReason: "stop",
		usage: {
			input: 100,
			output: 20,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 120,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now() + stopsBuilt++,
	};
}

function stubTool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: name,
		parameters: type({}),
		execute: async () => ({ content: [{ type: "text", text: "ok" }] }),
	};
}

describe("a reply that asks the user something ends the turn", () => {
	describe("the policy table", () => {
		const routes = Object.keys(SETTLE_CONTINUATION_POLICY) as SettleContinuationRoute[];

		/**
		 * Empty on purpose. A route that may legitimately talk over a question
		 * belongs here with a reason, and adding one is a decision someone makes
		 * deliberately rather than a default a new guard inherits.
		 */
		const ROUTES_ALLOWED_TO_OVERRIDE_A_QUESTION: SettleContinuationRoute[] = [];

		it("enumerates every guard that can re-wake the agent at settle", () => {
			expect(routes).toEqual(["rewind-checkpoint", "plan-mode-decision", "todo-reminder", "verification-evidence"]);
		});

		it("holds every route while the reply is waiting on the user", () => {
			for (const route of routes) {
				const allowed = ROUTES_ALLOWED_TO_OVERRIDE_A_QUESTION.includes(route);
				expect(mayContinueAtSettle(route, { awaitingUserAnswer: true })).toBe(allowed);
				expect(mayContinueAtSettle(route, { awaitingUserAnswer: false })).toBe(true);
			}
		});

		it("makes every route state why", () => {
			for (const route of routes) {
				expect(SETTLE_CONTINUATION_POLICY[route].why.length).toBeGreaterThan(40);
			}
		});
	});

	describe("the detector", () => {
		const AWAITING = [
			["a question alone", "Which storage backend do you want?"],
			["a question followed by its options", QUESTION_WITH_OPTIONS],
			["a question followed by a table", "Which one do you want?\n| a | b |\n| --- | --- |\n| 1 | 2 |"],
			["a question followed by a fenced block", "Should I apply this patch?\n```diff\n-a\n+b\n```"],
			["a question followed by blank lines", "Do you want me to push?\n\n\n"],
			["an explicit reply cue", "Let me know which way to go."],
			["a waiting cue", "I'll wait for your call."],
			["a labelled question", "Q1: proceed with the rename?"],
		] as const;

		const NOT_AWAITING = [
			["an ordinary report", PLAIN_REPORT],
			["a rhetorical question answered in the next line", "Which config wins? The repo one, so nothing to decide."],
			[
				"a question buried above ordinary prose",
				"Should I refactor?\n- maybe\nI refactored it and the suite is green.",
			],
			["TypeScript optional syntax in the tail", "The interface now has foo?: string, so callers keep compiling."],
			["an empty message", ""],
		] as const;

		for (const [label, text] of AWAITING) {
			it(`treats ${label} as waiting on the user`, () => {
				expect(isAwaitingUserAnswer(assistantMessage(text))).toBe(true);
			});
		}

		for (const [label, text] of NOT_AWAITING) {
			it(`does not treat ${label} as waiting on the user`, () => {
				expect(isAwaitingUserAnswer(assistantMessage(text))).toBe(false);
			});
		}

		it("pins the vocabulary it recognises", () => {
			expect([...QUESTION_OPENERS]).toEqual([
				"what",
				"which",
				"when",
				"where",
				"why",
				"how",
				"who",
				"whom",
				"whose",
				"do",
				"does",
				"did",
				"can",
				"could",
				"would",
				"will",
				"should",
				"is",
				"are",
				"am",
				"may",
				"shall",
			]);
			expect([...REQUEST_CUES]).toEqual([
				"confirm",
				"reply",
				"choose",
				"pick",
				"decide",
				"advise",
				"answer",
				"let me know",
				"tell me",
			]);
			expect([...WAITING_CUES]).toEqual([
				"wait for you",
				"wait for your",
				"wait on you",
				"wait on your",
				"waiting for you",
				"waiting for your",
				"waiting on you",
				"waiting on your",
				"standing by",
				"holding for you",
				"holding for your",
				"holding off for you",
				"holding off for your",
				"holding off until you",
				"holding off until your",
			]);
		});

		for (const opener of QUESTION_OPENERS) {
			it(`treats a question opening with "${opener}" as waiting on the user`, () => {
				const reply = `Landed the rename across every caller.\n\n${opener} the fallback path stay?`;
				expect(isAwaitingUserAnswer(assistantMessage(reply))).toBe(true);
			});
		}

		for (const cue of REQUEST_CUES) {
			it(`treats the request cue "${cue}" as waiting on the user`, () => {
				const reply = `Landed the rename across every caller.\n\n${cue} before I touch the schema.`;
				expect(isAwaitingUserAnswer(assistantMessage(reply))).toBe(true);
			});
		}

		for (const cue of WAITING_CUES) {
			it(`treats the waiting cue "${cue}" as waiting on the user`, () => {
				const reply = `Landed the rename across every caller.\n\n${cue} on the schema change.`;
				expect(isAwaitingUserAnswer(assistantMessage(reply))).toBe(true);
			});
		}
	});

	describe("the real settle path", () => {
		let tempDir: TempDir;
		let authStorage: AuthStorage;
		let sessionManager: SessionManager;
		let session: AgentSession;
		let continueCalls: number;
		let reminders: string[];

		beforeEach(async () => {
			tempDir = TempDir.createSync("@veyyon-settle-question-");
			authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
			authStorage.setRuntimeApiKey("anthropic", "test-key");
			sessionManager = SessionManager.create(tempDir.path(), tempDir.path());

			const model = getBundledModel("anthropic", "claude-sonnet-4-5");
			if (!model) throw new Error("Expected built-in anthropic model to exist");

			const agent = new Agent({
				initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			});
			session = new AgentSession({
				agent,
				sessionManager,
				settings: Settings.isolated({ "compaction.enabled": false, "todo.enabled": true }),
				modelRegistry: new ModelRegistry(authStorage),
				// Plan mode refuses to force a decision without these two, so an
				// empty registry would make its case pass for the wrong reason.
				toolRegistry: new Map([
					["ask", stubTool("ask")],
					["resolve", stubTool("resolve")],
				]),
			});

			reminders = [];
			session.subscribe((event: AgentSessionEvent) => {
				if (event.type === "todo_reminder") reminders.push(`todo:${event.attempt}`);
			});
			continueCalls = 0;
			vi.spyOn(session.agent, "continue").mockImplementation(async () => {
				continueCalls++;
			});
		});

		afterEach(async () => {
			await session.dispose();
			authStorage.close();
			try {
				await tempDir.remove();
			} catch {}
			vi.restoreAllMocks();
		});

		async function settle(text: string): Promise<void> {
			const msg = assistantMessage(text);
			session.agent.emitExternalEvent({ type: "message_end", message: msg });
			// External events are fire and forget, so the two handlers would
			// otherwise overlap and the settle tail would read the PREVIOUS reply as
			// the one that just ended. A real turn cannot interleave them.
			await delay(20);
			session.agent.emitExternalEvent({ type: "agent_end", messages: [msg] });
			await session.waitForIdle();
			// The `agent_end` tail runs off the event, not off the emit, so an
			// assertion taken straight after the emit would see nothing and every
			// negative control here would pass for the wrong reason.
			await delay(200);
		}

		/** Arm the evidence ledger with an unproven write, as a real turn would. */
		function recordUnprovenWrite(): void {
			session.agent.emitExternalEvent({
				type: "tool_execution_end",
				toolCallId: `call-write-${Math.random()}`,
				toolName: "write",
				result: {
					content: [{ type: "text", text: "written" }],
					details: { resolvedPath: path.join(tempDir.path(), "a.ts") },
				},
				isError: false,
			});
		}

		function openBoard(): void {
			session.setTodoPhases([
				{
					name: "Work",
					tasks: [
						{ content: "Slice 1", status: "pending" },
						{ content: "Slice 2", status: "pending" },
					],
				},
			]);
		}

		/**
		 * Text of every developer message in the active context. The rewind demand
		 * lands there rather than in the session branch, and the active context is
		 * what the next turn would carry to the model.
		 */
		function developerTextEntries(): string[] {
			return session.agent.state.messages.flatMap(message =>
				message.role === "developer" && Array.isArray(message.content)
					? message.content.filter((item): item is TextContent => item.type === "text").map(item => item.text)
					: [],
			);
		}

		it("does not force a rewind over a question, and still demands one afterwards", async () => {
			session.setCheckpointState({
				checkpointMessageCount: 1,
				checkpointEntryId: null,
				startedAt: new Date().toISOString(),
			});

			await settle(QUESTION_WITH_OPTIONS);
			expect(continueCalls).toBe(0);
			expect(developerTextEntries().some(text => text.includes("active checkpoint"))).toBe(false);

			// The checkpoint is still open, so the demand lands at the next settle
			// that is not a question: deferred, not dropped.
			await settle(PLAIN_REPORT);
			expect(continueCalls).toBe(1);
			expect(developerTextEntries().some(text => text.includes("active checkpoint"))).toBe(true);
		});

		it("does not force a plan-mode decision over a question, and still forces one afterwards", async () => {
			session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir.path(), "plan.md") });

			await settle(QUESTION_WITH_OPTIONS);
			expect(continueCalls).toBe(0);

			await settle(PLAIN_REPORT);
			expect(continueCalls).toBe(1);
		});

		it("does not nudge an open todo board over a question, and still nudges afterwards", async () => {
			openBoard();

			await settle(QUESTION_WITH_OPTIONS);
			expect(reminders).toEqual([]);
			expect(continueCalls).toBe(0);

			await settle(PLAIN_REPORT);
			expect(reminders).toEqual(["todo:1"]);
			expect(continueCalls).toBe(1);
		});

		it("does not spend the verification reminder over a question, and still spends it afterwards", async () => {
			recordUnprovenWrite();

			await settle(QUESTION_WITH_OPTIONS);
			expect(continueCalls).toBe(0);

			// The ledger's one reminder per turn was not consumed by the deferral,
			// so it is still there once the user is no longer being asked.
			await settle(PLAIN_REPORT);
			expect(continueCalls).toBe(1);
		});

		/**
		 * The hold is a parameter to `#checkTodoCompletion`, not a reason to skip
		 * calling it: its first statement consumes the tool-choice label the last
		 * turn was forced with. Short-circuiting the call would carry a `user-force`
		 * label onto the following turn and silence a reminder that is owed there.
		 */
		it("still consumes the forced-tool label while holding for a question", async () => {
			openBoard();
			session.toolChoiceQueue.pushOnce("required", { label: "user-force" });
			session.toolChoiceQueue.nextToolChoice();
			session.toolChoiceQueue.resolve();

			await settle(QUESTION_WITH_OPTIONS);
			expect(reminders).toEqual([]);
			expect(continueCalls).toBe(0);

			await settle(PLAIN_REPORT);
			expect(reminders).toEqual(["todo:1"]);
			expect(continueCalls).toBe(1);
		});

		/**
		 * Both held routes climb a bounded ladder (plan mode reminds three times then
		 * yields, the todo nudge escalates to `todo.reminders.max`), so a hold that
		 * spent a rung would be invisible in a single-question test and would strand
		 * a session one question short of its budget. Repeated questions must cost
		 * nothing: the ladder starts at rung one whenever the user stops being asked.
		 */
		it("spends no rung of the plan-mode ladder however often the reply is a question", async () => {
			session.setPlanModeState({ enabled: true, planFilePath: path.join(tempDir.path(), "plan.md") });

			await settle(QUESTION_WITH_OPTIONS);
			await settle(QUESTION_WITH_OPTIONS);
			await settle(QUESTION_WITH_OPTIONS);
			expect(continueCalls).toBe(0);

			// With a rung spent per question the cap would already be reached here and
			// the decision would never be forced at all.
			await settle(PLAIN_REPORT);
			expect(continueCalls).toBe(1);
			expect(developerTextEntries().filter(text => text.includes("plan")).length).toBeGreaterThan(0);
		});

		it("spends no rung of the todo ladder however often the reply is a question", async () => {
			openBoard();

			await settle(QUESTION_WITH_OPTIONS);
			await settle(QUESTION_WITH_OPTIONS);
			await settle(QUESTION_WITH_OPTIONS);
			expect(reminders).toEqual([]);
			expect(continueCalls).toBe(0);

			// Attempt one, not four: the escalation counter never moved.
			await settle(PLAIN_REPORT);
			expect(reminders).toEqual(["todo:1"]);
			expect(continueCalls).toBe(1);
		});
	});
});
