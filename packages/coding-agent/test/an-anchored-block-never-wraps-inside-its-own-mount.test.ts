/**
 * Contract: a block anchored above the composer draws rows the component it is
 * MOUNTED IN can render without adding a row.
 *
 * THE DEFECT THIS CLOSES. Both anchored blocks clamp every row to
 * `columns - 1`, and both were handed `terminal.columns`. That is not the width
 * they get. They are mounted in a `Text` carrying `ANCHORED_BLOCK_PADDING_X` on
 * each side, and `Text` soft-wraps its content to `width - paddingX * 2` before
 * anything reaches the terminal, so every row was two cells too wide and its
 * tail landed on a row of its own — at the margin, outside the block's rail. A
 * real capture of two live lanes at 131 columns shows each lane's model badge
 * alone on the line under it. Neither block's own width sweep could see this:
 * both were obeying the bound they were given, and the bound was wrong.
 *
 * So the assertion here is not another width bound. It is the invariant those
 * bounds exist to serve, measured through the real mount: rendering the block
 * inside the component that mounts it produces exactly as many rows as the
 * block emitted. One extra row means one wrap.
 *
 * WHY IT SWEEPS THE CONTAINERS. The anchored region is whatever
 * `InteractiveMode` mounts into an `AnchoredLiveContainer`, and that set grows.
 * The sweep reads the containers off a constructed mode at run time and fails
 * when it finds one this file neither exercises nor names, so a seventh anchored
 * surface cannot be added with no one deciding whether it can wrap.
 *
 * WHAT IT DOES NOT CATCH, measured by mutation. Handing the block
 * `terminal.columns` is caught at both widths (four rows become six, one wrap
 * per lane). Handing it `columns - 1` instead of `columns - paddingX * 2` is NOT
 * caught, and is not a defect: the block already reserves its own last column,
 * so the two expressions produce the same widest row and neither can wrap. The
 * `* 2` stays because it is the truthful statement of what the mount takes.
 * Also uncaught: a block that silently truncated its own content to fit (the
 * assertion is on the row count, not on what the row says), and anything about
 * where the region is positioned once its rows are correct.
 */
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { renderSubagentHudLines } from "@veyyon/coding-agent/modes/terminal/components/dashboard/subagent-hud";
import { renderTodoBoardLines } from "@veyyon/coding-agent/modes/terminal/components/dashboard/todo-board";
import { ANCHORED_BLOCK_PADDING_X, InteractiveMode } from "@veyyon/coding-agent/modes/terminal/interactive-mode";
import type { ObservableSession } from "@veyyon/coding-agent/modes/terminal/session-observer-registry";
import { AgentSession } from "@veyyon/coding-agent/session/agent-session";
import { SessionManager } from "@veyyon/coding-agent/session/session-manager";
import { type SubagentProgressPayload, TASK_SUBAGENT_PROGRESS_CHANNEL } from "@veyyon/coding-agent/task";
import { initTheme, theme } from "@veyyon/coding-agent/theme/theme";
import type { TodoItem, TodoPhase } from "@veyyon/coding-agent/tools/agent/todo";
import { paintRailMotion, railIdleHeadAt } from "@veyyon/coding-agent/tui/rail-motion";
import { EventBus } from "@veyyon/coding-agent/utils/event-bus";
import { AuthStorage } from "@veyyon/kernel/session/auth-storage";
import { Text } from "@veyyon/tui";
import { TempDir } from "@veyyon/utils";
import { getPaddingX } from "@veyyon/utils/tight-mode";
import { visibleWidth } from "@veyyon/utils/width";

/** The width the mode hands a block, which is what the mount leaves it. */
function contentColumns(terminalColumns: number): number {
	return Math.max(1, terminalColumns - getPaddingX(ANCHORED_BLOCK_PADDING_X) * 2);
}

function phase(name: string, tasks: Array<[string, TodoItem["status"]]>): TodoPhase {
	return { name, tasks: tasks.map(([content, status]) => ({ content, status })) };
}

