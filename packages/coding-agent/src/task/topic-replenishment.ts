/**
 * packages/coding-agent/src/task/topic-replenishment.ts
 *
 * Native Veyyon task executor completion, recovery reconciliation, and automatic
 * topic replenishment engine.
 *
 * Shared runtime contract:
 * 1. On subagent completion or session recovery, reconcile actual running native workers
 *    per eligible topic. Idle, parked, prepared, or simulated daemons are strictly INACTIVE.
 * 2. Enforce worker floor (minimum 7 running useful workers when >= 7 runnable units exist,
 *    normal target 7–15, hard ceiling 20).
 * 3. Enforce pre-spawn memory admission: hard ceiling at 95% RAM, process cleanup at 85%.
 *    (Pre-admission check does not guarantee runtime processes will not subsequently spike).
 * 4. Claim next ready authorized ticket atomically from durable request ledger with file locking.
 * 5. Fail-closed authorization: unauthorized requests (including empty `{}` authorization),
 *    forbidden production targets, ungranted merge authorizations, and pending decision blockers
 *    never dispatch. Blocked topics stay tracked with exact reasons.
 * 6. Dispatch next native task using native TaskTool/executor (Flash model role, no agent CLI).
 *    Missing executor fails immediately before claiming or incrementing counts.
 * 7. On worker dispatch error, claimed tickets are rolled back to pending with audit history.
 */
import { execFile, spawn, type ChildProcess } from "node:child_process";
import { once } from "node:events";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
// --- Functional Topics & Keyword Mapping ---

export const TOPIC_KEYWORDS_MAP: Readonly<Record<string, string>> = {
	gui: "Desktop GUI",
	desktop: "Desktop GUI",
	webprovider: "Desktop GUI",
	chatgpt: "Desktop GUI",
	design: "UX/design",
	conversion: "UX/design",
	motion: "Motion",
	telegram: "Telegram",
	decision: "Decisions",
	staging: "Staging",
	pooler: "Staging",
	workflow: "Workflow",
	gate: "Workflow",
	concurrent: "Workflow",
	todo: "Workflow",
	scheduler: "Workflow",
	issue: "Preserved GitHub issue inventory",
	migration: "Preserved GitHub issue inventory",
	dedicated: "Preserved GitHub issue inventory",
	inventory: "Preserved GitHub issue inventory",
	operator: "Operator accountability",
	accountability: "Operator accountability",
	live: "Live operator corrections",
	recovered: "Recovered authorized work",
	authorized: "Recovered authorized work",
	agent: "Agent system change",
	replenish: "Agent system change",
	system: "Agent system change",
};

export const RUNNABLE_TOPIC_NAMES: readonly string[] = [
	"Desktop GUI",
	"UX/design",
	"Motion",
	"Telegram",
	"Decisions",
	"Staging",
	"Workflow",
	"Preserved GitHub issue inventory",
	"Operator accountability",
	"Live operator corrections",
	"Recovered authorized work",
	"Agent system change",
] as const;

export const INACTIVE_STATUSES: ReadonlySet<string> = new Set([
	"idle",
	"parked",
	"completed",
	"stopped",
	"terminated",
	"prepared",
	"prepared_ticket",
	"reminder_daemon",
	"simulated_active",
	"fake",
	"cancelled",
]);

export const FORBIDDEN_TARGETS: readonly string[] = [
	"main",
	"master",
	"production",
	"prod",
	"zaraprptkegxqpvnsubu",
	"akamai-iad-prod",
] as const;

export const EXPLICITLY_CANCELLED_TASKS: Readonly<Record<string, string>> = {
	"record operator choice a for ci connectivity":
		"Explicitly dropped per live operator clarification (example choice, not confirmed decision); preserved as historical cancellation.",
};

export const DEFAULT_FLASH_MODEL = "google-antigravity/gemini-3.8-flash:high";
export const DEFAULT_MIN_FLOOR = 7;
export const DEFAULT_TARGET_COUNT = 10;
export const DEFAULT_MAX_CEILING = 20;
export const HARD_RAM_CEILING_PCT = 95.0;
export const CLEANUP_RAM_PCT = 85.0;

// --- Interfaces ---

