/**
 * Wire contracts for @veyyon/evals.
 *
 * Defines all data types, request/response bodies, and literal unions that cross
 * the /api/* boundary between the HTTP server and the web dashboard or API clients.
 *
 * This module is completely standalone: it depends on nothing inside the package
 * (no manager, no store, no core).
 */

/** Benchmark implementation that produced a run. */
export type BenchmarkKind = "harbor" | "edit" | "deepswe";

/** Lifecycle status of a managed benchmark run. */
export type RunStatus = "running" | "complete" | "failed" | "cancelled";

/** How a run relates to its experiment's question. */
export type RunRole = "baseline" | "variant" | "";

/** Formatting hint for benchmark metrics. */
export type MetricFormat = "percent" | "number" | "usd";

/** Prewalk configuration for two-phase trial execution. */
export interface PrewalkConfig {
	into?: string;
}

/** Describes a benchmark metric so storage and UI do not hard-code benchmark semantics. */
export interface MetricDefinition {
	key: string;
	label: string;
	format: MetricFormat;
	higherIsBetter: boolean;
}

/** Adapter metadata exposed to launch clients and the dashboard. */
export interface BenchmarkDefinition {
	kind: BenchmarkKind;
	label: string;
	metrics: MetricDefinition[];
}

/** A managed benchmark run row as serialized across /api/runs and /api/events. */
export interface RunRow {
	schemaVersion: number;
	suite: string;
	backend: string;
	benchmark: BenchmarkKind;
	jobName: string;
	/**
	 * Experiment this run belongs to, as recorded at launch. Empty when the run predates
	 * recorded coordinates; a reader then treats the job name as its own single-arm experiment
	 * rather than parsing an id out of it.
	 */
	experiment: string;
	/** Arm label inside the experiment, as recorded at launch. Empty for an uncoordinated run. */
	arm: string;
	dataset: string;
	agent: string;
	models: string;
	/** JSON prewalk config (`{ into?: string }`); older rows may hold legacy reasoning-slide JSON. */
	prewalk: string | null;
	/** Benchmark-specific launch configuration. */
	config: Record<string, unknown>;
	/** Role inside the experiment (baseline vs treatment); "" when unspecified. */
	role: RunRole;
	/** One-line description of what this arm tests (e.g. "prewalk→flash at first edit/write"). */
	note: string;
	/** Display-name override for the arm; "" falls back to the jobName-derived arm label. */
	label: string;
	status: RunStatus;
	pid: number | null;
	exitCode: number | null;
	createdAt: number;
	finishedAt: number | null;
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	running: number;
	/** null when no trial in the run reported a cost: unmeasured, not free. */
	costUsd: number | null;
	tokIn: number;
	tokOut: number;
	/** null when no trial reported a cache-token count. */
	tokCache: number | null;
	/** Benchmark-native aggregate score, when the benchmark exposes one. */
	score: number | null;
	/** Values keyed by the adapter's metric definitions. */
	metrics: Record<string, number | null>;
}

/** A trial trace row as serialized across /api/runs/:name. */
export interface TraceRow {
	jobName: string;
	name: string;
	task: string;
	status: string;
	reward: number | null;
	/** null when the trial reported no cost. */
	costUsd: number | null;
	durationMs: number;
	detail: string;
	updatedAt: number;
	/** Adapter-owned locator used by the uniform trace endpoint. */
	tracePath: string | null;
}

/** Linear extrapolation of a running arm to its full task count. */
export interface ArmProjection {
	/** Expected finish timestamp (ms epoch), from observed completion rate. */
	etaMs: number | null;
	passPct: number;
	costPerTask: number | null;
	totalCostUsd: number | null;
	meanTrialMs: number;
}

/** Comparable arm summary within an experiment. */
export interface ArmSummary {
	run: RunRow;
	/** Arm label: job name minus the experiment prefix. */
	arm: string;
	/** Human config line: models plus prewalk description when known. */
	config: string;
	/** Observed pass% over decided trials. */
	passPct: number | null;
	costPerTask: number | null;
	meanTrialMs: number | null;
	/** Present only while the arm is running with at least one decided trial. */
	projected: ArmProjection | null;
}

/** Top-level experiment summary across arms. */
export interface ExperimentSummary {
	id: string;
	goal: string;
	arms: number;
	runningArms: number;
	datasets: string[];
	nTotal: number;
	done: number;
	pass: number;
	fail: number;
	error: number;
	/** null when no trial in the experiment reported a cost. */
	costUsd: number | null;
	createdAt: number;
	updatedAt: number;
}

/** Detail payload for an experiment, including matrix and arm summaries. */
export interface ExperimentDetail {
	id: string;
	goal: string;
	arms: ArmSummary[];
	/** Union of task ids across arms, sorted. */
	tasks: string[];
	/** arm label → task → cell. */
	matrix: Record<string, Record<string, { status: string; reward: number | null }>>;
}

/** Normalized event entry in a trial trace transcript. */
export interface TranscriptEntry {
	kind: string;
	model?: string;
	tool?: string;
	isError?: boolean;
	text?: string;
	tools?: string[];
}

/** GET /api/token response. */
export interface ApiTokenResponse {
	token: string;
}

/** Standard error response body. */
export interface ApiErrorResponse {
	error: string;
}

/** POST /api/experiments request body — pre-registers an experiment id with a goal. */
export interface CreateExperimentRequest {
	/** Dash-free token; runs group into it as `<id>-<arm>` job names. */
	id: string;
	goal?: string;
}

/** POST /api/experiments response body. */
export interface CreateExperimentResponse {
	id: string;
	goal: string;
}

/** PUT /api/experiments/:id request body — goal and per-run role/note/label metadata. */
export interface ExperimentMetaUpdate {
	goal?: string;
	runs?: Record<string, { role?: RunRole; note?: string; label?: string }>;
}

