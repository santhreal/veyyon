/**
 * `/room say`: the operator's post to the room's `#room` channel.
 *
 * WHY THIS SUITE EXISTS. The operator is the one member of the room that is not
 * a conversation, and `/room say` is how they tell every conversation one thing
 * at once. The defect class closed here is a post that misses a conversation
 * (the one on screen, or one of the others), one that goes out empty, one that
 * claims to have reached a conversation it did not, and a command line whose
 * `say` is mistaken for a conversation number or id, or the reverse.
 *
 * A real `AgentRegistry`, a real `IrcBus` bound to it, and conversations that
 * record the lines they are handed. The command is driven through the `/room`
 * handler the terminal dispatches to.
 *
 * NOT CAUGHT. What a conversation does with the line (the session suite), and
 * the status line's drawing of the message.
 */

import { beforeEach, describe, expect, it } from "bun:test";
import {
	RoomController,
	type RoomControllerContext,
} from "@veyyon/coding-agent/modes/terminal/controllers/room-controller";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SESSION_HANDLERS } from "@veyyon/coding-agent/slash-commands/builtin-session";
import type { ParsedSlashCommand, TuiSlashCommandRuntime } from "@veyyon/coding-agent/slash-commands/types";
import { IrcBus, type IrcRoomDelivery, type IrcRoomLine } from "@veyyon/coding-agent/task/irc-bus";

interface Screen {
	readonly statuses: string[];
	readonly errors: string[];
	readonly warnings: string[];
}

let registry: AgentRegistry;
let bus: IrcBus;
/** Who was handed each line, and whether it woke them. */
let handed: Array<{ to: string; body: string; wake: boolean }>;
let broken: Set<string>;

beforeEach(() => {
	registry = new AgentRegistry();
	bus = new IrcBus(registry);
	handed = [];
	broken = new Set();
});

/** A driving conversation registered as `id`, in `room` when given. */
function conversation(id: string, room?: string, name?: string): AgentSession {
	const session = {
		getAgentId: () => id,
		sessionManager: { getSessionName: () => name },
		deliverRoomLines: (lines: readonly IrcRoomLine[], opts: { wake: boolean }): IrcRoomDelivery => {
			if (broken.has(id)) throw new Error("Recipient session is disposed.");
			for (const line of lines) handed.push({ to: id, body: line.body, wake: opts.wake });
			return opts.wake ? "woken" : "idle";
		},
	} as unknown as AgentSession;
	registry.register({ id, displayName: "main", kind: "main", session, room, status: "idle" });
	return session;
}

/** A room of three with `main:a` on screen, or `main:a` alone in no room. */
function terminal(options: { alone?: boolean } = {}): { room: RoomController; screen: Screen } {
	const onScreen = conversation("main:a", undefined, "refactor auth");
	if (!options.alone) {
		const id = registry.ensureRoom("main:a");
		conversation("main:b", id, "parser whitespace");
		conversation("main:c", id);
	}
	const screen: Screen = { statuses: [], errors: [], warnings: [] };
	const ctx = {
		session: onScreen,
		showStatus: (message: string) => screen.statuses.push(message),
		showError: (message: string) => screen.errors.push(message),
		showWarning: (message: string) => screen.warnings.push(message),
	} as unknown as RoomControllerContext;
	return { room: new RoomController(ctx, registry, bus), screen };
}

/** Type `/room <args>` and press Enter. */
async function command(room: RoomController, args: string): Promise<{ said: string[]; switched: string[] }> {
	const said: string[] = [];
	const switched: string[] = [];
	const runtime = {
		ctx: {
			editor: { setText: () => {} },
			room: {
				say: (text: string) => said.push(text),
				resolveArgument: (argument: string) => room.resolveArgument(argument),
				switchTo: async (id: string) => {
					switched.push(id);
				},
			},
			showError: () => {},
		},
	} as unknown as TuiSlashCommandRuntime;
	const parsed = { name: "room", args, text: `/room ${args}` } as ParsedSlashCommand;
	await SESSION_HANDLERS.room.handleTui(parsed, runtime);
	return { said, switched };
}

describe("/room say", () => {
	it("reaches every conversation in the room, the one on screen included, and says so", () => {
		const { room, screen } = terminal();
		room.say("  freeze main until the release is cut  ");
		expect(handed).toEqual([
			{ to: "main:a", body: "freeze main until the release is cut", wake: false },
			{ to: "main:b", body: "freeze main until the release is cut", wake: false },
			{ to: "main:c", body: "freeze main until the release is cut", wake: false },
		]);
		expect(screen.statuses).toEqual(["Posted to #room"]);
		expect(bus.latestRoomLine("main:b")).toMatchObject({
			label: "you",
			body: "freeze main until the release is cut",
		});
	});

	it("wakes the conversations it names and names them on the status line", () => {
		const { room, screen } = terminal();
		room.say("@2 @main:c stop and rebase");
		expect(handed.map(entry => [entry.to, entry.wake])).toEqual([
			["main:a", false],
			["main:b", true],
			["main:c", true],
		]);
		expect(screen.statuses).toEqual(["Posted to #room · woke 2 · parser whitespace, conversation 3"]);
	});

	it("posts nothing when there is nothing to say", () => {
		const { room, screen } = terminal();
		room.say("   ");
		expect(handed).toEqual([]);
		expect(screen.errors).toEqual([
			"/room say <message> posts the message to every conversation in the room (#room).",
		]);
	});

	it("in a terminal with one conversation, points at /room new and posts nothing", () => {
		const { room, screen } = terminal({ alone: true });
		room.say("anyone?");
		expect(handed).toEqual([]);
		expect(screen.statuses).toEqual(["No other conversation in this terminal — /room new opens one beside this"]);
	});

	it("names the conversation a line did not reach, and does not claim it did", () => {
		const { room, screen } = terminal();
		broken.add("main:c");
		room.say("heads up");
		expect(handed.map(entry => entry.to)).toEqual(["main:a", "main:b"]);
		expect(screen.statuses).toEqual([]);
		expect(screen.warnings).toEqual([
			"Posted to #room, but it did not reach conversation 3 (Recipient session is disposed.)",
		]);
	});
});

describe("the /room command line", () => {
	it("hands `say` and everything after it to the post, newlines and all", async () => {
		const { room } = terminal();
		expect((await command(room, "say hello there")).said).toEqual(["hello there"]);
		expect((await command(room, "say\tline one\nline two")).said).toEqual(["line one\nline two"]);
		expect((await command(room, "say")).said).toEqual([""]);
	});

	it("does not read a longer word, or a number, as `say`", async () => {
		const { room } = terminal();
		const sayer = await command(room, "sayer");
		expect(sayer).toEqual({ said: [], switched: [] });
		const second = await command(room, "2");
		expect(second).toEqual({ said: [], switched: ["main:b"] });
	});
});