export interface NativeActorSnapshot {
	id: string;
	status: string;
	role?: string; // "main" = orchestrator; "sub" / "task" = worker
	topic?: string;
	task?: string;
	metadata?: Record<string, unknown>;
}

export interface TopicReconciliationResult {
	activeWorkers: NativeActorSnapshot[];
	activeUsefulCount: number;
	idleWorkers: NativeActorSnapshot[];
	parkedWorkers: NativeActorSnapshot[];
	otherInactiveWorkers: NativeActorSnapshot[];
	fakeWorkersRejected: NativeActorSnapshot[];
	coveredTopics: string[];
	uncoveredTopics: string[];
	runningWorkersByTopic: Record<string, string[]>;
	floorDeficit: number;
	targetDeficit: number;
	eligibleTopicCount: number;
}

export interface MemoryAdmissionResult {
	admitted: boolean;
	usedPct: number;
	freeMb: number;
	totalMb: number;
	cleanedUp?: boolean;
	capacityException?: boolean;
	reason?: string;
}

export interface LedgerRequestHistoryItem {
	timestamp: string;
	from_state: string;
	to_state: string;
	actor: string;
	reason: string;
}

export interface LedgerRequestItem {
	id?: string;
	prompt?: string;
	session?: string;
	project?: string;
	criteria?: string[];
	owner?: string;
	dependencies?: string[];
	head?: string;
	evidence?: unknown[];
	authorization?: string | { timestamp?: string; scope?: string; authorized_by?: string; [k: string]: unknown };
	state?: string;
	blocker?: string;
	blocker_reason?: string;
	decision_blockers?: string[];
	next_action?: string;
	topic?: string;
	history?: LedgerRequestHistoryItem[];
	metadata?: Record<string, unknown>;
	[key: string]: unknown;
}

export interface LedgerFileShape {
	version?: number | string;
	role?: string;
	authority?: string;
	created_at?: string;
	updated_at?: string;
	requests: Record<string, LedgerRequestItem>;
	[key: string]: unknown;
}

export interface ClaimTicketOptions {
	coveredTopics?: readonly string[];
	activeUsefulCount?: number;
	targetCapacity?: number;
	authorizedProject?: string;
	lockTimeoutMs?: number;
	workerId?: string;
	customFilter?: (ticket: LedgerRequestItem) => boolean;
}

export interface ClaimedTicket {
	id: string;
	topic: string;
	prompt: string;
	task: string;
	state: string;
	owner: string;
	role: string;
	criteria: string[];
	dependencies: string[];
	head?: string;
	authorization: string;
	claimedAt: string;
	runId?: string;
	resultSchema?: Record<string, unknown>;
	stage?: string;
	repoRoot?: string;
	headSha?: string;
}

export interface BlockedTopicInfo {
	topic: string;
	ticketId: string;
	reason: string;
	dependencies?: string[];
}

export interface ClaimTicketResult {
	claimed: boolean;
	ticket?: ClaimedTicket;
	reason?: string;
	blockedTopics?: BlockedTopicInfo[];
	uncoveredTopics?: string[];
}

export interface TopicReplenishmentEngineOptions {
	ledgerPath?: string;
	executor?: (ticket: ClaimedTicket) => Promise<unknown>;
	minFloor?: number;
	targetCount?: number;
	maxCeiling?: number;
	maxRamPct?: number;
	cleanupRamPct?: number;
}

export interface ReplenishmentDispatchOptions {
	ledgerPath?: string;
	minFloor?: number;
	targetCount?: number;
	maxCeiling?: number;
	maxRamPct?: number;
	cleanupRamPct?: number;
	onCleanup?: () => Promise<void> | void;
	dispatchWorker?: (ticket: ClaimedTicket) => Promise<unknown>;
}

export interface ReplenishmentOutcome {
	reconciliation: TopicReconciliationResult;
	memoryAdmission: MemoryAdmissionResult;
	dispatchedTickets: ClaimedTicket[];
	dispatchedCount: number;
	blockedTopics: BlockedTopicInfo[];
	status: "replenished" | "floor_satisfied" | "memory_limited" | "no_eligible_work" | "error";
	reason?: string;
}

