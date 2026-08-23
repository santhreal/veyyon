/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists running *detached* subagents under a railed "Subagents"
 * header, and yields no output once nothing qualifies, so the block
 * self-clears. Sync task spawns and eval `agent()` spawns are excluded: their
 * progress is already rendered inline (tool block / eval cell).
 *
 * Each row is `<rail> <dot> <id>: <description> · <modelBadge>`. Tree connectors
 * (├, └, │) and task prompts (progress.task) are excluded.
 *
 * The class of defect this file exists to close is a row that does not fit: this
 * block is an anchored live region, so a row wider than the viewport does not
 * scroll away — it wraps, and the region grows taller on every rebuild until it
 * eats the screen. Every case that renders asserts the width bound (`columns - 1`),
 * and `fitsIn` is the single place that check lives.
 *
 * The block's motion is the rail sweep painted with `paintRailMotion`, gated by
 * the `lit` flags the renderer returns (one per railed row: header, agent rows,
 * and overflow row).
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import {
	renderSubagentHudLines,
	SUBAGENT_HUD_VISIBLE_LIMIT,
} from "@veyyon/coding-agent/modes/components/subagent-hud";
import { InteractiveMode, SUBAGENT_OBSERVER_UI_COALESCE_MS } from "@veyyon/coding-agent/modes/interactive-mode";
import { type ObservableSession, SessionObserverRegistry } from "@veyyon/coding-agent/modes/session-observer-registry";
import { initTheme, theme } from "@veyyon/coding-agent/modes/theme/theme";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { AuthStorage } from "@veyyon/coding-agent/session/auth-storage";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import {
	type AgentProgress,
	type SubagentLifecyclePayload,
	type SubagentProgressPayload,
	TASK_SUBAGENT_LIFECYCLE_CHANNEL,
	TASK_SUBAGENT_PROGRESS_CHANNEL,
} from "@veyyon/coding-agent/task";
import { paintRailMotion, railIdleHeadAt } from "@veyyon/coding-agent/tui/rail-motion";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { type AnsiPolicy, getAnsiPolicy, setAnsiPolicy } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";

function makeSession(overrides: Partial<ObservableSession> & { id: string }): ObservableSession {
	return {
		kind: "subagent",
		label: overrides.id,
		status: "active",
		detached: true,
		lastUpdate: Date.now(),
		...overrides,
	};
}

function makeProgress(overrides: Partial<AgentProgress> & { id: string }): AgentProgress {
	return {
		index: 0,
		agent: "task",
		agentSource: "bundled",
		status: "running",
		task: "",
		recentTools: [],
		recentOutput: [],
		toolCount: 0,
		requests: 0,
		tokens: 0,
		cost: 0,
		durationMs: 0,
		...overrides,
	};
}

function makeLifecycle(id: string, index: number, description: string, detached?: boolean): SubagentLifecyclePayload {
	return {
		id,
		index,
		agent: "task",
		agentSource: "bundled",
		description,
		status: "started",
		parentToolCallId: "tool-call",
		detached,
	};
}

function makeProgressPayload(
	id: string,
	index: number,
	description: string,
	detached?: boolean,
): SubagentProgressPayload {
	return {
		index,
		agent: "task",
		agentSource: "bundled",
		task: description,
		parentToolCallId: "tool-call",
		detached,
		progress: makeProgress({ id, index, description, task: description }),
	};
}

/** The block's own bytes, stripped, for a terminal `columns` wide. */
function renderAt(sessions: ObservableSession[], columns = 120, showModelBadge = true): string {
	return Bun.stripANSI(renderSubagentHudLines(sessions, { columns, showModelBadge }).lines.join("\n"));
}
/** The whole block, unstripped, for the cases that assert on colour or motion. */
function block(sessions: ObservableSession[], columns = 120) {
	return renderSubagentHudLines(sessions, { columns, showModelBadge: true });
}

/**
 * Assert every row fits, and return the text so a case reads as one expression.
 *
 * The last column is deliberately left clear — a row that fills it arms the
 * terminal's pending wrap — so the bound is `columns - 1`, not `columns`.
 */
