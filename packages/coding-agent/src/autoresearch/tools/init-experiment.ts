import * as path from "node:path";
import { clamp, errorMessage, formatCount, logger } from "@veyyon/utils";
import { replaceTabs } from "@veyyon/utils/tab-width";
import { truncateToWidth } from "@veyyon/utils/width";
import type { TextBlockView } from "@veyyon/view";
import { type } from "arktype";
import type { ToolDefinition } from "../../extensibility/extensions";
import * as git from "../../utils/git";
import { parseWorkDirDirtyPaths, tryReadHeadSha } from "../git";
import { dedupeStrings, normalizePathSpec, readWorkDirStatus } from "../helpers";
import { buildExperimentState } from "../state";
import {
	type AutoresearchStorage,
	type OpenSessionParams,
	openAutoresearchStorage,
	type SessionRow,
	type UpdateSessionParams,
} from "../storage";
import { MAX_ATTEMPTS, MAX_BREADTH } from "../swarm";
import type {
	AutoresearchRuntime,
	AutoresearchToolFactoryOptions,
	ExperimentState,
	MetricDirection,
	SwarmSetup,
} from "../types";
import { activeToolsChanged, activeToolsFor } from ".";

export const HARNESS_FILENAME = "autoresearch.sh";
export const DEFAULT_HARNESS_COMMAND = `bash ${HARNESS_FILENAME}`;
const HARNESS_COMMIT_TITLE = "autoresearch: harness setup";
const MISSING_HARNESS_MESSAGE = `Error: ./${HARNESS_FILENAME} does not exist. Phase 1 of autoresearch is harness setup — write \`./${HARNESS_FILENAME}\` so it exits 0 and prints \`METRIC <name>=<value>\`, validate it via \`bash ${HARNESS_FILENAME}\`, then call init_experiment again.`;
const CONSOLE_OVERRIDE_NOTICE =
	"The breadth, attempts and certification arguments were ignored: the console the user configured this run in decides them.";
const OFF_BRANCH_NOTICE =
	"Note: not on a dedicated `autoresearch/*` branch — `log_experiment discard` will only revert run-modified files, not reset to baseline.";

/** Undefined leaves the setting alone; a nonsense number is clamped, never rejected. */
function clampCount(value: number | undefined, max: number): number | null {
	if (value === undefined || !Number.isFinite(value)) return null;
	return clamp(Math.floor(value), 1, max);
}

const initExperimentSchema = type({
	name: type("string").describe("experiment name"),
	"goal?": type("string").describe("session goal"),
	primary_metric: type("string").describe("primary metric name"),
	"metric_unit?": type("string").describe("metric unit (e.g. ms, µs, mb)"),
	"direction?": type("'lower' | 'higher'").describe("better direction (default lower)"),
	"secondary_metrics?": type("string[]").describe("secondary metric names"),
	"scope_paths?": type("string[]").describe("expected-to-modify paths"),
	"off_limits?": type("string[]").describe("off-limits paths"),
	"constraints?": type("string[]").describe("free-form constraints"),
	"max_iterations?": type("number").describe("soft iteration cap per segment"),
	"new_segment?": type("boolean").describe("bump to a new segment in existing session"),
	"breadth?": type("number").describe("candidate arms explored per iteration (1 = serial, max 8)"),
	"attempts?": type("number").describe("retries an arm may make before it is abandoned"),
	"certify?": type("boolean").describe("have arms cross-review each other before a winner is kept"),
});

type InitExperimentParams = typeof initExperimentSchema.infer;

interface InitExperimentDetails {
	state: ExperimentState;
	createdSession: boolean;
	bumpedSegment: boolean;
	abandonedRuns: number;
	harnessCommitted: boolean;
	baselineCommit: string | null;
}

