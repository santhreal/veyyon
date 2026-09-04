import type { AgentToolResult } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import type { ExtensionAPI, ExtensionContext } from "../extensibility/extensions";
import type { SessionEntry } from "../session/session-entries";
import type { TruncationResult } from "../session/streaming-output";

export type MetricDirection = "lower" | "higher";

/**
 * Every outcome a logged run can carry, as a value rather than only as a type.
 *
 * A union spelled once in the type and again in each place that has to check it
 * goes stale one copy at a time: the storage parser, the screen's tag and the
 * status paint each held their own list, and a fifth outcome would have reached
 * a reader as a dropped row, an untagged row, or both. Anything that switches
 * on a status reads this array, and a test that sweeps it sees a new member the
 * day it is added.
 */
export const EXPERIMENT_STATUSES = ["keep", "discard", "crash", "checks_failed"] as const;

export type ExperimentStatus = (typeof EXPERIMENT_STATUSES)[number];

export type ASIValue = string | number | boolean | null | ASIValue[] | { [key: string]: ASIValue };

export interface ASIData {
	[key: string]: ASIValue;
}

export interface NumericMetricMap {
	[key: string]: number;
}

export interface MetricDef {
	name: string;
	unit: string;
}

export interface ExperimentResult {
	runNumber: number | null;
	commit: string;
	metric: number;
	/**
	 * The primary metric the harness itself printed, or null when it printed
	 * none. `metric` above is the number the log call was required to supply, so
	 * a crash that never measured contains a zero there; this is how the display
	 * distinguishes that placeholder from a run that measured 205ms and then died.
	 */
	measuredPrimary: number | null;
	metrics: NumericMetricMap;
	status: ExperimentStatus;
	description: string;
	timestamp: number;
	segment: number;
	confidence: number | null;
	asi?: ASIData;
	modifiedPaths: string[];
	scopeDeviations: string[];
	justification: string | null;
	flagged: boolean;
	flaggedReason: string | null;
	/** Candidate arm this run measured, when breadth was above 1. */
	arm: string | null;
	/** Which arm or the director certified this run. */
	certifiedBy: string | null;
	/**
	 * The model that built this run, `provider/id`, or null on a run logged
	 * before the field existed. What ran, next to the arm it is attributed to.
	 */
	model: string | null;
}

export interface ExperimentState {
	results: ExperimentResult[];
	bestMetric: number | null;
	bestDirection: MetricDirection;
	metricName: string;
	metricUnit: string;
	secondaryMetrics: MetricDef[];
	name: string | null;
	goal: string | null;
	currentSegment: number;
	maxExperiments: number | null;
	/** Candidate arms explored per iteration; 1 is the serial loop. */
	breadth: number;
	confidence: number | null;
	scopePaths: string[];
	offLimits: string[];
	constraints: string[];
	notes: string;
	branch: string | null;
	baselineCommit: string | null;
	sessionId: number | null;
}

export interface RunExperimentProgressDetails {
	phase: "running";
	elapsed: string;
	truncation?: TruncationResult;
	fullOutputPath?: string;
	runDirectory?: string;
}

export interface RunDetails {
	runNumber: number;
	runDirectory: string;
	benchmarkLogPath: string;
	command: string;
	exitCode: number | null;
	durationSeconds: number;
	passed: boolean;
	crashed: boolean;
	timedOut: boolean;
	tailOutput: string;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	parsedAsi: ASIData | null;
	metricName: string;
	metricUnit: string;
	preRunDirtyPaths: string[];
	abandonedPriorRun: number | null;
	truncation?: TruncationResult;
	fullOutputPath?: string;
}

export interface LogDetails {
	experiment: ExperimentResult;
	state: ExperimentState;
	wallClockSeconds: number | null;
	scopeDeviations: string[];
	justification: string | null;
	flaggedRuns: Array<{ runId: number; reason: string }>;
}

