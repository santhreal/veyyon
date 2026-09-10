/**
 * WHY: an approval card nobody answered used to outlive every stop.
 *
 * `ExtensionToolWrapper.execute` raised its card with one shared options
 * object, and that object carried no `AbortSignal`. Nothing could take the card
 * down, and a host that stops a turn waits for the agent to go idle -- which
 * waits for the prompt, which waits for the card. Measured on the desktop: with
 * a `read` approval up, the stop control and every action that leaves the
 * session sent no reply at all.
 *
 * The class this closes: the wrapper deciding an unanswered card's outcome
 * without looking at why it went unanswered. Two answers are wrong for a stop:
 * never returning, and returning "denied by user", which puts a decision the
 * operator never made into the history as a tool error and invites the agent
 * loop to re-issue the call. A cancellation is neither.
 *
 * The card, not the host, is the subject: this suite drives the real wrapper
 * over a real tool and a real approval policy, and fakes only the surface the
 * card is drawn on -- an operator who does not answer is the one boundary a
 * test cannot run. That is also what makes the suite host-independent: the
 * defect was in the wrapper every host shares, so the terminal and ACP hosts
 * are covered here and nowhere else.
 *
 * What it does not catch: a host that draws the card and ignores the signal it
 * is handed (the GUI host's ledger is asserted in
 * `test/gui-host/a-decision-a-turn-is-blocked-on-does-not-outlive-the-stop.test.ts`);
 * a decision raised by something other than the approval gate; and the terminal
 * overlay's own drawing of a withdrawn card.
 */
import { describe, expect, it } from "bun:test";
import type { AgentTool } from "@veyyon/agent-core";
import type { ExtensionRunner } from "@veyyon/coding-agent/extensibility/extensions/runner";
import type { ExtensionUIDialogOptions } from "@veyyon/coding-agent/extensibility/extensions/types";
import { ExtensionToolWrapper } from "@veyyon/coding-agent/extensibility/extensions/wrapper";
import type { SessionToolApprovals } from "@veyyon/coding-agent/tools/core/approval-modes";
import { isCancellation } from "@veyyon/utils";
import { type } from "arktype";

const RAN = "the tool ran";

/** The exact labels the wrapper matches by string, so a rename breaks this too. */
const APPROVE_ONCE = "Approve";
const DENY_ONCE = "Deny";

/**
 * How long an outcome may take.
 *
 * A bound, not a wait: on the passing path every call below settles in the same
 * tick. The defect was a call that never settled, and a test that can only
 * observe a wrong value cannot see that, so the deadline is the assertion. It
 * sits under bun's own 5s per-test default so the failure names the card rather
 * than the runner.
 */
const SETTLES_WITHIN_MS = 3_000;

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

interface CardSurface {
	runner: ExtensionRunner;
	/** The dialog options each presented card was raised with, in order. */
	raisedWith: Array<ExtensionUIDialogOptions | undefined>;
	/** Answer every card open now, and any that opens later. */
	answerWith(choice: string | undefined): void;
}

/**
 * A surface that draws a card and waits, the way a host with an operator in
 * front of it does. It honours the signal it is handed, because that is what
 * every real host does with one: the terminal races its overlay against it and
 * the GUI ledger closes the decision on it. A card raised with no signal
 * therefore stays up until the test answers it -- which is the defect, and the
 * only way this suite can see it.
 */
