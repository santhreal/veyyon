import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { AgentRegistry } from "../../src/registry/agent-registry";
import type { AgentSession } from "../../src/session/agent-session";
import { FileSessionStorage } from "../../src/session/session-storage";
import {
	NativeControlDeniedError,
	TelegramNativeControlBridge,
	type NativeControlAuth,
} from "../../src/native-control/telegram-control-bridge";
import {
	getTelegramNativeControlHost,
	installTelegramNativeControlHost,
} from "../../src/native-control/telegram-control-host";

const TOKEN = "native-control-test-token-0000000000000000";
const AUTH: NativeControlAuth = {
	authToken: TOKEN,
	actorId: "telegram-user-17",
	chatId: "telegram-chat-29",
	sessionId: "session-a",
};

let scratch = "";
let workspace = "";
let sessionDir = "";
let registry: AgentRegistry;
let bridge: TelegramNativeControlBridge;

beforeEach(async () => {
	scratch = await fs.mkdtemp(path.join(os.tmpdir(), "veyyon-native-control-"));
	workspace = path.join(scratch, "allowed", "project");
	sessionDir = path.join(scratch, "sessions");
	await fs.mkdir(workspace, { recursive: true });
	registry = new AgentRegistry();
	bridge = new TelegramNativeControlBridge({
		binding: { ...AUTH, workspaceRoots: [path.join(scratch, "allowed")] },
		registry,
		storage: new FileSessionStorage(),
		sessionDirFor: () => sessionDir,
	});
});

afterEach(async () => {
	await fs.rm(scratch, { recursive: true, force: true });
});

describe("TelegramNativeControlBridge authenticated reads", () => {
	test("returns only bounded agents in the bound session with progress and result", async () => {
		const fakeSession = {
			getLastAssistantText: () => "finished\u001b[31m safely",
		} as unknown as AgentSession;
		registry.register({
			id: "WorkerA",
			displayName: "Worker A",
			kind: "sub",
			session: fakeSession,
			scope: AUTH.sessionId,
			status: "running",
		});
		registry.setActivity("WorkerA", "reading\u001b[2J repository");
		registry.register({
			id: "OtherSession",
			displayName: "Other session",
			kind: "sub",
			session: null,
			scope: "session-b",
			status: "idle",
		});

		const page = await bridge.listAgents({ ...AUTH, limit: 50 });
		expect(page).toEqual({
			items: [
				expect.objectContaining({ id: "WorkerA", name: "Worker A", status: "running", summary: "reading [2J repository" }),
			],
		});
		const detail = await bridge.getAgentDetail({ ...AUTH, agentId: "WorkerA" });
		expect(detail.progress).toBe("reading [2J repository");
		expect(detail.result).toBe("finished safely");
		await expect(bridge.getAgentDetail({ ...AUTH, agentId: "OtherSession" })).rejects.toMatchObject({
			code: "AGENT_NOT_FOUND",
		});
	});

	test("denies invalid credentials, actors, chats, sessions, and cursors", async () => {
		const cases: Array<[Partial<NativeControlAuth>, NativeControlDeniedError["code"]]> = [
			[{ authToken: "wrong" }, "UNAUTHORIZED"],
			[{ actorId: "attacker" }, "ACTOR_MISMATCH"],
			[{ chatId: "other-chat" }, "CHAT_MISMATCH"],
			[{ sessionId: "session-b" }, "SESSION_MISMATCH"],
		];
		for (const [override, code] of cases) {
			await expect(bridge.listAgents({ ...AUTH, ...override })).rejects.toMatchObject({ code });
		}
		await expect(bridge.listAgents({ ...AUTH, cursor: "-1" })).rejects.toMatchObject({ code: "INVALID_CURSOR" });
	});
});

describe("TelegramNativeControlBridge safe session creation", () => {
	test("creates a persisted session without replacing Main and deduplicates an exact replay", async () => {
		registry.register({
			id: "main:session-a",
			displayName: "Main",
			kind: "main",
			session: null,
			scope: AUTH.sessionId,
			status: "running",
		});
		const mainBefore = registry.get("main:session-a");
		const request = { ...AUTH, requestId: "callback-001", workspace, title: "Telegram work" };

		const first = await bridge.createSession(request);
		const replay = await bridge.createSession(request);

		expect(replay).toEqual(first);
		expect(registry.get("main:session-a")).toBe(mainBefore);
		expect(first.workspace).toBe(await fs.realpath(workspace));
		expect(first.title).toBe("Telegram work");
		expect((await fs.readdir(sessionDir)).filter(name => name.endsWith(".jsonl"))).toHaveLength(1);
		await expect(
			bridge.createSession({ ...request, workspace: path.join(scratch, "allowed") }),
		).rejects.toMatchObject({ code: "REPLAY_MISMATCH" });
	});

	test("denies a workspace outside the configured realpath allowlist", async () => {
		const outside = path.join(scratch, "outside");
		await fs.mkdir(outside);
		await expect(
			bridge.createSession({ ...AUTH, requestId: "callback-002", workspace: outside }),
		).rejects.toMatchObject({ code: "WORKSPACE_DENIED" });
		expect(await fs.readdir(sessionDir).catch(() => [])).toHaveLength(0);
	});
});

describe("Telegram native control host wiring", () => {
	test("publishes a bindable in-process host and invalidates it on session switch", async () => {
		let activeSessionId = AUTH.sessionId;
		const installed = installTelegramNativeControlHost(() => activeSessionId, {
			registry,
			storage: new FileSessionStorage(),
			sessionDirFor: () => sessionDir,
		});
		expect(getTelegramNativeControlHost()).toBe(installed);

		const client = installed.bind({
			...AUTH,
			workspaceRoots: [path.join(scratch, "allowed")],
		});
		expect(client.getSessionIdentity(AUTH)).toEqual({
			id: AUTH.sessionId,
			actorId: AUTH.actorId,
			chatId: AUTH.chatId,
		});
		expect(await client.listAgents({ ...AUTH, limit: 5 })).toEqual({ items: [] });

		activeSessionId = "session-b";
		await expect(client.listAgents({ ...AUTH, limit: 5 })).rejects.toMatchObject({
			code: "SESSION_NOT_ACTIVE",
		});
		expect(() =>
			installed.bind({
				...AUTH,
				workspaceRoots: [path.join(scratch, "allowed")],
			}),
		).toThrow(
			expect.objectContaining({ code: "SESSION_NOT_ACTIVE" }),
		);
	});
});
