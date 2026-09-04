/**
 * WHY: the loop had exactly one way to continue, and every other outcome was
 * silence.
 *
 * `agent_end` continued the loop when a benchmark measurement was waiting or
 * when `log_experiment` had armed a resume. Any other end of turn returned
 * without a word: the mode stayed on, the experiment tools stayed attached, the
 * status row kept reading like a live experiment, and nothing was ever going to
 * happen again. A model that answered the setup prompt with prose, or stopped
 * after `init_experiment`, or lost the loop after a compaction, left a session
 * that looked exactly like one mid-iteration. The only way to find out was to
 * type something and see what answered.
 *
 * The class closed here: a turn that ends with no next step for the loop is
 * either steered or reported, never neither, and the steering is bounded so a
 * model that will not drive the loop cannot spend the session being asked again.
 * Both ends of the bound are asserted -- that a stall is steered at all, and
 * that the steering terminates in a loop which turns itself off and says how to
 * get back to the runs.
 *
 * The tool sweep is derived from `EXPERIMENT_TOOL_NAMES` at run time, so a
 * seventh experiment tool is swept the day it is added rather than the day
 * someone remembers this file.
 *
 * Not caught here: what the row reads while the loop is healthy (the status-row
 * suites own that), and whether the model obeys the steer, which is the model's
 * behavior and not this code's contract.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from "bun:test";
import { createAutoresearchExtension } from "@veyyon/coding-agent/autoresearch";
import { closeAllAutoresearchStorages, openAutoresearchStorage } from "@veyyon/coding-agent/autoresearch/storage";
import { EXPERIMENT_TOOL_NAMES } from "@veyyon/coding-agent/autoresearch/tools/index";
import type {
	AgentEndEvent,
	BeforeAgentStartEvent,
	ExtensionAPI,
	ExtensionContext,
	ExtensionHandler,
	SessionStartEvent,
	ToolExecutionEndEvent,
} from "@veyyon/coding-agent/extensibility/extensions";
import * as git from "@veyyon/coding-agent/utils/git";
import { logger, TempDir } from "@veyyon/utils";
import { useTruecolorTheme } from "./helpers/theme-assertions";

useTruecolorTheme("dark");

const SESSION_BRANCH = "autoresearch/tokenizer-throughput";

/** A message the loop sent itself, as `sendMessage` receives it. */
interface Steer {
	customType: string;
	content: string;
}

interface Handlers {
	session_start?: ExtensionHandler<SessionStartEvent>;
	before_agent_start?: ExtensionHandler<BeforeAgentStartEvent, unknown>;
	agent_end?: ExtensionHandler<AgentEndEvent>;
	tool_execution_end?: ExtensionHandler<ToolExecutionEndEvent>;
}

interface Harness {
	handlers: Handlers;
	steers: Steer[];
	notices: Array<{ text: string; level: string }>;
	activeTools: string[];
	/** Whether the experiment tools are still offered, which is the loop being on. */
	loopArmed(): boolean;
}

function buildHarness(): Harness {
	const handlers: Handlers = {};
	const steers: Steer[] = [];
	const notices: Array<{ text: string; level: string }> = [];
	const activeTools: string[] = ["read", ...EXPERIMENT_TOOL_NAMES];
	const api = {
		appendEntry(): void {},
		exec: async () => ({ code: 0, stderr: "", stdout: "" }),
		on(event: string, handler: ExtensionHandler<unknown, unknown>): void {
			(handlers as Record<string, ExtensionHandler<unknown, unknown>>)[event] = handler;
		},
		registerCommand(): void {},
		registerShortcut(): void {},
		registerTool(): void {},
		getActiveTools: (): string[] => [...activeTools],
		setActiveTools: async (names: string[]): Promise<void> => {
			activeTools.splice(0, activeTools.length, ...names);
		},
		sendUserMessage(): void {},
		sendMessage(message: { customType?: string; content: string }): void {
			steers.push({ customType: message.customType ?? "", content: message.content });
		},
	} as unknown as ExtensionAPI;
	createAutoresearchExtension(api);
	return {
		handlers,
		steers,
		notices,
		activeTools,
		loopArmed: () => activeTools.includes("run_experiment"),
		__notices: notices,
	} as Harness & { __notices: Array<{ text: string; level: string }> };
}