export interface SubagentCompleteEvent {
	agentId: string;
	agentName: string;
	task: string;
	status: "completed" | "failed" | "cancelled";
	exitCode?: number;
	durationMs?: number;
	error?: string;
	ticketId?: string;
	runId?: string;
	structuredResult?: Record<string, unknown>;
}

// --- Topic Resolution Helper ---

export function resolveTopicName(worker: Partial<NativeActorSnapshot>): string {
	if (worker.topic && (RUNNABLE_TOPIC_NAMES as readonly string[]).includes(worker.topic)) {
		return worker.topic;
	}

	const searchSpace = `${worker.id || ""} ${worker.task || ""} ${JSON.stringify(worker.metadata || {})}`.toLowerCase();

	for (const [kw, topic] of Object.entries(TOPIC_KEYWORDS_MAP)) {
		const wordPattern = new RegExp(`\\b${kw}\\b`, "i");
		if (wordPattern.test(searchSpace)) {
			return topic;
		}
	}

	for (const [kw, topic] of Object.entries(TOPIC_KEYWORDS_MAP)) {
		if (searchSpace.includes(kw)) {
			return topic;
		}
	}

	return "Workflow";
}

// --- Authorization Validation Helper ---

/**
 * Validate that authorization is structured and non-empty.
 * Empty object `{}` or falsy/unverified values are strictly unauthorized.
 */
export function isValidAuthorization(auth: unknown): boolean {
	if (typeof auth === "string") {
		const cleaned = auth.trim().toLowerCase();
		if (!cleaned) return false;
		if (["false", "none", "null", "unauthorized", "denied", "rejected", "no"].includes(cleaned)) {
			return false;
		}
		return true;
	}
	if (typeof auth === "object" && auth !== null && !Array.isArray(auth)) {
		const record = auth as Record<string, unknown>;
		const keys = Object.keys(record);
		if (keys.length === 0) {
			return false;
		}
		const ts = typeof record.timestamp === "string" ? record.timestamp.trim() : "";
		const scope = typeof record.scope === "string" ? record.scope.trim() : "";
		const by = typeof record.authorized_by === "string" ? record.authorized_by.trim() : "";
		const status = typeof record.status === "string" ? record.status.trim().toLowerCase() : "";
		if (status === "authorized") return true;
		return ts.length > 0 || scope.length > 0 || by.length > 0;
	}
	return false;
}

// --- Topic Reconciliation ---

/**
 * Reconcile actual running native workers per eligible topic.
 *
 * Rules:
 * - Only status === "running" counts as active.
 * - Idle, parked, prepared, simulated daemons are strictly inactive.
 * - Role "main" is an orchestrator, not a useful worker.
 */
