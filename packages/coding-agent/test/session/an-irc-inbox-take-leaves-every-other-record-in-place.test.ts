/**
 * WHY THIS EXISTS. The `irc` tool's `inbox` op answers from the records a streaming turn has not yet
 * taken, and takes them so the next step boundary does not deliver them a second time. A take that
 * drops a record it did not return loses a peer message; a take that reorders what it leaves delivers
 * the rest out of order; a take that returns an auto-reply or a malformed record hands the model a
 * message nobody sent it.
 *
 * WHAT IT PINS. `IrcInbox.takeIncoming` returns only well-formed `irc:incoming` records matching the
 * sender filter, interrupts before asides, stops at the limit, and leaves every other record in its
 * queue in arrival order for the next `takeAll`.
 *
 * WHAT IT DOES NOT CATCH. When the session queues a record, or which boundary takes it: those are
 * `AgentSession.deliverIrcMessage` and the aside provider, covered by `test/tools/irc.test.ts`.
 */
import { describe, expect, it } from "bun:test";
import type { CustomMessage } from "@veyyon/coding-agent/session/messages";
import { IrcInbox } from "@veyyon/coding-agent/session/runtime/irc-inbox";

function incoming(id: string, from: string, message: string, replyTo?: string): CustomMessage {
	return {
		role: "custom",
		customType: "irc:incoming",
		content: `[IRC ${from}] ${message}`,
		display: true,
		details: { id, from, message, ...(replyTo ? { replyTo } : {}) },
		attribution: "agent",
		timestamp: Number(id.slice(1)),
	};
}

function autoReply(to: string, body: string): CustomMessage {
	return {
		role: "custom",
		customType: "irc:autoreply",
		content: `[IRC you → ${to} (auto)] ${body}`,
		display: true,
		details: { to, body },
		attribution: "agent",
		timestamp: 0,
	};
}

describe("an IRC inbox take", () => {
	it("returns the matching sender's messages addressed to the caller and keeps the rest in order", () => {
		const inbox = new IrcInbox();
		const fromA1 = incoming("m1", "A", "first", "m0");
		const fromB = incoming("m2", "B", "second");
		const fromA2 = incoming("m3", "A", "third");
		const reply = autoReply("C", "said for us");
		inbox.queueInterrupt(fromA1);
		inbox.queueInterrupt(fromB);
		inbox.queueAside(reply);
		inbox.queueAside(fromA2);

		expect(inbox.takeIncoming("Main", { from: "A" })).toEqual([
			{ id: "m1", from: "A", to: "Main", body: "first", ts: 1, replyTo: "m0" },
			{ id: "m3", from: "A", to: "Main", body: "third", ts: 3 },
		]);
		expect(inbox.hasInterrupts).toBe(true);
		expect(inbox.takeAll()).toEqual([fromB, reply]);
		expect(inbox.isEmpty).toBe(true);
	});

	it("stops at the limit, taking interrupts before asides", () => {
		const inbox = new IrcInbox();
		const aside = incoming("m1", "A", "queued as an aside");
		const interrupt1 = incoming("m2", "B", "first interrupt");
		const interrupt2 = incoming("m3", "C", "second interrupt");
		inbox.queueAside(aside);
		inbox.queueInterrupt(interrupt1);
		inbox.queueInterrupt(interrupt2);

		expect(inbox.takeIncoming("Main", { limit: 2 }).map(message => message.id)).toEqual(["m2", "m3"]);
		expect(inbox.hasInterrupts).toBe(false);
		expect(inbox.takeAll()).toEqual([aside]);
	});

	it("never takes a record of another type or an incoming record whose details are not a message", () => {
		const inbox = new IrcInbox();
		const reply = autoReply("A", "said for us");
		// Details shaped like a peer message, so only the record's type keeps it out of the take.
		const otherType: CustomMessage = { ...incoming("m3", "A", "x"), customType: "irc:autoreply" };
		const noDetails: CustomMessage = { ...incoming("m1", "A", "x"), details: undefined };
		const numericId: CustomMessage = { ...incoming("m2", "A", "x"), details: { id: 2, from: "A", message: "x" } };
		inbox.queueInterrupt(noDetails);
		inbox.queueInterrupt(otherType);
		inbox.queueAside(reply);
		inbox.queueAside(numericId);

		expect(inbox.takeIncoming("Main")).toEqual([]);
		expect(inbox.takeAll()).toEqual([noDetails, otherType, reply, numericId]);
	});
});