function makeCtx(harness: Harness, cwd: string, pending = false): ExtensionContext {
	return {
		cwd,
		hasUI: true,
		hasPendingMessages: () => pending,
		ui: {
			setStatus: () => {},
			notify: (text: string, level: string) => harness.notices.push({ text, level }),
			requestRender: () => {},
		},
		sessionManager: {
			getSessionId: () => "session-stall",
			getBranch: () => [
				{
					type: "custom",
					customType: "autoresearch-control",
					id: "ctrl-1",
					parentId: null,
					timestamp: new Date(0).toISOString(),
					data: { mode: "on", goal: "make the tokenizer faster" },
				},
			],
		},
	} as unknown as ExtensionContext;
}

/** A session on the checked-out branch, at `breadth` -- 1 is serial, more is swarm. */
async function seedSession(cwd: string, breadth: number): Promise<number> {
	const storage = await openAutoresearchStorage(cwd);
	const session = storage.openSession({
		name: "tokenizer throughput",
		goal: "make the tokenizer faster",
		primaryMetric: "ms",
		metricUnit: "ms",
		direction: "lower",
		preferredCommand: "bash autoresearch.sh",
		branch: SESSION_BRANCH,
		baselineCommit: null,
		maxIterations: null,
		scopePaths: [],
		offLimits: [],
		constraints: [],
		secondaryMetrics: [],
		breadth,
		attempts: 1,
		maxParallel: breadth,
		certify: breadth > 1,
	});
	return session.id;
}

/** A measurement waiting to be logged, which is the loop's own reason to continue. */
async function seedPendingRun(cwd: string, sessionId: number): Promise<void> {
	const storage = await openAutoresearchStorage(cwd);
	const run = storage.insertRun({
		sessionId,
		segment: 0,
		command: "bash autoresearch.sh",
		logPath: "run.log",
		preRunDirtyPaths: [],
		startedAt: 1,
		arm: "a0",
		model: "acme/sonnet",
	});
	storage.markRunCompleted({
		runId: run.id,
		completedAt: 2,
		durationMs: 1000,
		exitCode: 0,
		timedOut: false,
		parsedPrimary: 240.1,
		parsedMetrics: { ms: 240.1 },
		parsedAsi: null,
	});
}

