/**
 * Disposing a session waits for its aborted agent loop to unwind, and stops
 * waiting at a stated bound.
 *
 * WHY THIS SUITE EXISTS. `dispose()` aborted the agent and then went straight on
 * to release the async jobs, eval kernels, browser tabs and transcript. A tool
 * that does not honour its abort signal keeps the loop running past that point,
 * so teardown raced a loop that was still using what it released.
 *
 * WHAT CLASS THIS CLOSES. Every teardown step after the abort runs only once the
 * loop has settled or the bound has passed: the loop-finished marker must precede
 * dispose resolving, whichever tool held the loop. The bound is asserted both
 * ways, from above (a tool that never returns does not hang dispose) and from
 * below (a loop that settles promptly is not held for the full bound, so the wait
 * is not a sleep).
 *
 * WHAT IT DOES NOT CATCH. A resource released before the abort, or a teardown
 * step that starts its own work detached from dispose, is outside this ordering.
 */
import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import * as path from "node:path";
import { Agent, type AgentTool } from "@veyyon/agent-core";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel, type MockResponse } from "@veyyon/ai/providers/mock";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { DISPOSE_AGENT_LOOP_SETTLE_MS } from "@veyyon/coding-agent/session/agent-session-types";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { TempDir } from "@veyyon/utils";
import { type } from "arktype";

const TOOL_NAME = "stubborn";

function toolCall(): MockResponse {
	return { content: [{ type: "toolCall", id: "call-1", name: TOOL_NAME, arguments: {} }], stopReason: "toolUse" };
}

/** How the scripted tool behaves once the loop reaches it. */
type ToolBehaviour = "ignores-abort" | "honours-abort";

interface Harness {
	session: AgentSession;
	/** Resolves when the loop is inside the tool. */
	entered: Promise<void>;
	/** Lets an abort-ignoring tool return. */
	release(): void;
	/** Observed order of the tool returning and dispose resolving. */
	events: string[];
	/** The prompt the loop runs under, settled after dispose. */
	running: Promise<void>;
}

describe("dispose waits for the aborted agent loop", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	const harnesses: Harness[] = [];

	beforeEach(async () => {
		tempDir = TempDir.createSync("@veyyon-dispose-loop-");
		resetSettingsForTest();
		await Settings.init({ inMemory: true, cwd: tempDir.path() });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		authStorage.setRuntimeApiKey("anthropic", "test-key");
	});

	afterEach(async () => {
		for (const harness of harnesses.splice(0)) {
			harness.release();
			await harness.running;
		}
		authStorage.close();
		resetSettingsForTest();
		await tempDir.remove();
	});

	async function startTurn(behaviour: ToolBehaviour): Promise<Harness> {
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("expected claude-sonnet-4-5 to be bundled");
		const entered = Promise.withResolvers<void>();
		const released = Promise.withResolvers<void>();
		const events: string[] = [];
		const tool: AgentTool = {
			name: TOOL_NAME,
			label: TOOL_NAME,
			description: TOOL_NAME,
			parameters: type({}),
			execute: async (_id, _params, signal) => {
				entered.resolve();
				if (behaviour === "honours-abort") {
					const aborted = Promise.withResolvers<void>();
					if (signal?.aborted) aborted.resolve();
					signal?.addEventListener("abort", () => aborted.resolve(), { once: true });
					await Promise.race([aborted.promise, released.promise]);
				} else {
					await released.promise;
				}
				events.push("tool-returned");
				return { content: [{ type: "text", text: "ok" }] };
			},
		};
		const responses: MockResponse[] = [toolCall()];
		const mock = createMockModel({
			handler: () => responses.shift() ?? { content: [{ type: "text", text: "done" }], stopReason: "stop" },
		});
		const settings = Settings.isolated({ "compaction.enabled": false, "todo.enabled": false });
		const session = new AgentSession({
			agent: new Agent({
				getApiKey: () => "test-key",
				initialState: { model, systemPrompt: ["Test"], tools: [tool], messages: [] },
				convertToLlm,
				streamFn: mock.stream,
			}),
			sessionManager: SessionManager.inMemory(tempDir.path()),
			settings,
			modelRegistry: new ModelRegistry(authStorage, path.join(tempDir.path(), "models.yml")),
			toolRegistry: new Map([[TOOL_NAME, tool]]),
		});
		const running = session.prompt("go").then(
			() => {},
			() => {},
		);
		const harness: Harness = { session, entered: entered.promise, release: released.resolve, events, running };
		harnesses.push(harness);
		await entered.promise;
		return harness;
	}

	async function timedDispose(harness: Harness, options?: { agentLoopSettleTimeoutMs?: number }): Promise<number> {
		const started = performance.now();
		await harness.session.dispose(options);
		harness.events.push("disposed");
		return performance.now() - started;
	}

	it("does not finish teardown until a tool that ignores its abort has returned", async () => {
		const harness = await startTurn("ignores-abort");
		const disposing = timedDispose(harness);
		setTimeout(() => harness.release(), 150);
		const elapsed = await disposing;

		expect(harness.events).toEqual(["tool-returned", "disposed"]);
		expect(elapsed).toBeGreaterThanOrEqual(140);
		expect(elapsed).toBeLessThan(DISPOSE_AGENT_LOOP_SETTLE_MS);
	});

	it("stops waiting at the bound it is given when the tool never returns", async () => {
		const harness = await startTurn("ignores-abort");
		const elapsed = await timedDispose(harness, { agentLoopSettleTimeoutMs: 200 });

		expect(harness.events).toEqual(["disposed"]);
		expect(elapsed).toBeGreaterThanOrEqual(190);
		// Under the default bound, so a dispose that ignored the option fails here.
		expect(elapsed).toBeLessThan(DISPOSE_AGENT_LOOP_SETTLE_MS - 300);
	});

	it("stops waiting at the default bound when no bound is given", async () => {
		const harness = await startTurn("ignores-abort");
		const elapsed = await timedDispose(harness);

		expect(harness.events).toEqual(["disposed"]);
		expect(elapsed).toBeGreaterThanOrEqual(DISPOSE_AGENT_LOOP_SETTLE_MS - 10);
		expect(elapsed).toBeLessThan(DISPOSE_AGENT_LOOP_SETTLE_MS + 1_500);
	});

	it("waits only as long as the loop takes when the tool honours its abort", async () => {
		const harness = await startTurn("honours-abort");
		const elapsed = await timedDispose(harness, { agentLoopSettleTimeoutMs: 5_000 });

		expect(harness.events).toEqual(["tool-returned", "disposed"]);
		expect(elapsed).toBeLessThan(1_000);
	});
});
