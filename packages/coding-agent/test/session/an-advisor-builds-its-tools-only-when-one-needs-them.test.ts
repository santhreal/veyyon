/**
 * A session builds the advisor's tools when an advisor first needs them, and builds them once.
 *
 * WHY: the advisor is a full agent with its own instance of every built-in tool, bound to its own
 * tool session. The session used to construct that set while it started, whether or not an advisor
 * ever ran: every top-level session and every spawned agent paid for a second copy of every tool,
 * and loaded the modules of tools the primary had switched off (the browser tool and its stealth
 * payloads, the eval bridges). The class is "advisor tool construction happens off the advisor's
 * own path": at session start, at advisor start, or more than once per session. Each case drives
 * the real session: `createAgentSession` for the start path, with every `BUILTIN_TOOLS` factory
 * swept from the registry and observed, and `AgentSession` with a real advisor runtime reviewing
 * real primary turns for the advisor path.
 *
 * NOT CAUGHT: the modules a tool pulls in by static import beyond its own factory, which no
 * in-process test can unload; the idle heap difference is measured by the binary bench instead.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "bun:test";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { Agent, type AgentTool, type StreamFn } from "@veyyon/agent-core";
import type { AssistantMessage, Model } from "@veyyon/ai";
import { AuthStorage } from "@veyyon/ai/auth-storage";
import { createMockModel } from "@veyyon/ai/providers/mock";
import { AssistantMessageEventStream } from "@veyyon/ai/utils/event-stream";
import { getBundledModel } from "@veyyon/catalog/models";
import { AsyncJobManager } from "@veyyon/coding-agent/async/job-manager";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { createAgentSession } from "@veyyon/coding-agent/sdk";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { BUILTIN_TOOLS, type ToolSession } from "@veyyon/coding-agent/tools";
import { SessionManager } from "@veyyon/kernel/session/session-manager";
import { removeSyncWithRetries, Snowflake } from "@veyyon/utils";
import { type } from "arktype";

const ADVISOR_MODEL = "anthropic/claude-sonnet-4-5";

function tool(name: string): AgentTool {
	return {
		name,
		label: name,
		description: `${name} stand-in`,
		parameters: type("object"),
		execute: async () => ({ content: [{ type: "text" as const, text: "ok" }] }),
	};
}

function silentReview(model: Model): AssistantMessageEventStream {
	const message: AssistantMessage = {
		role: "assistant",
		content: [{ type: "text", text: "On track." }],
		api: model.api,
		provider: model.provider,
		model: model.id,
		stopReason: "stop",
		usage: {
			input: 10,
			output: 5,
			cacheRead: 0,
			cacheWrite: 0,
			totalTokens: 15,
			cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
		},
		timestamp: Date.now(),
	};
	const stream = new AssistantMessageEventStream();
	queueMicrotask(() => stream.push({ type: "done", reason: "stop", message }));
	return stream;
}

const tempDirs: string[] = [];
const live: AgentSession[] = [];
let sharedDir: string;
let authStorage: AuthStorage;
let modelRegistry: ModelRegistry;

beforeAll(async () => {
	sharedDir = fs.mkdtempSync(path.join(os.tmpdir(), "veyyon-advisor-tools-shared-"));
	authStorage = await AuthStorage.create(path.join(sharedDir, "auth.db"));
	authStorage.setRuntimeApiKey("anthropic", "test-key");
	authStorage.setRuntimeApiKey("mock", "test-key");
	modelRegistry = new ModelRegistry(authStorage, path.join(sharedDir, "models.yml"));
});

afterAll(() => {
	authStorage.close();
	removeSyncWithRetries(sharedDir);
});

afterEach(async () => {
	vi.restoreAllMocks();
	for (const session of live.splice(0)) await session.dispose();
	for (const dir of tempDirs.splice(0)) removeSyncWithRetries(dir);
	AsyncJobManager.resetForTests();
});

function scratchDir(): string {
	const dir = fs.mkdtempSync(path.join(os.tmpdir(), `veyyon-advisor-tools-${Snowflake.next()}-`));
	tempDirs.push(dir);
	return dir;
}

describe("the session start builds no advisor tool", () => {
	/** Every built-in factory, wrapped so a call made for the advisor's tool session is counted by name. */
	function observeAdvisorFactoryCalls(): Map<string, number> {
		const calls = new Map<string, number>();
		for (const name of Object.keys(BUILTIN_TOOLS) as Array<keyof typeof BUILTIN_TOOLS>) {
			const factory = BUILTIN_TOOLS[name];
			vi.spyOn(BUILTIN_TOOLS, name).mockImplementation((session: ToolSession) => {
				if (session.getAgentId?.() === "advisor") calls.set(name, (calls.get(name) ?? 0) + 1);
				return factory(session);
			});
		}
		return calls;
	}

	it("constructs no tool for the advisor, then every built-in exactly once for the first listing", async () => {
		const calls = observeAdvisorFactoryCalls();
		const dir = scratchDir();
		const cwd = path.join(dir, "project");
		fs.mkdirSync(cwd, { recursive: true });
		const { session } = await createAgentSession({
			cwd,
			agentDir: path.join(dir, "agent"),
			sessionManager: SessionManager.inMemory(cwd),
			settings: Settings.isolated({ "compaction.enabled": false }),
			disableExtensionDiscovery: true,
			skills: [],
			contextFiles: [],
			promptTemplates: [],
			slashCommands: [],
			enableMCP: false,
			enableLsp: false,
			hasUI: false,
			modelRegistry,
		});
		live.push(session);

		expect([...calls.keys()]).toEqual([]);

		const names = await session.getAdvisorAvailableToolNames();
		const everyFactoryOnce = Object.fromEntries(Object.keys(BUILTIN_TOOLS).map(name => [name, 1]));
		expect(Object.fromEntries(calls)).toEqual(everyFactoryOnce);
		expect(names.filter(name => !(name in BUILTIN_TOOLS))).toEqual([]);
		expect(names).toContain("read");
		expect(names).toContain("search");

		expect(await session.getAdvisorAvailableToolNames()).toEqual(names);
		expect(Object.fromEntries(calls)).toEqual(everyFactoryOnce);
	}, 60_000);
});

