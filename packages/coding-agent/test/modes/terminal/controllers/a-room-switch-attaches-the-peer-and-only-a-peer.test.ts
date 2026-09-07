/**
 * WHY: the room strip is the sideways axis of one terminal, and a switch
 * through it is a full attach: `ctx.session` becomes the peer, every
 * session-derived surface is rebuilt, and the conversation left behind keeps
 * running under the background keeper. The class this closes is a switch that
 * lands somewhere other than a live room peer: a spawn, a stranger driver in
 * the same process, a killed peer, or the session already on screen.
 *
 * The controller runs against the real registry and the real keeper with a
 * fake context that records the attach order, so the assertions are about what
 * the screen ends up attached to and what the keeper holds, not about which
 * method was called.
 *
 * What it does NOT catch: the terminal repaint after the swap, and the
 * double-tap timing, which `input-controller-escape` covers for both arrows.
 */

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "bun:test";
import { stripVTControlCharacters } from "node:util";
import { RoomController } from "@veyyon/coding-agent/modes/terminal/controllers/room-controller";
import type { InteractiveModeContext } from "@veyyon/coding-agent/modes/terminal/types";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BackgroundSessions } from "@veyyon/coding-agent/session/background-sessions";
import { getThemeByName, setThemeInstance } from "@veyyon/coding-agent/theme/theme";

interface FakeSession {
	readonly id: string;
	isStreaming: boolean;
	getAgentId(): string;
	waitForIdle(): Promise<void>;
	sessionManager: {
		getSessionId(): string;
		getSessionName(): string | undefined;
		getCwd(): string;
		getSessionFile(): string;
		flush(): Promise<void>;
	};
}

function makeSession(id: string, options: { streaming?: boolean; cwd?: string; name?: string } = {}): FakeSession {
	// A streaming fake never settles, so the keeper holds it for the test.
	const idle: Promise<void> = options.streaming ? new Promise<void>(() => {}) : Promise.resolve();
	return {
		id,
		isStreaming: options.streaming ?? false,
		getAgentId: () => id,
		waitForIdle: () => idle,
		sessionManager: {
			getSessionId: () => id,
			getSessionName: () => options.name,
			getCwd: () => options.cwd ?? "/repo",
			getSessionFile: () => `/repo/.veyyon/${id}.jsonl`,
			async flush() {},
		},
	};
}

type Listener = (data: string) => { consume: true } | undefined;

interface Harness {
	controller: RoomController;
	registry: AgentRegistry;
	ctx: {
		session: FakeSession;
		focusedAgentId: string | undefined;
		createNextSession: ((options?: { room?: string }) => Promise<AgentSession>) | undefined;
	};
	/** Session ids handed to attachMainSession, in order. */
	attached: string[];
	/** Cwds handed to applyCwdChange, in order. */
	rerooted: string[];
	errors: string[];
	statuses: string[];
	peerCounts: number[];
	/** The strip's current text, VT stripped, or undefined while it is empty. */
	strip(): string | undefined;
	/** Register a driving agent, optionally in a room, with a live session object. */
	driver(id: string, room: string | undefined, session?: FakeSession): FakeSession;
	/** Send raw key bytes through the listener the controller installed. */
	key(data: string): { consume: true } | undefined;
}

