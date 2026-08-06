/**
 * An approval you answered for the session is not asked again for the calls
 * that were already in flight when you answered it.
 *
 * WHY THIS SUITE EXISTS. The model routinely issues several calls to the same
 * tool in one batch, and each one raises its own approval prompt. Only one can
 * be on screen: the dialog host presents one and queues the rest. The standing
 * grant is read once, before a call queues, so "Approve for session" answered
 * at the first card could not dismiss the cards already waiting behind it.
 * Those cards are built with no abort signal either, so neither an interrupt
 * nor the end of the turn drops them. They surface whenever the surface frees
 * up, which is the operator-visible symptom: you answer once, the agent goes
 * off and finishes, and then it asks you again for the same tool after the
 * work is done. Nothing about it reaches the transcript, because no second
 * tool call was ever made, which is why it reads as the harness glitching
 * rather than the model repeating itself.
 *
 * The fix is that a second call waits on the prompt already open for that tool
 * instead of queueing its own card, then re-reads the answer. So the contract
 * has two halves and both are pinned here: a session grant dismisses the
 * waiters with no card at all, and "Approve" (once) still asks every time,
 * because that answer was only ever about one call.
 *
 * Nothing here spawns a process or touches the filesystem. The tool records
 * that it ran and the UI is a recording stub, so "did not prompt" is
 * observable as a count rather than inferred from a return value.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/approval-modes";
import { type } from "arktype";

const RAN = "the tool ran";

/**
 * The exact labels the wrapper matches by string. Spelled here rather than
 * imported because the wrapper matches the returned label byte for byte, so a
 * rename must break this suite too, not be silently followed by it.
 */
const APPROVE_ONCE = "Approve";
const APPROVE_SESSION = "Approve for session";
const DENY_SESSION = "Deny for session";

/** Exec tier, which the `ask` rung always prompts for. */
function execTool(name = "bash"): AgentTool {
	return {
		name,
		label: name,
		summary: "records that it ran",
		description: "records that it ran",
		parameters: type({}),
		approval: () => ({ tier: "exec" as const }),
		execute: async () => ({ content: [{ type: "text", text: RAN }] }),
	} as unknown as AgentTool;
}

interface GatedUi {
	runner: ExtensionRunner;
	/** One entry per approval card actually presented. */
	presented: string[];
	/** Resolves once `count` cards are open at the same time. */
	waitForPresented(count: number): Promise<void>;
	/** Answer every card that is open now, and any that open later. */
	answerWith(choice: string | undefined): void;
}

/**
 * A UI whose select BLOCKS until the test answers it. Blocking is the whole
 * point: the defect only exists while a second call arrives with a card
 * already open, so a select that returns immediately cannot reproduce it.
 */
function gatedUi(failFirst = false): GatedUi {
	const presented: string[] = [];
	const waiting: Array<(choice: string | undefined) => void> = [];
	let standingAnswer: { choice: string | undefined } | undefined;
	let observer: { count: number; resolve: () => void } | undefined;

	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ({
			select: (body: string) => {
				presented.push(body);
				if (observer && presented.length >= observer.count) {
					observer.resolve();
					observer = undefined;
				}
				if (failFirst && presented.length === 1) {
					return Promise.reject(new Error("dialog surface died"));
				}
				if (standingAnswer) return Promise.resolve(standingAnswer.choice);
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				waiting.push(resolve);
				return promise;
			},
		}),
		emit: async () => undefined,
		emitToolCall: async () => undefined,
		emitToolResult: async () => undefined,
		createContext: () => ({}),
	} as unknown as ExtensionRunner;

	return {
		runner,
		presented,
		waitForPresented(count: number): Promise<void> {
			if (presented.length >= count) return Promise.resolve();
			const { promise, resolve } = Promise.withResolvers<void>();
			observer = { count, resolve };
			return promise;
		},
		answerWith(choice: string | undefined): void {
			standingAnswer = { choice };
			for (const resolve of waiting.splice(0)) resolve(choice);
		},
	};
}


function makeStore(): SessionToolApprovals {
	const map = new Map<string, "allow" | "deny">();
	return {
		get: (toolName: string) => map.get(toolName),
		set: (toolName: string, decision: "allow" | "deny") => {
			map.set(toolName, decision);
		},
	};
}

interface BatchOutcome {
	presented: string[];
	ran: number;
	errors: string[];
}

/**
 * Fire `count` concurrent calls to one tool in one session, wait until the
 * first card is on screen, then answer with `choice`.
 */
