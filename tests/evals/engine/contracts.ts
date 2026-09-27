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

import type { ContainerProgramContext, StagedProgram } from "./harness/container-program";

/**
 * Identifier for an execution backend (e.g. "pier", "harbor", "in-process").
 */
export type BackendId = "pier" | "harbor" | "in-process" | "local-cli" | (string & {});

/**
 * One axis of the variant matrix that needs an applier: a config overlay, a prompt-variant
 * overlay, an arm attachment, or a build. The harness and the model reach every backend and are
 * not on this list. `plan/variant-axes.ts` holds the labels, the harness capability each axis
 * needs, and the refusal.
 */
export type VariantAxis = "config" | "promptVariant" | "attachments" | "build";

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
	readonly id: string;
	readonly version: string;
	readonly displayName: string;
	readonly description: string;
	readonly backend: BackendId;
	discoverTasks(context: SuiteContext): Promise<readonly string[]>;
	describeTask(taskId: string, context: SuiteContext): Promise<TaskDescriptor>;
	provenance(context: SuiteContext): Promise<SuiteProvenance>;
	scoreTrial(cell: TrialCell, artifacts: TrialArtifacts): Promise<TrialScore>;
	preflight(context: SuiteContext): Promise<PreflightVerdict>;
	/**
	 * Write the suite's own report into a finished run's directory, reading whatever the
	 * backend left there. Optional: a suite whose rows are read from `run.json` declares
	 * none, and the run says so rather than writing an empty report.
	 */
	writeRunReport?(context: SuiteReportContext): Promise<void> | void;
	/**
	 * Start what one trial needs before its agent does: a service the task is performed against,
	 * files in the trial directory, the tools and settings the task requires. A backend that runs a
	 * suite declaring it calls it once per trial, before the agent starts, and calls the returned
	 * `finish` once the agent has stopped, whether or not it finished, before the trial is scored.
	 * Optional: a suite whose tasks are files alone declares none.
	 */
	prepareTrial?(cell: TrialCell, context: TrialPrepareContext): Promise<TrialEnvironment>;
}

/** What a suite prepares one trial in. */
export interface TrialPrepareContext {
	/** The trial's directory, where `finish` writes what the grader reads. The agent cannot read it. */
	readonly trialDir: string;
	/** The agent's working directory: a task's files go here. */
	readonly workspace: string;
	readonly signal?: AbortSignal;
	readonly options?: Readonly<Record<string, unknown>>;
}

/** What one trial runs against, from `EvalSuite.prepareTrial`. */
export interface TrialEnvironment {
	/** The instruction the agent is sent, in place of the task's own; it may name a URL the suite just started. */
	readonly instruction?: string;
	/** The tools the agent runs with, when the task needs a set other than the backend's default. */
	readonly tools?: readonly string[];
	/** Settings the task needs, applied under the variant's own config overlay. */
	readonly settings?: Readonly<Record<string, unknown>>;
	/** Variables the agent's tools need, such as the browser executable to launch. */
	readonly env?: Readonly<Record<string, string>>;
	/** Paths the sandboxed agent must read, such as that executable's directory. */
	readonly readable?: readonly string[];
	/** Stop what `prepareTrial` started and write what the grader reads into the trial directory. */
	finish(): Promise<void>;
}

/**
 * What a suite renders a finished run from. The run directory holds the journal, the run
 * record and every artifact a backend filed; the model, tasks, repeats and variants are the
 * plan's, so a report names them without re-deriving them from the rows.
 */
export interface SuiteReportContext {
	readonly runDir: string;
	/** Every model the run used, joined when it used more than one. */
	readonly model: string;
	readonly tasks: readonly string[];
	readonly repeats: number;
	/** The variants' names in plan order; the first is the baseline a paired report compares against. */
	readonly variants: readonly string[];
}

/**
 * Capabilities supported by a harness adapter.
 */
