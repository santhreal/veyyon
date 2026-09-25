/**
 * A line of the room's `#room` channel arriving in a real AgentSession.
 *
 * WHY IT EXISTS. A room is several conversations, each driven on its own, and
 * the channel is how one tells the others something. The defect class closed
 * here is a line that starts work nobody asked for: an idle conversation woken
 * by a post that did not name it, a line that missed the turn's last step
 * waking the conversation when the turn ends, or plan mode woken by a name.
 * The other half of the class is a line that never arrives: a working
 * conversation that does not read it at its next step, an idle one whose next
 * turn does not have it, a named one that is not woken.
 *
 * Every case drives the production AgentSession with a scripted model and
 * counts model calls: a call nobody asked for is the defect, and a context
 * without the line is the other.
 *
 * The same file pins what a driving conversation is told of its room each
 * turn: its own seat, its peers by seat and id, and `#room`, and that a spawn
 * or a conversation alone is told none of it.
 *
 * What it does not catch: which conversations the bus hands a line to, and
 * when it names one (`tools/a-room-post-reaches-every-driver-in-the-room-and-no-spawn`),
 * or how the card draws.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockCall, type MockHandler, type MockModel } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentRegistry } from "@veyyon/coding-agent/registry/agent-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { convertToLlm, IRC_ROOM_MESSAGE_TYPE } from "@veyyon/coding-agent/session/messages";
import { IrcBus, type IrcRoomLine } from "@veyyon/coding-agent/task/irc-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake, TempDir } from "@veyyon/utils";
import { type } from "arktype";

const readTool: AgentTool = {
	name: "read",
	label: "read",
	description: "Fake read",
	parameters: type({}),
	async execute() {
		return { content: [{ type: "text" as const, text: "ok" }] };
	},
};

function roomLine(body: string): IrcRoomLine {
	return { id: Snowflake.next(), from: "main:peer", label: "2 · parser whitespace", body, ts: Date.now() };
}

/** Whether a model call carried `text` anywhere in the conversation it was sent. */
function sawText(call: MockCall | undefined, text: string): boolean {
	return call !== undefined && JSON.stringify(call.context.messages).includes(text);
}

/**
 * A scripted answer that resolves `called` when the model is asked for it: a wake turn starts
 * after the turn that stranded its line settles, so the test waits on the call itself.
 */
function answered(text: string): { readonly handler: MockHandler; readonly called: Promise<void> } {
	const { promise, resolve } = Promise.withResolvers<void>();
	return {
		handler: () => {
			resolve();
			return { content: [text] };
		},
		called: promise,
	};
}

