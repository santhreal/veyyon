/**
 * A peer running off screen is counted once.
 *
 * WHY THIS SUITE EXISTS. Two status chips count conversations the operator is
 * not looking at: `room` counts the peers beside the one on screen (and how
 * many are working), and `bg` counts sessions `BackgroundSessions` is holding
 * while their turn finishes. A room peer that leaves the screen mid-turn is
 * held there like a `/new` hand-off, so feeding `bg` the keeper's size put the
 * same turn on the status line twice: "2 bg · 2 peers · 2 working".
 * `RoomController.unwatchedOutsideRoom()` is what the interactive mode feeds
 * `bg` from instead.
 *
 * THE CLASS CLOSED. Every kind of held session is swept: a peer of the room on
 * screen (not counted; the room chip has it), a `/new` hand-off in no room and
 * a peer of a different room (both counted: nothing else shows them), and a
 * registry row in the room with no session yet (it holds nothing and changes
 * nothing). The room is the one on screen, so moving the screen moves the
 * line, and releasing a held session drops it from the count.
 *
 * Real `BackgroundSessions` and a real `AgentRegistry`. The sessions are
 * identities whose turn never settles, because the count reads only which
 * session is held and which rows the registry lists, and a real turn would
 * settle and leave the keeper before it could be counted.
 *
 * NOT CAUGHT. That the interactive mode re-reads the count on every keeper
 * event (it subscribes in its constructor, which needs the whole terminal).
 */

import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import {
	RoomController,
	type RoomControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/room-controller";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";

let registry: AgentRegistry;
const finishers: Array<() => void> = [];

/** The process keeper the interactive mode reads; a singleton, so every test starts and ends with it empty. */
const keeper = BackgroundSessions.global();

function releaseEverything(): void {
	for (const entry of keeper.kept) keeper.release(entry.session);
}

beforeEach(() => {
	// The keeper is a process singleton: start from nothing held.
	releaseEverything();
	registry = new AgentRegistry();
});

afterEach(() => {
	releaseEverything();
	for (const finish of finishers.splice(0)) finish();
});

/** A driving session registered as `id`, in `room` when given, whose turn is still running. */
function driver(id: string, room?: string): AgentSession {
	const turn = Promise.withResolvers<void>();
	finishers.push(turn.resolve);
	const session = {
		getAgentId: () => id,
		waitForIdle: () => turn.promise,
		sessionManager: {
			getSessionId: () => id,
			getSessionFile: () => `/repo/.veyyon/${id}.jsonl`,
			flush: async () => {},
		},
	} as unknown as AgentSession;
	registry.register({ id, displayName: "main", kind: "main", session, room, status: "running" });
	return session;
}

/** A room controller whose screen shows `onScreen`; the count reads nothing else of the context. */
function controllerShowing(onScreen: AgentSession): { room: RoomController; show(session: AgentSession): void } {
	const ctx = { session: onScreen } as unknown as RoomControllerContext;
	return {
		room: new RoomController(ctx, registry),
		show: session => {
			ctx.session = session;
		},
	};
}

describe("unwatchedOutsideRoom", () => {
	it("counts a hand-off in no room and not the peer the room chip already counts", () => {
		const a = driver("main:a");
		const room = registry.ensureRoom("main:a");
		const b = driver("main:b", room);
		const c = driver("main:c");
		const { room: controller } = controllerShowing(a);

		keeper.keep(b);
		keeper.keep(c);
		expect(keeper.size).toBe(2);
		expect(controller.unwatchedOutsideRoom()).toBe(1);

		keeper.release(b);
		expect(controller.unwatchedOutsideRoom()).toBe(1);
		keeper.release(c);
		expect(controller.unwatchedOutsideRoom()).toBe(0);
	});

	it("counts a peer of a different room: nothing on this screen shows it", () => {
		const a = driver("main:a");
		const b = driver("main:b", registry.ensureRoom("main:a"));
		driver("main:d");
		const e = driver("main:e", registry.ensureRoom("main:d"));
		const { room: controller } = controllerShowing(a);

		keeper.keep(b);
		keeper.keep(e);
		expect(controller.unwatchedOutsideRoom()).toBe(1);
	});

	/**
	 * The registry lists a driver before its session attaches; that row holds
	 * nothing and must neither add to the count nor hide a held session.
	 */
	it("a row in the room with no session yet changes nothing", () => {
		const a = driver("main:a");
		const room = registry.ensureRoom("main:a");
		const b = driver("main:b", room);
		const c = driver("main:c");
		const { room: controller } = controllerShowing(a);
		keeper.keep(b);
		keeper.keep(c);
		const before = controller.unwatchedOutsideRoom();
		registry.register({
			id: "main:pending",
			displayName: "main",
			kind: "main",
			session: null,
			room,
			status: "running",
		});
		expect(controller.unwatchedOutsideRoom()).toBe(before);
		expect(before).toBe(1);
	});

	/**
	 * "The room" is the room of the conversation on screen. With the hand-off
	 * on screen, both room members are outside its room of one, and the room
	 * chip no longer shows them.
	 */
	it("follows the conversation on screen", () => {
		const a = driver("main:a");
		const b = driver("main:b", registry.ensureRoom("main:a"));
		const c = driver("main:c");
		const { room: controller, show } = controllerShowing(a);
		keeper.keep(b);
		keeper.keep(c);
		expect(controller.unwatchedOutsideRoom()).toBe(1);

		// The hand-off comes back on screen: it leaves the keeper and the one it replaced enters it.
		keeper.release(c);
		keeper.keep(a);
		show(c);
		expect(controller.unwatchedOutsideRoom()).toBe(2);
	});
});
