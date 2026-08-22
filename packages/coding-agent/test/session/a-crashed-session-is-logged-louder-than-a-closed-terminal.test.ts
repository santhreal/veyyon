/**
 * The severity of the `Session exit recorded` log line matches what happened to the session.
 *
 * WHY THIS SUITE EXISTS. The record was written at one of two levels, chosen by asking whether
 * the teardown was a clean dispose. So a session killed by an uncaught exception and a session
 * whose terminal closed with nothing in flight both came out as `warn`. Measured across 19
 * profile logs before the fix: 23 exits at warn, 17 of them `sighup` with zero pending tool
 * calls and 4 of them `fatal`. The level that means "look at this" was carried by the records
 * that deserved it four times out of twenty-three, and a crash was indistinguishable from a
 * closed window.
 *
 * THE CLASS THIS CLOSES is not "sighup is too loud". It is that the severity of this record was
 * derived from one of the two facts it has (the kind of teardown) and ignored the other (whether
 * work was orphaned), while collapsing three distinct outcomes onto two levels. So the sweep
 * below enumerates `postmortem.Reason` from the enum at run time, crosses every member with both
 * transcript states, and pins the level for all of them. A reason added to `postmortem` fails
 * this suite until someone records what it means, which is the only thing that stops the next
 * member from inheriting whatever the fallback happens to be.
 *
 * WHAT IT DOES NOT CATCH. It asserts the level of one log line, not whether the line is written
 * at all on a path that never reaches `#recordSessionExit` (a `process.exit` that outruns the
 * postmortem list, an OOM kill, SIGKILL). Nothing in-process can record those.
 */
import { afterEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import type { AssistantMessage } from "@veyyon/ai";
import { getBundledModel } from "@veyyon/catalog/models";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { Settings } from "@veyyon/coding-agent/config/settings";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SESSION_EXIT_CUSTOM_TYPE, type SessionExitLogLevel } from "@veyyon/coding-agent/session/exit-diagnostics";
import { convertToLlm } from "@veyyon/coding-agent/session/messages";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { logger, postmortem, TempDir } from "@veyyon/utils";

const EXIT_MESSAGE = "Session exit recorded";

/** Every level the record can be written at, so a run can prove which one fired and which did not. */
const LEVELS: readonly SessionExitLogLevel[] = ["debug", "warn", "error"];

const emptyUsage = () => ({
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
});

/** An assistant turn that finished. Something must be in the transcript or no record is written at all. */
const settledAssistant = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "text", text: "done" }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: emptyUsage(),
	stopReason: "stop",
	timestamp: Date.now(),
});

/** An assistant turn that asked for a tool and never got a result: work the exit orphans. */
const pendingAssistant = (): AssistantMessage => ({
	role: "assistant",
	content: [{ type: "toolCall", id: "toolu_pending", name: "bash", arguments: { command: "sleep 30" } }],
	api: "anthropic-messages",
	provider: "anthropic",
	model: "mock",
	usage: emptyUsage(),
	stopReason: "toolUse",
	timestamp: Date.now(),
});

type Transcript = "settled" | "pending" | "empty";

/**
 * What the reason means, per transcript state. Keyed by the persisted reason string, which is
 * what the record itself carries, so the table reads the same way as the log line it governs.
 */
const EXPECTED_LEVEL: Record<string, { settled: SessionExitLogLevel; pending: SessionExitLogLevel }> = {
	// A programmatic dispose: `/quit`, a finished subagent, a test tearing down.
	dispose: { settled: "debug", pending: "warn" },
	[postmortem.Reason.MANUAL]: { settled: "debug", pending: "warn" },
	// The process is going away for a reason outside the session and nothing is lost.
	[postmortem.Reason.PRE_EXIT]: { settled: "debug", pending: "warn" },
	[postmortem.Reason.EXIT]: { settled: "debug", pending: "warn" },
	[postmortem.Reason.SIGINT]: { settled: "debug", pending: "warn" },
	[postmortem.Reason.SIGTERM]: { settled: "debug", pending: "warn" },
	[postmortem.Reason.SIGHUP]: { settled: "debug", pending: "warn" },
	// The session died on an unhandled throw. Nothing else in the log says so, because the
	// record is written from the teardown path and not from the thrower.
	[postmortem.Reason.UNCAUGHT_EXCEPTION]: { settled: "error", pending: "error" },
	[postmortem.Reason.UNHANDLED_REJECTION]: { settled: "error", pending: "error" },
};

interface ExitObservation {
	/** The level the record was written at, or undefined when nothing was recorded. */
	level: SessionExitLogLevel | undefined;
	/** Levels other than `level` that also carried the record. Must always be empty. */
	extraLevels: SessionExitLogLevel[];
	fields: Record<string, unknown> | undefined;
	/** The persisted diagnostic, so the level can be checked against the record it describes. */
	persisted: Record<string, unknown> | undefined;
}

