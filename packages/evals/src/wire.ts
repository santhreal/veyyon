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
export type BenchmarkKind = "harbor" | "edit" | "deepswe" | (string & {});

/** Lifecycle status of a managed benchmark run. */
export type RunStatus = "running" | "complete" | "failed" | "cancelled";

/**
 * Every status one trial can carry, as a runtime inventory.
 *
 * Five modules each spelled this union inline and classified it by hand, and the two
 * classifications disagreed: an arm's `done` count treated an errored trial as decided while the
 * per-task comparison treated it as unrun. `status` also crossed the wire as a bare `string`, so a
 * status added on the producer side was decided by nobody: it counted toward no denominator, made
 * an arm's `done` sit below `nTotal` forever, and rendered as an unlabelled grey square.
 */
export const TRIAL_STATUSES = ["pass", "fail", "error", "running"] as const;

/** Status of one trial. */
export type TrialStatus = (typeof TRIAL_STATUSES)[number];

/** Whether a recorded value is a status this package knows. */
export function isTrialStatus(value: unknown): value is TrialStatus {
	return typeof value === "string" && (TRIAL_STATUSES as readonly string[]).includes(value);
}

/**
 * Whether the trial is over: it counts toward `done` and toward a pass-rate denominator.
 * The switch is exhaustive, so a new status has to state its own answer here.
 */
export function isDecidedTrialStatus(status: TrialStatus): boolean {
	switch (status) {
		case "pass":
		case "fail":
		case "error":
			return true;
		case "running":
			return false;
	}
}

/**
 * Whether a verifier produced a verdict for the trial. Narrower than decided: an errored trial is
 * over but carries no reward, so it informs neither task difficulty nor a re-run's merge order.
 */
export function isGradedTrialStatus(status: TrialStatus): boolean {
	switch (status) {
		case "pass":
		case "fail":
			return true;
		case "error":
		case "running":
			return false;
	}
}

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
	/** Dataset a launch drives when the request names none. */
	defaultDataset: string;
	/** Whether a settled run of this benchmark can be resumed in place. */
	resumable: boolean;
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
	status: TrialStatus;
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
	/** Arm label: the label an operator set, else the arm the run's coordinates state. */
	arm: string;
	/**
	 * The arm the run's own coordinates state, whatever label an operator set over it. A job name
	 * is only read as `<experiment>-<arm>` for an experiment somebody registered, so this is never
	 * a guess at where a name splits.
	 */
	recordedArm: string;
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
	matrix: Record<string, Record<string, { status: TrialStatus; reward: number | null }>>;
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

/** A request body that does not describe an operation this server can perform. */
export class InvalidRequestBodyError extends Error {
	constructor(what: string, reason: string) {
		super(`${what} rejected: ${reason}`);
		this.name = "InvalidRequestBodyError";
	}
}

/** The kinds of value a request-body field takes. */
export type BodyFieldKind = "string" | "strings" | "count" | "ratio" | "boolean" | "object" | "map";

/** A field table: every field a body accepts, by name, and the kind of value it takes. */
export type BodyFields<T> = Readonly<Record<keyof T, BodyFieldKind>>;

/**
 * What one request body accepts.
 *
 * `fields` is keyed by `keyof T`, so a field added to the interface and not to the table is a
 * type error: the checker cannot drift from the contract it checks.
 */
export interface BodySpec<T> {
	/** Names the boundary in a refusal, e.g. `"Launch request"`. */
	what: string;
	fields: BodyFields<T>;
	/** Values a string field is pinned to, by field name. */
	enums?: Readonly<Record<string, readonly string[]>>;
	/** Field table for an `"object"` field's value, or for every value of a `"map"` field. */
	nested?: Readonly<Record<string, Readonly<Record<string, BodyFieldKind>>>>;
	/** Shape a string field must match, by field name at any depth, with the shape stated in prose. */
	patterns?: Readonly<Record<string, { regex: RegExp; describe: string }>>;
	/** Fields that must be present, and non-blank when they take a string. */
	required?: readonly string[];
}