export function createInitExperimentTool(
	options: AutoresearchToolFactoryOptions,
): ToolDefinition<typeof initExperimentSchema, InitExperimentDetails> {
	return {
		name: "init_experiment",
		label: "Init Experiment",
		description:
			"Initialize or reconfigure the autoresearch session. On first call (Phase 1 → Phase 2 transition), requires `./autoresearch.sh` to exist and pending harness changes are auto-committed on an autoresearch branch. Pass `new_segment: true` to start a fresh baseline within an existing session.",
		parameters: initExperimentSchema,
		defaultInactive: true,
		async execute(_toolCallId, params, _signal, _onUpdate, ctx) {
			const storage = await openAutoresearchStorage(ctx.cwd);
			const runtime = options.getRuntime(ctx);
			const branch = (await git.branch.current(ctx.cwd)) ?? null;
			const onAutoresearchBranch = branch?.startsWith("autoresearch/") ?? false;
			const existing = storage.getActiveSessionForBranch(branch);
			const newSegment = existing !== null && params.new_segment === true;
			const requiresHarness = !existing || newSegment;
			const settings = resolveInitSettings(params, runtime.pendingSwarm, existing);
			runtime.pendingSwarm = null;

			if (requiresHarness && !(await Bun.file(path.join(ctx.cwd, HARNESS_FILENAME)).exists())) {
				return { content: [{ type: "text", text: MISSING_HARNESS_MESSAGE }] };
			}
			const harness =
				requiresHarness && onAutoresearchBranch
					? await commitPendingHarness(ctx.cwd, settings.goal, params.name)
					: NO_HARNESS_COMMIT;
			const baselineCommit = await tryReadHeadSha(ctx.cwd);
			const columns = sessionColumns(params.primary_metric, settings, branch, baselineCommit);
			const outcome = writeSession(storage, existing, newSegment, params, columns);
			const state = buildExperimentState(outcome.session, storage.listLoggedRuns(outcome.session.id));
			armRuntime(runtime, state, outcome.session.goal);
			options.dashboard.update(ctx, runtime);
			options.dashboard.requestRender();

			// The stored session is the first place the real breadth exists, so this
			// is where a swarm gains `certify_arms` and a serial session loses it.
			// The command path armed the set before the breadth was known.
			const activeTools = options.pi.getActiveTools();
			const nextActiveTools = activeToolsFor(activeTools, true, state.breadth);
			if (activeToolsChanged(activeTools, nextActiveTools)) {
				await options.pi.setActiveTools(nextActiveTools);
			}

			const offBranch = requiresHarness && !onAutoresearchBranch;
			return {
				content: [{ type: "text", text: initReport(outcome, harness, settings.overriddenByConsole, offBranch) }],
				details: {
					state,
					createdSession: outcome.kind === "created",
					bumpedSegment: outcome.kind === "newSegment",
					abandonedRuns: outcome.abandonedRuns,
					harnessCommitted: harness.committed,
					baselineCommit: outcome.session.baselineCommit,
				},
			};
		},
		view: {
			renderCall: args => initExperimentCallView(args.name),
			renderResult: result => ({
				kind: "textBlock",
				spans: [{ text: replaceTabs(result.content.find(part => part.type === "text")?.text ?? "") }],
			}),
		},
	};
}

/** The swarm an init sets up, and whether the console's parked answers overrode the call's arguments. */
interface SwarmChoice {
	breadth: number;
	attempts: number;
	certify: boolean;
	armModels: string[];
	maxIterations: number | null;
	overriddenByConsole: boolean;
}

/** Every setting an init call resolves before it touches the worktree or the store. */
interface InitSettings extends SwarmChoice {
	goal: string | null;
	metricUnit: string;
	direction: MetricDirection;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	secondaryMetrics: string[];
}

function resolveInitSettings(
	params: InitExperimentParams,
	parked: SwarmSetup | null,
	existing: SessionRow | null,
): InitSettings {
	// `metric_unit: "comparisons"` beside `primary_metric: "comparisons"` is
	// the name twice, and printed as `1,596,000comparisons` on every surface.
	const unit = params.metric_unit?.trim() ?? "";
	return {
		...resolveSwarm(params, parked, existing),
		goal: params.goal?.trim() || null,
		metricUnit: unit.toLowerCase() === params.primary_metric.trim().toLowerCase() ? "" : unit,
		direction: params.direction ?? "lower",
		scopePaths: dedupeStrings((params.scope_paths ?? []).map(normalizePathSpec)),
		offLimits: dedupeStrings((params.off_limits ?? []).map(normalizePathSpec)),
		constraints: dedupeStrings(params.constraints ?? []),
		secondaryMetrics: dedupeStrings(params.secondary_metrics ?? []),
	};
}

