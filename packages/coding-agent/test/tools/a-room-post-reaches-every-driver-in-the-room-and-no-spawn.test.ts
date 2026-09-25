/**
 * `irc send to:"#room"`, `/room say` and the channel behind them.
 *
 * WHY IT EXISTS. `#room` is the one irc address that reaches across
 * conversations, and it reaches several at once. The defect class closed here
 * is a post that reaches the wrong set: past the room (a spawn, a driver in
 * another room, a driver in no room), short of it (a member it skipped), or
 * from a sender that has no business posting (a spawn, whose news goes to its
 * parent). Around that: a name that wakes the wrong conversation, a run of
 * wakes with no end, a backlog that repeats or drops a line, and seat numbers
 * that disagree with the ones the room view shows.
 *
 * The fixture holds one agent of every kind the registry has and every place a
 * driver can sit (in the room, in another room, in none), and a new kind fails
 * the sweep until it is placed. Every expected set is derived from the
 * registry's own room rule, never restated, and pinned by exact equality.
 *
 * What it does not catch: what a conversation does with a line it is handed
 * (`session/a-room-line-starts-a-turn-only-where-it-names`), or how the line
 * draws.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentLifecycleManager } from "@veyyon/coding-agent/registry/agent-lifecycle";
import { AGENT_KINDS, type AgentKind, AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import {
	IrcBus,
	type IrcRoomDelivery,
	type IrcRoomLine,
	ROOM_CHANNEL,
	ROOM_WAKE_CAP,
	roomMentions,
} from "@veyyon/coding-agent/task/irc-bus";
import type { ToolSession } from "@veyyon/coding-agent/tools";
import { type IrcDetails, IrcTool } from "@veyyon/coding-agent/tools/agent/irc";
import { makeToolSession } from "../helpers/tool-session";

/** Lines kept for a conversation that joins later; the channel's own cap. */
const BACKLOG = 20;

interface Delivery {
	readonly to: string;
	readonly lines: readonly IrcRoomLine[];
	readonly named: boolean;
	readonly wake: boolean;
	readonly backlog: boolean;
}

/** Every line handed to a conversation, in order. Cleared in place: the sessions hold it. */
const deliveries: Delivery[] = [];
/** Conversations mid-turn; the rest are idle. */
const working = new Set<string>();
/** Conversations whose delivery throws, as a disposed session's does. */
const broken = new Set<string>();

function fakeSession(id: string, name?: string): AgentSession {
	return {
		sessionManager: { getSessionName: () => name },
		deliverRoomLines: (
			lines: readonly IrcRoomLine[],
			opts: { named: boolean; wake: boolean; backlog?: boolean },
		): IrcRoomDelivery => {
			if (broken.has(id)) throw new Error("Recipient session is disposed.");
			deliveries.push({
				to: id,
				lines: [...lines],
				named: opts.named,
				wake: opts.wake,
				backlog: opts.backlog === true,
			});
			if (working.has(id)) return "working";
			return opts.wake ? "woken" : "idle";
		},
	} as unknown as AgentSession;
}

function toolFor(agentId: string): IrcTool {
	const session: ToolSession = makeToolSession({
		cwd: "/repo",
		hasUI: false,
		getSessionFile: () => null,
		getSessionSpawns: () => "*",
		settings: Settings.isolated(),
		agentRegistry: AgentRegistry.global(),
		getAgentId: () => agentId,
	});
	return new IrcTool(session);
}

async function post(agentId: string, params: Partial<Parameters<IrcTool["execute"]>[1]> = {}) {
	const result = await toolFor(agentId).execute("call", {
		op: "send",
		to: ROOM_CHANNEL,
		message: "ping",
		...params,
	});
	const text = result.content.find(part => part.type === "text")?.text ?? "";
	return { text, isError: result.isError === true, details: result.details as IrcDetails };
}

let registry: AgentRegistry;
let bus: IrcBus;
let roomOne: string;

