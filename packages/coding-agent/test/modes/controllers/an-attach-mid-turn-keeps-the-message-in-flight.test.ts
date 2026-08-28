/**
 * WHY: two features re-point the transcript at a session that may already be
 * streaming — viewing a subagent, and `/new` / `/resume` swapping the session
 * the composer displays. Both land after the in-flight assistant message's
 * `message_start` has already been emitted, so without a synthesized start the
 * accumulating `message_update` deltas have no anchor and the answer renders
 * nowhere.
 *
 * The guard used to live inline in `SessionFocusController`, which has no test
 * coverage. It now has one owner, `EventController.attachTo`, and this suite is
 * that owner's contract: every re-pointing caller inherits it.
 *
 * What it does NOT catch: whether the transcript component chosen for the
 * synthesized start is the same one the real start would have produced.
 */

import { describe, expect, it } from "bun:test";
import {
	EventController,
	type EventControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/event-controller";
import type { AgentSession, AgentSessionEvent } from "@veyyon/coding-agent/session/agent-session";

interface Attached {
	controller: EventController;
	ctx: { unsubscribe?: () => void };
	seen: AgentSessionEvent[];
	emit(event: AgentSessionEvent): Promise<void>;
	unsubscribeCalls: () => number;
}

function attach(): Attached {
	const ctx = { session: undefined } as unknown as EventControllerContext;
	const controller = new EventController(ctx);
	const seen: AgentSessionEvent[] = [];
	controller.handleEvent = async (event: AgentSessionEvent) => {
		seen.push(event);
	};
	let listener: ((event: AgentSessionEvent) => Promise<void>) | undefined;
	let unsubscribed = 0;
	const target = {
		subscribe: (fn: (event: AgentSessionEvent) => Promise<void>) => {
			listener = fn;
			return () => {
				unsubscribed++;
			};
		},
	} as unknown as AgentSession;
	controller.attachTo(target);
	return {
		controller,
		ctx: ctx as { unsubscribe?: () => void },
		seen,
		emit: async event => {
			if (!listener) throw new Error("attachTo did not subscribe");
			await listener(event);
		},
		unsubscribeCalls: () => unsubscribed,
	};
}

function assistantUpdate(text: string): AgentSessionEvent {
	return { type: "message_update", message: { role: "assistant", content: text } } as unknown as AgentSessionEvent;
}

function assistantStart(text: string): AgentSessionEvent {
	return { type: "message_start", message: { role: "assistant", content: text } } as unknown as AgentSessionEvent;
}

describe("attaching to a session mid-turn", () => {
	it("synthesizes the start the attach arrived too late for", async () => {
		const a = attach();

		await a.emit(assistantUpdate("half an answ"));

		expect(a.seen.map(event => event.type)).toEqual(["message_start", "message_update"]);
	});

	it("synthesizes it once, not on every delta", async () => {
		const a = attach();

		await a.emit(assistantUpdate("half"));
		await a.emit(assistantUpdate("half an answer"));

		expect(a.seen.map(event => event.type)).toEqual(["message_start", "message_update", "message_update"]);
	});

	it("stays out of the way when the turn starts after the attach", async () => {
		const a = attach();

		await a.emit(assistantStart(""));
		await a.emit(assistantUpdate("an answer"));

		expect(a.seen.map(event => event.type)).toEqual(["message_start", "message_update"]);
	});

	it("does not invent an assistant message for another role's update", async () => {
		const a = attach();

		await a.emit({
			type: "message_update",
			message: { role: "user", content: "hi" },
		} as unknown as AgentSessionEvent);

		expect(a.seen.map(event => event.type)).toEqual(["message_update"]);
	});

	it("publishes the unsubscriber, which is what a session swap tears down", () => {
		const a = attach();

		expect(typeof a.ctx.unsubscribe).toBe("function");
		a.ctx.unsubscribe?.();

		expect(a.unsubscribeCalls()).toBe(1);
	});
});