/**
 * An unset value keeps whatever the session already has, so a plain reconfigure
 * never silently collapses a swarm back to serial.
 *
 * The console parks the operator's answers before a session exists, and they
 * outrank the tool's arguments on the init that consumes them: the model never
 * saw the console, so an argument it passes here is a guess, and a guess of 1
 * turned a configured swarm into a serial loop with nothing on screen saying so.
 * A later init, with nothing parked, may still reconfigure from what the harness
 * turned out to be.
 */
function resolveSwarm(
	params: InitExperimentParams,
	parked: SwarmSetup | null,
	existing: SessionRow | null,
): SwarmChoice {
	const argBreadth = clampCount(params.breadth, MAX_BREADTH);
	const argAttempts = clampCount(params.attempts, MAX_ATTEMPTS);
	const argIterations =
		params.max_iterations !== undefined && Number.isFinite(params.max_iterations) && params.max_iterations > 0
			? Math.floor(params.max_iterations)
			: null;
	const breadth = parked?.breadth ?? argBreadth ?? existing?.breadth ?? 1;
	const overriddenByConsole =
		parked !== null &&
		((params.breadth !== undefined && argBreadth !== parked.breadth) ||
			(params.attempts !== undefined && argAttempts !== parked.attempts) ||
			(params.certify !== undefined && params.certify !== parked.certify));
	return {
		breadth,
		attempts: parked?.attempts ?? argAttempts ?? existing?.attempts ?? 1,
		certify: parked?.certify ?? params.certify ?? existing?.certify ?? true,
		// Per-arm models are the user's choice in the console, never the model's:
		// this tool takes no argument for them, and a breadth that lands back at 1
		// drops them, since there are no arms to spread.
		armModels: breadth > 1 ? (parked?.armModels ?? existing?.armModels ?? []).slice(0, breadth) : [],
		maxIterations: parked?.maxIterations ?? argIterations,
		overriddenByConsole,
	};
}

/** Every session column an init writes, as a fresh session or a new segment takes it. */
type SessionColumns = Omit<OpenSessionParams, "name">;

function sessionColumns(
	primaryMetric: string,
	settings: InitSettings,
	branch: string | null,
	baselineCommit: string | null,
): SessionColumns {
	return {
		goal: settings.goal,
		primaryMetric,
		metricUnit: settings.metricUnit,
		direction: settings.direction,
		preferredCommand: DEFAULT_HARNESS_COMMAND,
		branch,
		baselineCommit,
		maxIterations: settings.maxIterations,
		scopePaths: settings.scopePaths,
		offLimits: settings.offLimits,
		constraints: settings.constraints,
		secondaryMetrics: settings.secondaryMetrics,
		breadth: settings.breadth,
		attempts: settings.attempts,
		certify: settings.certify,
		armModels: settings.armModels,
	};
}

/**
 * A reconfigure of the current segment: a value the call left unset keeps the
 * stored one, and the preferred command is not rewritten.
 */
function reconfiguredColumns(
	existing: SessionRow,
	params: InitExperimentParams,
	columns: SessionColumns,
): UpdateSessionParams {
	return {
		goal: columns.goal ?? existing.goal,
		maxIterations: columns.maxIterations ?? existing.maxIterations,
		scopePaths: params.scope_paths !== undefined ? columns.scopePaths : existing.scopePaths,
		offLimits: params.off_limits !== undefined ? columns.offLimits : existing.offLimits,
		constraints: params.constraints !== undefined ? columns.constraints : existing.constraints,
		secondaryMetrics: params.secondary_metrics !== undefined ? columns.secondaryMetrics : existing.secondaryMetrics,
		primaryMetric: columns.primaryMetric,
		metricUnit: columns.metricUnit,
		direction: columns.direction,
		branch: columns.branch ?? existing.branch,
		baselineCommit: columns.baselineCommit ?? existing.baselineCommit,
		breadth: columns.breadth,
		attempts: columns.attempts,
		certify: columns.certify,
		armModels: columns.armModels,
	};
}