describe("A #room line in a conversation", () => {
	let tempDir: TempDir;
	let session: AgentSession | undefined;
	const authStorages: AuthStorage[] = [];

	beforeEach(() => {
		tempDir = TempDir.createSync("@room-line-");
		IrcBus.resetGlobalForTests();
		AgentRegistry.resetGlobalForTests();
	});

	afterEach(async () => {
		try {
			await session?.dispose();
		} finally {
			session = undefined;
			for (const authStorage of authStorages.splice(0)) authStorage.close();
			await tempDir?.remove();
		}
	});

	async function createSession(
		handlers: MockHandler[],
		options?: { planMode?: boolean; agentId?: string; registry?: AgentRegistry },
	): Promise<MockModel> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected bundled anthropic model to exist");
		const mock = createMockModel({ responses: handlers });
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model, systemPrompt: ["Test"], tools: [readTool], messages: [] },
			// The production conversion: it is what carries a custom record to the model at all.
			convertToLlm,
			streamFn: mock.stream,
		});
		const authStorage = await AuthStorage.create(tempDir.join(`auth-${Snowflake.next()}.db`));
		authStorages.push(authStorage);
		authStorage.setRuntimeApiKey("anthropic", "test-key");
		session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(),
			settings: Settings.isolated({ "compaction.enabled": false, "retry.enabled": false }),
			modelRegistry: new ModelRegistry(authStorage, tempDir.join(`models-${Snowflake.next()}.yml`)),
			toolRegistry: new Map<string, AgentTool>([["read", readTool]]),
			builtInToolNames: ["read"],
			advisorTools: [],
			...(options?.agentId ? { agentId: options.agentId, agentRegistry: options.registry } : {}),
		});
		if (options?.planMode) session.setPlanModeState({ enabled: true, planFilePath: "local://PLAN.md" });
		return mock;
	}

	function live(): AgentSession {
		if (!session) throw new Error("no session");
		return session;
	}

	it("idle and not named: waits in context for the next turn and starts none", async () => {
		const mock = await createSession([{ content: ["noted"] }]);
		const line = roomLine("tokenize now takes (src, opts)");

		expect(live().deliverRoomLines([line], { named: false, wake: false })).toBe("idle");
		await live().waitForIdle();
		expect(mock.calls.length).toBe(0);

		await live().prompt("carry on");
		await live().waitForIdle();
		expect(mock.calls.length).toBe(1);
		expect(sawText(mock.calls[0], line.body)).toBe(true);
	});

	it("idle and named with a wake: a turn starts with the line in it", async () => {
		const answer = answered("on it");
		const mock = await createSession([answer.handler]);
		const line = roomLine("@2 your lexer calls the old tokenize");

		expect(live().deliverRoomLines([line], { named: true, wake: true })).toBe("woken");
		await answer.called;
		await live().waitForIdle();
		expect(mock.calls.length).toBe(1);
		expect(sawText(mock.calls[0], line.body)).toBe(true);
		expect(sawText(mock.calls[0], "naming you")).toBe(true);
	});

	it("named without a wake (the room's wake run is spent): addressed, and still asleep", async () => {
		const mock = await createSession([]);
		const line = roomLine("@2 look at this when you can");

		expect(live().deliverRoomLines([line], { named: true, wake: false })).toBe("idle");
		await live().waitForIdle();
		expect(mock.calls.length).toBe(0);
		const record = live().agent.state.messages.find(
			message => message.role === "custom" && message.customType === IRC_ROOM_MESSAGE_TYPE,
		);
		expect(JSON.stringify(record)).toContain("naming you");
	});

	it("in plan mode, a name does not wake it", async () => {
		const mock = await createSession([], { planMode: true });

		expect(live().deliverRoomLines([roomLine("@2 plan around the new API")], { named: true, wake: true })).toBe(
			"idle",
		);
		await live().waitForIdle();
		expect(mock.calls.length).toBe(0);
	});

	it("working: reads the line at its next step", async () => {
		const line = roomLine("config.ts moved to src/config/index.ts");
		let outcome: string | undefined;
		const mock = await createSession([
			() => {
				outcome = live().deliverRoomLines([line], { named: false, wake: false });
				return { content: [{ type: "toolCall", name: "read", arguments: {} }] };
			},
			{ content: ["done"] },
		]);

		await live().prompt("go");
		await live().waitForIdle();
		expect(outcome).toBe("working");
		expect(mock.calls.length).toBe(2);
		expect(sawText(mock.calls[0], line.body)).toBe(false);
		expect(sawText(mock.calls[1], line.body)).toBe(true);
	});

	it("working through its last step, not named: the line waits for the next turn and wakes nothing", async () => {
		const line = roomLine("the release branch is frozen");
		const mock = await createSession([
			() => {
				live().deliverRoomLines([line], { named: false, wake: false });
				return { content: ["finished"] };
			},
			{ content: ["next"] },
		]);

		await live().prompt("go");
		await live().waitForIdle();
		expect(mock.calls.length).toBe(1);

		await live().prompt("and now");
		await live().waitForIdle();
		expect(mock.calls.length).toBe(2);
		expect(sawText(mock.calls[1], line.body)).toBe(true);
	});

	it("working through its last step, named with a wake: the turn's end wakes it with the line", async () => {
		const line = roomLine("@2 rebase on main before you push");
		const woken = answered("rebasing");
		const mock = await createSession([
			() => {
				live().deliverRoomLines([line], { named: true, wake: true });
				return { content: ["finished"] };
			},
			woken.handler,
		]);

		await live().prompt("go");
		await woken.called;
		await live().waitForIdle();
		expect(mock.calls.length).toBe(2);
		expect(sawText(mock.calls[1], line.body)).toBe(true);
	});

	it("a backlog is one record of every line, worded as what the room said before it joined", async () => {
		const mock = await createSession([]);
		const first = roomLine("parser.ts is mine until noon");
		const second = { ...roomLine("tests are green on main"), from: undefined, label: "you" };

		expect(live().deliverRoomLines([first, second], { named: false, wake: false, backlog: true })).toBe("idle");
		await live().waitForIdle();
		expect(mock.calls.length).toBe(0);
		const records = live().agent.state.messages.filter(
			message => message.role === "custom" && message.customType === IRC_ROOM_MESSAGE_TYPE,
		);
		expect(records.length).toBe(1);
		const text = JSON.stringify(records[0]);
		expect(text).toContain("before this conversation joined the room");
		expect(text).toContain(first.body);
		expect(text).toContain(second.body);
		expect(text).toContain("The operator");
	});

	it("a disposed conversation refuses the line", async () => {
		await createSession([]);
		await live().dispose();
		expect(() => live().deliverRoomLines([roomLine("anyone?")], { named: false, wake: false })).toThrow(
			"Recipient session is disposed.",
		);
		session = undefined;
	});

	describe("what a driving conversation is told of its room", () => {
		/**
		 * `main:a` beside `main:b`, `main:b`'s spawn, and a driver in no room.
		 * `main:a` holds its seat with a stand-in session: only its id is read.
		 */
		function room(): AgentRegistry {
			const registry = new AgentRegistry();
			registry.register({
				id: "main:a",
				displayName: "main",
				kind: "main",
				session: {} as AgentSession,
				status: "idle",
			});
			const id = registry.ensureRoom("main:a");
			registry.register({
				id: "main:b",
				displayName: "main",
				kind: "main",
				session: null,
				room: id,
				status: "idle",
			});
			registry.register({
				id: "Scout-B",
				displayName: "scout",
				kind: "sub",
				parentId: "main:b",
				session: null,
				status: "idle",
			});
			registry.register({ id: "acp:z", displayName: "main", kind: "main", session: null, status: "idle" });
			return registry;
		}

		/** The context of the first model call `agentId` makes, seated in the room above. */
		async function firstCallAs(agentId: string): Promise<MockCall | undefined> {
			const registry = room();
			const mock = await createSession([{ content: ["ok"] }], { agentId, registry });
			registry.attachSession(agentId, live(), null);
			await live().prompt("hi");
			await live().waitForIdle();
			return mock.calls[0];
		}

		it("is told its own seat, its peers by seat and id, and how #room reaches them", async () => {
			const call = await firstCallAs("main:b");
			expect(sawText(call, "Room: you are conversation 2, beside 1 `main:a`.")).toBe(true);
			expect(sawText(call, "posts to every conversation in the room")).toBe(true);
		});

		it("a spawn in the room is told nothing of it", async () => {
			const call = await firstCallAs("Scout-B");
			expect(call).toBeDefined();
			expect(sawText(call, "Room:")).toBe(false);
			expect(sawText(call, "#room")).toBe(false);
		});

		it("a driver in no room is told nothing of one", async () => {
			const call = await firstCallAs("acp:z");
			expect(call).toBeDefined();
			expect(sawText(call, "Room:")).toBe(false);
		});
	});
});
