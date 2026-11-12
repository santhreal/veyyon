/**
 * The bus refuses to carry a closed two-agent loop past a bounded number of
 * work-free messages.
 *
 * WHY IT EXISTS. Two agents that answer each other and nothing else cannot
 * stop on their own. Every inbound message wakes the recipient, a wake is
 * indistinguishable from progress, and neither agent can see the pattern
 * because each one only ever sees the single message in front of it. Nothing
 * else bounded it: an irc wake is not a job, so no job budget applies, and the
 * per-run soft request budget resets because a woken agent keeps re-entering.
 * The observed failure is a pair trading turns until the process is killed.
 *
 * The bound is on the pattern, not on message content. An earlier content rule
 * matched "understood", "heads up" and "working on" at the start of a message
 * and discouraged real coordination; it is gone. What is pinned below: the cap
 * fires on a closed loop with no work in it, a non-coordination tool call by
 * either agent resets it, coordination calls (`irc`, `job`, `todo`) do not, a
 * revive does not, a third party resets it, and the refusal is a receipt.
 *
 * Not caught here: whether the session wiring reports tool calls to the
 * registry; `a-tool-call-counts-as-work-for-the-irc-loop-bound.test.ts` drives
 * that through a real session.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { IrcBus } from "@veyyon/coding-agent/task/irc-bus";

/** Accepts every hand-off, so delivery succeeds and only the cap can refuse. */
function receivingSession(): AgentSession {
	return {
		deliverIrcMessage: async () => {},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

/** Mirrors WORK_FREE_EXCHANGE_CAP in src/task/irc-bus.ts. */
const CAP = 8;
const REFUSAL = "messages with no work done by either of you in between";

let bus: IrcBus;
let registry: AgentRegistry;

function register(id: string): void {
	registry.register({ id, displayName: "reviewer", kind: "sub", session: receivingSession(), status: "running" });
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	bus = IrcBus.global();
	registry = AgentRegistry.global();
	for (const id of ["Alpha", "Beta", "Gamma", "Delta"]) register(id);
});

/** Alternate `count` messages starting from `first`, returning the last receipt. */
async function pingPong(count: number, first = "Alpha", second = "Beta") {
	let receipt = await bus.send({ from: first, to: second, body: "0" });
	for (let index = 1; index < count; index++) {
		const from = index % 2 === 0 ? first : second;
		const to = index % 2 === 0 ? second : first;
		receipt = await bus.send({ from, to, body: String(index) });
	}
	return receipt;
}

describe("IRC work-free exchange cap", () => {
	/**
	 * The bound itself. The message AT the cap still lands, so the number is the
	 * count of exchanges allowed and not one less; the next one is refused.
	 */
	test("delivers up to the cap and refuses the message that would exceed it", async () => {
		const atCap = await pingPong(CAP);
		expect(atCap.outcome).not.toBe("failed");

		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
		expect(overCap.error).toContain(`${CAP} ${REFUSAL}`);
	});

	/**
	 * The refusal has to tell the agent what to do instead, because an agent
	 * that only learns "failed" retries.
	 */
	test("names the ways out of the loop in the refusal", async () => {
		await pingPong(CAP);
		const refused = await bus.send({ from: "Alpha", to: "Beta", body: "again" });
		expect(refused.error).toContain("Do the work the conversation is about");
		expect(refused.error).toContain("report to whoever spawned you");
	});

	/**
	 * The false-positive guard this cap exists to keep: a pair that works between
	 * messages is collaborating, however long it talks. Either side's work
	 * resets the chain, so the recipient doing the work counts as much as the
	 * sender doing it. Runs to four times the cap to prove there is no second,
	 * hidden bound on total traffic.
	 */
	test.each(["sender", "recipient"] as const)(
		"a pair whose %s works between messages is never refused",
		async worker => {
			for (let index = 0; index < CAP * 4; index++) {
				const from = index % 2 === 0 ? "Alpha" : "Beta";
				const to = from === "Alpha" ? "Beta" : "Alpha";
				if (index % 3 === 0) registry.noteToolCall(worker === "sender" ? from : to, "edit");
				const receipt = await bus.send({ from, to, body: String(index) });
				expect(receipt.outcome).not.toBe("failed");
			}
		},
	);

	/**
	 * Talking and waiting are not work. A pair that answers each other between
	 * `job` polls, todo updates, or more `irc` calls is still looping, so these
	 * calls must not reset the chain.
	 */
	test.each(["irc", "job", "todo"])("a %s call between messages does not reset the chain", async tool => {
		for (let index = 0; index < CAP; index++) {
			const from = index % 2 === 0 ? "Alpha" : "Beta";
			registry.noteToolCall(from, tool);
			await bus.send({ from, to: from === "Alpha" ? "Beta" : "Alpha", body: String(index) });
		}
		registry.noteToolCall("Alpha", tool);
		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
	});

	/**
	 * Work resets the chain; it does not disable the cap. After one tool call the
	 * pair gets a fresh CAP of work-free messages and is refused after that, so a
	 * loop that once did work is still bounded.
	 */
	test("the chain counts again from zero after work", async () => {
		await pingPong(CAP);
		registry.noteToolCall("Beta", "bash");
		const afterWork = await pingPong(CAP);
		expect(afterWork.outcome).not.toBe("failed");

		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
	});

	/**
	 * A revive re-registers the agent's ref. Counts are keyed by id so the fresh
	 * ref does not read as work done, which would let a pair of sleepers loop
	 * forever by waking each other.
	 */
	test("re-registering an agent does not reset the chain", async () => {
		registry.noteToolCall("Beta", "read");
		await pingPong(CAP);
		register("Beta");
		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
	});

	/**
	 * A pair that is also reporting to a third agent is coordinating, not
	 * looping, and must never be cut off.
	 */
	test("a third agent in the middle resets the chain", async () => {
		await pingPong(CAP);
		await bus.send({ from: "Alpha", to: "Gamma", body: "status report" });

		const afterBreak = await bus.send({ from: "Beta", to: "Alpha", body: "still working" });
		expect(afterBreak.outcome).not.toBe("failed");
	});

	/**
	 * Counting strict alternation is evaded by one repeated send. Confinement to
	 * the pair closes it.
	 */
	test("a double send does not reset the pair's budget", async () => {
		for (let index = 0; index < CAP; index++) {
			const from = index % 3 === 0 ? "Alpha" : index % 2 === 0 ? "Alpha" : "Beta";
			await bus.send({ from, to: from === "Alpha" ? "Beta" : "Alpha", body: String(index) });
		}
		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
	});

	/** One agent talking past the cap with no work and no answer is the same runaway. */
	test("a one-directional runaway is bounded as well", async () => {
		for (let index = 0; index < CAP; index++) {
			await bus.send({ from: "Alpha", to: "Beta", body: `update ${index}` });
		}
		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "update final" });
		expect(overCap.outcome).toBe("failed");
	});

	/** The cap is per pair; a second pair does not inherit the first pair's chain. */
	test("the cap is scoped to the pair that looped", async () => {
		await pingPong(CAP);
		expect((await bus.send({ from: "Alpha", to: "Beta", body: "over" })).outcome).toBe("failed");

		const otherPair = await bus.send({ from: "Gamma", to: "Alpha", body: "unrelated" });
		expect(otherPair.outcome).not.toBe("failed");
	});

	/**
	 * The log is global and several agents run at once. Traffic that involves
	 * neither of the pair is skipped, not treated as a break, or concurrency
	 * would keep the chain from ever reaching the cap.
	 */
	test("unrelated traffic between two other agents does not reset the pair", async () => {
		for (let index = 0; index < CAP; index++) {
			const from = index % 2 === 0 ? "Alpha" : "Beta";
			await bus.send({ from, to: from === "Alpha" ? "Beta" : "Alpha", body: String(index) });
			await bus.send({ from: "Gamma", to: "Delta", body: `unrelated ${index}` });
			// Work by agents outside the pair is not the pair's work either.
			registry.noteToolCall("Gamma", "edit");
		}

		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
		expect(overCap.error).toContain(REFUSAL);
	});

	/** The other half of the same rule: one of the pair messaging outward still resets. */
	test("one of the pair messaging a third agent still resets the chain", async () => {
		await pingPong(CAP);
		await bus.send({ from: "Gamma", to: "Delta", body: "noise" });
		await bus.send({ from: "Beta", to: "Gamma", body: "status report" });

		const afterBreak = await bus.send({ from: "Alpha", to: "Beta", body: "still working" });
		expect(afterBreak.outcome).not.toBe("failed");
	});

	/** A refusal is a receipt, not an exception, so the sender's turn reads the advice. */
	test("refuses as a delivery receipt rather than throwing", async () => {
		await pingPong(CAP);
		const refused = await bus.send({ from: "Alpha", to: "Beta", body: "reply" });
		expect(refused.to).toBe("Beta");
		expect(refused.outcome).toBe("failed");
	});
});