function register(
	id: string,
	kind: AgentKind,
	options: { parentId?: string; room?: string; name?: string; seated?: boolean } = {},
): void {
	registry.register({
		id,
		displayName: id,
		kind,
		parentId: options.parentId,
		session: options.seated === false ? null : fakeSession(id, options.name),
		scope: kind === "main" ? `scope-${id}` : undefined,
		room: options.room,
		status: "running",
	});
}

beforeEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
	registry = AgentRegistry.global();
	bus = IrcBus.global();
	deliveries.length = 0;
	working.clear();
	broken.clear();
	// Room one: three drivers side by side, the first two named, each with spawns.
	register("main:a", "main", { name: "refactor auth" });
	roomOne = registry.ensureRoom("main:a")!;
	register("main:b", "main", { room: roomOne, name: "parser whitespace" });
	register("main:c", "main", { room: roomOne });
	register("Scout-A", "sub", { parentId: "main:a" });
	register("Deep-A", "sub", { parentId: "Scout-A" });
	register("Scout-B", "sub", { parentId: "main:b" });
	register("Advisor-A", "advisor", { parentId: "main:a" });
	// Room two, in the same process: another terminal's pair.
	register("main:x", "main");
	const roomTwo = registry.ensureRoom("main:x")!;
	register("main:y", "main", { room: roomTwo });
	// A driver in no room: an ACP session.
	register("acp:z", "main");
});

afterEach(() => {
	AgentRegistry.resetGlobalForTests();
	AgentLifecycleManager.resetGlobalForTests();
	IrcBus.resetGlobalForTests();
});

describe("Who a post reaches", () => {
	test("the fixture holds every agent kind, so a new kind is placed before this sweep passes", () => {
		expect([...new Set(registry.list().map(ref => ref.kind))].sort()).toEqual([...AGENT_KINDS].sort());
	});

	/**
	 * The invariant at the choke point: for every agent in the process, a post
	 * reaches exactly the other seated drivers of its room when it is a driver
	 * in a room, and reaches nobody otherwise.
	 */
	test("for every agent: a driver in a room reaches its room's other seats; anyone else reaches nobody", async () => {
		const refused: string[] = [];
		for (const ref of registry.list()) {
			deliveries.length = 0;
			const { isError } = await post(ref.id, { message: `from ${ref.id}` });
			const expected =
				ref.kind === "main" && ref.room !== undefined
					? registry
							.roomSeats(ref.id)
							.map(seat => seat.id)
							.filter(id => id !== ref.id)
					: [];
			expect(deliveries.map(delivery => delivery.to)).toEqual(expected);
			if (isError) refused.push(ref.id);
		}
		expect(refused.sort()).toEqual(["Advisor-A", "Deep-A", "Scout-A", "Scout-B", "acp:z"]);
	});

	test("a spawn is refused with its own parent to report to, at every depth", async () => {
		for (const [spawn, parent] of [
			["Scout-A", "main:a"],
			["Deep-A", "Scout-A"],
			["Scout-B", "main:b"],
		] as const) {
			const { text, isError } = await post(spawn);
			expect(isError).toBe(true);
			expect(text).toContain(`Report to your parent \`${parent}\` instead`);
		}
		expect(deliveries).toEqual([]);
	});

	test("a driver in no room is told the room does not exist yet", async () => {
		const { text, isError } = await post("acp:z");
		expect(isError).toBe(true);
		expect(text).toContain(`This conversation is in no room, so ${ROOM_CHANNEL} reaches nobody.`);
	});

	test("the operator's post reaches every seat, the conversation on screen included, as `you`", () => {
		const result = bus.postToRoom({ member: "main:b", byOperator: true, body: "freeze main" });
		expect(result.posted).toBe(true);
		expect(deliveries.map(delivery => delivery.to)).toEqual(["main:a", "main:b", "main:c"]);
		expect(deliveries[0]!.lines[0]).toMatchObject({ label: "you", body: "freeze main" });
		expect(deliveries[0]!.lines[0]!.from).toBeUndefined();
	});

	test("a member still being built holds no seat and takes no line; the seats after it keep their numbers", async () => {
		register("main:d", "main", { room: roomOne, seated: false });
		const { details } = await post("main:c");
		expect(details.room?.map(receipt => [receipt.to, receipt.label])).toEqual([
			["main:a", "1 · refactor auth"],
			["main:b", "2 · parser whitespace"],
		]);
		expect(deliveries[0]!.lines[0]!.label).toBe("conversation 3");
	});

	test("a member whose delivery fails is reported; the rest still get the line", async () => {
		broken.add("main:b");
		const { text, isError, details } = await post("main:a");
		expect(isError).toBe(false);
		expect(details.room?.map(receipt => receipt.outcome)).toEqual(["failed", "idle"]);
		expect(text).toContain("- 2 · parser whitespace (main:b): failed — Recipient session is disposed.");
		expect(deliveries.map(delivery => delivery.to)).toEqual(["main:c"]);

		broken.add("main:c");
		expect((await post("main:a")).isError).toBe(true);
	});

	test("`await` and `replyTo` are refused before anything is delivered", async () => {
		expect((await post("main:a", { await: true })).isError).toBe(true);
		expect((await post("main:a", { replyTo: "123" })).isError).toBe(true);
		expect(deliveries).toEqual([]);
	});
});