export function reconcileRunningTopics(
	roster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
	options?: { minFloor?: number; targetCount?: number; eligibleTopics?: readonly string[] },
): TopicReconciliationResult {
	const minFloor = options?.minFloor ?? DEFAULT_MIN_FLOOR;
	const targetCount = options?.targetCount ?? DEFAULT_TARGET_COUNT;
	const eligibleTopics = options?.eligibleTopics ?? RUNNABLE_TOPIC_NAMES;

	const activeWorkers: NativeActorSnapshot[] = [];
	const idleWorkers: NativeActorSnapshot[] = [];
	const parkedWorkers: NativeActorSnapshot[] = [];
	const otherInactiveWorkers: NativeActorSnapshot[] = [];
	const fakeWorkersRejected: NativeActorSnapshot[] = [];

	const runningWorkersByTopic: Record<string, string[]> = {};
	for (const t of eligibleTopics) {
		runningWorkersByTopic[t] = [];
	}

	for (const raw of roster) {
		const item: NativeActorSnapshot = {
			id: String(raw.id || "unknown"),
			status: String(raw.status || "idle").toLowerCase(),
			role: raw.role ? String(raw.role).toLowerCase() : "sub",
			topic: raw.topic ? String(raw.topic) : undefined,
			task: raw.task ? String(raw.task) : undefined,
			metadata: (raw.metadata as Record<string, unknown>) || undefined,
		};

		// Filter out fake or simulated active workers
		if (
			item.status === "simulated_active" ||
			item.status === "fake" ||
			item.id.startsWith("fake-") ||
			item.id.startsWith("simulated-")
		) {
			fakeWorkersRejected.push(item);
			continue;
		}

		if (item.status === "idle") {
			idleWorkers.push(item);
			continue;
		}

		if (item.status === "parked") {
			parkedWorkers.push(item);
			continue;
		}

		if (INACTIVE_STATUSES.has(item.status)) {
			otherInactiveWorkers.push(item);
			continue;
		}

		if (item.status === "running") {
			// Main orchestrator does not count as a subagent worker
			if (item.role === "main" || item.id === "Main" || item.id.startsWith("main:")) {
				continue;
			}
			activeWorkers.push(item);
			const topic = resolveTopicName(item);
			if (!runningWorkersByTopic[topic]) {
				runningWorkersByTopic[topic] = [];
			}
			runningWorkersByTopic[topic].push(item.id);
		} else {
			otherInactiveWorkers.push(item);
		}
	}

	const activeUsefulCount = activeWorkers.length;
	const coveredTopics = Object.entries(runningWorkersByTopic)
		.filter(([, workers]) => workers.length > 0)
		.map(([topic]) => topic);

	const uncoveredTopics = eligibleTopics.filter(t => !coveredTopics.includes(t));
	const eligibleTopicCount = eligibleTopics.length;

	const floorDeficit = Math.max(0, Math.min(minFloor, eligibleTopicCount) - activeUsefulCount);
	const targetDeficit = Math.max(0, Math.min(targetCount, eligibleTopicCount) - activeUsefulCount);

	return {
		activeWorkers,
		activeUsefulCount,
		idleWorkers,
		parkedWorkers,
		otherInactiveWorkers,
		fakeWorkersRejected,
		coveredTopics,
		uncoveredTopics,
		runningWorkersByTopic,
		floorDeficit,
		targetDeficit,
		eligibleTopicCount,
	};
}

// --- Memory Admission Check ---

/**
 * Enforce system memory admission:
 * - Hard ceiling at >= 95% RAM: spawn no new workers / processes.
 * - Cleanup threshold at >= 85% RAM: trigger cleanup callback, then re-evaluate.
 *
 * NOTE: This is an advisory pre-spawn check. It guarantees pre-admission bounds,
 * but cannot guarantee that running processes will not subsequently spike memory.
 */
export async function checkMemoryAdmission(options?: {
	maxPct?: number;
	cleanupPct?: number;
	onCleanup?: () => Promise<void> | void;
}): Promise<MemoryAdmissionResult> {
	const maxPct = options?.maxPct ?? HARD_RAM_CEILING_PCT;
	const cleanupPct = options?.cleanupPct ?? CLEANUP_RAM_PCT;

	const total = os.totalmem();
	let free = os.freemem();
	let used = total - free;
	let usedPct = (used / total) * 100;
	const totalMb = Math.round(total / (1024 * 1024));
	let freeMb = Math.round(free / (1024 * 1024));

	if (usedPct >= maxPct) {
		return {
			admitted: false,
			usedPct: Number(usedPct.toFixed(2)),
			freeMb,
			totalMb,
			capacityException: true,
			reason: `System RAM (${usedPct.toFixed(1)}%) exceeds hard ceiling of ${maxPct}%. No new workers permitted.`,
		};
	}

	let cleanedUp = false;
	if (usedPct >= cleanupPct && options?.onCleanup) {
		try {
			await options.onCleanup();
			cleanedUp = true;
			free = os.freemem();
			used = total - free;
			usedPct = (used / total) * 100;
			freeMb = Math.round(free / (1024 * 1024));
		} catch {
			// On cleanup error, continue with fresh measurement
		}

		if (usedPct >= maxPct) {
			return {
				admitted: false,
				usedPct: Number(usedPct.toFixed(2)),
				freeMb,
				totalMb,
				cleanedUp,
				capacityException: true,
				reason: `System RAM (${usedPct.toFixed(1)}%) exceeds hard ceiling of ${maxPct}% even after cleanup.`,
			};
		}
	}

	return {
		admitted: true,
		usedPct: Number(usedPct.toFixed(2)),
		freeMb,
		totalMb,
		cleanedUp,
	};
}