interface InitOutcome {
	kind: "created" | "newSegment" | "reconfigured";
	session: SessionRow;
	/** Incomplete runs a new segment abandoned from the one before it. */
	abandonedRuns: number;
}

function writeSession(
	storage: AutoresearchStorage,
	existing: SessionRow | null,
	newSegment: boolean,
	params: InitExperimentParams,
	columns: SessionColumns,
): InitOutcome {
	if (!existing) {
		return { kind: "created", session: storage.openSession({ name: params.name, ...columns }), abandonedRuns: 0 };
	}
	if (newSegment) {
		const abandonedRuns = storage.abandonIncompleteRuns(existing.id);
		storage.bumpSessionSegment(existing.id, columns.baselineCommit);
		return { kind: "newSegment", session: storage.updateSession(existing.id, columns), abandonedRuns };
	}
	const session = storage.updateSession(existing.id, reconfiguredColumns(existing, params, columns));
	return { kind: "reconfigured", session, abandonedRuns: 0 };
}

/** Point the runtime at the session just written and clear what the last run left behind. */
function armRuntime(runtime: AutoresearchRuntime, state: ExperimentState, goal: string | null): void {
	runtime.state = state;
	runtime.goal = goal;
	runtime.autoresearchMode = true;
	runtime.autoResumeArmed = true;
	runtime.lastAutoResumePendingRunNumber = null;
	runtime.lastRunDuration = null;
	runtime.lastRunAsi = null;
	runtime.lastRunArtifactDir = null;
	runtime.lastRunNumber = null;
	runtime.lastRunSummary = null;
}

/** What init_experiment answers: what happened, the session as stored, and the next step. */
function initReport(
	outcome: InitOutcome,
	harness: HarnessCommit,
	overriddenByConsole: boolean,
	offBranch: boolean,
): string {
	const lines = outcomeLines(outcome);
	if (harness.committed) {
		lines.push(`Auto-committed harness setup (${HARNESS_COMMIT_TITLE}).`);
	} else if (harness.warning) {
		lines.push(`Warning: ${harness.warning}`);
	}
	lines.push(...sessionLines(outcome.session, overriddenByConsole));
	if (outcome.kind === "created") {
		lines.push("Phase 2: iteration loop is active. Run the baseline experiment with `run_experiment` and log it.");
	} else if (outcome.kind === "newSegment") {
		lines.push("Run a fresh baseline for the new segment.");
	}
	if (offBranch) lines.push(OFF_BRANCH_NOTICE);
	return lines.join("\n");
}

function outcomeLines({ kind, session, abandonedRuns }: InitOutcome): string[] {
	switch (kind) {
		case "created":
			return [
				`Initialized autoresearch session "${session.name}" (ID ${session.id}) for segment ${session.currentSegment}.`,
			];
		case "newSegment":
			return abandonedRuns > 0
				? [
						`Started new segment ${session.currentSegment} for session "${session.name}" (ID ${session.id}).`,
						`Abandoned ${abandonedRuns} incomplete run(s) from prior segment.`,
					]
				: [`Started new segment ${session.currentSegment} for session "${session.name}" (ID ${session.id}).`];
		case "reconfigured":
			return [
				`Reconfigured autoresearch session "${session.name}" (ID ${session.id}) on segment ${session.currentSegment}.`,
			];
	}
}

