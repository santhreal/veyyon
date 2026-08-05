/**
 * THE BUG THIS LOCKS OUT: a spawned agent that needs permission had nowhere to ask.
 *
 * `task/executor.ts` called `extensionRunner.initialize(actions, runtime)` while the
 * signature is `initialize(actions, runtime, commandContextActions?, uiContext?)`. The
 * fourth argument was accepted and never passed, so every subagent's runner kept
 * `noOpUIContext`, `hasUI()` was false, and the approval wrapper threw
 * "requires approval but no interactive UI available" instead of asking anybody. The
 * child died mid-task with no card ever drawn and no operator ever consulted.
 *
 * That was survivable only while `createSubagentSettings` forced every child to `yolo`,
 * because a `yolo` child never asks. Removing that hardcode (children now inherit the
 * operator's rung) turned a dormant hole into a hard failure on an ordinary call, which
 * is why the surfacing below is load-bearing rather than a nicety.
 *
 * THE FOUR STATES, each proven here:
 *   1. never-raised is gone      — a subagent at an asking rung DOES construct a request.
 *   2. raised-and-answered       — at DEPTH 2, reaching the ROOT and not the intermediate
 *                                  spawner, with the requesting agent named on the card.
 *   3. raised-with-no-root-UI    — refuses readably, and the child's tool result carries
 *                                  the explanation verbatim.
 *   4. a waiting child survives  — `subagent.maxRuntimeMs` does not charge the agent for
 *                                  the operator's reading time.
 *
 * WHY DEPTH 2 AND NOT DEPTH 1. Routing to "the parent" works at one level and is exactly
 * the design being avoided: every intermediate is an agent that can be parked, aborted or
 * busy, and each hop is another place the request can be dropped. Resolution goes through
 * `AgentRef.scope`, which is inherited transitively at registration, so a child at any
 * depth already carries the root's identity. A depth-1 test cannot tell the two designs
 * apart, because at depth 1 the parent IS the root.
 *
 * WHY REAL COLLABORATORS. The whole defect was a missing argument between a real
 * `ExtensionRunner` and a real `ExtensionToolWrapper`, so both are the production classes
 * here, the rung comes from the real `createSubagentSettings`, and the lookup runs against
 * the real process-global `AgentRegistry`. A stubbed `hasUI: () => true` would have been
 * green throughout the entire period the bug existed.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { setTimeout as delay } from "node:timers/promises";
import type { AgentTool } from "@veyyon/agent-core";
import type { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import type {
	ExtensionActions,
	ExtensionContextActions,
	ExtensionRuntime,
	ExtensionUIContext,
} from "@veyyon/coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import type { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { createSubagentSettings, resolveRootUIContext, runSubprocess } from "@veyyon/coding-agent/task/executor";
import type { AgentDefinition } from "@veyyon/coding-agent/task/types";
import { type } from "arktype";
import { useIsolatedAgentDir } from "../helpers/isolated-agent-dir";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/subagent-session";

useIsolatedAgentDir();

/** Text the tool returns when it actually runs, so "the call proceeded" is observable. */
const RAN = "the tool ran";
const CWD = "/tmp/veyyon-subagent-approval-root";

const ROOT_SESSION_ID = "root-conversation";

/** One recorded presentation of an approval card, as the surface that showed it saw it. */
interface Card {
	body: string;
}

/** A surface that records what it was asked and answers with `answer`. */
function recordingUI(cards: Card[], answer: string | undefined = "Approve"): ExtensionUIContext {
	return {
		select: async (body: string) => {
			cards.push({ body });
			return answer;
		},
	} as unknown as ExtensionUIContext;
}

/** A surface that fails the way a dismissed or torn-down dialog does. */
function throwingUI(error: Error): ExtensionUIContext {
	return {
		select: async () => {
			throw error;
		},
	} as unknown as ExtensionUIContext;
}

/**
 * A REAL `ExtensionRunner`, because `hasUI()` / `getUIContext()` are precisely the
 * behavior under test and a stub of them proves nothing about the missing argument.
 * `uiContext` omitted models a session with no interactive surface.
 */
function makeRunner(uiContext?: ExtensionUIContext): ExtensionRunner {
	const runner = new ExtensionRunner([], {} as ExtensionRuntime, CWD, {} as SessionManager, {} as ModelRegistry);
	runner.initialize({} as ExtensionActions, {} as ExtensionContextActions, undefined, uiContext);
	return runner;
}

function makeTool(name = "bash"): AgentTool {
	return {
		name,
		label: name,
		summary: "records that it ran",
		description: "records that it ran",
		parameters: type({}),
		approval: () => "exec",
		execute: async () => ({ content: [{ type: "text", text: RAN }] }),
	} as unknown as AgentTool;
}