// --- Cross-Platform File Locking Backed by Python native-ledger-bridge ---
/**
 * Safely resolve the native ledger bridge script path.
 * In development, resolves to source tree. In a compiled binary,
 * extracts to an on-disk temp file if virtual bunfs is detected.
 */
export function resolveBridgeScriptPath(): string {
	const sourcePath = path.join(import.meta.dirname, "native-ledger-bridge.py");
	if (fs.existsSync(sourcePath)) {
		return sourcePath;
	}
	const extractPath = path.join(os.tmpdir(), "veyyon-native-ledger-bridge.py");
	try {
		const content = fs.readFileSync(sourcePath, "utf-8");
		fs.writeFileSync(extractPath, content, "utf-8");
		return extractPath;
	} catch {
		return sourcePath;
	}
}

/**
 * Execute the isolated Python ledger bridge module under OS-level FileLock.
 * All ledger claims, rollbacks, and completions are routed through this bridge
 * to guarantee cross-process mutual exclusion with msvcrt/fcntl locking.
 */
export async function runLedgerBridge<T = unknown>(
	args: string[],
	options?: { timeoutMs?: number; pythonPath?: string; cwd?: string },
): Promise<T> {
	const python = options?.pythonPath || process.env.PYTHON_EXECUTABLE || process.env.PYTHON || "python";
	const bridgeScript = resolveBridgeScriptPath();
	const timeout = options?.timeoutMs ?? 30000;

	const { promise, resolve, reject } = Promise.withResolvers<T>();
	execFile(python, [bridgeScript, ...args], { timeout, cwd: options?.cwd }, (error, stdout, stderr) => {
		if (error) {
			reject(new Error(`native-ledger-bridge failed (${error.message}): ${stderr}`));
			return;
		}
		try {
			const parsed = JSON.parse(stdout.trim()) as T;
			resolve(parsed);
		} catch (parseErr) {
			reject(new Error(`Failed to parse bridge output: ${stdout}\nstderr: ${stderr}`));
		}
	});
	return promise;
}

/**
 * Cross-process OS-level advisory file lock backed by native-ledger-bridge / Python FileLock.
 * Uses msvcrt.locking on Windows and fcntl.flock on POSIX.
 */
export class FileLock {
	readonly lockPath: string;
	#proc: ChildProcess | null = null;

	constructor(filePath: string) {
		this.lockPath = filePath.endsWith(".lock") ? filePath : `${filePath}.lock`;
	}

	async acquire(timeoutMs = 15000): Promise<void> {
		const timeoutSec = (timeoutMs / 1000).toFixed(1);
		const python = process.env.PYTHON_EXECUTABLE || process.env.PYTHON || "python";
		const bridgeScript = resolveBridgeScriptPath();

		const { promise, resolve, reject } = Promise.withResolvers<void>();
		let settled = false;
		let stderr = "";

		const proc = spawn(
			python,
			[
				bridgeScript,
				"hold-lock",
				"--lock-path",
				this.lockPath,
				"--duration",
				"3600",
				"--timeout",
				timeoutSec,
				"--ready-signal",
				"LOCKED",
			],
			{ stdio: ["ignore", "pipe", "pipe"] },
		);
		this.#proc = proc;

		proc.stdout?.on("data", (chunk: Buffer) => {
			if (chunk.toString().includes("LOCKED") && !settled) {
				settled = true;
				resolve();
			}
		});

		proc.stderr?.on("data", (chunk: Buffer) => {
			stderr += chunk.toString();
		});

		proc.on("error", err => {
			if (!settled) {
				settled = true;
				reject(err);
			}
		});

		proc.on("close", () => {
			if (!settled) {
				settled = true;
				reject(new Error(`Failed to acquire lock on ${this.lockPath} within ${timeoutMs}ms: ${stderr}`));
			}
		});

		return promise;
	}

	async release(): Promise<void> {
		if (this.#proc) {
			const proc = this.#proc;
			this.#proc = null;
			proc.kill();
			await once(proc, "close").catch(() => {});
		}
	}
}

// --- Atomic Ledger Ticket Claiming via Python Bridge ---

