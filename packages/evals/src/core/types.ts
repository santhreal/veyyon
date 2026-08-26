/**
 * Core type contracts for @veyyon/evals.
 *
 * Defines the unified contracts for the five evaluation axes:
 * 1. EvalSuite (evaluation dataset and task definition)
 * 2. HarnessAdapter (agent system under evaluation)
 * 3. Config (settings overlay)
 * 4. PromptVariant (system prompt and attachment modifications)
 * 5. Model (target LLM / provider)
 *
 * Plus the ExecutionBackend (containerized or in-process execution engine).
 */

/**
 * Identifier for an execution backend (e.g. "pier", "harbor", "in-process").
 */
export type BackendId = "pier" | "harbor" | "in-process" | (string & {});

/**
 * Result of a preflight check before commencing a run or trial.
 */
export interface PreflightVerdict {
	readonly ok: boolean;
	readonly reason?: string | null;
	readonly missingRequirements?: readonly string[];
}

/**
 * Runtime context passed to suite lifecycle methods.
 */
export interface SuiteContext {
	readonly workDir?: string;
	readonly datasetDir?: string;
	readonly signal?: AbortSignal;
	readonly options?: Readonly<Record<string, unknown>>;
}

/**
 * Dataset identity and provenance information for an evaluation suite.
 */
export interface SuiteProvenance {
	readonly suite: string;
	readonly version: string;
	readonly sha?: string | null;
	readonly sourceUrl?: string | null;
	readonly metadata?: Readonly<Record<string, unknown>>;
}

/**
 * Descriptor of a single task within an evaluation suite.
 */
export interface TaskDescriptor {
	readonly id: string;
	readonly path: string | null;
	readonly timeBudgetSec: number;
	readonly instructionPath: string | null;
	readonly metadata: Readonly<Record<string, unknown>>;
}

/**
 * Coordinate of an individual trial cell in the evaluation matrix.
 */
export interface TrialCell {
	readonly variant: string;
	readonly suite: string;
	readonly task: string;
	readonly repeat: number;
}

/**
 * Token, cost, and latency consumption metrics recorded during a trial.
 */