function harness(): Harness {
	const registry = AgentRegistry.global();
	const attached: string[] = [];
	const rerooted: string[] = [];
	const errors: string[] = [];
	const statuses: string[] = [];
	const peerCounts: number[] = [];
	const listeners: Listener[] = [];
	const roomChildren: Array<{ render(width: number): string[] }> = [];
	const first = makeSession("main:a", { name: "alpha" });
	const ctx = {
		session: first,
		sessionManager: first.sessionManager,
		focusedAgentId: undefined as string | undefined,
		createNextSession: undefined as Harness["ctx"]["createNextSession"],
		attachMainSession(session: AgentSession) {
			const previous = ctx.session as unknown as AgentSession;
			attached.push((session as unknown as FakeSession).id);
			ctx.session = session as unknown as FakeSession;
			ctx.sessionManager = ctx.session.sessionManager;
			return BackgroundSessions.global().keep(previous);
		},
		applyCwdChange: async (cwd: string) => {
			rerooted.push(cwd);
		},
		unfocusSession: async () => {
			ctx.focusedAgentId = undefined;
		},
		clearTransientSessionUi: () => {},
		resetObserverRegistry: () => {},
		reloadTodos: async () => {},
		renderInitialMessages: () => {},
		updateEditorBorderColor: () => {},
		showError: (message: string) => {
			errors.push(message);
		},
		showStatus: (message: string) => {
			statuses.push(message);
		},
		statusLine: {
			setRoomPeerCount: (count: number) => {
				peerCounts.push(count);
			},
			invalidate: () => {},
			resetActiveTime: () => {},
		},
		roomContainer: {
			addChild(child: { render(width: number): string[] }) {
				roomChildren.push(child);
			},
			clear() {
				roomChildren.length = 0;
			},
		},
		ui: {
			terminal: { columns: 120 },
			requestRender: () => {},
			addInputListener(listener: Listener) {
				listeners.push(listener);
				return () => {
					const index = listeners.indexOf(listener);
					if (index >= 0) listeners.splice(index, 1);
				};
			},
		},
	};
	const controller = new RoomController(ctx as unknown as InteractiveModeContext, registry);
	return {
		controller,
		registry,
		ctx,
		attached,
		rerooted,
		errors,
		statuses,
		peerCounts,
		strip() {
			const child = roomChildren[0];
			if (!child) return undefined;
			return child
				.render(120)
				.map(line => stripVTControlCharacters(line))
				.join("\n");
		},
		driver(id, room, session = makeSession(id)) {
			registry.register({
				id,
				displayName: "main",
				kind: "main",
				session: session as unknown as AgentSession,
				sessionFile: session.sessionManager.getSessionFile(),
				scope: `scope-${id}`,
				room,
				status: "running",
			});
			return session;
		},
		key(data) {
			let result: { consume: true } | undefined;
			for (const listener of [...listeners]) {
				result = listener(data) ?? result;
			}
			return result;
		},
	};
}

/** Let the `void this.confirm()` behind Enter run its awaits. */
async function settle(): Promise<void> {
	for (let i = 0; i < 4; i++) await Promise.resolve();
}

beforeAll(async () => {
	const theme = await getThemeByName("dark");
	if (!theme) throw new Error("Expected dark theme");
	setThemeInstance(theme);
});

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
});

afterEach(async () => {
	AgentRegistry.resetGlobalForTests();
	// A zero-bound drain abandons the never-settling turns the tests park there.
	await BackgroundSessions.global().drain(0);
});