export interface HarnessCapabilities {
	readonly replay: boolean;
	readonly compaction: boolean;
	readonly armAttachments: boolean;
	readonly promptOverrides: boolean;
	/**
	 * Whether the harness runs a build a variant names (`--build`), so one plan can compare two
	 * builds of the same agent trial by trial. A harness that runs only its installed build says no.
	 */
	readonly builds: boolean;
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
	readonly sourceMount?: boolean;
	readonly localTarball?: boolean;
	readonly authGateway?: boolean;
	readonly requiresDocker?: boolean;
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
	readonly id: string;
	readonly displayName: string;
	readonly description: string;
	/**
	 * Flags this adapter reads out of the invocation, without the leading dashes.
	 *
	 * An entry point unions these into its flag grammar, so `--factory-binary` is accepted only
	 * where the factory adapter is registered and `--factry-binary` refuses instead of leaving the
	 * adapter to fall back to a default the caller was trying to replace.
	 */
	readonly flags: readonly string[];
	readonly defaultModel: string | null;
	readonly capabilities: HarnessCapabilities;
	readonly backends: Readonly<Partial<Record<BackendId, HarnessBackendBinding>>>;
	preflight(context: HarnessPreflightContext): Promise<PreflightVerdict>;
	stageAssets(context: HarnessStageContext | SystemStageContext): Promise<void> | void;
	/**
	 * The one declaration of how this harness runs inside a task container: the files a
	 * backend uploads, the setup, the invocation, the log and the session sources.
	 *
	 * A harness that declares it needs no per-backend staging code and no per-backend agent
	 * class: `core/container-program.ts` stages it and one Python executor runs it under both
	 * Pier and Harbor. A harness whose container delivery is bespoke (veyyon builds from a
	 * source mount and seeds a credential store) declares none and keeps its own agents.
	 */
	containerProgram?(context: ContainerProgramContext): StagedProgram;
	/**
	 * How this harness runs as a local process for the `local-cli` backend: one non-interactive run
	 * of the agent on one instruction, printing its JSON event stream to stdout. A harness that
	 * declares none cannot run under `local-cli`.
	 */
	localCommand?(context: LocalCommandContext): LocalCommand;
	validatePreflight?(context: SystemPreflightContext): Promise<SystemPreflightResult> | SystemPreflightResult;
	buildJobConfigKwargs?(context: SystemJobConfigContext): Record<string, unknown>;
}

/** What a harness builds its local command from. */
export interface LocalCommandContext {
	readonly model: string;
	readonly instruction: string;
	/** Tools the agent runs with; empty means the harness's own default set. */
	readonly tools: readonly string[];
	/** Settings overlay files, applied in order. */
	readonly configFiles: readonly string[];
	/** The build the variant names: a source tree or an executable, or null for the harness's default. */
	readonly build: string | null;
	/** The directory holding the credential the model needs, and nothing else. */
	readonly agentDir: string;
	readonly options: Readonly<Record<string, unknown>>;
}

/** One local run of a harness. */
export interface LocalCommand {
	readonly command: string;
	readonly args: readonly string[];
	/** Variables the run needs beyond the backend's own minimal environment. */
	readonly env: Readonly<Record<string, string>>;
	/** Paths the sandboxed run must read: the build, the runtime it runs on. */
	readonly readable: readonly string[];
}

/**
 * Read access to the harness roster a run was planned against.
 *
 * A backend, a suite and an engine pass reach the roster through this, never by
 * importing the loader. `engine/members.ts` scans the `harnesses/` directory and
 * imports every file in it, so a module those files can reach cannot import it
 * back: the cycle would deadlock on the loader's top-level await. Passing the
 * roster as data also keeps a plan reproducible, since a run states the roster it
 * used rather than whatever the filesystem holds at the moment a lookup runs.
 *
 * `Registry<HarnessAdapter>` satisfies this shape, so the entrypoint passes the
 * loaded registry straight through.
 */
export interface HarnessLookup {
	get(id: string): HarnessAdapter | undefined;
	require(id: string): HarnessAdapter;
	list(): readonly HarnessAdapter[];
	ids(): readonly string[];
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
	/** The harness roster this run was planned against. */
	readonly harnesses: HarnessLookup;
	readonly options?: Readonly<Record<string, unknown>> & { readonly variants?: readonly Variant[] };
}

/**
 * One member of the execution axis (e.g. Pier, Harbor, in-process).
 */
export interface ExecutionBackend {
	readonly id: BackendId;
	/**
	 * The variant axes this backend reads. An axis absent here is dropped, so a run that
	 * varies it is refused rather than reporting one trial under several arm names. Every
	 * backend states the whole list, so a new axis turns each declaration into a decision
	 * instead of a silent default.
	 */
	readonly appliesVariantAxes: readonly VariantAxis[];
	preflight(context: RunContext): Promise<PreflightVerdict>;
	prepare(context: RunContext): Promise<void>;
	runTrial(cell: TrialCell, context: RunContext): Promise<TrialArtifacts>;
	cleanup(cell: TrialCell, context: RunContext): Promise<void>;
}

/**
 * One member of the variant matrix: product of harness × config × prompt variant × model × build.
 */
export interface Variant {
	readonly name: string;
	readonly harness: string;
	readonly configPath: string | null;
	readonly promptVariantPath: string | null;
	readonly model: string;
	readonly attachments: readonly string[];
	/** The build the variant runs (`--build`), or absent for the harness's default build. */
	readonly build?: string | null;
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