/** The session's configuration as stored, one line per field that is set. */
function sessionLines(session: SessionRow, overriddenByConsole: boolean): string[] {
	const lines: string[] = [];
	if (session.goal) lines.push(`Goal: ${session.goal}`);
	lines.push(`Primary metric: ${session.primaryMetric} (direction: ${session.direction})`);
	if (session.metricUnit) lines.push(`Metric unit: ${session.metricUnit}`);
	if (session.secondaryMetrics.length > 0) lines.push(`Secondary metrics: ${session.secondaryMetrics.join(", ")}`);
	lines.push(
		session.breadth > 1
			? `Breadth: ${formatCount("arm", session.breadth)} per iteration, ${formatCount("attempt", session.attempts)} each, certification ${session.certify ? "on" : "off"}.`
			: "Breadth: 1 (serial, no arms).",
	);
	if (overriddenByConsole) lines.push(CONSOLE_OVERRIDE_NOTICE);
	if (session.scopePaths.length > 0) lines.push(`Files in scope: ${session.scopePaths.join(", ")}`);
	if (session.offLimits.length > 0) lines.push(`Off limits: ${session.offLimits.join(", ")}`);
	if (session.maxIterations !== null) lines.push(`Max iterations per segment: ${session.maxIterations}`);
	if (session.branch) lines.push(`Active branch: ${session.branch}`);
	if (session.baselineCommit) lines.push(`Baseline commit: ${session.baselineCommit.slice(0, 12)}`);
	return lines;
}

interface HarnessCommit {
	committed: boolean;
	/** Why pending harness changes could not be committed; null when nothing failed. */
	warning: string | null;
}

const NO_HARNESS_COMMIT: HarnessCommit = { committed: false, warning: null };

/** Commit the harness changes pending in the worktree, so the baseline is recorded at a HEAD that holds them. */
async function commitPendingHarness(cwd: string, goal: string | null, name: string): Promise<HarnessCommit> {
	if (!(await detectPendingChanges(cwd))) return NO_HARNESS_COMMIT;
	try {
		await git.stage.files(cwd, []);
		await git.commit(cwd, buildHarnessCommitMessage(goal, name));
		return { committed: true, warning: null };
	} catch (err) {
		return {
			committed: false,
			warning: `Failed to auto-commit harness changes: ${errorMessage(err)}. Recording baseline at current HEAD; discard may not preserve uncommitted harness files.`,
		};
	}
}

/**
 * The card for a call: the tool's name, then the experiment being started.
 *
 * `truncateToWidth` takes an explicit length here because the call is shown in the
 * transcript and on the status row, and a 200-character name wraps and pushes the
 * result off the visible screen. `replaceTabs` is the second sanitization rule: a
 * tab character is a hole in differential terminal rendering.
 */
function initExperimentCallView(name: string): TextBlockView {
	return {
		kind: "textBlock",
		spans: [
			{ text: "init_experiment", tone: "title", bold: true },
			{ text: " " },
			{ text: truncateToWidth(replaceTabs(name), 100), tone: "accent" },
		],
	};
}

/**
 * Whether the worktree has changes that need committing before a baseline is recorded.
 *
 * FAILS CLOSED: a status that cannot be read answers TRUE, not false. The caller commits the harness
 * changes when this is true, and warns that "discard may not preserve uncommitted harness files" when the
 * commit fails -- so answering false on a failure quietly took the branch that loses work, and the
 * baseline was recorded at a HEAD that did not contain the harness. Answering true instead attempts the
 * commit, and a commit that cannot run produces the warning the reader needs to see.
 */
async function detectPendingChanges(cwd: string): Promise<boolean> {
	try {
		const { statusText, workDirPrefix } = await readWorkDirStatus(cwd);
		return parseWorkDirDirtyPaths(statusText, workDirPrefix).length > 0;
	} catch (err) {
		logger.warn("Git status failed while checking for harness changes; assuming there are some", {
			cwd,
			error: errorMessage(err),
		});
		return true;
	}
}

function buildHarnessCommitMessage(goal: string | null, name: string): string {
	const lines = [HARNESS_COMMIT_TITLE, "", `Benchmark entrypoint: ${DEFAULT_HARNESS_COMMAND}`];
	if (goal) {
		lines.push(`Goal: ${goal}`);
	} else {
		lines.push(`Session: ${name}`);
	}
	return lines.join("\n");
}