describe("switchTo", () => {
	it("attaches the screen to a room peer and hands the displayed session to the keeper", async () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		const peer = h.driver("main:b", "room:a");
		h.controller.install();

		await h.controller.switchTo("main:b");

		expect(h.attached).toEqual(["main:b"]);
		expect(h.ctx.session).toBe(peer);
		expect(h.errors).toEqual([]);
		expect(h.statuses.at(-1)).toContain("Switched to");
	});

	it("re-roots the terminal when the peer's cwd differs, and not otherwise", async () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:b", "room:a", makeSession("main:b", { cwd: "/elsewhere" }));
		h.driver("main:c", "room:a", makeSession("main:c", { cwd: "/repo" }));
		h.controller.install();

		await h.controller.switchTo("main:b");
		expect(h.rerooted).toEqual(["/elsewhere"]);
		await h.controller.switchTo("main:c");
		expect(h.rerooted).toEqual(["/elsewhere", "/repo"]);
		await h.controller.switchTo("main:a");
		// /repo → /repo: nothing to re-root.
		expect(h.rerooted).toEqual(["/elsewhere", "/repo"]);
	});

	/**
	 * A peer that is still answering was kept by the switch that left it. It is
	 * on screen again after this switch, so it must not stay counted as an
	 * off-screen conversation; the one just left must be.
	 */
	it("releases a streaming peer from the background set and keeps the one it left", async () => {
		const h = harness();
		const a = h.driver("main:a", "room:a", h.ctx.session);
		const b = h.driver("main:b", "room:a", makeSession("main:b", { streaming: true }));
		a.isStreaming = true;
		// `a` never settles either, so the keeper holds whichever is off screen.
		a.waitForIdle = () => new Promise<void>(() => {});
		h.controller.install();

		await h.controller.switchTo("main:b");
		expect(BackgroundSessions.global().kept.map(entry => entry.sessionId)).toEqual(["main:a"]);

		await h.controller.switchTo("main:a");
		expect(BackgroundSessions.global().kept.map(entry => entry.sessionId)).toEqual(["main:b"]);
		expect(h.ctx.session).toBe(a);
		expect(b.isStreaming).toBe(true);
	});

	it("leaves a focused spawn view before switching", async () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:b", "room:a");
		h.ctx.focusedAgentId = "Worker";
		h.controller.install();

		await h.controller.switchTo("main:b");

		expect(h.ctx.focusedAgentId).toBeUndefined();
		expect(h.attached).toEqual(["main:b"]);
	});

	/**
	 * Every way a target can fail to be a live room peer, and each is refused
	 * without touching the screen. Swept as a table so a new kind of stranger
	 * is added here rather than assumed.
	 */
	it("refuses everything that is not a live room peer, without attaching", async () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:other-room", "room:z");
		h.driver("main:no-room", undefined);
		h.driver("main:no-session", "room:a");
		const noSession = h.registry.get("main:no-session");
		if (noSession) noSession.session = null;
		h.driver("main:aborted", "room:a");
		h.registry.mirrorStatus("main:aborted", "aborted");
		h.registry.register({
			id: "Worker",
			displayName: "worker",
			kind: "sub",
			parentId: "main:a",
			session: makeSession("Worker") as unknown as AgentSession,
			status: "running",
		});
		h.controller.install();

		const refused: Record<string, string> = {};
		for (const id of [
			"main:a",
			"main:other-room",
			"main:no-room",
			"main:no-session",
			"main:aborted",
			"Worker",
			"ghost",
		]) {
			h.errors.length = 0;
			await h.controller.switchTo(id);
			refused[id] = h.errors[0] ?? "(no error)";
		}

		expect(h.attached).toEqual([]);
		const stranger = (id: string) => `"${id}" is not a peer of this conversation. Run /room to list the room.`;
		expect(refused).toEqual({
			// Already on screen: nothing to do and nothing to complain about.
			"main:a": "(no error)",
			"main:other-room": stranger("main:other-room"),
			"main:no-room": stranger("main:no-room"),
			"main:no-session": 'Peer "main:no-session" has no live session to switch to.',
			// Killed: dropped from the room's peer list, so a stranger from here on.
			"main:aborted": stranger("main:aborted"),
			Worker: stranger("Worker"),
			ghost: stranger("ghost"),
		});
	});
});

describe("openPeer", () => {
	it("opens a room on the displayed driver, builds the peer in it, and attaches to it", async () => {
		const h = harness();
		h.driver("main:a", undefined, h.ctx.session);
		const rooms: (string | undefined)[] = [];
		h.ctx.createNextSession = async options => {
			rooms.push(options?.room);
			return h.driver("main:b", options?.room) as unknown as AgentSession;
		};
		h.controller.install();

		await h.controller.openPeer();

		expect(rooms).toEqual(["room:main:a"]);
		expect(h.registry.isPeer("main:a", "main:b")).toBe(true);
		expect(h.attached).toEqual(["main:b"]);
		expect(h.ctx.session.id).toBe("main:b");
		expect(h.peerCounts.at(-1)).toBe(1);
	});

	it("says so when the host cannot open a second conversation", async () => {
		const h = harness();
		h.driver("main:a", undefined, h.ctx.session);
		h.controller.install();

		await h.controller.openPeer();

		expect(h.errors).toEqual(["This host cannot open a second conversation."]);
		expect(h.attached).toEqual([]);
	});
});