describe("Who a post names, and who it wakes", () => {
	test("`@<seat>` and `@<id>` name exactly those members; an address or a longer number names nobody", async () => {
		await post("main:a", { message: "@2: and @main:c, mail a@1.dev or seat @23" });
		expect(deliveries.map(delivery => [delivery.to, delivery.named, delivery.wake])).toEqual([
			["main:b", true, true],
			["main:c", true, true],
		]);
		deliveries.length = 0;
		await post("main:a", { message: "nobody here: a@2 x@main:b" });
		expect(deliveries.map(delivery => delivery.named)).toEqual([false, false]);
	});

	test("mention tokens end on a word character and start after a non-word one", () => {
		expect([...roomMentions("(@2), @3. @4: @main:b-1, a@5 @@6")].sort()).toEqual(["2", "3", "4", "main:b-1"]);
	});

	test("the receipt says when each conversation reads the post", async () => {
		working.add("main:b");
		const { text } = await post("main:a", { message: "@3 heads up" });
		expect(text).toContain("- 2 · parser whitespace (main:b): working; reads it at its next step");
		expect(text).toContain("- conversation 3 (main:c): woken by it");
		deliveries.length = 0;
		const quiet = await post("main:a", { message: "no names" });
		expect(quiet.text).toContain("- conversation 3 (main:c): idle; reads it at its next turn");
	});

	/**
	 * The loop bound: agent posts that wake a conversation stop waking one at
	 * the cap, keep reaching everyone, and wake again only after the operator
	 * posts. Asserted past the cap too, so a counter that wraps is caught.
	 */
	test(`after ${ROOM_WAKE_CAP} agent posts that woke someone, a name no longer wakes until the operator posts`, async () => {
		// Posts that wake nobody do not count toward the run.
		for (let i = 0; i < ROOM_WAKE_CAP + 3; i++) await post("main:a", { message: "no names" });
		for (let i = 0; i < ROOM_WAKE_CAP; i++) {
			deliveries.length = 0;
			await post(i % 2 === 0 ? "main:a" : "main:c", { message: "@2 again" });
			expect(deliveries.find(delivery => delivery.to === "main:b")?.wake).toBe(true);
		}
		for (let i = 0; i < 3; i++) {
			deliveries.length = 0;
			const held = await post("main:a", { message: "@2 once more" });
			const toB = deliveries.find(delivery => delivery.to === "main:b");
			expect(toB?.named).toBe(true);
			expect(toB?.wake).toBe(false);
			expect(held.text).toContain(`${ROOM_WAKE_CAP} posts in a row have woken one without the operator posting`);
		}
		bus.postToRoom({ member: "main:a", byOperator: true, body: "carry on" });
		deliveries.length = 0;
		await post("main:a", { message: "@2 now" });
		expect(deliveries.find(delivery => delivery.to === "main:b")?.wake).toBe(true);
	});

	test("the operator's names always wake, past the cap", async () => {
		for (let i = 0; i < ROOM_WAKE_CAP; i++) await post("main:a", { message: "@2 again" });
		deliveries.length = 0;
		bus.postToRoom({ member: "main:a", byOperator: true, body: "@2 @3 stop and read this" });
		expect(deliveries.map(delivery => [delivery.to, delivery.wake])).toEqual([
			["main:a", false],
			["main:b", true],
			["main:c", true],
		]);
	});
});

