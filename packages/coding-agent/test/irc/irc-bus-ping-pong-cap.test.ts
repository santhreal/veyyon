/**
 * The bus refuses to carry a closed two-agent loop past a bounded number of
 * turns.
 *
 * WHY IT EXISTS. Two subagents that answer each other and nothing else cannot
 * stop on their own. Every inbound message wakes the recipient, a wake is
 * indistinguishable from progress, and neither agent can see the pattern
 * because each one only ever sees the single message in front of it. Nothing
 * else bounded it: an irc wake is not a job, so no job budget applies, and the
 * per-run soft request budget resets because a woken agent keeps re-entering.
 * The observed failure is a pair trading turns until the process is killed.
 *
 * The bus is the only participant that watches both halves, so the bound lives
 * here. What is pinned below is the whole contract: the cap fires on a genuinely
 * closed loop, it does NOT fire on a pair that is also talking to anyone else,
 * it does not fire on one agent sending repeatedly in one direction, the
 * refusal is a delivery failure rather than a throw, and a third party breaking
 * in resets the pair's budget.
 */
import { beforeEach, describe, expect, test } from "bun:test";
import { IrcBus } from "@veyyon/coding-agent/irc/bus";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";

/** Accepts every hand-off, so delivery succeeds and only the cap can refuse. */
function receivingSession(): AgentSession {
	return {
		deliverIrcMessage: async () => {},
		emitIrcRelayObservation: () => {},
	} as unknown as AgentSession;
}

/** Mirrors PING_PONG_CAP in src/irc/bus.ts. */
const CAP = 16;

let bus: IrcBus;

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	bus = IrcBus.global();
	const registry = AgentRegistry.global();
	for (const id of ["Alpha", "Beta", "Gamma"]) {
		registry.register({
			id,
			displayName: "reviewer",
			kind: "sub",
			session: receivingSession(),
			status: "running",
		});
	}
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

describe("IRC ping-pong cap", () => {
	/**
	 * The bound itself. The message AT the cap still lands, so the number is the
	 * count of exchanges allowed and not one less; the next one is refused.
	 */
	test("delivers up to the cap and refuses the message that would exceed it", async () => {
		const atCap = await pingPong(CAP);
		expect(atCap.outcome).not.toBe("failed");

		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
		expect(overCap.error).toContain(`${CAP} messages in a row`);
	});

	/**
	 * The refusal has to tell the agent what to do instead, because an agent
	 * that only learns "failed" retries. Both exits are named: decide it
	 * yourself, or escalate to the spawner.
	 */
	test("names both ways out of the loop in the refusal", async () => {
		await pingPong(CAP);
		const refused = await bus.send({ from: "Alpha", to: "Beta", body: "again" });
		expect(refused.error).toContain("Stop messaging that agent");
		expect(refused.error).toContain("report to whoever spawned you");
	});

	/**
	 * The false-positive guard, and the reason the chain is counted from the log
	 * rather than from a per-pair counter. A pair that is also reporting to a
	 * third agent is coordinating, not looping, and must never be cut off.
	 */
	test("a third agent in the middle resets the chain", async () => {
		await pingPong(CAP);
		await bus.send({ from: "Alpha", to: "Gamma", body: "status report" });

		const afterBreak = await bus.send({ from: "Beta", to: "Alpha", body: "still working" });
		expect(afterBreak.outcome).not.toBe("failed");
	});

	/**
	 * The evasion this bound was hardened against. An earlier version counted
	 * strict alternation, which one repeated send resets to nothing: a pair that
	 * mostly alternates and occasionally doubles up never accumulates and never
	 * trips the cap, while looping exactly as hard. Confinement to the pair is
	 * what closes it.
	 */
	test("a double send does not reset the pair's budget", async () => {
		for (let index = 0; index < CAP; index++) {
			// Every third message repeats the previous sender, breaking alternation
			// without involving anyone else.
			const from = index % 3 === 0 ? "Alpha" : index % 2 === 0 ? "Alpha" : "Beta";
			await bus.send({ from, to: from === "Alpha" ? "Beta" : "Alpha", body: String(index) });
		}
		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "one too many" });
		expect(overCap.outcome).toBe("failed");
	});

	/**
	 * One agent talking past the cap with nobody answering and nobody else
	 * involved is the same runaway with one side mute, so it is bounded too.
	 */
	test("a one-directional runaway is bounded as well", async () => {
		for (let index = 0; index < CAP; index++) {
			await bus.send({ from: "Alpha", to: "Beta", body: `update ${index}` });
		}
		const overCap = await bus.send({ from: "Alpha", to: "Beta", body: "update final" });
		expect(overCap.outcome).toBe("failed");
	});

	/**
	 * The cap is per pair. A second pair sharing the process must not inherit
	 * the first pair's exhausted budget, which a global counter would do.
	 */
	test("the cap is scoped to the pair that looped", async () => {
		await pingPong(CAP);
		expect((await bus.send({ from: "Alpha", to: "Beta", body: "over" })).outcome).toBe("failed");

		const otherPair = await bus.send({ from: "Gamma", to: "Alpha", body: "unrelated" });
		expect(otherPair.outcome).not.toBe("failed");
	});

	/**
	 * A refusal is a receipt, not an exception. The sender's turn continues and
	 * reads the error, which is what lets it act on the advice; a throw would
	 * unwind the tool call instead.
	 */
	test("refuses as a delivery receipt rather than throwing", async () => {
		await pingPong(CAP);
		const refused = await bus.send({ from: "Alpha", to: "Beta", body: "reply" });
		expect(refused.to).toBe("Beta");
		expect(refused.outcome).toBe("failed");
	});
});