describe("a loop that advances nothing does not pass for a running one", () => {
	let dbDir: TempDir;
	let cwdDir: TempDir;

	beforeEach(() => {
		dbDir = TempDir.createSync("@pi-autoresearch-stall-db-");
		process.env.VEYYON_AUTORESEARCH_DB_DIR = dbDir.path();
		cwdDir = TempDir.createSync("@pi-autoresearch-stall-cwd-");
		vi.spyOn(git.branch, "current").mockResolvedValue(SESSION_BRANCH);
	});

	afterEach(() => {
		delete process.env.VEYYON_AUTORESEARCH_DB_DIR;
		closeAllAutoresearchStorages();
		cwdDir.removeSync();
		dbDir.removeSync();
		vi.restoreAllMocks();
	});

	/** One turn of the real loop: the turn starts, optional tools run, the turn ends. */
	const turn = async (harness: Harness, ctx: ExtensionContext, tools: string[] = []): Promise<void> => {
		await harness.handlers.before_agent_start?.({ type: "before_agent_start", systemPrompt: [] } as never, ctx);
		for (const toolName of tools) {
			await harness.handlers.tool_execution_end?.(
				{ type: "tool_execution_end", toolCallId: "c1", toolName, result: null, isError: false },
				ctx,
			);
		}
		await harness.handlers.agent_end?.({ type: "agent_end" } as never, ctx);
	};

	const startedHarness = async (breadth: number, pending = false): Promise<[Harness, ExtensionContext]> => {
		const cwd = cwdDir.path();
		await seedSession(cwd, breadth);
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwd, pending);
		await harness.handlers.session_start?.({ type: "session_start" } as never, ctx);
		return [harness, ctx];
	};

	it("steers a turn that ended with nothing for the loop to do", async () => {
		const [harness, ctx] = await startedHarness(1);

		await turn(harness, ctx);

		expect(harness.steers.map(steer => steer.customType)).toEqual(["autoresearch-stall-nudge"]);
		expect(harness.loopArmed()).toBe(true);
	});

	it("names the tool that opens an experiment when no session exists yet", async () => {
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwdDir.path());
		await harness.handlers.session_start?.({ type: "session_start" } as never, ctx);

		await turn(harness, ctx);

		expect(harness.steers).toHaveLength(1);
		expect(harness.steers[0]?.content).toContain("init_experiment");
		expect(harness.steers[0]?.content).not.toContain("run_experiment");
	});

	it("asks for the next measurement, not for a session, once one is open", async () => {
		const [harness, ctx] = await startedHarness(1);

		await turn(harness, ctx);

		expect(harness.steers[0]?.content).toContain("run_experiment");
		expect(harness.steers[0]?.content).not.toContain("init_experiment");
	});

	it("stops asking and turns itself off, naming the way back to the runs", async () => {
		const [harness, ctx] = await startedHarness(1);

		// The bound is what this asserts: a stalling loop must reach `off` on its
		// own. A cap of twelve turns is the failure mode for a loop that never does
		// -- a red test rather than a session that steers forever.
		let turns = 0;
		while (harness.loopArmed() && turns < 12) {
			await turn(harness, ctx);
			turns += 1;
		}

		expect(harness.loopArmed()).toBe(false);
		expect(harness.steers).toHaveLength(2);
		expect(harness.activeTools).toEqual(["read"]);
		const notice = harness.notices.at(-1);
		expect(notice?.level).toBe("warning");
		expect(notice?.text).toContain("Autoresearch stopped");
		expect(notice?.text).toContain("/autoresearch status");
		expect(notice?.text).toContain("kept");
	});

	it("says autoswarm, and points at autoswarm, when breadth is what stalled", async () => {
		const [harness, ctx] = await startedHarness(4);

		while (harness.loopArmed()) await turn(harness, ctx);

		expect(harness.notices.at(-1)?.text).toContain("Autoswarm stopped");
		expect(harness.notices.at(-1)?.text).toContain("/autoswarm status");
	});

	it("a further turn after the loop stopped itself steers nothing", async () => {
		const [harness, ctx] = await startedHarness(1);
		while (harness.loopArmed()) await turn(harness, ctx);
		const sent = harness.steers.length;

		await turn(harness, ctx);

		expect(harness.steers).toHaveLength(sent);
	});

	it("a measurement resets the budget, so a slow loop is not read as a dead one", async () => {
		const cwd = cwdDir.path();
		const sessionId = await seedSession(cwd, 1);
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwd);
		await harness.handlers.session_start?.({ type: "session_start" } as never, ctx);

		await turn(harness, ctx);
		await seedPendingRun(cwd, sessionId);
		await turn(harness, ctx);
		await turn(harness, ctx);

		// One stall, then a real measurement, then a stall again: the loop is still
		// on, because the budget counts consecutive dead turns and not turns.
		expect(harness.steers.map(steer => steer.customType)).toEqual([
			"autoresearch-stall-nudge",
			"autoresearch-resume",
			"autoresearch-stall-nudge",
		]);
		expect(harness.loopArmed()).toBe(true);
	});

	it("continues a waiting measurement instead of calling it a stall", async () => {
		const cwd = cwdDir.path();
		const sessionId = await seedSession(cwd, 1);
		await seedPendingRun(cwd, sessionId);
		const harness = buildHarness();
		const ctx = makeCtx(harness, cwd);
		await harness.handlers.session_start?.({ type: "session_start" } as never, ctx);

		await turn(harness, ctx);

		expect(harness.steers.map(steer => steer.customType)).toEqual(["autoresearch-resume"]);
	});

	it("leaves a turn alone when the user has already typed the next one", async () => {
		const [harness, ctx] = await startedHarness(1, true);

		await turn(harness, ctx);
		await turn(harness, ctx);
		await turn(harness, ctx);

		expect(harness.steers).toHaveLength(0);
		expect(harness.loopArmed()).toBe(true);
	});

	it("reports which kind of stall it was, for every experiment tool there is", async () => {
		const warn = vi.spyOn(logger, "warn");
		const [harness, ctx] = await startedHarness(1);

		const observed = new Map<string, boolean>();
		for (const toolName of EXPERIMENT_TOOL_NAMES) {
			warn.mockClear();
			await turn(harness, ctx, [toolName]);
			const stall = warn.mock.calls.find(call => String(call[0]).includes("without advancing"));
			observed.set(toolName, Boolean((stall?.[1] as { toolRanThisTurn?: boolean } | undefined)?.toolRanThisTurn));
			// The loop turns itself off part-way through the sweep, so each tool is
			// swept against a live loop rather than a stopped one.
			if (!harness.loopArmed()) await harness.handlers.session_start?.({ type: "session_start" } as never, ctx);
		}

		expect([...observed.entries()].filter(([, seen]) => !seen).map(([name]) => name)).toEqual([]);
		expect(observed.size).toBe(EXPERIMENT_TOOL_NAMES.length);

		warn.mockClear();
		await harness.handlers.session_start?.({ type: "session_start" } as never, ctx);
		await turn(harness, ctx, ["read"]);
		const other = warn.mock.calls.find(call => String(call[0]).includes("without advancing"));
		expect((other?.[1] as { toolRanThisTurn?: boolean } | undefined)?.toolRanThisTurn).toBe(false);
	});
});