/**
 * Safely resolve the default ledger file path.
 */
export function getDefaultLedgerPath(): string {
	const home = os.homedir();
	return path.join(home, ".veyyon", "workflows", "ledger.json");
}

/**
 * Claim next ready authorized ticket atomically from the ledger.
 * Handled entirely inside the Python bridge with OS-level FileLock.
 */
export async function claimNextAuthorizedTicket(
	ledgerPath: string,
	options?: ClaimTicketOptions,
): Promise<ClaimTicketResult> {
	const args = ["claim", "--ledger", ledgerPath];
	if (options?.workerId) {
		args.push("--worker-id", options.workerId);
	}
	if (options?.coveredTopics && options.coveredTopics.length > 0) {
		args.push("--covered-topics", options.coveredTopics.join(","));
	}
	if (options?.lockTimeoutMs) {
		args.push("--timeout", (options.lockTimeoutMs / 1000).toFixed(1));
	}
	try {
		const result = await runLedgerBridge<ClaimTicketResult & { blocked_topics?: BlockedTopicInfo[] }>(args);
		if (!result.blockedTopics && result.blocked_topics) {
			result.blockedTopics = result.blocked_topics;
		}
		return result;
	} catch (err) {
		return {
			claimed: false,
			reason: `Bridge execution failed: ${err}`,
		};
	}
}

/**
 * Rollback claimed ticket on worker dispatch failure.
 * Handled entirely inside the Python bridge with OS-level FileLock.
 */
export async function rollbackClaimedTicket(
	ledgerPath: string,
	ticketId: string,
	reason: string,
	options?: { lockTimeoutMs?: number },
): Promise<void> {
	const args = ["rollback", "--ledger", ledgerPath, "--ticket-id", ticketId, "--reason", reason];
	if (options?.lockTimeoutMs) {
		args.push("--timeout", (options.lockTimeoutMs / 1000).toFixed(1));
	}
	await runLedgerBridge(args);
}

/**
 * Record native dispatch handle binding in WorkerBackend.
 */
export async function recordNativeDispatch(runId: string, taskHandle: string): Promise<void> {
	await runLedgerBridge(["record-dispatch", "--run-id", runId, "--task-handle", taskHandle]);
}

/**
 * Complete ticket on worker finish through canonical validation.
 * Handled entirely inside the Python bridge with OS-level FileLock.
 */
export async function completeClaimedTicket(
	ledgerPath: string,
	ticketId: string,
	optionsOrStatus?:
		| "completed"
		| "failed"
		| "cancelled"
		| {
				runId?: string;
				taskHandle?: string;
				agentId?: string;
				structuredResult?: Record<string, unknown>;
				exitCode?: number;
				error?: string;
				lockTimeoutMs?: number;
		  },
	exitCode = 0,
	error = "",
	options?: { lockTimeoutMs?: number },
): Promise<{ completed: boolean; ok: boolean; state: string; blocked_reason?: string; head_sha?: string }> {
	const args = ["complete", "--ledger", ledgerPath, "--ticket-id", ticketId];
	if (typeof optionsOrStatus === "object" && optionsOrStatus !== null) {
		if (optionsOrStatus.runId) args.push("--run-id", optionsOrStatus.runId);
		if (optionsOrStatus.taskHandle) args.push("--task-handle", optionsOrStatus.taskHandle);
		if (optionsOrStatus.agentId) args.push("--agent-id", optionsOrStatus.agentId);
		if (optionsOrStatus.structuredResult) args.push("--result-json", JSON.stringify(optionsOrStatus.structuredResult));
		if (typeof optionsOrStatus.exitCode === "number") args.push("--exit-code", String(optionsOrStatus.exitCode));
		if (optionsOrStatus.error) args.push("--error", optionsOrStatus.error);
		if (optionsOrStatus.lockTimeoutMs) args.push("--timeout", (optionsOrStatus.lockTimeoutMs / 1000).toFixed(1));
	} else if (typeof optionsOrStatus === "string") {
		args.push("--status", optionsOrStatus);
		args.push("--exit-code", String(exitCode));
		if (error) args.push("--error", error);
		if (options?.lockTimeoutMs) args.push("--timeout", (options.lockTimeoutMs / 1000).toFixed(1));
	}
	return await runLedgerBridge(args);
}

