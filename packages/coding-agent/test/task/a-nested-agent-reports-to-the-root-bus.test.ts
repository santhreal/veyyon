/**
 * A spawned agent at any depth reports its lifecycle and progress on the ROOT session's bus.
 *
 * THE DEFECT. The options a child session is built from carried no `eventBus`, so
 * `createAgentSession` gave every child a fresh bus of its own. A depth-1 agent still showed up,
 * because the root's executor emits on its behalf, but a child that spawned built ITS child with
 * the child's private bus as the target: from depth 2 down, every `task:subagent:*` frame landed on
 * a bus nothing subscribed to, and the TUI agent dashboard, the RPC agent stream and the collab
 * guest went blind for nested trees. The cold-revive path built its session the same way.
 *
 * THE CLASS. A session built for a spawned agent, live or revived, whose bus is not the root's.
 * The live case chains spawns through the real `runSubprocess`: each level spawns with the bus the
 * executor handed its parent's session, which is the bus that session's task tool emits on, so a
 * level that drops the bus silences every level below it. The revive case builds a real session
 * from a persisted transcript and checks the bus it was built with.
 *
 * WHAT IT DOES NOT CATCH. The chain is six levels deep, not unbounded (`-1` is a legal depth).
 * Every level is built by the same builder from the same options shape, so a depth-specific branch
 * in that builder would be needed to escape it. The session construction inside the executor is
 * faked; `createAgentSession` resolving `options.eventBus` into the session's tool bus is covered by
 * the revive case, which builds a real session.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { MAIN_AGENT_ID } from "@veyyon/coding-agent/registry/agent-registry";
import * as sdkModule from "@veyyon/coding-agent/sdk";
import type { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { runSubprocess } from "@veyyon/coding-agent/task/executor";
import { createPersistedAgentReviverFactory } from "@veyyon/coding-agent/task/persisted-revive";
import {
	type AgentDefinition,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@veyyon/coding-agent/task/types";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { Snowflake, TempDir } from "@veyyon/utils";
import { createMockSession, createSessionResult, yieldSuccessEvent } from "../helpers/agent-session";
import { useIsolatedConfigRoot } from "../helpers/isolated-agent-dir";

useIsolatedConfigRoot();

const agentDefinition: AgentDefinition = {
	name: "task",
	description: "test",
	systemPrompt: "test",
	source: "bundled",
};

const CHAIN_DEPTH = 6;

afterEach(() => {
	vi.restoreAllMocks();
});

interface Frame {
	channel: string;
	id: string;
	status?: string;
}

function recordFrames(bus: EventBus): Frame[] {
	const frames: Frame[] = [];
	bus.on(TASK_SUBAGENT_LIFECYCLE_CHANNEL, data => {
		const payload = data as { id: string; status: string };
		frames.push({ channel: TASK_SUBAGENT_LIFECYCLE_CHANNEL, id: payload.id, status: payload.status });
	});
	bus.on(TASK_SUBAGENT_PROGRESS_CHANNEL, data => {
		const payload = data as { progress: { id: string } };
		frames.push({ channel: TASK_SUBAGENT_PROGRESS_CHANNEL, id: payload.progress.id });
	});
	return frames;
}

/**
 * Spawn one agent at `taskDepth` through the real executor, with `eventBus` as the spawning
 * session's bus, and return the bus the executor built the child session with.
 */
async function spawnAt(taskDepth: number, eventBus: EventBus | undefined): Promise<EventBus | undefined> {
	const id = `Nested-${taskDepth}`;
	const spy = vi
		.spyOn(sdkModule, "createAgentSession")
		.mockResolvedValue(
			createSessionResult(createMockSession(({ emit }) => emit(yieldSuccessEvent({ ok: true }, id)))),
		);
	const result = await runSubprocess({
		cwd: process.cwd(),
		agent: agentDefinition,
		task: "do work",
		index: 0,
		id,
		taskDepth,
		settings: Settings.isolated(),
		modelRegistry: { refresh: async () => {} } as unknown as ModelRegistry,
		enableLsp: false,
		eventBus,
	});
	expect(result.exitCode).toBe(0);
	const built = spy.mock.calls[0]?.[0];
	if (!built) throw new Error(`the executor never built the session for ${id}`);
	spy.mockRestore();
	return built.eventBus;
}