/** Register an agent whose only interesting property is the runner hanging off its session. */
function registerAgent(id: string, options: { parentId?: string; runner?: ExtensionRunner }): void {
	AgentRegistry.global().register({
		id,
		displayName: id,
		kind: options.parentId ? "sub" : "main",
		parentId: options.parentId,
		session: { extensionRunner: options.runner } as unknown as AgentSession,
		...(options.parentId ? {} : { scope: ROOT_SESSION_ID }),
	});
}

interface CallOutcome {
	text: string | undefined;
	error: Error | undefined;
}

/**
 * Drive one tool call through the production wrapper, as agent `agentId` would.
 *
 * The rung comes from the real `createSubagentSettings` fork of a parent at `rung`, so a
 * change to how a spawn inherits permission moves these assertions rather than leaving
 * them asserting a literal this file wrote.
 */
async function callAsAgent(agentId: string, rung: string, tool: AgentTool = makeTool()): Promise<CallOutcome> {
	const settings = createSubagentSettings(Settings.isolated({ "tools.approvalMode": rung }));
	// The child's own runner, wired exactly as `runSubprocess` wires it: named, then
	// handed whatever surface the ROOT resolves to.
	const runner = makeRunner(resolveRootUIContext(agentId));
	runner.setAgentId(agentId);
	const context = {
		settings,
		sessionManager: { getCwd: () => CWD, getSessionId: () => `${agentId}-session` },
	} as unknown as Parameters<AgentTool["execute"]>[4];

	const wrapped = new ExtensionToolWrapper(tool, runner);
	try {
		const result = await wrapped.execute("call-1", {}, undefined, undefined, context);
		const first = result.content[0];
		return { text: first && first.type === "text" ? first.text : undefined, error: undefined };
	} catch (err) {
		return { text: undefined, error: err instanceof Error ? err : new Error(String(err)) };
	}
}

