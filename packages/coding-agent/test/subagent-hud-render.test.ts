/**
 * Contract: the anchored subagent HUD (rendered above the editor, next to the
 * Todos block) lists exactly the running *detached* subagents as one aligned
 * LANE each, and yields no output once nothing qualifies, so the block
 * self-clears. Sync task spawns and eval `agent()` spawns are excluded: their
 * progress is already rendered inline (tool block / eval cell).
 *
 * A lane is `<rail> <id> <activity> <badge>`, dropping columns from the right
 * when the terminal is narrow. The class of defect this file exists to close is
 * a row that does not fit: this block is an anchored live region, so a row wider
 * than the viewport does not scroll away — it wraps, and the region grows taller
 * on every rebuild until it eats the screen. Every case that renders asserts the
 * width bound, and `fitsIn` is the single place that check lives so no new case
 * can forget it.
 *
 * The block's one motion is the rail sweep its caller paints with
 * `paintRailMotion`, gated by the `lit` flags the renderer returns, so the cases
 * about motion drive that real owner rather than a copy of its arithmetic.
 *
 * What it does not catch: the rasterized appearance of a lane (colour, contrast,
 * whether the sweep reads as motion at all). That is what the image proofs from
 * `scripts/demos/render-subagent-lanes.ts` are for.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "bun:test";
import * as path from "node:path";
import { Agent } from "@veyyon/agent-core";
import { ModelRegistry } from "@veyyon/coding-agent/config/model-registry";
import { resetSettingsForTest, Settings } from "@veyyon/coding-agent/config/settings";
import { renderSubagentLaneLines } from "@veyyon/coding-agent/modes/components/subagent-lanes";
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
function renderAt(sessions: ObservableSession[], columns: number, showModelBadge = true): string {
	return Bun.stripANSI(renderSubagentLaneLines(sessions, { columns, showModelBadge, nowMs: 0 }).lines.join("\n"));
}

function render(sessions: ObservableSession[], columns = 120): string {
	return renderAt(sessions, columns);
}

/** The whole block, unstripped, for the cases that assert on colour or motion. */
function block(sessions: ObservableSession[], columns = 120) {
	return renderSubagentLaneLines(sessions, { columns, showModelBadge: true, nowMs: 0 });
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

/** The lane row naming `id`, without the leading rail and its space. */
function laneFor(out: string, id: string): string {
	return (out.split("\n").find(line => line.includes(id)) ?? "").trimStart().slice(2);
}

describe("subagent HUD lines", () => {
	// The block's motion IS its bytes, and a test runner has no TTY, so the
	// theme's own detector answers "plain" and every colour these cases exist to
	// assert would be stripped before the assertion saw it. `setAnsiPolicy` is the
	// documented override; the previous value is restored so nothing that runs
	// after this file inherits a policy it did not ask for.
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
	 * `Subagents` is the whole header. A count there is not news next to the rows
	 * that ARE the agents, and it cost a column of the widest row in the block; the
	 * one place a number says something the lanes cannot is when the block stopped
	 * drawing some of them, which is the overflow row's case below.
	 */
	it("renders one lane per running subagent under a bare Subagents header", () => {
		const out = fitsIn(
			render([
				makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" }),
				makeSession({ id: "SchemaMigrator", description: "Migrating the users table" }),
			]),
			120,
		);
		expect(out.split("\n").map(line => line.trim())).toContain("Subagents");
		expect(out).not.toContain("2 running");
		expect(laneFor(out, "AuthLoader")).toContain("AuthLoader");
		expect(laneFor(out, "AuthLoader")).toContain("Refactoring the auth flow");
		expect(laneFor(out, "SchemaMigrator")).toContain("Migrating the users table");
	});

	it("only shows active subagents and clears once everything finished", () => {
		const finishedStates = ["completed", "failed", "aborted"] as const;
		const sessions: ObservableSession[] = [
			{ id: "main", kind: "main", label: "Main Session", status: "active", lastUpdate: Date.now() },
			...finishedStates.map(status => makeSession({ id: `Done-${status}`, status, description: "old work" })),
		];
		expect(block(sessions).lines).toEqual([]);

		const out = render([...sessions, makeSession({ id: "StillRunning", description: "live work" })]);
		expect(laneFor(out, "StillRunning")).toContain("live work");
		expect(out).not.toContain("Done-");
		expect(out).not.toContain("Main Session");
	});

	it("falls back to the description and task carried by progress snapshots", () => {
		const fromProgressDesc = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", description: "From progress" }) }),
		]);
		expect(laneFor(fromProgressDesc, "Worker")).toContain("From progress");

		const fromTask = render([
			makeSession({ id: "Worker", progress: makeProgress({ id: "Worker", task: "Investigate flaky CI on macOS" }) }),
		]);
		expect(laneFor(fromTask, "Worker")).toContain("Investigate flaky CI on macOS");
	});

	/**
	 * The middle column is one slot carrying two different facts, and which one it
	 * carries is the agent's state. THE defect this closes: the old row printed
	 * the id, the description and the model badge, all three constant for the
	 * agent's whole life, so an agent ninety seconds into a single command and one
	 * that had just started rendered byte-identical.
	 */
	it("says what a working agent is doing, and what an idle one is for", () => {
		const working = render([
			makeSession({
				id: "Worker",
				description: "Audit the secrets subsystem",
				progress: makeProgress({ id: "Worker", currentTool: "bash", currentToolArgs: "cargo test --workspace" }),
			}),
		]);
		const lane = laneFor(working, "Worker");
		expect(lane).toContain("bash cargo test --workspace");
		// The description is what the id already implies; the live tool is not.
		expect(lane).not.toContain("Audit the secrets subsystem");

		const idle = render([makeSession({ id: "Worker", description: "Audit the secrets subsystem" })]);
		expect(laneFor(idle, "Worker")).toContain("Audit the secrets subsystem");
	});

	/**
	 * The tool NAME never truncates and the argument absorbs the whole squeeze:
	 * `read` with no path still says what kind of work is in flight, while a
	 * truncated `rea` says nothing at all.
	 */
	it("keeps the tool name whole and spends the squeeze on its arguments", () => {
		const out = fitsIn(
			render(
				[
					makeSession({
						id: "Worker",
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
		expect(laneFor(out, "Worker")).toContain("bash");
		expect(out).not.toContain("end");
	});

	it("hides non-detached spawns: sync task calls and eval agent() helpers", () => {
		// Sync task spawn (parent blocked on the call) and eval `agent()` spawn
		// (no detached flag at all) both stay off the HUD.
		const sessions = [
			makeSession({ id: "SyncSpawn", description: "inline task work", detached: false }),
			makeSession({ id: "EvalSpawn", description: "eval cell work", detached: undefined }),
		];
		expect(block(sessions).lines).toEqual([]);

		const out = render([...sessions, makeSession({ id: "BackgroundSpawn", description: "detached work" })]);
		expect(laneFor(out, "BackgroundSpawn")).toContain("detached work");
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

		const out = render(registry.getSessions());
		expect(laneFor(out, "Detached")).toContain("background work");
		expect(laneFor(out, "FromProgress")).toContain("background work");
		expect(out).not.toContain("Inline");
	});

	it("renders nested ids as a breadcrumb and truncates long descriptions to the viewport", () => {
		const out = fitsIn(
			render([makeSession({ id: "Anna.Bob", description: `start ${"x".repeat(300)} end` })], 60),
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

	/**
	 * The HUD showed no model at all: you could see four agents running and had
	 * no way to tell which model any of them was on without opening `/agents`.
	 * The badge comes from `modelBadgeFromSelector`, the one formatter, so the
	 * provider prefix is stripped and the thinking level renders as a word
	 * rather than the raw `anthropic/sonnet-4-6:high` selector the executor
	 * reports.
	 */
	it("ends each lane with the model the agent is running on", () => {
		const out = render([
			makeSession({
				id: "AuthLoader",
				description: "Refactoring the auth flow",
				progress: makeProgress({ id: "AuthLoader", resolvedModel: "anthropic/claude-sonnet-4-5:high" }),
			}),
		]);
		expect(laneFor(out, "AuthLoader")).toMatch(/claude-sonnet-4-5[^\n]*$/);
		expect(out).not.toContain("anthropic/");
		expect(out).not.toContain(":high");
	});

	/**
	 * `subagent.showResolvedModelBadge` is the ONE gate for this badge on every
	 * surface that prints it (inline task widget, `/agents` roster, this HUD).
	 * Turning it off has to hide it here too, or the setting lies about what it
	 * controls.
	 */
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
		expect(laneFor(out, "AuthLoader")).toContain("Refactoring the auth flow");
	});

	/**
	 * An agent that has not reported a model yet (spawned, no first response)
	 * leaves no empty slot and no trailing whitespace: the lane ends at its last
	 * column with content in it. A row padded out to the viewport is what turns
	 * a themed background into a slab.
	 */
	it("leaves no empty slot or trailing whitespace when the agent has reported no model", () => {
		const out = render([makeSession({ id: "AuthLoader", description: "Refactoring the auth flow" })]);
		for (const line of out.split("\n")) expect(line).toBe(line.trimEnd());
	});

	/**
	 * An agent that fell back to another entry in its model chain is marked, so
	 * "why is this one slower than its peers" is answerable from the HUD. The
	 * badge alone reads as a deliberate choice; the arrow says it was not.
	 */
	it("marks an agent that fell back to a later model in its chain", () => {
		const plain = render([
			makeSession({
				id: "AuthLoader",
				description: "work",
				progress: makeProgress({ id: "AuthLoader", resolvedModel: "anthropic/claude-sonnet-4-5" }),
			}),
		]);
		const fellBack = render([
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

	/**
	 * The badge is fixed cost and the description is elastic, so the badge comes
	 * out of the row budget first: it survives a long description, the
	 * description truncates around it, and the row still fits the viewport.
	 */
	it("keeps the badge and truncates the description when the row is crowded", () => {
		const out = fitsIn(
			render(
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

	/**
	 * On a narrow terminal the badge is dropped rather than wrapping the row, the
	 * same rule the `/agents` roster applies to a narrow card. A wrapped HUD row
	 * pushes the composer down and is worse than not knowing the model.
	 *
	 * The boundary is DERIVED, not named. The first cut of this case asserted the
	 * badge was gone at 60 columns, where this session's short id leaves room for
	 * all of it — so it failed against correct code and would have been "fixed"
	 * by putting the floor back. What matters is not which width drops the badge
	 * but that the transition is a drop: one column below the last width that
	 * fits the badge, the badge is gone and the row still fits.
	 */
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
		// A badge that never appears would pass a one-sided assertion vacuously.
		expect(cut).toBeGreaterThan(0);
		expect(hasBadge(cut - 1)).toBe(false);
		fitsIn(renderAt(sessions, cut), cut);
		fitsIn(renderAt(sessions, cut - 1), cut - 1);
	});

	/**
	 * THE defect this file exists for, and the reason it is a sweep rather than
	 * one width. The first cut of the lane layout floored the middle column at
	 * `TRUNCATE_LENGTHS.SHORT` (40) after charging every fixed column, so at 100
	 * columns the budget was 37 and every row ran exactly 3 cells past the
	 * viewport. It looked right at the width it was developed at, which is how a
	 * single-width test lets this class through: the overshoot is
	 * `max(0, FLOOR - available)`, so it is invisible wherever `available >= FLOOR`
	 * and appears the moment the terminal gets narrower or a column gets wider.
	 *
	 * Every width from a 3-cell-wide terminal up, against the worst row this block
	 * can be asked to draw: long ids, a long tool argument, a long description, a
	 * badge, a fallback arrow and a trace, all at once.
	 */
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
			const painted = paintRailMotion(
				block(sessions, columns).lines,
				{ kind: "idle", head: railIdleHeadAt(4) },
				theme,
			);
			for (const line of painted) {
				// The bound is `columns - 1` at EVERY width, with no floor anywhere: the
				// block returns nothing at all rather than drawing chrome that does not
				// fit. An expectation with its own floor in it would have accepted the
				// very overflow this case exists to catch.
				expect(Bun.stringWidth(Bun.stripANSI(line))).toBeLessThanOrEqual(columns - 1);
			}
		}
	});

	/**
	 * Columns are dropped from the right in cheapest-first order, and the order is
	 * the point: the badge is a name constant for the agent's whole run, while the
	 * activity column is the one that says what the agent is doing right now. A
	 * ladder that dropped them the other way would keep the least informative
	 * column on the narrowest terminal.
	 */
	it("drops the badge before the activity, and never puts one back", () => {
		const sessions = [
			makeSession({
				id: "AuthLoader",
				description: "Refactoring the auth flow",
				progress: makeProgress({
					id: "AuthLoader",
					currentTool: "bash",
					durationMs: 64_000,
					resolvedModel: "anthropic/claude-sonnet-4-5",
				}),
			}),
		];
		// Swept rather than sampled at chosen widths. Sampling asserts the
		// arithmetic that happens to hold today — the first cut of this case guessed
		// the badge was gone by 70 columns when it still fits — while the ladder is a
		// claim about ORDER, which holds at every width or not at all.
		const seen: string[] = [];
		for (let columns = 200; columns >= 1; columns--) {
			const out = fitsIn(renderAt(sessions, columns), columns);
			const state = [out.includes("claude-sonnet-4-5") ? "badge" : "", out.includes("bash") ? "activity" : ""]
				.filter(Boolean)
				.join("+");
			if (seen.at(-1) !== state) seen.push(state);
		}
		// Each column leaves exactly once, in this order, and none returns.
		expect(seen).toEqual(["badge+activity", "activity", ""]);
	});

	/**
	 * The middle column answers one question with the most urgent fact it has:
	 * blocked, then doing, then what the agent is FOR, then nothing to say. The
	 * order is the contract, because every lower rank is still true when a higher
	 * one is — an agent asleep on a 429 also has a description — and the row that
	 * printed the description while the agent was not running is the defect this
	 * closes: it was byte-identical to an agent thinking.
	 */
	it("shows a recovery over a tool, a tool over a description, and a description over waiting", () => {
		const out = render([
			makeSession({
				id: "Sleeping",
				description: "port the vault reader",
				progress: makeProgress({
					id: "Sleeping",
					currentTool: "bash",
					currentToolArgs: "cargo test",
					retryState: {
						attempt: 2,
						maxAttempts: 5,
						delayMs: 38_000,
						errorMessage: "429 rate limit",
						startedAtMs: 0,
					},
				}),
			}),
			makeSession({
				id: "Working",
				description: "port the vault reader",
				progress: makeProgress({ id: "Working", currentTool: "read", currentToolArgs: "settings.ts" }),
			}),
			makeSession({ id: "Thinking", description: "port the vault reader" }),
			makeSession({ id: "Bare" }),
		]);
		// The countdown is live, so the assertion is the attempt and the cause,
		// which are what say this lane is asleep rather than thinking.
		expect(laneFor(out, "Sleeping")).toContain("(2/5)");
		expect(laneFor(out, "Sleeping")).toContain("429 rate limit");
		expect(laneFor(out, "Sleeping")).not.toContain("cargo test");
		expect(laneFor(out, "Working")).toContain("read settings.ts");
		expect(laneFor(out, "Working")).not.toContain("port the vault reader");
		expect(laneFor(out, "Thinking")).toContain("port the vault reader");
		expect(laneFor(out, "Bare")).toContain("waiting");
	});

	/**
	 * Only a lane with a tool in flight may be lit. The block-wide sweep that was
	 * tried first put the brightest frame of the animation on the WAITING lane,
	 * because `paintRailMotion` blends a `dim` rail toward white for its head; an
	 * animation that puts the most light on the least active row is worse than
	 * none. The gate is `lit`, which the block returns per railed row, so the
	 * assertion is not "something changed" but "the idle lane's bytes are
	 * identical across every frame of the sweep, and the live lane's are not".
	 *
	 * The head still TRAVELS the whole block — it is one sweep down one rail, not
	 * a per-row animation — and `lit` decides only where it may land warm.
	 */
	it("lights only the lanes that have a tool in flight", () => {
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
					currentTool: "bash",
					retryState: { attempt: 1, maxAttempts: 5, delayMs: 1000, errorMessage: "429", startedAtMs: 0 },
				}),
			}),
		];
		const built = block(sessions);
		// One entry per railed row, in render order: the header is not one.
		expect(built.lit).toEqual([true, false, false]);

		const laneAt = (id: string, frame: number | undefined): string => {
			const lines =
				frame === undefined
					? built.lines
					: paintRailMotion(built.lines, { kind: "idle", head: railIdleHeadAt(frame) }, theme, {
							lit: index => built.lit[index] === true,
						});
			return lines.find(line => line.includes(id)) ?? "";
		};
		const frames = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9];
		expect(new Set(frames.map(frame => laneAt("Waiting", frame))).size).toBe(1);
		expect(new Set(frames.map(frame => laneAt("Sleeping", frame))).size).toBe(1);
		expect(new Set(frames.map(frame => laneAt("Working", frame))).size).toBeGreaterThan(1);
		// No frame at all is the reduced-motion path: the unpainted block, which is
		// also what the last frame of a settle must equal.
		expect(laneAt("Waiting", undefined)).toBe(laneAt("Waiting", 0));
	});

	it("renders the first eight active detached subagents and summarizes the rest", () => {
		const active = Array.from({ length: 10 }, (_, index) =>
			makeSession({ id: `Worker${index}`, description: `job ${index}` }),
		);

		const out = fitsIn(render(active, 120), 120);

		for (const session of active.slice(0, 8))
			expect(laneFor(out, session.id)).toContain(`job ${session.id.slice(6)}`);
		for (const session of active.slice(8)) expect(out).not.toContain(session.id);
		expect(out).toContain("2 more running");
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
		await mode.init({ suppressWelcomeIntro: true });
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
		// Exactly the coalescing window, not `runAllTimers`: the block arms a
		// repeating rail-motion interval as soon as it has lanes, and draining
		// every timer of a self-rearming interval never returns.
		vi.advanceTimersByTime(SUBAGENT_OBSERVER_UI_COALESCE_MS);
		await Promise.resolve();

		const rows = Bun.stripANSI(mode.subagentContainer.render(120).join("\n")).split("\n");
		const lane = (id: string, activity: string): boolean =>
			rows.some(row => row.trimStart().startsWith("▏ ") && row.includes(id) && row.includes(activity));
		expect(lane("BurstAgent0", "Burst job 0")).toBe(true);
		expect(lane("BurstAgent5", "Burst job 5")).toBe(true);
		expect(rebuildHud).toHaveBeenCalledTimes(1);
		expect(requestRender).toHaveBeenCalledTimes(1);
	});
});