export interface TrialUsage {
	readonly inputTokens?: number | null;
	readonly outputTokens?: number | null;
	readonly cacheTokens?: number | null;
	readonly cacheReadTokens?: number | null;
	readonly cacheWriteTokens?: number | null;
	readonly costUsd?: number | null;
	readonly durationSec?: number | null;
	readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Output artifacts produced by a trial run in an execution backend.
 * Large data (logs, patches, workspace files) must be represented as file paths on disk,
 * never in-memory file contents.
 */
export interface TrialArtifacts {
	/** Absolute paths to log files produced during the trial. */
	readonly logPaths?: readonly string[];
	/** Directory holding the trial's workspace and outputs on disk. */
	readonly trialDir?: string | null;
	/** Bounded tail of raw output (capped at <= 64 KiB), never unbounded output logs. */
	readonly rawOutput?: string | null;
	/**
	 * Map of relative artifact names or identifiers to their absolute file paths on disk.
	 * Paths only: a reader opens the file. Two maps, one for paths and one for contents,
	 * is what forced a reader to guess which it held.
	 */
	readonly filePaths?: Readonly<Record<string, string>>;
	/**
	 * Token, spend and latency the backend observed for this trial. A suite that
	 * parses richer numbers from its own artifacts reports those instead; a suite
	 * with no other source reports this, so a run's spend is never silently zero.
	 */
	readonly usage?: TrialUsage | null;
	/** Lightweight trial metadata and exit statistics. */
	readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Evaluated score and grading outcome for a trial.
 */
export interface TrialScore {
	readonly reward: number | null;
	readonly partial: number | null;
	readonly error: string | null;
	readonly usage: TrialUsage | null;
	readonly extra: Readonly<Record<string, unknown>>;
}

/**
 * One member of the suite axis: defines tasks and trial scoring logic.
 */
export interface EvalSuite {
	readonly name: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	readonly backend: BackendId;
	discoverTasks(context: SuiteContext): Promise<readonly string[]>;
	describeTask(taskId: string, context: SuiteContext): Promise<TaskDescriptor>;
	provenance(context: SuiteContext): Promise<SuiteProvenance>;
	scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore>;
	preflight(context: SuiteContext): Promise<PreflightVerdict>;
}

/**
 * Capabilities supported by a harness adapter.
 */
export interface HarnessCapabilities {
	readonly replay?: boolean;
	readonly compaction?: boolean;
	readonly armAttachments?: boolean;
	readonly promptOverrides?: boolean;
	readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Backend-specific binding parameters for a harness adapter.
 *
 * `agentImportPath` is the class a backend imports to drive the harness (pier, harbor
 * source installs). `agentName` is the name a backend's CLI selects the harness by
 * (`harbor run --agent <name>`); it defaults to the harness name when absent.
 */
export interface HarnessBackendBinding {
	readonly agentImportPath?: string;
	readonly agentName?: string;
	readonly containerAssetsDir?: string;
	readonly envVars?: Readonly<Record<string, string>>;
	readonly cliFlags?: readonly string[];
	readonly extra?: Readonly<Record<string, unknown>>;
}

/**
 * Preflight context passed to a harness adapter.
 */
export interface HarnessPreflightContext {
	readonly workDir?: string;
	readonly signal?: AbortSignal;
	readonly backend?: BackendId;
	readonly options?: Readonly<Record<string, unknown>>;
}

/**
 * Staging context for a harness to prepare assets for a variant.
 */
export interface HarnessStageContext {
	readonly variant: Variant;
	readonly targetDir: string;
	readonly backend: BackendId;
	readonly options?: Readonly<Record<string, unknown>>;
}

export interface SystemStageContext {
	readonly system: string;
	readonly assetsDir: string;
	readonly outRoot: string;
	readonly binarySha: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly model: string;
}

export interface SystemJobConfigContext {
	readonly system: string;
	readonly task: string;
	readonly repeat: number;
	readonly model: string;
	readonly assetsDir: string;
	readonly binarySha?: string | null;
	readonly replayPath?: string | null;
	readonly promptTemplatePath?: string | null;
	readonly armName?: string | null;
	readonly comparisonMode?: boolean;
}

export interface SystemPreflightContext {
	readonly system: string;
	readonly model: string;
	readonly args: Readonly<Record<string, unknown>>;
	readonly dryRun: boolean;
}

export interface SystemPreflightResult {
	readonly valid: boolean;
	readonly errors: readonly string[];
	readonly warnings: readonly string[];
}

/**
 * One member of the harness axis: an agent system that can execute tasks.
 */
export interface HarnessAdapter {
	readonly name: string;
	readonly displayName: string;
	readonly description: string;
	readonly defaultModel: string | null;
	readonly capabilities: HarnessCapabilities;
	readonly backends: Readonly<Partial<Record<BackendId, HarnessBackendBinding>>>;
	preflight(context: HarnessPreflightContext): Promise<PreflightVerdict>;
	stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> | void;
	validatePreflight?(context: SystemPreflightContext): Promise<SystemPreflightResult> | SystemPreflightResult;
	buildJobConfigKwargs?(context: SystemJobConfigContext): Record<string, unknown>;
}

export function sanitizeVariantName(name: string): string {
	return name.trim().replace(/[^a-zA-Z0-9._-]/g, "_") || "default";
}

/**
 * Execution context for preparing, running, and cleaning up trials.
 *
 * `options` stays an open bag because a suite carries its own flags through it, but the
 * plan's variants are NOT suite-specific: a backend reads them to load the config and
 * prompt overlays a cell runs under, and a cast at every such read is how one of them
 * ends up reading a field nobody writes.
 */
export interface RunContext {
	readonly runId: string;
	readonly suite: EvalSuite;
	readonly workDir: string;
	readonly runsDir: string;
	readonly signal?: AbortSignal;
	readonly options?: Readonly<Record<string, unknown>> & { readonly variants?: readonly Variant[] };
}

/**
 * One member of the execution axis (e.g. Pier, Harbor, in-process).
 */
export interface ExecutionBackend {
	readonly id: BackendId;
	preflight(context: RunContext): Promise<PreflightVerdict>;
	prepare(context: RunContext): Promise<void>;
	runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts>;
	cleanup(cell: TrialCell, context: RunContext): Promise<void>;
}

/**
 * One member of the variant matrix: product of harness × config × prompt variant × model.
 */
export interface Variant {
	readonly name: string;
	readonly harness: string;
	readonly configPath: string | null;
	readonly promptVariantPath: string | null;
	readonly model: string;
	readonly attachments: readonly string[];
}

/**
 * Provenance tracking for an evaluation run.
 */
export interface RunProvenance {
	readonly suiteName: string;
	readonly suiteVersion: string;
	readonly suiteProvenanceSha?: string | null;
	readonly gitSha?: string | null;
	readonly timestamp: string;
	readonly host?: string | null;
	readonly extra?: Readonly<Record<string, unknown>>;
}