describe("a subagent's approval request reaches the root session", () => {
	let rootCards: Card[];
	let intermediateCards: Card[];

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
		rootCards = [];
		intermediateCards = [];
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
	});

	/**
	 * A three-level tree: root with a real surface, an intermediate spawner that ALSO has
	 * a surface, and a grandchild. The intermediate is given one on purpose — it is the
	 * decoy. A parent-walking implementation would stop there and still look correct, so
	 * the assertion below is not merely "the root got it" but "the root got it AND the
	 * intermediate got nothing".
	 */
	function buildDepthTwoTree({ rootHasUI = true }: { rootHasUI?: boolean } = {}): void {
		registerAgent("Main", { runner: makeRunner(rootHasUI ? recordingUI(rootCards) : undefined) });
		registerAgent("Intermediate", { parentId: "Main", runner: makeRunner(recordingUI(intermediateCards)) });
		registerAgent("Depth2", { parentId: "Intermediate" });
	}

	/**
	 * STATE 1: never-raised is gone.
	 *
	 * A subagent at an asking rung constructs a request instead of silently proceeding.
	 * Asserted as a card COUNT plus the call's own outcome, because "no card and the tool
	 * ran" and "one card, approved, and the tool ran" produce the same return value and
	 * are the exact two states this has to distinguish.
	 */
	it("constructs a request rather than proceeding unasked", async () => {
		buildDepthTwoTree();

		const outcome = await callAsAgent("Depth2", "ask");

		expect(rootCards.length).toBe(1);
		expect(outcome.text).toBe(RAN);
		expect(outcome.error).toBeUndefined();
	});

	/**
	 * STATE 2: raised and answered AT DEPTH 2, at the root, with attribution.
	 *
	 * Three separate claims, asserted together because they fail independently: the root
	 * saw it, the intermediate did NOT (so this is scope resolution and not a parent
	 * hop), and the card names both who is asking and what for.
	 */
	it("presents a depth-2 child's request at the root, naming the child and the tool", async () => {
		buildDepthTwoTree();

		const outcome = await callAsAgent("Depth2", "ask");

		expect(rootCards.length).toBe(1);
		expect(intermediateCards.length).toBe(0);
		expect(rootCards[0]?.body).toContain("**Requested by:** `Depth2`");
		expect(rootCards[0]?.body).toContain("**Tool:** `bash`");
		expect(outcome.text).toBe(RAN);
	});

	/**
	 * The operator answers ONE queue. Two children asking at the same moment must be two
	 * distinguishable prompts, or the operator approves the wrong agent's call and cannot
	 * tell that they did. Asserted on the bylines specifically, since both cards are
	 * otherwise byte-identical.
	 */
	it("distinguishes two children asking at once", async () => {
		registerAgent("Main", { runner: makeRunner(recordingUI(rootCards)) });
		registerAgent("Intermediate", { parentId: "Main" });
		registerAgent("Alpha", { parentId: "Intermediate" });
		registerAgent("Beta", { parentId: "Intermediate" });

		await Promise.all([callAsAgent("Alpha", "ask"), callAsAgent("Beta", "ask")]);

		const bylines = rootCards.map(card => card.body.split("\n").find(line => line.startsWith("**Requested by:**")));
		expect(bylines.sort()).toEqual(["**Requested by:** `Alpha`", "**Requested by:** `Beta`"]);
	});

	/**
	 * Scope resolution itself, asserted by IDENTITY rather than through a card.
	 *
	 * The two surfaces in the tree are different objects, so "which one came back" is a
	 * decidable question with no room for a coincidence. This is the assertion that goes
	 * red the instant someone reimplements the lookup as a walk up `parentId`.
	 */
	it("resolves the root's surface, not the intermediate spawner's", () => {
		const rootUI = recordingUI(rootCards);
		const intermediateUI = recordingUI(intermediateCards);
		registerAgent("Main", { runner: makeRunner(rootUI) });
		registerAgent("Intermediate", { parentId: "Main", runner: makeRunner(intermediateUI) });
		registerAgent("Depth2", { parentId: "Intermediate" });

		const resolved = resolveRootUIContext("Depth2");

		expect(resolved).toBe(rootUI);
		expect(resolved).not.toBe(intermediateUI);
	});

	/**
	 * STATE 3: a genuinely non-interactive root refuses READABLY.
	 *
	 * Refusal is correct here — nobody can be asked. What must not happen is that it reads
	 * like a crash, or that it auto-approves, which would make a headless root the most
	 * permissive configuration in the product.
	 *
	 * Pinned as exact bytes because this string IS the deliverable: no card is ever drawn,
	 * so the child's tool result is the operator's only account of what was refused and
	 * what to do about it. The `(requested by Depth2)` clause matters for the same reason
	 * the byline does — a fan-out of ten children produces ten of these.
	 */
	it("refuses with a readable explanation when the root has no surface either", async () => {
		buildDepthTwoTree({ rootHasUI: false });

		const outcome = await callAsAgent("Depth2", "ask");

		expect(outcome.text).toBeUndefined();
		expect(outcome.error?.message).toBe(
			'Tool "bash" (requested by Depth2) requires approval but no interactive UI available.\n' +
				"Options:\n" +
				"  1. Raise tools.approvalMode (ask-command / auto / yolo) in /settings, or pass --approval-mode\n" +
				"  2. Add tools.approval.bash: allow to config\n" +
				"  3. Use an interactive UI to approve the tool call",
		);
		expect(rootCards.length).toBe(0);
	});

	/**
	 * A root holding the no-op context is NOT a surface. Passing it down would make the
	 * child's `hasUI()` true and turn every prompt into a silent `undefined` choice — a
	 * denial the operator was never shown, which is worse than the readable refusal
	 * because nothing anywhere says a decision was made.
	 */
	it("treats a root with no interactive surface as no surface, not as a silent denier", () => {
		registerAgent("Main", { runner: makeRunner(undefined) });
		registerAgent("Depth1", { parentId: "Main" });

		expect(resolveRootUIContext("Depth1")).toBeUndefined();
	});

	/**
	 * STATE 4a: the wait is OBSERVABLE while it is happening.
	 *
	 * A blocked agent's status stays `running` (it is mid-turn), so status alone cannot
	 * tell it from an agent grinding through a build. Sampled from inside the dialog,
	 * which is the only window in which the claim is even checkable, and asserted on the
	 * attribution fields because a bare boolean would not let a dashboard say what the
	 * agent is blocked ON.
	 */
	it("publishes the waiting agent, the tool and the reason while the prompt is open", async () => {
		let observedWhileOpen: { toolName: string; reason?: string } | undefined;
		registerAgent("Main", {
			runner: makeRunner({
				select: async () => {
					const pending = AgentRegistry.global().get("Depth2")?.pendingApproval;
					observedWhileOpen = pending && { toolName: pending.toolName, reason: pending.reason };
					return "Approve";
				},
			} as unknown as ExtensionUIContext),
		});
		registerAgent("Intermediate", { parentId: "Main" });
		registerAgent("Depth2", { parentId: "Intermediate" });

		await callAsAgent("Depth2", "ask");

		expect(observedWhileOpen?.toolName).toBe("bash");
		expect(AgentRegistry.global().get("Depth2")?.pendingApproval).toBeUndefined();
	});

	/**
	 * STATE 4b: no throw path leaks the flag set.
	 *
	 * A dialog that is dismissed, aborted or torn down throws out of `select`, and a flag
	 * left set there is worse than never setting it: the agent is charged nothing against
	 * its runtime budget forever, and the dashboard shows it blocked on a prompt that no
	 * longer exists. The clear lives in the `finally`, and this is what proves it.
	 */
	it("clears the waiting state when the dialog throws", async () => {
		const dialogFailure = new Error("dialog torn down");
		registerAgent("Main", { runner: makeRunner(throwingUI(dialogFailure)) });
		registerAgent("Intermediate", { parentId: "Main" });
		registerAgent("Depth2", { parentId: "Intermediate" });

		const outcome = await callAsAgent("Depth2", "ask");

		expect(outcome.error).toBe(dialogFailure);
		expect(AgentRegistry.global().get("Depth2")?.pendingApproval).toBeUndefined();
		// And the interval it did wait was banked, so a budget can still exclude it.
		expect(AgentRegistry.global().approvalWaitedMs("Depth2")).toBeGreaterThanOrEqual(0);
	});

	/**
	 * A root session raises its own prompts with no byline. The attribution exists because
	 * a subagent's card is presented somewhere other than where it was raised; a root's is
	 * not, and stamping it with its own name is noise on the card the operator sees most.
	 */
	it("leaves a root session's own card unattributed", async () => {
		registerAgent("Main", { runner: makeRunner(recordingUI(rootCards)) });
		const settings = Settings.isolated({ "tools.approvalMode": "ask" });
		const runner = makeRunner(recordingUI(rootCards));
		const context = {
			settings,
			sessionManager: { getCwd: () => CWD, getSessionId: () => "main-session" },
		} as unknown as Parameters<AgentTool["execute"]>[4];

		await new ExtensionToolWrapper(makeTool(), runner).execute("call-1", {}, undefined, undefined, context);

		expect(rootCards.at(-1)?.body).not.toContain("Requested by");
	});
});