function checkFields(
	what: string,
	raw: Record<string, unknown>,
	fields: Readonly<Record<string, BodyFieldKind>>,
	where: string,
	spec: {
		enums?: BodySpec<unknown>["enums"];
		nested?: BodySpec<unknown>["nested"];
		patterns?: BodySpec<unknown>["patterns"];
	},
): void {
	const stray = Object.keys(raw).filter(key => !(key in fields));
	if (stray.length > 0) {
		throw new InvalidRequestBodyError(
			what,
			`unknown field(s) ${stray.map(key => `"${key}"`).join(", ")} in ${where}. Known fields: ${Object.keys(fields).sort().join(", ")}`,
		);
	}

	for (const [key, value] of Object.entries(raw)) {
		if (value === undefined || value === null) continue;
		const at = where === "the body" ? `"${key}"` : `"${where}.${key}"`;
		const kind = fields[key];
		if (kind === "string") {
			if (typeof value !== "string") throw new InvalidRequestBodyError(what, `${at} must be a string`);
			const allowed = spec.enums?.[key];
			if (allowed && !allowed.includes(value)) {
				throw new InvalidRequestBodyError(
					what,
					`${at} must be one of ${allowed.map(option => `"${option}"`).join(", ")}, got "${value}"`,
				);
			}
			const pattern = spec.patterns?.[key];
			if (pattern && !pattern.regex.test(value)) {
				throw new InvalidRequestBodyError(what, `${at} must be ${pattern.describe}, got "${value}"`);
			}
		} else if (kind === "strings") {
			if (!Array.isArray(value) || value.some(item => typeof item !== "string" || item.length === 0)) {
				throw new InvalidRequestBodyError(what, `${at} must be an array of non-empty strings`);
			}
		} else if (kind === "count") {
			if (typeof value !== "number" || !Number.isInteger(value) || value < 1) {
				throw new InvalidRequestBodyError(what, `${at} must be an integer >= 1, got ${JSON.stringify(value)}`);
			}
		} else if (kind === "ratio") {
			if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) {
				throw new InvalidRequestBodyError(what, `${at} must be a number > 0, got ${JSON.stringify(value)}`);
			}
		} else if (kind === "boolean") {
			if (typeof value !== "boolean") throw new InvalidRequestBodyError(what, `${at} must be true or false`);
		} else {
			if (typeof value !== "object" || Array.isArray(value)) {
				throw new InvalidRequestBodyError(what, `${at} must be an object`);
			}
			const inner = spec.nested?.[key];
			if (!inner) continue;
			if (kind === "object") {
				checkFields(what, value as Record<string, unknown>, inner, key, spec);
				continue;
			}
			for (const [entryKey, entry] of Object.entries(value as Record<string, unknown>)) {
				if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
					throw new InvalidRequestBodyError(what, `"${key}.${entryKey}" must be an object`);
				}
				checkFields(what, entry as Record<string, unknown>, inner, `${key}.${entryKey}`, spec);
			}
		}
	}
}

/**
 * Reads an HTTP body against a spec, rejecting anything the operation behind it would mis-parse.
 *
 * Every mutating endpoint cast its JSON body to the interface it documents and used it, so a body
 * the caller got wrong still took effect: `concurrency: "lots"` and `tasks: -5` reached the runner
 * as command-line values, and a misspelled key -- `models` for `model`, `kind` for `benchmark` --
 * was dropped in silence and the run started on the defaults, costing a job directory, a store row
 * and a container before anything reported the mistake. A refusal names the boundary, the field and
 * the reason, and the router maps it to 400.
 */
export function parseRequestBody<T>(body: unknown, spec: BodySpec<T>): T {
	if (!body || typeof body !== "object" || Array.isArray(body)) {
		throw new InvalidRequestBodyError(spec.what, "the body is not a JSON object");
	}
	const raw = body as Record<string, unknown>;
	checkFields(
		spec.what,
		raw,
		spec.fields as Readonly<Record<string, BodyFieldKind>>,
		"the body",
		spec as BodySpec<unknown>,
	);

	for (const field of spec.required ?? []) {
		const value = raw[field];
		const blank = typeof value === "string" && value.trim().length === 0;
		if (value === undefined || value === null || blank) {
			throw new InvalidRequestBodyError(spec.what, `"${field}" is required`);
		}
	}
	return raw as T;
}

/**
 * Every field of a launch body, by name and by the kind of value it takes.
 *
 * `"strings"` is an array of non-empty strings, `"count"` an integer >= 1, `"ratio"` a finite
 * number > 0.
 */
export const LAUNCH_REQUEST_FIELDS: BodyFields<LaunchRequest> = {
	suite: "string",
	backend: "string",
	benchmark: "string",
	model: "string",
	dataset: "string",
	tasks: "count",
	include: "strings",
	concurrency: "count",
	timeoutMultiplier: "ratio",
	attempts: "count",
	agent: "string",
	jobName: "string",
	experiment: "string",
	arm: "string",
	webSearch: "boolean",
	environment: "string",
	prewalk: "object",
	role: "string",
	note: "string",
	goal: "string",
	prebuiltBinaries: "boolean",
	extraArgs: "strings",
};