async function batch(options: {
	count: number;
	choice: string | undefined;
	sessionId?: string | ((index: number) => string);
	tool?: () => AgentTool;
	/** Make the first card reject, as a dialog surface that dies mid-prompt. */
	failFirst?: boolean;
}): Promise<BatchOutcome> {
	const ui = gatedUi(options.failFirst ?? false);
	const store = makeStore();
	const sessionIdFor = (index: number): string =>
		typeof options.sessionId === "function" ? options.sessionId(index) : (options.sessionId ?? "session-under-test");

	const contextFor = (index: number) => ({
		settings: {
			get: (path: string) => {
				if (path === "tools.approvalMode") return "ask";
				if (path === "tools.approval") return {};
				return undefined;
			},
		},
		sessionApprovals: store,
		sessionManager: { getSessionId: () => sessionIdFor(index) },
	});

	const calls: Array<Promise<string | undefined>> = [];
	for (let index = 0; index < options.count; index++) {
		const wrapped = new ExtensionToolWrapper(options.tool ? options.tool() : execTool(), ui.runner);
		calls.push(
			wrapped
				.execute(`call-${index}`, {} as never, undefined, undefined, contextFor(index) as never)
				.then(result => {
					const first = result.content[0];
					return first && first.type === "text" ? first.text : undefined;
				}),
		);
	}

	await ui.waitForPresented(1);
	ui.answerWith(options.choice);

	const settled = await Promise.allSettled(calls);
	return {
		presented: ui.presented,
		ran: settled.filter(entry => entry.status === "fulfilled" && entry.value === RAN).length,
		errors: settled.map(entry => (entry.status === "rejected" ? String(entry.reason?.message ?? entry.reason) : "")),
	};
}

describe("a batch of calls to one tool, answered for the session", () => {
	it("shows one card, not one per call", async () => {
		const outcome = await batch({ count: 3, choice: APPROVE_SESSION });

		expect(outcome.presented.length).toBe(1);
	});

	it("runs every call in the batch", async () => {
		const outcome = await batch({ count: 3, choice: APPROVE_SESSION });

		expect(outcome.ran).toBe(3);
	});

	it("denies every call in the batch off one card when the answer is a session deny", async () => {
		const outcome = await batch({ count: 3, choice: DENY_SESSION });

		expect(outcome.presented.length).toBe(1);
		expect(outcome.ran).toBe(0);
		expect(outcome.errors.filter(message => message.includes("denied"))).toHaveLength(3);
	});
});

describe("the narrowness of the fix", () => {
	/**
	 * "Approve" answers for ONE call. Collapsing a batch onto it would be a
	 * standing grant the operator never gave, so each call must still ask.
	 */
	it("still asks once per call when the answer is Approve, not Approve for session", async () => {
		const outcome = await batch({ count: 3, choice: APPROVE_ONCE });

		expect(outcome.presented.length).toBe(3);
		expect(outcome.ran).toBe(3);
	});

	it("does not let one session's grant dismiss another session's card", async () => {
		const outcome = await batch({
			count: 2,
			choice: APPROVE_SESSION,
			sessionId: index => `session-${index}`,
		});

		expect(outcome.presented.length).toBe(2);
	});

	it("asks per call for two different tools, since a grant is per tool", async () => {
		let next = 0;
		const outcome = await batch({
			count: 2,
			choice: APPROVE_SESSION,
			tool: () => execTool(next++ === 0 ? "bash" : "write"),
		});

		expect(outcome.presented.length).toBe(2);
	});
});

describe("a dialog that dies while calls are queued behind it", () => {
	/**
	 * The in-flight entry is the batch's only gate. A prompt that throws without
	 * clearing it leaves every later call to that tool awaiting a promise nobody
	 * will ever settle, which is worse than the bug being fixed: the agent stops
	 * dead with no card on screen and nothing to answer. The wait is raced
	 * against a timer so a hang reports as a stranded batch rather than as a
	 * suite timeout with no explanation.
	 */
	it("lets the calls behind it ask for themselves instead of stranding them", async () => {
		const settled = batch({ count: 2, choice: APPROVE_SESSION, failFirst: true });
		const timer = Promise.withResolvers<"stranded">();
		const handle = setTimeout(() => timer.resolve("stranded"), 2000);
		const outcome = await Promise.race([settled, timer.promise]);
		clearTimeout(handle);

		expect(outcome).not.toBe("stranded");
	});
});