function fitsIn(out: string, columns: number): string {
	for (const line of out.split("\n")) expect(Bun.stringWidth(line)).toBeLessThanOrEqual(columns - 1);
	return out;
}

/** The agent row naming `id`, without the leading rail and its space. */
function rowFor(out: string, id: string): string {
	return (out.split("\n").find(line => line.includes(id)) ?? "").replace(/^▏\s*/, "");
}

describe("subagent HUD lines", () => {
	let policy: AnsiPolicy;
	beforeAll(async () => {
		await initTheme();
		policy = getAnsiPolicy();
		setAnsiPolicy("full");
	});
	afterAll(() => {
		setAnsiPolicy(policy);
	});

	/**
	 * `Subagents` is the whole header, preceded by a blank line. A count is not
	 * news next to the rows that ARE the agents; the one place a number says
	 * something the rows cannot is when the block stopped drawing some of them.
	 */
	it("renders running subagents under a blank line and a bare Subagents header", () => {
		const blockResult = block([
			makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
			makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
		]);
		expect(blockResult.lines[0]).toBe("");
		expect(blockResult.lines[1]).toContain("Subagents");

		const out = fitsIn(Bun.stripANSI(blockResult.lines.join("\n")), 120);
		const lines = out.split("\n");
		expect(lines[0]).toBe("");
		expect(lines[1]).toBe("▏ Subagents");
		expect(out).not.toContain("2 running");
		expect(rowFor(out, "AuthLoader")).toContain("AuthLoader");
		expect(rowFor(out, "AuthLoader")).toContain("Refactoring the auth flow");
		expect(rowFor(out, "SchemaMigrator")).toContain("Migrating the users table");
		for (const line of lines.slice(1)) {
			expect(line.startsWith("▏ ")).toBe(true);
		}
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(block(sessions).lines).toEqual([]);

		const out = renderAt([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(rowFor(out, "StillRunning")).toContain("live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("falls back to the description carried by progress snapshots but never uses task", () => {
		const fromProgressDesc = renderAt([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expect(rowFor(fromProgressDesc, "Worker")).toContain("From progress");

		const fromTask = renderAt([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		// progress.task is the prompt and is never drawn
		expect(rowFor(fromTask, "Worker")).not.toContain("Investigate flaky CI on macOS");
		expect(rowFor(fromTask, "Worker")).toBe("▪ Worker");
	});

	it("draws no tree connectors and never draws progress.task", () => {
		const out = renderAt([
			makeSession({
				id: "WorkerA",
				description: "first worker",
				progress: makeProgress({ id: "WorkerA", task: "Secret task prompt for A" }),
			}),
			makeSession({
				id: "WorkerB",
				description: "second worker",
				progress: makeProgress({ id: "WorkerB", task: "Secret task prompt for B" }),
			}),
		]);
		expect(out).not.toContain("├");
		expect(out).not.toContain("└");
		expect(out).not.toContain("│");
		expect(out).not.toContain("Secret task prompt");
	});

	/**
	 * A tool argument is not drawn at all, so no argument can push a row past the
	 * viewport and no argument can put text outside the block. Real newlines in
	 * descriptions or tool arguments are folded so no text leaks outside the rail.
	 */
	it("draws no tool argument, at any length and with any newline in it", () => {
		const out = fitsIn(
			renderAt(
				[
					makeSession({
						id: "Worker",
						description: "audit secrets",
						progress: makeProgress({
							id: "Worker",
							currentTool: "bash",
							currentToolArgs: `cargo ${"x".repeat(300)} end`,
						}),
					}),
				],
				80,
			),
			80,
		);
		expect(rowFor(out, "Worker")).toContain("audit secrets");
		expect(out).not.toContain("end");
		expect(out).not.toContain("cargo");

		const multiline = block(
			[
				makeSession({
					id: "Worker",
					description: "run the sandbox\nsecond line of a description",
					progress: makeProgress({ id: "Worker", currentTool: "bash", currentToolArgs: "bun -e '\nimport x'" }),
				}),
			],
			80,
		);
		// Blank line, header, exactly one agent row.
		expect(multiline.lines.length).toBe(3);
		for (const line of multiline.lines) expect(line).not.toContain("\n");
		expect(multiline.lines[2]).toContain("run the sandbox second line of a description");
	});

	it("hides non-detached spawns: sync task calls and eval agent() helpers", () => {
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
		];
		expect(block(sessions).lines).toEqual([]);

		const out = renderAt([...sessions, makeSession({ id: "BackgroundSpawn", description: "detached work" })]);
		expect(rowFor(out, "BackgroundSpawn")).toContain("detached work");
		expect(out).not.toContain("SyncSpawn");
		expect(out).not.toContain("EvalSpawn");
	});

	it("threads the detached flag from lifecycle and progress payloads", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);

		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Detached", 0, "background work", true));
		eventBus.emit(TASK_SUBAGENT_LIFECYCLE_CHANNEL, makeLifecycle("Inline", 1, "sync work"));
		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, makeProgressPayload("FromProgress", 2, "background work", true));

		const out = renderAt(registry.getSessions());
		expect(rowFor(out, "Detached")).toContain("background work");
		expect(rowFor(out, "FromProgress")).toContain("background work");
		expect(out).not.toContain("Inline");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = fitsIn(
			renderAt([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60),
			60,
		);
		expect(out).toContain("Anna>Bob");
		expect(out).not.toContain("end");
	});

	it("keeps subagent registry order stable while progress arrives out of order", () => {
		const eventBus = new EventBus();
		const registry = new SessionObserverRegistry();
		registry.subscribeToEventBus(eventBus);
		const activeIds = () =>
			registry
				.getSessions()
				.filter(session => session.kind === "subagent" && session.status === "active")
				.map(session => session.id);

		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("SelectorSurfaces", 0, "Map model-selector resolution surfaces"),
		);
		eventBus.emit(
			TASK_SUBAGENT_LIFECYCLE_CHANNEL,
			makeLifecycle("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);

		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("VariantsSurvey", 2, "Survey tier-variant ids across catalog"),
		);
		eventBus.emit(
			TASK_SUBAGENT_PROGRESS_CHANNEL,
			makeProgressPayload("BlastRadius", 1, "Survey id-keyed downstream consumers"),
		);

		expect(activeIds()).toEqual(["SelectorSurfaces", "BlastRadius", "VariantsSurvey"]);
	});

	it("ends each row with the model the agent is running on", () => {
		const out = renderAt([
			makeSession({
				id: "AuthLoader",
				description: "Refactoring the auth flow",
				progress: makeProgress({ id: "AuthLoader", resolvedModel: "anthropic/claude-sonnet-4-5:high" }),
			}),
		]);
		expect(rowFor(out, "AuthLoader")).toMatch(/claude-sonnet-4-5 high$/);
		expect(out).not.toContain("anthropic/");
		expect(out).not.toContain(":high");
	});

	it("hides the badge when subagent.showResolvedModelBadge is off", () => {
		const sessions = [
			makeSession({
				id: "AuthLoader",
				description: "Refactoring the auth flow",
				progress: makeProgress({ id: "AuthLoader", resolvedModel: "anthropic/claude-sonnet-4-5:high" }),
			}),
		];
		const out = renderAt(sessions, 120, false);
		expect(out).not.toContain("claude-sonnet-4-5");
		expect(rowFor(out, "AuthLoader")).toContain("Refactoring the auth flow");
	});

	it("leaves no empty slot or trailing whitespace when the agent has reported no model", () => {
		const out = renderAt([makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" })]);
		for (const line of out.split("\n")) expect(line).toBe(line.trimEnd());
	});

	it("marks an agent that fell back to a later model in its chain", () => {
		const plain = renderAt([
			makeSession({
				id: "AuthLoader",
				description: "work",
				progress: makeProgress({ id: "AuthLoader", resolvedModel: "anthropic/claude-sonnet-4-5" }),
			}),
		]);
		const fellBack = renderAt([
			makeSession({
				id: "AuthLoader",
				description: "work",
				progress: makeProgress({
					id: "AuthLoader",
					resolvedModel: "anthropic/claude-sonnet-4-5",
					fellBackFrom: "anthropic/claude-opus-4-1",
				}),
			}),
		]);
		expect(plain).not.toContain("↓");
		expect(fellBack).toContain("↓claude-sonnet-4-5");
	});

	it("keeps the badge and truncates the description when the row is crowded", () => {
		const out = fitsIn(
			renderAt(
				[
					makeSession({
						id: "AuthLoader",
						description: `start ${"x".repeat(300)} end`,
						progress: makeProgress({ id: "AuthLoader", resolvedModel: "anthropic/claude-sonnet-4-5" }),
					}),
				],
				120,
			),
			120,
		);
		expect(out).toContain("claude-sonnet-4-5");
		expect(out).not.toContain("end");
	});

	it("drops the badge instead of wrapping the row on a narrow terminal", () => {
		const sessions = [
			makeSession({
				id: "AuthLoader",
				description: "Refactoring the auth flow",
				progress: makeProgress({ id: "AuthLoader", resolvedModel: "anthropic/claude-sonnet-4-5" }),
			}),
		];
		const hasBadge = (columns: number) => renderAt(sessions, columns).includes("claude-sonnet-4-5");
		let cut = 0;
		for (let columns = 1; columns <= 200; columns++) {
			if (hasBadge(columns)) {
				cut = columns;
				break;
			}
		}
		expect(cut).toBeGreaterThan(0);
		expect(hasBadge(cut - 1)).toBe(false);
		fitsIn(renderAt(sessions, cut), cut);
		fitsIn(renderAt(sessions, cut - 1), cut - 1);
	});

	it("fits every terminal width, for every combination of columns it can draw", () => {
		const sessions = [
			makeSession({
				id: "DeeplyNested.SubAgent.WithALongName",
				description: `start ${"d".repeat(300)} end`,
				progress: makeProgress({
					id: "DeeplyNested.SubAgent.WithALongName",
					currentTool: "bash",
					currentToolArgs: `cargo ${"a".repeat(300)}`,
					durationMs: 3_600_000 + 61_000,
					contextTokens: 190_000,
					contextWindow: 200_000,
					resolvedModel: "anthropic/claude-sonnet-4-5:high",
					fellBackFrom: "anthropic/claude-opus-4-1",
				}),
			}),
			makeSession({ id: "Short", description: "waiting on the model" }),
		];
		for (let columns = 1; columns <= 220; columns++) {
			const blockResult = block(sessions, columns);
			const painted = paintRailMotion(
				blockResult.lines,
				{ kind: "idle", head: railIdleHeadAt(4) },
				theme,
				{ lit: index => blockResult.lit[index] === true },
			);
			for (const line of painted) {
				expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(columns - 1);
			}
			if (columns <= 5) {
				expect(blockResult.lines).toEqual([]);
				expect(blockResult.lit).toEqual([]);
			} else {
				expect(blockResult.lines.length).toBeGreaterThan(0);
			}
		}
	});

	it("aligns rail and lit flags index-for-index across railed rows", () => {
		const sessions = [
			makeSession({
				id: "Working",
				progress: makeProgress({ id: "Working", currentTool: "bash", currentToolArgs: "cargo test" }),
			}),
			makeSession({ id: "Waiting", description: "waiting on the model" }),
			makeSession({
				id: "Sleeping",
				progress: makeProgress({
					id: "Sleeping",
				}),
			}),
		];
		const built = block(sessions);
		// lines[0] is "", lines[1] is header, lines[2..4] are agents.
		expect(built.lines.length).toBe(5);
		// lit aligns index-for-index with the 4 railed rows (header + 3 agents).
		expect(built.lit.length).toBe(4);
		// Header is lit because Working has a tool; Working is lit; Waiting and Sleeping are not.
		expect(built.lit).toEqual([true, true, false, false]);

		// When no session has an active tool, everything is unlit.
		const idleSessions = [
			makeSession({ id: "WaitingA", description: "idle work" }),
			makeSession({ id: "WaitingB", description: "idle work" }),
		];
		const idleBuilt = block(idleSessions);
		expect(idleBuilt.lit).toEqual([false, false, false]);

		// paintRailMotion with all-false lit returns settled bytes matching unpainted lines
		const settled = paintRailMotion(
			idleBuilt.lines,
			{ kind: "idle", head: railIdleHeadAt(4) },
			theme,
			{ lit: index => idleBuilt.lit[index] === true },
		);
		expect(settled).toEqual(idleBuilt.lines);

		// Motion test across animation frames: idle agent's line is static, active agent's line animates
		const rowAt = (id: string, frame: number | undefined): string => {
			const lines =
				frame === undefined
					? built.lines
					: paintRailMotion(built.lines, { kind: "idle", head: railIdleHeadAt(frame) }, theme, {
							lit: index => built.lit[index] === true,
						});
			return lines.find(line => line.includes(id)) ?? "";
		};
		const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		expect(new Set(frames.map(frame => rowAt("Waiting", frame))).size).toBe(1);
		expect(new Set(frames.map(frame => rowAt("Sleeping", frame))).size).toBe(1);
		expect(new Set(frames.map(frame => rowAt("Working", frame))).size).toBeGreaterThan(1);
	});

	it("renders the first eight active detached subagents and summarizes the rest", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({ id: `Worker${index}`, description: `job ${index}` }),
		);

		const built = block(active, 120);
		// 1 blank + 1 header + 8 agents + 1 overflow = 11 lines
		expect(built.lines.length).toBe(11);
		// lit has 1 header + 8 agents + 1 overflow = 10 entries (all false since idle)
		expect(built.lit.length).toBe(10);
		expect(built.lit.every(l => l === false)).toBe(true);

		const out = fitsIn(renderAt(active, 120), 120);
		for (const session of active.slice(0, 8))
			expect(rowFor(out, session.id)).toContain(`job ${session.id.slice(6)}`);
		for (const session of active.slice(8)) expect(out).not.toContain(session.id);
		expect(out).toContain(`… 2 more running — /agents for the full roster`);
	});
});

describe("InteractiveMode subagent observer UI sync", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeAll(async () => {
		await initTheme();
	});

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@pi-subagent-observer-");
		await Settings.init({
			inMemory: true,
			cwd: tempDir.path(),
			overrides: { "startup.quiet": true },
		});
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");

		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({
				initialState: {
					model,
					systemPrompt: ["Test"],
					tools: [],
					messages: [],
				},
			}),
			sessionManager: SessionManager.create(tempDir.path(), tempDir.path()),
			settings: Settings.isolated({ "startup.quiet": true }),
			modelRegistry,
		});
		mode = new InteractiveMode(session, "test", undefined, undefined, undefined, eventBus);
	});

	afterEach(async () => {
		mode?.stop();
		await session?.dispose();
		authStorage?.close();
		tempDir?.removeSync();
		vi.useRealTimers();
		vi.restoreAllMocks();
		resetSettingsForTest();
	});

	it("coalesces a burst of progress observer changes into one HUD rebuild and render request", async () => {
		await mode.init();
		const requestRender = vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		const rebuildHud = vi.spyOn(mode.subagentContainer, "clear");
		vi.useFakeTimers();

		for (let index = 0; index < 6; index++) {
			eventBus.emit(
				TASK_SUBAGENT_PROGRESS_CHANNEL,
				makeProgressPayload(`BurstAgent${index}`, index, `Burst job ${index}`, true),
			);
		}

		await Promise.resolve();
		vi.advanceTimersByTime(SUBAGENT_OBSERVER_UI_COALESCE_MS);
		await Promise.resolve();

		const rows = Bun.stripANSI(mode.subagentContainer.render(120).join("\n")).split("\n");
		const rowMatches = (id: string, activity: string): boolean =>
			rows.some(row => row.trimStart().startsWith("▏ ") && row.includes(id) && row.includes(activity));
		expect(rowMatches("BurstAgent0", "Burst job 0")).toBe(true);
		expect(rowMatches("BurstAgent5", "Burst job 5")).toBe(true);
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