describe("the strip", () => {
	it("stays closed in a room of one and says how to open a peer", () => {
		const h = harness();
		h.driver("main:a", undefined, h.ctx.session);
		h.controller.install();

		h.controller.open();

		expect(h.controller.isOpen).toBe(false);
		expect(h.strip()).toBeUndefined();
		expect(h.statuses).toEqual(["No peer conversations — /room new opens one beside this"]);
	});

	it("opens with the cursor on the next peer, arrows move it, Enter switches, Esc closes", async () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:b", "room:a", makeSession("main:b", { name: "beta" }));
		h.driver("main:c", "room:a", makeSession("main:c", { name: "gamma" }));
		h.controller.install();

		h.controller.open();
		expect(h.controller.isOpen).toBe(true);
		const opened = h.strip() ?? "";
		for (const name of ["alpha", "beta", "gamma"]) expect(opened).toContain(name);
		// Enter straight away lands on the next peer: the cursor opened on it.
		expect(h.key("\r")).toEqual({ consume: true });
		await settle();
		expect(h.attached).toEqual(["main:b"]);
		expect(h.controller.isOpen).toBe(false);
		expect(h.strip()).toBeUndefined();

		// From `b` the strip opens on gamma: → wraps to alpha, → to beta (self),
		// ← back to alpha, ← wraps to gamma.
		h.controller.open();
		expect(h.key("\x1b[C")).toEqual({ consume: true });
		expect(h.key("\x1b[C")).toEqual({ consume: true });
		expect(h.key("\x1b[D")).toEqual({ consume: true });
		expect(h.key("\x1b[D")).toEqual({ consume: true });
		expect(h.key("\r")).toEqual({ consume: true });
		await settle();
		expect(h.attached).toEqual(["main:b", "main:c"]);

		h.controller.open();
		expect(h.key("\x1b")).toEqual({ consume: true });
		expect(h.controller.isOpen).toBe(false);
		expect(h.attached).toEqual(["main:b", "main:c"]);
	});

	it("closes and lets any other key through, so typing never has to dismiss it first", () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:b", "room:a");
		h.controller.install();

		h.controller.open();
		expect(h.key("x")).toBeUndefined();
		expect(h.controller.isOpen).toBe(false);
		// Closed: the arrows are the editor's again.
		expect(h.key("\x1b[C")).toBeUndefined();
	});

	it("redraws when a peer joins or leaves the registry, and collapses when the room empties", () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:b", "room:a", makeSession("main:b", { name: "beta" }));
		h.controller.install();
		h.controller.open();
		expect(h.strip()).not.toContain("gamma");

		h.driver("main:c", "room:a", makeSession("main:c", { name: "gamma" }));
		expect(h.strip()).toContain("gamma");

		h.registry.unregister("main:c");
		h.registry.unregister("main:b");
		expect(h.controller.isOpen).toBe(false);
		expect(h.strip()).toBeUndefined();
	});
});

describe("the status line count", () => {
	it("follows the registry: peers only, never spawns, never a stranger driver", () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.controller.install();
		expect(h.peerCounts.at(-1)).toBe(0);

		h.driver("main:b", "room:a");
		expect(h.peerCounts.at(-1)).toBe(1);
		h.driver("acp:c", undefined);
		h.registry.register({
			id: "Worker",
			displayName: "worker",
			kind: "sub",
			parentId: "main:a",
			session: null,
			status: "running",
		});
		expect(h.peerCounts.at(-1)).toBe(1);
		h.registry.unregister("main:b");
		expect(h.peerCounts.at(-1)).toBe(0);
	});
});

describe("/room arguments", () => {
	it("resolves an ordinal or an id to a member, and nothing else", () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:b", "room:a");
		h.controller.install();

		expect(h.controller.resolveArgument("1")).toBe("main:a");
		expect(h.controller.resolveArgument("2")).toBe("main:b");
		expect(h.controller.resolveArgument("main:b")).toBe("main:b");
		expect(h.controller.resolveArgument("3")).toBeUndefined();
		expect(h.controller.resolveArgument("0")).toBeUndefined();
		expect(h.controller.resolveArgument("2x")).toBeUndefined();
		expect(h.controller.resolveArgument("acp:z")).toBeUndefined();
	});

	it("describes the room with the displayed member starred", () => {
		const h = harness();
		h.driver("main:a", "room:a", h.ctx.session);
		h.driver("main:b", "room:a", makeSession("main:b", { name: "beta" }));
		h.controller.install();

		const text = h.controller.describe();
		expect(text.split("\n")[1]).toBe("* 1. alpha [running] main:a");
		expect(text.split("\n")[2]).toBe("  2. beta [running] main:b");
	});
});