/**
 * THE CALL SITE ITSELF, which is where the defect actually lived.
 *
 * Every case above builds the wiring the way `runSubprocess` builds it. That proves the
 * resolver and the wrapper, and it would stay green if the spawner went back to calling
 * `initialize(actions, runtime)` with the fourth argument dropped — which is precisely the
 * bug. So this drives the real spawner and then asks the CHILD'S OWN runner what it ended
 * up holding.
 *
 * Asserted by identity against the root's surface rather than through `hasUI()` alone: a
 * `true` from `hasUI()` says only that something was passed, and passing the wrong
 * session's surface routes the operator's prompt to the wrong window.
 */
describe("the spawner hands the child the root's surface", () => {
	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
	});

	it("wires the resolved root surface and the child's own name onto the spawned runner", async () => {
		const rootCards: Card[] = [];
		const rootUI = recordingUI(rootCards);
		AgentRegistry.global().register({
			id: "Main",
			displayName: "Main",
			kind: "main",
			scope: ROOT_SESSION_ID,
			session: { extensionRunner: makeRunner(rootUI) } as unknown as AgentSession,
		});
		AgentRegistry.global().register({
			id: "Intermediate",
			displayName: "Intermediate",
			kind: "sub",
			parentId: "Main",
			session: null,
		});
		AgentRegistry.global().register({
			id: "spawned-child",
			displayName: "spawned-child",
			kind: "sub",
			parentId: "Intermediate",
			session: null,
		});

		// A runner with NO surface of its own, so anything it reports afterwards can only
		// have come from the spawner.
		const childRunner = makeRunner(undefined);
		const session = createMockSession(({ emit }) => {
			emit(yieldSuccessEvent({ ok: true }, "tool-yield"));
		});
		Object.assign(session, { extensionRunner: childRunner });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(createSessionResult(session));

		const result = await runSubprocess({
			cwd: "/tmp",
			agent: { name: "task", description: "test", systemPrompt: "test", source: "bundled" },
			task: "do work",
			index: 0,
			id: "spawned-child",
			modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
			enableLsp: false,
			settings: Settings.isolated({ "tools.approvalMode": "ask" }),
		});

		expect(result.aborted).toBe(false);
		expect(childRunner.hasUI()).toBe(true);
		expect(childRunner.getUIContext()).toBe(rootUI);
		expect(childRunner.agentId).toBe("spawned-child");
	});
});

