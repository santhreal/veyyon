/**
 * WHY THIS SUITE EXISTS. Session startup awaited work no frame reads. The memory backend's start —
 * a database open plus a per-session state install — was awaited inside `createAgentSession` for an
 * auto-learn session, so it was paid before the terminal drew anything, to satisfy a tool call that
 * cannot happen until the user has typed. `AgentSession.deferStartupWork` is where that work goes
 * now, and the guarantee it used to buy is bought at the one place that needs it: a turn.
 *
 * THE CLASS THIS CLOSES is broader than the memory backend. Any future deferral rides the same gate,
 * so these assertions are about the gate: work handed over does not block construction, a turn does
 * not start until it finishes, a message that triggers a turn waits the same way, and a failure
 * neither reaches the process nor refuses the turn.
 *
 * WHAT IT DOES NOT CATCH. It cannot see work that is still awaited inline on the boot path — a
 * deferral nobody wrote. That is the startup bench (`scripts/bench-startup.ts`) and its recorded
 * baseline, which fail on the time rather than on the shape.
 */
import { afterEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { scheduler } from "node:timers/promises";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { TempDir } from "@veyyon/utils";

type Harness = { session: AgentSession; authStorage: AuthStorage; tempDir: TempDir };

const open: Harness[] = [];

afterEach(async () => {
	for (const harness of open.splice(0)) {
		await harness.session.dispose().catch(() => {});
		harness.authStorage.close();
		harness.tempDir.removeSync();
	}
});

async function harness(): Promise<AgentSession> {
	const tempDir = TempDir.createSync("@pi-startup-hydration-");
	const authStorage = await AuthStorage.create(path.join(tempDir.path(), "auth.db"));
	authStorage.setRuntimeApiKey("mock", "test-key");
	const mock = createMockModel({ responses: [{ content: [{ type: "text", text: "ok" }], stopReason: "stop" }] });
	const modelRegistry = new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml"));
	const settings = Settings.isolated({
		"compaction.enabled": false,
		"retry.enabled": false,
		"todo.enabled": false,
		"todo.reminders": false,
	});
	settings.setModelRole("default", `${mock.provider}/${mock.id}`);
	const tools: AgentTool[] = [];
	const agent = new Agent({
		getApiKey: () => "test-key",
		initialState: { model: mock, systemPrompt: ["Test"], tools, messages: [] },
		convertToLlm,
		streamFn: mock.stream,
	});
	const session = new AgentSession({
		agent,
		sessionManager: SessionManager.inMemory(tempDir.path()),
		settings,
		modelRegistry,
		toolRegistry: new Map(),
	});
	open.push({ session, authStorage, tempDir });
	return session;
}

/** Let every queued microtask and macrotask run, without waiting on a clock. */
async function drain(): Promise<void> {
	for (let i = 0; i < 20; i++) await scheduler.yield();
}

describe("the first turn waits for hydration, the first frame does not", () => {
	it("hands work over without waiting for it", async () => {
		const session = await harness();
		let finished = false;
		const { promise, resolve } = Promise.withResolvers<void>();

		session.deferStartupWork(promise.then(() => void (finished = true)));

		// Construction is already done; handing work over must not have waited for it.
		expect(finished).toBe(false);
		resolve();
		await session.whenStartupHydrated();
		expect(finished).toBe(true);
	});

	it("does not start a turn until the deferred work finishes", async () => {
		const session = await harness();
		const { promise, resolve } = Promise.withResolvers<void>();
		session.deferStartupWork(promise);

		const turn = session.prompt("say ok");
		// Drain the queues rather than asserting on the synchronous prefix, which stops at the first
		// await whether the gate is there or not. `scheduler.yield` is a macrotask tick, so anything
		// the turn would do without the gate has had every chance to happen by the last one.
		await drain();
		expect(session.messages.some(message => message.role === "user")).toBe(false);
		expect(session.isStreaming).toBe(false);

		resolve();
		await turn;
		expect(session.messages.some(message => message.role === "user")).toBe(true);
	});

	it("makes a turn-triggering message wait the same way", async () => {
		const session = await harness();
		const { promise, resolve } = Promise.withResolvers<void>();
		session.deferStartupWork(promise);

		const sent = session.sendCustomMessage(
			{ customType: "test-nudge", content: "go", display: false, attribution: "user" },
			{ deliverAs: "nextTurn", triggerTurn: true },
		);
		await drain();
		expect(session.messages.some(message => message.role === "custom")).toBe(false);

		resolve();
		await sent;
		expect(session.messages.some(message => message.role === "custom")).toBe(true);
	});

	it("orders several deferrals and lets a failed one through", async () => {
		const session = await harness();
		const order: string[] = [];
		session.deferStartupWork(Promise.reject(new Error("backend start failed")));
		session.deferStartupWork(Promise.resolve().then(() => void order.push("second")));

		// A rejection is swallowed: it must neither reach the process nor keep the turn from running.
		await session.whenStartupHydrated();
		expect(order).toEqual(["second"]);
		await session.prompt("say ok");
		expect(session.messages.some(message => message.role === "user")).toBe(true);
	});
});