function laneSessions(): ObservableSession[] {
	// The shape the capture caught: two long CamelCase ids, one description that
	// runs past a lane's share of a wide terminal, and a resolved model badge —
	// which is the column that ended up on its own row.
	const base = {
		kind: "subagent" as const,
		status: "active" as const,
		detached: true,
		lastUpdate: 0,
	};
	return [
		{
			...base,
			id: "InsRatelimiter",
			label: "InsRatelimiter",
			description: "Inspect rate limiter implementation for one observation",
			progress: {
				index: 0,
				agent: "task",
				agentSource: "bundled",
				id: "InsRatelimiter",
				task: "Inspect rate limiter implementation for one observation",
				status: "running",
				resolvedModel: "local/demo-qwen38-27b-64k",
			},
		},
		{
			...base,
			id: "InsRatelimiterTest",
			label: "InsRatelimiterTest",
			description: "Review rate-limiter test coverage",
			progress: {
				index: 1,
				agent: "task",
				agentSource: "bundled",
				id: "InsRatelimiterTest",
				task: "Review rate-limiter test coverage",
				status: "running",
				currentTool: "read",
				currentToolArgs: "src/rate-limiter.test.ts",
				resolvedModel: "local/demo-qwen38-27b-64k",
			},
		},
	] as unknown as ObservableSession[];
}

const plan: readonly TodoPhase[] = [
	phase("Foundation and core architecture setup for the new subsystem", [
		["read the rate limiter and its test across multiple packages and directories", "completed"],
		["write the validating owner with exhaustive property assertions and invariant checks", "in_progress"],
		["implement fallback mechanisms for when rate limiting is temporarily degraded", "pending"],
	]),
	phase("Migration and rollout across all service endpoints", [
		["fan the edits out to three directories and update all caller signatures", "pending"],
	]),
	phase("Validation and comprehensive end-to-end integration tests", [
		["run the suite across full terminal width spectrum and advance the plan", "pending"],
	]),
];

/**
 * The anchored blocks this file drives, and the width each is asked for. Both
 * are painted the way their owner paints them, because the sweep is what turns
 * a settled row into a lit one and a lit row is a different string.
 */
const ANCHORED_BLOCKS: Record<string, { minColumns: number; build: (terminalColumns: number) => readonly string[] }> = {
	subagentContainer: {
		minColumns: 12,
		build: terminalColumns => {
			const lines = renderSubagentHudLines(laneSessions(), {
				columns: contentColumns(terminalColumns),
				showModelBadge: true,
			});
			return paintRailMotion(lines, { kind: "idle", head: railIdleHeadAt(4) }, theme);
		},
	},
	todoContainer: {
		minColumns: 21,
		build: terminalColumns =>
			renderTodoBoardLines(plan, {
				columns: contentColumns(terminalColumns),
				maxRows: 14,
				expanded: false,
				owned: new Set(["implement fallback mechanisms for when rate limiting is temporarily degraded"]),
				frame: 4,
				animate: true,
				live: true,
			}),
	},
};

/**
 * Anchored containers that mount no width-clamped block of their own, with the
 * reason each is exempt. Pinned by exact equality: a new anchored container is
 * a decision, and the suite goes red until someone records it here or drives it
 * above.
 */
const NOT_A_CLAMPED_BLOCK: Record<string, string> = {
	statusContainer: "the status line and the working loader, which own their own width",
	btwContainer: "one transient note, rendered by the transcript's own note component",
	omfgContainer: "one transient note, rendered by the transcript's own note component",
	errorBannerContainer: "the error banner, which is a bordered component and not a row list",
};

beforeAll(async () => {
	await initTheme();
});

describe("an anchored block never wraps inside its own mount", () => {
	it("mounts every anchored container this suite knows about", () => {
		expect(Object.keys(ANCHORED_BLOCKS).concat(Object.keys(NOT_A_CLAMPED_BLOCK)).sort()).toEqual([
			"btwContainer",
			"errorBannerContainer",
			"omfgContainer",
			"statusContainer",
			"subagentContainer",
			"todoContainer",
		]);
	});

	for (const [name, entry] of Object.entries(ANCHORED_BLOCKS)) {
		it(`${name} renders through its mount without gaining a row`, () => {
			for (let columns = entry.minColumns; columns <= 220; columns++) {
				const lines = entry.build(columns);
				if (lines.length === 0) continue;
				const usable = contentColumns(columns);
				for (const line of lines) {
					expect(visibleWidth(line)).toBeLessThanOrEqual(usable);
				}
				const mounted = new Text(lines.join("\n"), ANCHORED_BLOCK_PADDING_X, 0).render(columns);
				// A blank line inside a multi-line `Text` is a row, so the leading blank
				// every anchored block emits is one of them: the count is every line.
				expect({ columns, rows: mounted.length }).toEqual({ columns, rows: lines.length });
				for (const row of mounted) {
					expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(columns);
				}
			}
		});
	}
});