function cardSurface(): CardSurface {
	const raisedWith: Array<ExtensionUIDialogOptions | undefined> = [];
	const waiting: Array<(choice: string | undefined) => void> = [];
	let standingAnswer: { choice: string | undefined } | undefined;

	const runner = {
		hasHandlers: () => false,
		hasUI: () => true,
		getUIContext: () => ({
			select: (_body: string, _options: unknown, dialogOptions?: ExtensionUIDialogOptions) => {
				raisedWith.push(dialogOptions);
				if (dialogOptions?.signal?.aborted) return Promise.resolve(undefined);
				if (standingAnswer) return Promise.resolve(standingAnswer.choice);
				const { promise, resolve } = Promise.withResolvers<string | undefined>();
				waiting.push(resolve);
				dialogOptions?.signal?.addEventListener("abort", () => resolve(undefined), { once: true });
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
		raisedWith,
		answerWith(choice: string | undefined): void {
			standingAnswer = { choice };
			for (const resolve of waiting.splice(0)) resolve(choice);
		},
	};
}

function approvalStore(): SessionToolApprovals {
	const decisions = new Map<string, "allow" | "deny">();
	return {
		get: (toolName: string) => decisions.get(toolName),
		set: (toolName: string, decision: "allow" | "deny") => {
			decisions.set(toolName, decision);
		},
	};
}

/** The `ask` rung, one session, with the session grant store the wrapper writes to. */
function toolContext(store: SessionToolApprovals): unknown {
	return {
		settings: {
			get: (path: string) => {
				if (path === "tools.approvalMode") return "ask";
				if (path === "tools.approval") return {};
				return undefined;
			},
		},
		sessionApprovals: store,
		sessionManager: { getSessionId: () => "session-under-test" },
	};
}

interface Outcome {
	/** The tool's own text, when it ran. */
	ran?: string;
	/** The error it ended with, when it did not. */
	error?: unknown;
}

/** A sentinel that wins the race when a call never settles at all. */
const NEVER_SETTLED = Symbol("the call did not settle");

async function settle(call: Promise<{ content: Array<{ type: string; text?: string }> }>): Promise<Outcome> {
	const timer = new Promise<typeof NEVER_SETTLED>(resolve => {
		setTimeout(() => resolve(NEVER_SETTLED), SETTLES_WITHIN_MS);
	});
	let outcome: Outcome;
	try {
		const result = await Promise.race([call, timer]);
		if (result === NEVER_SETTLED) throw new Error("the call never settled, so the card outlived the stop");
		const first = result.content[0];
		outcome = { ran: first?.type === "text" ? first.text : undefined };
	} catch (error) {
		outcome = { error };
	}
	return outcome;
}

/**
 * Call `count` concurrent exec-tier calls in one session under `signal`, then
 * run `act` once the first card is up.
 */
async function callsUnder(
	count: number,
	signal: AbortSignal | undefined,
	act: (surface: CardSurface) => void,
): Promise<{ surface: CardSurface; outcomes: Outcome[] }> {
	const surface = cardSurface();
	const store = approvalStore();
	const context = toolContext(store);
	const calls: Array<Promise<Outcome>> = [];
	for (let index = 0; index < count; index++) {
		const wrapped = new ExtensionToolWrapper(execTool(), surface.runner);
		calls.push(
			settle(
				wrapped.execute(`call-${index}`, {} as never, signal, undefined, context as never) as Promise<{
					content: Array<{ type: string; text?: string }>;
				}>,
			),
		);
	}
	// The card is raised inside the first continuation of `execute`, so one turn
	// of the microtask queue per call is enough to have every one of them either
	// presented or waiting behind the first.
	for (let tick = 0; tick < 20 && surface.raisedWith.length === 0; tick++) {
		await new Promise<void>(resolve => {
			setImmediate(resolve);
		});
	}
	act(surface);
	return { surface, outcomes: await Promise.all(calls) };
}

describe("an approval nobody answered", () => {
	it("ends the call when the turn is stopped", async () => {
		const controller = new AbortController();
		const { outcomes } = await callsUnder(1, controller.signal, () => controller.abort());

		expect(outcomes[0]?.ran).toBeUndefined();
		expect(isCancellation(outcomes[0]?.error)).toBe(true);
	});

	it("does not tell the model the operator refused it", async () => {
		const controller = new AbortController();
		const { outcomes } = await callsUnder(1, controller.signal, () => controller.abort());

		// "denied by user" is a decision the model reasons around, and as a tool
		// error rather than a cancellation it invites the loop to re-issue the
		// call the operator just stopped. Nobody decided anything here.
		expect(String((outcomes[0]?.error as Error | undefined)?.message)).not.toContain("denied by user");
	});

	it("ends the calls queued behind it too", async () => {
		// The cards behind the first one are the sibling defect: they surface
		// whenever the surface frees up, so before the signal reached them an
		// operator who stopped a batch was asked about the rest of it afterwards.
		const controller = new AbortController();
		const { outcomes } = await callsUnder(3, controller.signal, () => controller.abort());

		expect(outcomes.map(outcome => isCancellation(outcome.error))).toEqual([true, true, true]);
	});

	it("is still answerable while the turn is running", async () => {
		// The positive control: a signal that exists and has not fired must not
		// turn an approval into a cancellation. Every other approval suite runs
		// with no signal at all, so this is the only place the live one is
		// exercised against an answer.
		const controller = new AbortController();
		const { outcomes } = await callsUnder(1, controller.signal, surface => surface.answerWith(APPROVE_ONCE));

		expect(outcomes[0]?.ran).toBe(RAN);
		expect(outcomes[0]?.error).toBeUndefined();
	});

	it("is a refusal when the operator refuses it, signal or no signal", async () => {
		const controller = new AbortController();
		const { outcomes } = await callsUnder(1, controller.signal, surface => surface.answerWith(DENY_ONCE));

		expect(String((outcomes[0]?.error as Error | undefined)?.message)).toContain("denied by user");
		expect(isCancellation(outcomes[0]?.error)).toBe(false);
	});

	it("hands the turn's signal to the surface that draws it", async () => {
		// Not option forwarding for its own sake: the signal IS how a host
		// withdraws the card, and a host cannot be asked to withdraw what it was
		// never given. The wrapper used to pass one shared options object with no
		// signal in it at all.
		const controller = new AbortController();
		const { surface } = await callsUnder(1, controller.signal, s => s.answerWith(APPROVE_ONCE));

		expect(surface.raisedWith[0]?.signal).toBe(controller.signal);
	});
});