describe("the severity of a recorded session exit", () => {
	const tempDirs: TempDir[] = [];
	let sharedAuth: AuthStorage | undefined;
	let sharedRegistry: ModelRegistry | undefined;

	afterEach(() => {
		vi.restoreAllMocks();
		sharedAuth?.close();
		sharedAuth = undefined;
		sharedRegistry = undefined;
		for (const dir of tempDirs.splice(0)) dir.removeSync();
	});

	/**
	 * Real `AgentSession`, real `SessionManager`, real `dispose`. The model registry is pinned at
	 * an absent temp path so construction does not read the developer's own models config once per
	 * swept reason.
	 */
	const registry = async (): Promise<ModelRegistry> => {
		if (sharedRegistry) return sharedRegistry;
		const dir = TempDir.createSync("@pi-exit-severity-");
		tempDirs.push(dir);
		sharedAuth = await AuthStorage.create(path.join(dir.path(), "auth.db"));
		sharedAuth.setRuntimeApiKey("anthropic", "test-key");
		sharedRegistry = new ModelRegistry(sharedAuth, path.join(dir.path(), "models.json"));
		return sharedRegistry;
	};

	const recordExit = async (
		reason: postmortem.Reason | "dispose",
		transcript: Transcript,
	): Promise<ExitObservation> => {
		const modelRegistry = await registry();
		const model = getBundledModel("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected the bundled anthropic model to exist");
		const dir = TempDir.createSync("@pi-exit-severity-session-");
		tempDirs.push(dir);
		const sessionManager = SessionManager.inMemory(dir.path());
		const agent = new Agent({
			initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] },
			convertToLlm,
		});
		const session = new AgentSession({
			agent,
			sessionManager,
			settings: Settings.isolated({ "compaction.enabled": false }),
			modelRegistry,
		});

		if (transcript !== "empty") {
			const message = transcript === "pending" ? pendingAssistant() : settledAssistant();
			agent.emitExternalEvent({ type: "message_end", message });
			// `message_end` persistence is fire-and-forget behind several awaits, so one tick is
			// not enough and a timer is not allowed. Drain microtasks until the entry lands, with
			// a bound: a persistence path that stops writing fails here rather than hanging.
			let drained = 0;
			while (drained < 500 && !sessionManager.getEntries().some(entry => entry.type === "message")) {
				await Promise.resolve();
				drained++;
			}
			expect(
				sessionManager.getEntries().some(entry => entry.type === "message"),
				`the ${transcript} assistant turn never reached the transcript`,
			).toBe(true);
		}

		const captured: Array<{ level: SessionExitLogLevel; fields: Record<string, unknown> | undefined }> = [];
		for (const level of LEVELS) {
			vi.spyOn(logger, level).mockImplementation(((message: string, fields?: Record<string, unknown>) => {
				if (message === EXIT_MESSAGE) captured.push({ level, fields });
			}) as unknown as typeof logger.warn);
		}

		await session.dispose(reason === "dispose" ? undefined : { reason });
		vi.restoreAllMocks();

		const entry = sessionManager
			.getEntries()
			.find(candidate => candidate.type === "custom" && candidate.customType === SESSION_EXIT_CUSTOM_TYPE);
		const persisted =
			entry?.type === "custom" && typeof entry.data === "object" && entry.data !== null
				? (entry.data as Record<string, unknown>)
				: undefined;
		const [first, ...rest] = captured;
		return {
			level: first?.level,
			extraLevels: rest.map(item => item.level),
			fields: first?.fields,
			persisted,
		};
	};

	/**
	 * FAIL BY DEFAULT. A reason added to `postmortem.Reason` has no entry here, so this goes red
	 * before it can inherit the fallback level by accident. Exact equality on purpose: a count or
	 * a subset check lets a new member ride in on the old number.
	 */
	it("names every teardown reason the process can hand the recorder", () => {
		const reasons = ["dispose", ...Object.values(postmortem.Reason)].sort();
		expect(Object.keys(EXPECTED_LEVEL).sort()).toEqual(reasons);
	});

	it("writes the record at one level, and it is the level the reason and the orphaned work imply", async () => {
		const observed = new Set<SessionExitLogLevel>();
		for (const [reason, expected] of Object.entries(EXPECTED_LEVEL)) {
			for (const transcript of ["settled", "pending"] as const) {
				const where = `${reason}/${transcript}`;
				const result = await recordExit(reason as postmortem.Reason | "dispose", transcript);
				expect(result.level, `${where} recorded no exit at all`).toBe(expected[transcript]);
				expect(result.extraLevels, `${where} logged the record more than once`).toEqual([]);
				expect(result.fields?.pendingToolCalls, `${where} pending count`).toBe(transcript === "pending" ? 1 : 0);
				expect(result.persisted?.reason, `${where} persisted reason`).toBe(reason);
				if (result.level) observed.add(result.level);
			}
		}
		// GREEN BY LUCK CONTROL: all three levels have to be reachable through the sweep, or the
		// table above could be satisfied by a ladder that answers with one or two of them.
		expect(observed).toEqual(new Set<SessionExitLogLevel>(["debug", "warn", "error"]));
	});

	/**
	 * The two axes are live independently. Both of these are rows of the sweep as well; stating
	 * them alone is what names the defect, so a reader of a failure knows which half broke.
	 */
	it("separates a crash from a closed terminal, and orphaned work from none", async () => {
		const crashed = await recordExit(postmortem.Reason.UNCAUGHT_EXCEPTION, "settled");
		const closed = await recordExit(postmortem.Reason.SIGHUP, "settled");
		const orphaned = await recordExit(postmortem.Reason.SIGHUP, "pending");

		expect(crashed.level).toBe("error");
		expect(closed.level).toBe("debug");
		expect(orphaned.level).toBe("warn");
		expect(crashed.persisted?.kind).toBe("fatal");
		expect(closed.persisted?.kind).toBe("signal");
		expect(orphaned.persisted?.kind).toBe("signal");
	});

	/**
	 * A session that never produced an assistant turn and orphaned nothing records nothing, at any
	 * level. Without this the sweep above could pass on a recorder that logs unconditionally.
	 */
	it("says nothing about a session that did nothing", async () => {
		const result = await recordExit(postmortem.Reason.SIGHUP, "empty");

		expect(result.level).toBeUndefined();
		expect(result.persisted).toBeUndefined();
	});
});