describe("an advisor receives its tools before its first request", () => {
	interface Harness {
		session: AgentSession;
		/** Tool names on each advisor request, in order. */
		requests: string[][];
		/** Calls made to the session's advisor tool loader. */
		loads: () => number;
	}

	function harness(options: { turns: number; loader?: "pool" | "fails-once" | "none" }): Harness {
		const advisorModel = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!advisorModel) throw new Error("Expected the bundled advisor model to exist");
		const mainMock = createMockModel({
			responses: Array.from({ length: options.turns }, (_, i) => ({ content: [`ANSWER-${i}`], stopReason: "stop" })),
		});
		const agent = new Agent({
			getApiKey: () => "test-key",
			initialState: { model: mainMock, systemPrompt: ["Test"], tools: [] },
			streamFn: mainMock.stream,
		});
		const requests: string[][] = [];
		const advisorStreamFn: StreamFn = (requestModel, requestContext) => {
			requests.push((requestContext.tools ?? []).map(t => t.name).sort());
			return silentReview(requestModel);
		};
		let loads = 0;
		const pool = [tool("read"), tool("search"), tool("bash")];
		const loadAdvisorTools =
			options.loader === "none"
				? undefined
				: async (): Promise<AgentTool[]> => {
						loads++;
						if (options.loader === "fails-once" && loads === 1) throw new Error("advisor tool build failed");
						return pool;
					};
		const settings = Settings.isolated({
			"async.enabled": false,
			"retry.enabled": false,
			"compaction.enabled": false,
			// The primary turn's turn_end waits for the advisor to catch up, so `prompt` resolves
			// after the advisor's review of that turn.
			"advisor.syncBacklog": "1",
		});
		settings.setModelRole("advisor", ADVISOR_MODEL);
		const session = new AgentSession({
			agent,
			sessionManager: SessionManager.inMemory(scratchDir()),
			settings,
			modelRegistry,
			loadAdvisorTools,
			advisorStreamFn,
		});
		live.push(session);
		return { session, requests, loads: () => loads };
	}

	it("starts an advisor without building a tool, and reviews with the configured tools only", async () => {
		const h = harness({ turns: 1 });
		expect(h.session.setAdvisorEnabled(true)).toBe(true);
		expect(h.loads()).toBe(0);
		expect(h.session.getAdvisorAgent()?.state.tools.map(t => t.name)).toEqual(["advise"]);

		await h.session.prompt("first");
		await h.session.waitForIdle();

		expect(h.requests).toEqual([["advise", "read", "search"]]);
		expect(h.loads()).toBe(1);
	}, 30_000);

	it("builds the pool once for later reviews, a restarted advisor and the tool listing", async () => {
		const h = harness({ turns: 3 });
		expect(h.session.setAdvisorEnabled(true)).toBe(true);
		await h.session.prompt("first");
		await h.session.prompt("second");
		expect(h.session.setAdvisorEnabled(false)).toBe(false);
		expect(h.session.setAdvisorEnabled(true)).toBe(true);
		await h.session.prompt("third");
		await h.session.waitForIdle();

		expect(h.requests).toEqual([
			["advise", "read", "search"],
			["advise", "read", "search"],
			["advise", "read", "search"],
		]);
		expect(await h.session.getAdvisorAvailableToolNames()).toEqual(["read", "search", "bash"]);
		expect(h.loads()).toBe(1);
	}, 30_000);

	it("lists the pool before any advisor runs, and the first review reuses that build", async () => {
		const h = harness({ turns: 1 });
		expect(await h.session.getAdvisorAvailableToolNames()).toEqual(["read", "search", "bash"]);
		expect(h.loads()).toBe(1);

		expect(h.session.setAdvisorEnabled(true)).toBe(true);
		await h.session.prompt("first");
		await h.session.waitForIdle();

		expect(h.requests).toEqual([["advise", "read", "search"]]);
		expect(h.loads()).toBe(1);
	}, 30_000);

	it("builds again after a failed build instead of keeping the failure", async () => {
		const h = harness({ turns: 1, loader: "fails-once" });
		expect(h.session.setAdvisorEnabled(true)).toBe(true);
		await h.session.prompt("first");
		await h.session.waitForIdle();

		// The failed build fails the advisor's first attempt before any request; the retry builds
		// again and reviews with the tools.
		expect(h.requests).toEqual([["advise", "read", "search"]]);
		expect(h.loads()).toBe(2);
	}, 30_000);

	it("gives advisors only advise when the session has no tool loader", async () => {
		const h = harness({ turns: 1, loader: "none" });
		expect(h.session.setAdvisorEnabled(true)).toBe(true);
		await h.session.prompt("first");
		await h.session.waitForIdle();

		expect(h.requests).toEqual([["advise"]]);
		expect(await h.session.getAdvisorAvailableToolNames()).toEqual([]);
	}, 30_000);
});