export interface PendingRunSummary {
	command: string;
	durationSeconds: number | null;
	parsedAsi: ASIData | null;
	parsedMetrics: NumericMetricMap | null;
	parsedPrimary: number | null;
	passed: boolean;
	preRunDirtyPaths: string[];
	runDirectory: string;
	runNumber: number;
	exitCode: number | null;
	timedOut: boolean;
}

export interface RunningExperiment {
	startedAt: number;
	command: string;
	runDirectory: string;
	runNumber: number;
}

/** What the user decides about a swarm. Everything else is the model's to derive. */
export interface SwarmSetup {
	breadth: number;
	attempts: number;
	certify: boolean;
	/**
	 * Model spec per arm index, `a0` first, resolved the way `--model` resolves
	 * one. An empty entry, and any arm past the end, runs on the session model.
	 * Empty at breadth 1, where there are no arms to spread across models.
	 */
	armModels: string[];
}

export interface AutoresearchRuntime {
	autoresearchMode: boolean;
	/**
	 * The branch an active session is recorded on, when that is not the branch
	 * checked out now. Non-null means the loop is paused: its tools are detached
	 * and its runs stay readable, so the row names the branch to switch back to.
	 */
	pausedOnBranch: string | null;
	autoResumeArmed: boolean;
	lastAutoResumePendingRunNumber: number | null;
	lastRunDuration: number | null;
	lastRunAsi: ASIData | null;
	lastRunArtifactDir: string | null;
	lastRunNumber: number | null;
	lastRunSummary: PendingRunSummary | null;
	runningExperiment: RunningExperiment | null;
	state: ExperimentState;
	goal: string | null;
	/**
	 * Swarm configuration chosen before any session exists, by the setup console
	 * or `/autoswarm breadth N`. `init_experiment` consumes it, so the user
	 * configures in the order they reach for it: set up, then start.
	 */
	pendingSwarm: SwarmSetup | null;
	/**
	 * The arm currently being built, and the model it was switched to, from
	 * `start_arm` until the `log_experiment` that closes that arm. Null outside
	 * an arm, which is where the loop's own reasoning happens.
	 */
	activeArm: ActiveArm | null;
	/**
	 * Whether an experiment tool ran during the turn now ending. Diagnostic: it
	 * separates a turn that stopped part-way through the loop from one that
	 * ignored the loop entirely, which are the same stall on the row and
	 * different failures in the log.
	 */
	loopToolRanThisTurn: boolean;
	/**
	 * Consecutive turns that ended with no next step for the loop. Reset by a
	 * measurement or a logged run, bounded by `MAX_STALL_NUDGES`: past the budget
	 * the loop turns itself off and says so, so a model that will not drive it
	 * cannot spend the session being asked again.
	 */
	stallNudges: number;
}

export interface ActiveArm {
	/** Arm id as the loop names it, `a0` first. */
	arm: string;
	/** Display name of the model the arm builds on. */
	modelLabel: string;
	/**
	 * The model to return to when the arm closes. Undefined when the arm runs on
	 * the session model and nothing was switched.
	 */
	restore: Model | undefined;
}

export interface AutoresearchControlEntryData {
	mode: "on" | "off" | "clear";
	goal?: string;
}

export interface ReconstructedControlState {
	autoresearchMode: boolean;
	goal: string | null;
	lastMode: AutoresearchControlEntryData["mode"] | null;
}

export interface RuntimeStore {
	clear(sessionKey: string): void;
	ensure(sessionKey: string): AutoresearchRuntime;
}

export interface DashboardController {
	clear(ctx: ExtensionContext): void;
	requestRender(): void;
	/** Open the run screen and resolve when it closes. */
	showScreen(ctx: ExtensionContext, runtime: AutoresearchRuntime): Promise<void>;
	/** Repaint the status row from the current runtime. */
	update(ctx: ExtensionContext, runtime: AutoresearchRuntime): void;
}

export interface AutoresearchToolFactoryOptions {
	dashboard: DashboardController;
	getRuntime(ctx: ExtensionContext): AutoresearchRuntime;
	pi: ExtensionAPI;
}

export type AutoresearchToolResult<TDetails> = AgentToolResult<TDetails>;
export type SessionEntries = SessionEntry[];