describe("A conversation that joins later", () => {
	test(`reads the newest ${BACKLOG} lines it missed, once, as one backlog`, async () => {
		for (let i = 1; i <= BACKLOG + 5; i++) await post("main:a", { message: `line ${i}` });
		register("main:d", "main", { room: roomOne });
		deliveries.length = 0;

		expect(bus.joinRoom("main:d")).toBe(BACKLOG);
		expect(deliveries).toHaveLength(1);
		const [backlog] = deliveries;
		expect(backlog).toMatchObject({ to: "main:d", named: false, wake: false, backlog: true });
		expect(backlog!.lines.map(line => line.body)).toEqual(
			Array.from({ length: BACKLOG }, (_, index) => `line ${index + 6}`),
		);
		expect(bus.joinRoom("main:d")).toBe(0);
	});

	test("the lines posted after its seat was taken reached it live and are not given again", async () => {
		await post("main:a", { message: "before" });
		register("main:d", "main", { room: roomOne });
		await post("main:a", { message: "after one" });
		await post("main:c", { message: "after two" });
		deliveries.length = 0;

		expect(bus.joinRoom("main:d")).toBe(1);
		expect(deliveries[0]!.lines.map(line => line.body)).toEqual(["before"]);
	});

	test("a room that said nothing gives nothing, and another room's lines never arrive", async () => {
		await post("main:x", { message: "room two only" });
		register("main:d", "main", { room: roomOne });
		deliveries.length = 0;
		expect(bus.joinRoom("main:d")).toBe(0);
		expect(deliveries).toEqual([]);
	});
});

describe("What `irc list` says about the channel", () => {
	test("a driver in a room is shown every seat by number and id, itself marked", async () => {
		const result = await toolFor("main:b").execute("call", { op: "list" });
		const text = result.content.find(part => part.type === "text")?.text ?? "";
		expect(text).toContain(
			`${ROOM_CHANNEL}: 1 · refactor auth (main:a); 2 · parser whitespace (main:b, you); conversation 3 (main:c).`,
		);
		expect((result.details as IrcDetails).seats?.map(seat => seat.id)).toEqual(
			registry.roomSeats("main:b").map(seat => seat.id),
		);
	});

	test("a spawn and a driver in no room are not shown the channel", async () => {
		for (const id of ["Scout-A", "acp:z"]) {
			const result = await toolFor(id).execute("call", { op: "list" });
			expect(result.content.find(part => part.type === "text")?.text ?? "").not.toContain(ROOM_CHANNEL);
			expect((result.details as IrcDetails).seats).toBeUndefined();
		}
	});
});

describe("What the room view reads", () => {
	test("the newest line of a member's own room, and a listener told which room each line is in", async () => {
		const heard: Array<[string, string]> = [];
		const stop = bus.onRoomLine((room, line) => heard.push([room, line.body]));
		await post("main:a", { message: "one" });
		await post("main:x", { message: "two" });
		stop();
		await post("main:a", { message: "three" });

		expect(heard).toEqual([
			[roomOne, "one"],
			[registry.get("main:x")!.room!, "two"],
		]);
		expect(bus.latestRoomLine("main:c")?.body).toBe("three");
		expect(bus.latestRoomLine("main:y")?.body).toBe("two");
		expect(bus.latestRoomLine("acp:z")).toBeUndefined();
		expect(bus.latestRoomLine("Scout-A")).toBeUndefined();
	});
});