/** PUT /api/experiments/:id response body. */
export interface UpdateExperimentMetaResponse {
	id: string;
	updatedRuns: string[];
}

/** DELETE /api/experiments/:id response body. */
export interface DeleteExperimentResponse {
	id: string;
	deletedRuns: string[];
}

/** POST /api/experiments/:id/arms request body — a new comparable arm. */
export interface AddArmRequest {
	/** Arm label; becomes the `<id>-<arm>` job name. */
	arm: string;
	model: string;
	prewalk?: PrewalkConfig;
	/** Explicit task sample; skips sibling inheritance when provided. */
	include?: string[];
	role?: RunRole;
	note?: string;
	extraArgs?: string[];
}

/** POST /api/runs request body — launch any supported benchmark. */
export interface LaunchRequest {
	suite?: string;
	backend?: string;
	/** Benchmark adapter to execute. */
	benchmark?: BenchmarkKind;
	model: string;
	dataset?: string;
	/** Task count for a dataset sample, or omit when `include` is given. */
	tasks?: number;
	/** Explicit task names (passed as repeated --include). */
	include?: string[];
	concurrency?: number;
	timeoutMultiplier?: number;
	attempts?: number;
	agent?: string;
	jobName?: string;
	/**
	 * Experiment this run joins, and its arm label inside that experiment. Recorded on the run
	 * so a reader never has to parse an id back out of the job name.
	 */
	experiment?: string;
	arm?: string;
	webSearch?: boolean;
	/** Harbor container backend. */
	environment?: "docker" | "apple-container";
	/** Prewalk to a fast/cheap model at the first edit/write once the todo list exists. */
	prewalk?: PrewalkConfig;
	/** Role of this run inside its experiment (baseline vs treatment). */
	role?: RunRole;
	/** One-line description of what this arm tests. */
	note?: string;
	/** Experiment goal; upserted for the run's experiment. */
	goal?: string;
	/** Use prebuilt dist/vey-linux-* binaries instead of the default source mount. */
	prebuiltBinaries?: boolean;
	/** Extra raw runner args, appended verbatim. */
	extraArgs?: string[];
}

/** Standard launch response returned by run and arm launch endpoints. */
export interface LaunchResponse {
	jobName: string;
	pid: number;
}

/** POST /api/runs/:name/resume request body. */
export interface ResumeRunRequest {
	filterErrorTypes?: string[];
}

/** POST /api/runs/:name/cancel response body. */
export interface CancelRunResponse {
	jobName: string;
	cancelled: boolean;
}

/** GET /api/runs/:name response body. */
export interface RunDetailResponse {
	run: RunRow;
	traces: TraceRow[];
}

/** DELETE /api/runs/:name response body. */
export interface DeleteRunResponse {
	jobName: string;
	deleted: true;
}

/** GET /api/runs/:name/traces/:trace response body (when not raw stream). */
export interface TraceDetailResponse {
	jobName: string;
	trace: string;
	entries: TranscriptEntry[];
	totalEvents: number;
}

/** Canonical HTTP methods supported across /api/* endpoints. */
export type HttpMethod = "GET" | "POST" | "PUT" | "DELETE";

/** Server route descriptor identifying endpoint path and HTTP method. */
export interface RouteDescriptor {
	readonly method: HttpMethod;
	readonly path: string;
}

/**
 * Static route inventory of every endpoint served over /api/*.
 * Used by runtime contract suites to verify 100% endpoint coverage.
 */
export const SERVER_ROUTES: readonly RouteDescriptor[] = [
	{ method: "GET", path: "/api/token" },
	{ method: "GET", path: "/api/events" },
	{ method: "GET", path: "/api/benchmarks" },
	{ method: "GET", path: "/api/experiments" },
	{ method: "POST", path: "/api/experiments" },
	{ method: "GET", path: "/api/experiments/:id" },
	{ method: "PUT", path: "/api/experiments/:id" },
	{ method: "DELETE", path: "/api/experiments/:id" },
	{ method: "POST", path: "/api/experiments/:id/arms" },
	{ method: "GET", path: "/api/runs" },
	{ method: "POST", path: "/api/runs" },
	{ method: "GET", path: "/api/runs/:name" },
	{ method: "DELETE", path: "/api/runs/:name" },
	{ method: "POST", path: "/api/runs/:name/cancel" },
	{ method: "POST", path: "/api/runs/:name/resume" },
	{ method: "GET", path: "/api/runs/:name/traces/:trace" },
] as const;

/**
 * A USD amount, or the absent marker when nothing measured it.
 *
 * The one owner of that decision: a dashboard cell, a markdown report and the harbor runner's
 * summary line all reached it separately, and one of the three still printed `$0.000` for an
 * unmeasured run. The marker differs by surface (a table cell reads `—`, a markdown report reads
 * `n/a`), so the caller names it; the tiers and the never-zero rule do not vary.
 */
export function formatUsd(v: number | null, absent = "—"): string {
	if (v === null) return absent;
	return v >= 100 ? `$${v.toFixed(0)}` : v >= 1 ? `$${v.toFixed(2)}` : `$${v.toFixed(3)}`;
}

/** Formats duration in milliseconds to minutes. */
export function formatMinutes(ms: number): string {
	return `${(ms / 60000).toFixed(1)}m`;
}

/** Formats an ETA epoch timestamp in ms to relative time, honestly preserving null as an em dash ("—"). */
export function formatEta(etaMs: number | null, now = Date.now()): string {
	if (etaMs === null) return "—";
	const mins = Math.max(0, Math.round((etaMs - now) / 60000));
	return mins >= 90 ? `~${(mins / 60).toFixed(1)}h` : `~${mins}m`;
}