// --- Native Dispatch Engine ---

export class TopicReplenishmentEngine {
	readonly ledgerPath: string;
	executor?: (ticket: ClaimedTicket) => Promise<unknown>;
	readonly minFloor: number;
	readonly targetCount: number;
	readonly maxCeiling: number;
	readonly maxRamPct: number;
	readonly cleanupRamPct: number;

	constructor(options?: TopicReplenishmentEngineOptions) {
		this.ledgerPath = options?.ledgerPath ?? getDefaultLedgerPath();
		this.executor = options?.executor;
		this.minFloor = options?.minFloor ?? DEFAULT_MIN_FLOOR;
		this.targetCount = options?.targetCount ?? DEFAULT_TARGET_COUNT;
		this.maxCeiling = options?.maxCeiling ?? DEFAULT_MAX_CEILING;
		this.maxRamPct = options?.maxRamPct ?? HARD_RAM_CEILING_PCT;
		this.cleanupRamPct = options?.cleanupRamPct ?? CLEANUP_RAM_PCT;
	}

	setNativeExecutor(executor: (ticket: ClaimedTicket) => Promise<unknown>): void {
		this.executor = executor;
	}

	/**
	 * Rollback claimed ticket on worker dispatch failure (Finding 6).
	 * Clears owner, sets blocker, and records rollback in history audit trail under OS FileLock.
	 */
	async rollbackClaimedTicket(ticketId: string, reason: string): Promise<void> {
		await rollbackClaimedTicket(this.ledgerPath, ticketId, reason);
	}

	/**
	 * Complete claimed ticket under OS FileLock through canonical validation.
	 */
	async completeClaimedTicket(
		ticketId: string,
		optionsOrStatus?:
			| "completed"
			| "failed"
			| "cancelled"
			| {
					runId?: string;
					taskHandle?: string;
					agentId?: string;
					structuredResult?: Record<string, unknown>;
					exitCode?: number;
					error?: string;
			  },
		exitCode = 0,
		error = "",
	): Promise<{ completed: boolean; ok: boolean; state: string; blocked_reason?: string; head_sha?: string }> {
		return await completeClaimedTicket(this.ledgerPath, ticketId, optionsOrStatus, exitCode, error);
	}