/**
 * The case above proves the arithmetic. This one proves the mode USES it: the
 * defect was a call site handing the block `terminal.columns`, and a block that
 * clamps correctly against a wrong number is exactly what shipped. So this
 * drives the real `InteractiveMode`, publishes two real subagent progress
 * events, and renders the container the mode mounted, at the width the mode was
 * told it had.
 */
describe("the live subagent HUD fits the width the mode reports", () => {
	let tempDir: TempDir;
	let authStorage: AuthStorage;
	let session: AgentSession;
	let mode: InteractiveMode;
	let eventBus: EventBus;

	beforeEach(async () => {
		resetSettingsForTest();
		tempDir = TempDir.createSync("@veyyon-anchored-wrap-");
		await Settings.init({ inMemory: true, cwd: tempDir.path(), overrides: { "startup.quiet": true } });
		authStorage = await AuthStorage.create(path.join(tempDir.path(), "testauth.db"));
		const modelRegistry = new ModelRegistry(authStorage);
		const model = modelRegistry.find("anthropic", "claude-sonnet-4-5");
		if (!model) throw new Error("Expected claude-sonnet-4-5 to exist in registry");
		eventBus = new EventBus();
		session = new AgentSession({
			agent: new Agent({ initialState: { model, systemPrompt: ["Test"], tools: [], messages: [] } }),
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

	// 131 is the width the capture that found this was taken at, and 80 is the
	// fallback a terminal with no reported size gets.
	for (const columns of [80, 131]) {
		it(`draws two lanes as two rows at ${columns} columns`, async () => {
			await mode.init();
			vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
			// `spyOn` cannot stub an accessor, and the terminal reports its width
			// through one. The own property dies with this test's own instance.
			Object.defineProperty(mode.ui.terminal, "columns", { get: () => columns, configurable: true });
			vi.useFakeTimers();

			for (const [index, lane] of laneSessions().entries()) {
				eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
					index,
					agent: "task",
					agentSource: "bundled",
					task: lane.description,
					parentToolCallId: "tool-call",
					detached: true,
					progress: lane.progress,
				} as SubagentProgressPayload);
			}
			await Promise.resolve();
			// Past the observer's coalesce window, and no further: the anchored rail
			// runs on a repeating interval, so draining every timer never returns.
			vi.advanceTimersByTime(500);
			await Promise.resolve();

			const rows = mode.subagentContainer.render(columns);
			// Blank, header, one row per lane. A third lane row means a wrap put a
			// lane's last column on a line of its own.
			expect(rows.length).toBe(4);
			for (const row of rows) expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(columns);
		});
	}

	it("strips literal newlines from subagent progress so no text leaks outside the block", async () => {
		await mode.init();
		vi.spyOn(mode.ui, "requestRender").mockImplementation(() => {});
		Object.defineProperty(mode.ui.terminal, "columns", { get: () => 100, configurable: true });
		vi.useFakeTimers();

		eventBus.emit(TASK_SUBAGENT_PROGRESS_CHANNEL, {
			index: 0,
			agent: "task",
			agentSource: "bundled",
			task: "Inspect\nrate\nlimiter",
			parentToolCallId: "tool-call-1",
			detached: true,
			progress: {
				index: 0,
				agent: "task",
				agentSource: "bundled",
				id: "MultilineTask",
				task: "Multiline\ntask\nwith\nnewlines",
				status: "running",
				currentTool: "bash\nexec",
				currentToolArgs: "echo hello\nrm -rf /tmp/leak\nexit 0",
				resolvedModel: "local/demo-model",
			},
		} as SubagentProgressPayload);

		await Promise.resolve();
		vi.advanceTimersByTime(500);
		await Promise.resolve();

		const rows = mode.subagentContainer.render(100);
		// Blank, header, exactly one lane row. Any unstripped newline would split the lane into multiple rows.
		expect(rows.length).toBe(3);
		for (const row of rows) {
			expect(row).not.toContain("\n");
			expect(row).not.toContain("\r");
			expect(Bun.stringWidth(Bun.stripANSI(row))).toBeLessThanOrEqual(100);
		}
		const laneRow = rows[2]!;
		expect(laneRow).toContain(theme.symbol("block.rail"));
		expect(laneRow).toContain("MultilineTask");
	});
});