describe("a nested agent reports to the root bus", () => {
	it("every level of a spawn chain emits its lifecycle and progress on the root session's bus", async () => {
		const root = new EventBus();
		const frames = recordFrames(root);

		let spawningBus: EventBus | undefined = root;
		for (let depth = 0; depth < CHAIN_DEPTH; depth++) {
			spawningBus = await spawnAt(depth, spawningBus);
		}

		for (let depth = 0; depth < CHAIN_DEPTH; depth++) {
			const id = `Nested-${depth}`;
			const own = frames.filter(frame => frame.id === id);
			expect({
				id,
				lifecycle: own.filter(f => f.channel === TASK_SUBAGENT_LIFECYCLE_CHANNEL).map(f => f.status),
			}).toEqual({ id, lifecycle: ["started", "completed"] });
			expect(own.some(frame => frame.channel === TASK_SUBAGENT_PROGRESS_CHANNEL)).toBe(true);
		}
	});

	it("a revived agent is built on the bus of the session that revives it", async () => {
		const root = TempDir.createSync("nested-agent-bus-");
		const agentDir = path.resolve(root.join("agent"));
		const project = path.resolve(root.join("project"));
		let parent: AgentSession | undefined;
		let revived: AgentSession | undefined;
		let authStorage: AuthStorage | undefined;
		try {
			await Promise.all([fs.mkdir(agentDir, { recursive: true }), fs.mkdir(project, { recursive: true })]);
			authStorage = await AuthStorage.create(root.join("auth.db"));
			const modelRegistry = new ModelRegistry(authStorage, root.join("models.yml"));
			const settings = await Settings.loadReadOnly({ cwd: project, agentDir });
			const bus = new EventBus();
			({ session: parent } = await sdkModule.createAgentSession({
				cwd: project,
				agentDir,
				sessionManager: SessionManager.inMemory(project),
				settings,
				modelRegistry,
				eventBus: bus,
				disableExtensionDiscovery: true,
				skills: [],
				contextFiles: [],
				promptTemplates: [],
				slashCommands: [],
				enableMCP: false,
				enableLsp: false,
				skipPythonPreflight: true,
			}));

			const childManager = SessionManager.create(project, root.join("persisted-child"));
			childManager.appendSessionInit({
				systemPrompt: "Persisted child",
				task: "Spawn below",
				tools: ["task", "yield"],
				spawns: "*",
				maxNestedSpawnDepth: 2,
			});
			childManager.appendMessage({ role: "user", content: "ready", timestamp: Date.now() });
			await childManager.ensureOnDisk();
			await childManager.flush();
			const sessionFile = childManager.getSessionFile()!;
			await childManager.close();

			const factory = createPersistedAgentReviverFactory({
				session: parent,
				authStorage,
				modelRegistry,
				settings,
				eventBus: bus,
				enableLsp: false,
			});
			const id = `Revive-${Snowflake.next()}`;
			const revive = await factory({
				id,
				displayName: id,
				kind: "sub",
				parentId: MAIN_AGENT_ID,
				status: "parked",
				session: null,
				sessionFile,
				createdAt: Date.now(),
				lastActivity: Date.now(),
			});
			const build = vi.spyOn(sdkModule, "createAgentSession");
			revived = await revive!();
			expect(build.mock.calls.map(([options]) => options?.eventBus === bus)).toEqual([true]);
		} finally {
			await revived?.dispose();
			await parent?.dispose();
			authStorage?.close();
			await root.remove();
		}
	});
});