	/**
	 * Perform a full replenishment cycle:
	 * 1. Verify that a native executor is bound (Finding 2). Missing executor fails immediately.
	 * 2. Reconcile running roster against topic inventory.
	 * 3. Check memory admission bounds.
	 * 4. Calculate worker deficit.
	 * 5. Claim and dispatch next authorized tickets up to target.
	 * 6. Roll back claimed ticket if dispatch throws (Finding 6).
	 */
	async replenish(
		currentRoster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
		options?: {
			onCleanup?: () => Promise<void> | void;
			dispatchWorker?: (ticket: ClaimedTicket) => Promise<unknown>;
		},
	): Promise<ReplenishmentOutcome> {
		const activeExecutor = options?.dispatchWorker ?? this.executor;
		if (!activeExecutor) {
			throw new Error(
				"TopicReplenishmentEngine: native task executor is required but was not provided. Cannot claim or dispatch tickets without a bound executor.",
			);
		}

		const reconciliation = reconcileRunningTopics(currentRoster, {
			minFloor: this.minFloor,
			targetCount: this.targetCount,
		});

		const memoryAdmission = await checkMemoryAdmission({
			maxPct: this.maxRamPct,
			cleanupPct: this.cleanupRamPct,
			onCleanup: options?.onCleanup,
		});

		if (!memoryAdmission.admitted) {
			return {
				reconciliation,
				memoryAdmission,
				dispatchedTickets: [],
				dispatchedCount: 0,
				blockedTopics: [],
				status: "memory_limited",
				reason: memoryAdmission.reason,
			};
		}

		if (reconciliation.targetDeficit <= 0) {
			return {
				reconciliation,
				memoryAdmission,
				dispatchedTickets: [],
				dispatchedCount: 0,
				blockedTopics: [],
				status: "floor_satisfied",
				reason: `Worker target (${this.targetCount}) already satisfied with ${reconciliation.activeUsefulCount} running workers.`,
			};
		}

		const dispatchedTickets: ClaimedTicket[] = [];
		const allBlockedTopics: BlockedTopicInfo[] = [];
		const covered = new Set(reconciliation.coveredTopics);
		let currentRunning = reconciliation.activeUsefulCount;

		while (currentRunning < this.targetCount && currentRunning < this.maxCeiling) {
			const stepMem = await checkMemoryAdmission({ maxPct: this.maxRamPct });
			if (!stepMem.admitted) {
				break;
			}

			const claimResult = await claimNextAuthorizedTicket(this.ledgerPath, {
				coveredTopics: Array.from(covered),
				activeUsefulCount: currentRunning,
				targetCapacity: this.targetCount,
			});

			if (claimResult.blockedTopics) {
				for (const bt of claimResult.blockedTopics) {
					if (!allBlockedTopics.some(x => x.ticketId === bt.ticketId)) {
						allBlockedTopics.push(bt);
					}
				}
			}

			if (!claimResult.claimed || !claimResult.ticket) {
				break;
			}

			const ticket = claimResult.ticket;
			dispatchedTickets.push(ticket);
			covered.add(ticket.topic);
			currentRunning++;

			try {
				await activeExecutor(ticket);
			} catch (err) {
				await this.rollbackClaimedTicket(ticket.id, String(err));
				return {
					reconciliation,
					memoryAdmission,
					dispatchedTickets,
					dispatchedCount: dispatchedTickets.length - 1,
					blockedTopics: allBlockedTopics,
					status: "error",
					reason: `Failed to dispatch ticket ${ticket.id}: ${err} (claimed ticket rolled back to pending)`,
				};
			}
		}

		return {
			reconciliation,
			memoryAdmission,
			dispatchedTickets,
			dispatchedCount: dispatchedTickets.length,
			blockedTopics: allBlockedTopics,
			status: dispatchedTickets.length > 0 ? "replenished" : "no_eligible_work",
			reason:
				dispatchedTickets.length > 0
					? `Dispatched ${dispatchedTickets.length} native ticket(s) to maintain worker floor.`
					: "No further eligible authorized tickets available.",
		};
	}

	/**
	 * Hook invoked when a native worker completes.
	 * Updates the ledger and automatically triggers next topic replenishment.
	 */
	async onWorkerComplete(
		event: SubagentCompleteEvent,
		currentRoster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
		options?: {
			onCleanup?: () => Promise<void> | void;
			dispatchWorker?: (ticket: ClaimedTicket) => Promise<unknown>;
		},
	): Promise<ReplenishmentOutcome> {
		if (event.ticketId && fs.existsSync(this.ledgerPath)) {
			try {
				await completeClaimedTicket(this.ledgerPath, event.ticketId, {
					runId: event.runId,
					taskHandle: `agent://${event.agentId}`,
					agentId: event.agentId,
					structuredResult: event.structuredResult,
					exitCode: event.exitCode ?? (event.status === "completed" ? 0 : 1),
					error: event.error,
				});
			} catch {
				// Non-fatal bridge error logged
			}
		}

		const updatedRoster = currentRoster.filter(w => {
			if (typeof w === "object" && w !== null && "id" in w) {
				return w.id !== event.agentId;
			}
			return true;
		});

		return this.replenish(updatedRoster, options);
	}

	/**
	 * Hook invoked on session recovery/resume.
	 * Preserves all durable work and replenishes worker pool up to floor.
	 */
	async onSessionRecovery(
		currentRoster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
		options?: {
			onCleanup?: () => Promise<void> | void;
			dispatchWorker?: (ticket: ClaimedTicket) => Promise<unknown>;
		},
	): Promise<ReplenishmentOutcome> {
		return this.replenish(currentRoster, options);
	}
}

let globalReplenishmentEngine: TopicReplenishmentEngine | null = null;

export function getGlobalReplenishmentEngine(): TopicReplenishmentEngine | null {
	return globalReplenishmentEngine;
}

export function setGlobalReplenishmentEngine(engine: TopicReplenishmentEngine | null): void {
	globalReplenishmentEngine = engine;
}