/** Every field of a nested prewalk config, so a stray key there is rejected by name too. */
const PREWALK_FIELDS: BodyFields<PrewalkConfig> = { into: "string" };

/** A prewalk names the model it walks into, so an empty id is a mistake rather than a default. */
const PREWALK_PATTERNS = { into: { regex: /\S/, describe: "a non-empty model id" } } as const;

/** Per-run metadata an experiment update may set. */
const RUN_META_FIELDS: Readonly<Record<string, BodyFieldKind>> = { role: "string", note: "string", label: "string" };

/** The values a run's `environment` and `role` accept, pinned so a typo cannot reach the runner. */
const RUN_ENUMS: Readonly<Record<string, readonly string[]>> = {
	environment: ["docker", "apple-container"],
	role: ["baseline", "variant", ""],
};

/** POST /api/runs. */
export const LAUNCH_REQUEST_SPEC: BodySpec<LaunchRequest> = {
	what: "Launch request",
	fields: LAUNCH_REQUEST_FIELDS,
	enums: RUN_ENUMS,
	nested: { prewalk: PREWALK_FIELDS },
	patterns: PREWALK_PATTERNS,
	required: ["model"],
};

/** POST /api/experiments. */
export const CREATE_EXPERIMENT_SPEC: BodySpec<CreateExperimentRequest> = {
	what: "Create experiment request",
	fields: { id: "string", goal: "string" },
	patterns: {
		id: {
			regex: /^[A-Za-z0-9_.]+$/,
			describe: "a token of [A-Za-z0-9_.] (runs group as `<id>-<arm>`)",
		},
	},
	required: ["id"],
};

/** PUT /api/experiments/:id. */
export const EXPERIMENT_META_UPDATE_SPEC: BodySpec<ExperimentMetaUpdate> = {
	what: "Experiment update",
	fields: { goal: "string", runs: "map" },
	enums: RUN_ENUMS,
	nested: { runs: RUN_META_FIELDS },
};

/** POST /api/experiments/:id/arms. */
export const ADD_ARM_SPEC: BodySpec<AddArmRequest> = {
	what: "Add arm request",
	fields: {
		arm: "string",
		model: "string",
		prewalk: "object",
		include: "strings",
		role: "string",
		note: "string",
		extraArgs: "strings",
	},
	enums: RUN_ENUMS,
	nested: { prewalk: PREWALK_FIELDS },
	patterns: PREWALK_PATTERNS,
	required: ["arm", "model"],
};

/** POST /api/runs/:name/resume. */
export const RESUME_RUN_SPEC: BodySpec<ResumeRunRequest> = {
	what: "Resume request",
	fields: { filterErrorTypes: "strings" },
};

/**
 * The spec that checks each mutating route's body, or null for a route that takes no body.
 *
 * A mutating route added without an entry here has no checked body, so a contract suite sweeps
 * `SERVER_ROUTES` against this table and fails until the new route records its decision.
 */
export const BODY_SPEC_BY_ROUTE: Readonly<Record<string, BodySpec<never> | null>> = {
	"POST /api/experiments": CREATE_EXPERIMENT_SPEC as BodySpec<never>,
	"PUT /api/experiments/:id": EXPERIMENT_META_UPDATE_SPEC as BodySpec<never>,
	"DELETE /api/experiments/:id": null,
	"POST /api/experiments/:id/arms": ADD_ARM_SPEC as BodySpec<never>,
	"POST /api/runs": LAUNCH_REQUEST_SPEC as BodySpec<never>,
	"DELETE /api/runs/:name": null,
	"POST /api/runs/:name/cancel": null,
	"POST /api/runs/:name/resume": RESUME_RUN_SPEC as BodySpec<never>,
};

/** Reads a launch body, rejecting anything the runner would mis-parse. */
export function parseLaunchRequest(body: unknown): LaunchRequest {
	return parseRequestBody(body, LAUNCH_REQUEST_SPEC);
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
 * Route parameters that name one directory: a run's job directory, an experiment's rows. The
 * router refuses anything else for these, so `%2e%2e%2f` in a run name cannot reach a `path.join`
 * or a kill.
 */
export const PATH_SEGMENT_PARAMS: readonly string[] = ["name", "id"];

/**
 * Route parameters deliberately left free-form. A trace is matched against the names the store
 * holds for that run before anything opens a file, so the match is the check.
 */
export const FREE_FORM_PARAMS: readonly string[] = ["trace"];

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