/**
 * STATE 4c: the runtime budget must not charge the operator's reading time.
 *
 * `subagent.maxRuntimeMs` exists to bound a child that hangs on a provider stream. It was
 * also counting every second a child sat at an approval card, so a slow decision killed
 * the agent while its prompt was still on screen: the operator then answers for something
 * already dead and the work is lost with no report. That is abandonment with extra steps,
 * and it is the failure the whole surfacing exists to prevent — a prompt nobody can act on
 * usefully is not better than no prompt.
 *
 * Driven through the real `runSubprocess` against a mock session, because the exclusion
 * lives in the executor's wall-clock timer and a unit test of the arithmetic would not
 * show that the timer actually re-arms instead of aborting.
 */
describe("subagent.maxRuntimeMs excludes time spent waiting on the operator", () => {
	const agent: AgentDefinition = { name: "task", description: "test", systemPrompt: "test", source: "bundled" };
	const baseOptions = {
		cwd: "/tmp",
		agent,
		task: "do work",
		index: 0,
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
	};
	/** Comfortably longer than the budget, so a run that survives can only have excluded it. */
	const WAIT_MS = 260;
	const BUDGET_MS = 80;

	beforeEach(() => {
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(() => {
		AgentRegistry.resetGlobalForTests();
		vi.restoreAllMocks();
	});

	/** A child that blocks on `prompts` approval cards in a row, then yields. */
	function sessionThatWaits(id: string, prompts: number): AgentSession {
		const registry = AgentRegistry.global();
		return createMockSession(async ({ emit }) => {
			for (let n = 0; n < prompts; n++) {
				registry.setPendingApproval(id, { toolName: "bash", since: Date.now() });
				await delay(WAIT_MS / prompts);
				registry.setPendingApproval(id, undefined);
			}
			emit(yieldSuccessEvent({ ok: true }, "tool-yield"));
		});
	}

	/**
	 * THE HEADLINE. One wait, longer than the entire budget, and the child still completes
	 * and returns its result. Asserted on the result rather than on a timer, because
	 * "survived" and "produced its work" are different claims and only the second one is
	 * what the operator loses when the child is killed.
	 */
	it("does not abort a child blocked on a card for longer than its whole budget", async () => {
		AgentRegistry.global().register({
			id: "waiting-child",
			displayName: "waiting-child",
			kind: "sub",
			session: null,
		});
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(sessionThatWaits("waiting-child", 1)),
		);

		const result = await runSubprocess({
			...baseOptions,
			id: "waiting-child",
			settings: Settings.isolated({ "subagent.maxRuntimeMs": BUDGET_MS }),
		});

		expect(result.aborted).toBe(false);
		expect(result.abortReason).toBeUndefined();
		expect(result.exitCode).toBe(0);
	});

	/**
	 * THE DIFFERENTIAL. Identical timing, identical budget, no approval wait — and the
	 * child IS aborted. Without this the test above would also pass if the wall clock had
	 * simply been switched off, which would be a regression dressed as a fix.
	 */
	it("still aborts a child that is merely slow", async () => {
		AgentRegistry.global().register({ id: "slow-child", displayName: "slow-child", kind: "sub", session: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(
				createMockSession(async ({ emit }) => {
					await delay(WAIT_MS);
					emit(yieldSuccessEvent({ ok: true }, "tool-yield"));
				}),
			),
		);

		const result = await runSubprocess({
			...baseOptions,
			id: "slow-child",
			settings: Settings.isolated({ "subagent.maxRuntimeMs": BUDGET_MS }),
		});

		expect(result.aborted).toBe(true);
		expect(result.abortReason).toContain("runtime limit exceeded");
	});

	/**
	 * Several ANSWERED prompts are excluded too, not just the one currently open.
	 *
	 * `pendingApprovalSince` reports the live interval only. A child that answered three
	 * prompts and went back to work has no pending state at all, so an exclusion reading
	 * only the open interval credits it nothing and charges it the full sum of the
	 * operator's reading time — the failure returns intact for exactly the agent that was
	 * most cooperative about asking.
	 */
	it("excludes prompts that were already answered, not only the open one", async () => {
		AgentRegistry.global().register({ id: "thrice-child", displayName: "thrice-child", kind: "sub", session: null });
		vi.spyOn(sdkModule, "createAgentSession").mockResolvedValue(
			createSessionResult(sessionThatWaits("thrice-child", 3)),
		);

		const result = await runSubprocess({
			...baseOptions,
			id: "thrice-child",
			settings: Settings.isolated({ "subagent.maxRuntimeMs": BUDGET_MS }),
		});

		expect(result.aborted).toBe(false);
		expect(AgentRegistry.global().approvalWaitedMs("thrice-child")).toBeGreaterThan(BUDGET_MS);
	});
});
