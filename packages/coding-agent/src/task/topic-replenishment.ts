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
 * 5. Fail-closed authorization: unauthorized requests, forbidden production targets, and
 *    ungranted merge authorizations never dispatch. Blocked topics stay tracked with exact reasons.
 * 6. Dispatch next native task using native TaskTool/executor (Flash model role, no agent CLI).
 */

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

export interface LedgerRequestItem {
	prompt?: string;
	session?: string;
	project?: string;
	criteria?: string[];
	owner?: string;
	dependencies?: string[];
	head?: string;
	evidence?: unknown[];
	authorization?: string | { timestamp?: string; scope?: string; [k: string]: unknown };
	state?: string;
	blocker?: string;
	blocker_reason?: string;
	next_action?: string;
	topic?: string;
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

// --- Cross-Platform File Locking ---

export class FileLock {
	readonly lockPath: string;
	#fd: fs.promises.FileHandle | null = null;

	constructor(filePath: string) {
		this.lockPath = `${filePath}.lock`;
	}

	async acquire(timeoutMs = 10000, retryIntervalMs = 50): Promise<void> {
		const deadline = Date.now() + timeoutMs;
		while (Date.now() < deadline) {
			try {
				this.#fd = await fs.promises.open(this.lockPath, "wx");
				await this.#fd.writeFile(
					JSON.stringify({ pid: process.pid, time: Date.now(), iso: new Date().toISOString() }),
				);
				return;
			} catch (err: unknown) {
				const error = err as { code?: string };
				if (error?.code === "EEXIST") {
					try {
						const stat = await fs.promises.stat(this.lockPath);
						// If lock file is older than 30s, treat as stale from crashed process
						if (Date.now() - stat.mtimeMs > 30000) {
							await fs.promises.unlink(this.lockPath).catch(() => {});
						}
					} catch {}
					const { promise, resolve } = Promise.withResolvers<void>();
					setTimeout(resolve, retryIntervalMs);
					await promise;
					continue;
				}
				throw err;
			}
		}
		throw new Error(`Failed to acquire lock on ${this.lockPath} within ${timeoutMs}ms`);
	}

	async release(): Promise<void> {
		if (this.#fd !== null) {
			try {
				await this.#fd.close();
			} catch {}
			this.#fd = null;
		}
		try {
			await fs.promises.unlink(this.lockPath);
		} catch {}
	}
}

// --- Atomic Ledger Ticket Claiming ---

/**
 * Safely resolve the default ledger file path.
 */
export function getDefaultLedgerPath(): string {
	const home = os.homedir();
	return path.join(home, ".veyyon", "workflows", "ledger.json");
}

/**
 * Claim next ready authorized ticket atomically from the ledger.
 *
 * Invariants enforced:
 * 1. Unauthorized tickets are strictly refused.
 * 2. Forbidden production targets ("main", "production", etc.) are strictly refused.
 * 3. Ungranted merge authorizations ("awaiting authorization") never auto-dispatch.
 * 4. Explicitly cancelled tasks (e.g. choice A) are never restored or claimed.
 * 5. Blocked topics stay tracked with exact reasons.
 * 6. Priority: uncovered runnable topics first, then target-capacity filling.
 */
export async function claimNextAuthorizedTicket(
	ledgerPath: string,
	options?: ClaimTicketOptions,
): Promise<ClaimTicketResult> {
	const lock = new FileLock(ledgerPath);
	const lockTimeoutMs = options?.lockTimeoutMs ?? 10000;
	const coveredTopics = new Set(options?.coveredTopics ?? []);
	const blockedTopics: BlockedTopicInfo[] = [];

	await lock.acquire(lockTimeoutMs);
	try {
		if (!fs.existsSync(ledgerPath)) {
			return { claimed: false, reason: `Ledger file does not exist at ${ledgerPath}` };
		}

		const raw = await fs.promises.readFile(ledgerPath, "utf-8");
		let ledgerData: LedgerFileShape;
		try {
			ledgerData = JSON.parse(raw) as LedgerFileShape;
		} catch (err) {
			return { claimed: false, reason: `Malformed ledger JSON: ${err}` };
		}

		const requests = ledgerData.requests || {};
		const drivableStates = new Set(["pending", "implementation", "QA", "review"]);

		interface Candidate {
			id: string;
			topic: string;
			req: LedgerRequestItem;
			priority: number; // 1 = uncovered topic, 2 = covered topic
		}

		const candidates: Candidate[] = [];

		for (const [id, req] of Object.entries(requests)) {
			const promptText = req.prompt || "";
			const canonicalPrompt = promptText.trim().toLowerCase().replace(/\s+/g, " ");

			// 1. Skip explicitly cancelled tasks
			if (EXPLICITLY_CANCELLED_TASKS[canonicalPrompt]) {
				continue;
			}
			if (req.state === "cancelled" || req.state === "dropped") {
				continue;
			}

			// 2. Fail-closed target guard (production & merge)
			const forbiddenMatch = FORBIDDEN_TARGETS.find(target => {
				const p = promptText.toLowerCase();
				return p.includes(`@${target}`) || p.includes(`branch ${target}`) || p.includes(`target: ${target}`);
			});
			if (forbiddenMatch) {
				continue;
			}

			// 3. Fail-closed authorization check
			const auth = req.authorization;
			const isAuthorized =
				auth !== undefined &&
				auth !== null &&
				auth !== "" &&
				(typeof auth === "string" ? auth.trim().length > 0 : true);

			if (!isAuthorized) {
				continue;
			}

			// 4. Check for ungranted merge authorization
			if (req.state === "awaiting authorization") {
				continue;
			}

			const state = (req.state || "pending").toLowerCase();

			// Skip if already claimed and in progress by an owner
			if (req.owner && typeof req.owner === "string" && req.owner.trim().length > 0 && state !== "pending") {
				continue;
			}

			// 5. Check blocker status
			if (req.blocker || req.blocker_reason || state === "blocked") {
				const topic = resolveTopicName({ id, task: promptText, metadata: req.metadata });
				blockedTopics.push({
					topic,
					ticketId: id,
					reason: req.blocker || req.blocker_reason || "Task marked blocked",
				});
				continue;
			}

			// 6. Check if state is drivable
			if (!drivableStates.has(state)) {
				continue;
			}
			// 7. Check dependency blockers
			if (Array.isArray(req.dependencies) && req.dependencies.length > 0) {
				const terminalStates = new Set(["done", "live verification", "integration", "awaiting authorization"]);
				const unfulfilledDeps = req.dependencies.filter(depId => {
					const dep = requests[depId];
					return !dep || !terminalStates.has((dep.state || "").toLowerCase());
				});
				if (unfulfilledDeps.length > 0) {
					const topic = resolveTopicName({ id, task: promptText, metadata: req.metadata });
					blockedTopics.push({
						topic,
						ticketId: id,
						reason: `Dependencies unfulfilled: ${unfulfilledDeps.join(", ")}`,
						dependencies: unfulfilledDeps,
					});
					continue;
				}
			}

			// 8. Custom filter if supplied
			if (options?.customFilter && !options.customFilter(req)) {
				continue;
			}

			// Derive topic (honoring explicit req.topic or metadata.topic if present)
			const explicitTopic =
				typeof req.topic === "string"
					? req.topic
					: req.metadata && typeof req.metadata === "object" && "topic" in req.metadata && typeof req.metadata.topic === "string"
						? req.metadata.topic
						: undefined;
			const topic = resolveTopicName({ id, topic: explicitTopic, task: promptText, metadata: req.metadata });
			const isUncovered = !coveredTopics.has(topic);
			const priority = isUncovered ? 1 : 2;

			candidates.push({ id, topic, req, priority });
		}

		if (candidates.length === 0) {
			return {
				claimed: false,
				reason: "No eligible authorized tickets found",
				blockedTopics,
			};
		}

		// Sort by priority (uncovered first), then id
		candidates.sort((a, b) => a.priority - b.priority || a.id.localeCompare(b.id));

		const chosen = candidates[0];
		const workerId = options?.workerId || `native-replenish-${Date.now().toString(36)}`;
		const nowIso = new Date().toISOString();

		// Update ledger request atomically
		const updatedState = (chosen.req.state || "pending").toLowerCase() === "pending" ? "implementation" : chosen.req.state!;
		chosen.req.state = updatedState;
		chosen.req.owner = workerId;
		chosen.req.claimed_at = nowIso;
		chosen.req.updated_at = nowIso;
		ledgerData.updated_at = nowIso;

		// Write to temp file on the same filesystem and atomic rename
		const dir = path.dirname(ledgerPath);
		const tempFile = path.join(dir, `.tmp-ledger-${Date.now()}-${Math.random().toString(36).slice(2)}.json`);
		await fs.promises.writeFile(tempFile, JSON.stringify(ledgerData, null, 2), "utf-8");
		await fs.promises.rename(tempFile, ledgerPath);

		const claimedTicket: ClaimedTicket = {
			id: chosen.id,
			topic: chosen.topic,
			prompt: chosen.req.prompt || "",
			task: chosen.req.prompt || "",
			state: updatedState,
			owner: workerId,
			role: "fast",
			criteria: chosen.req.criteria || [],
			dependencies: chosen.req.dependencies || [],
			head: chosen.req.head,
			authorization: typeof chosen.req.authorization === "string" ? chosen.req.authorization : JSON.stringify(chosen.req.authorization),
			claimedAt: nowIso,
		};

		return {
			claimed: true,
			ticket: claimedTicket,
			blockedTopics,
		};
	} finally {
		await lock.release().catch(() => {});
	}
}

// --- Native Dispatch Engine ---

export class TopicReplenishmentEngine {
	readonly ledgerPath: string;
	readonly minFloor: number;
	readonly targetCount: number;
	readonly maxCeiling: number;
	readonly maxRamPct: number;
	readonly cleanupRamPct: number;

	constructor(options?: {
		ledgerPath?: string;
		minFloor?: number;
		targetCount?: number;
		maxCeiling?: number;
		maxRamPct?: number;
		cleanupRamPct?: number;
	}) {
		this.ledgerPath = options?.ledgerPath ?? getDefaultLedgerPath();
		this.minFloor = options?.minFloor ?? DEFAULT_MIN_FLOOR;
		this.targetCount = options?.targetCount ?? DEFAULT_TARGET_COUNT;
		this.maxCeiling = options?.maxCeiling ?? DEFAULT_MAX_CEILING;
		this.maxRamPct = options?.maxRamPct ?? HARD_RAM_CEILING_PCT;
		this.cleanupRamPct = options?.cleanupRamPct ?? CLEANUP_RAM_PCT;
	}

	/**
	 * Perform a full replenishment cycle:
	 * 1. Reconcile running roster against topic inventory.
	 * 2. Check memory admission bounds.
	 * 3. Calculate worker deficit.
	 * 4. Claim and dispatch next authorized tickets up to target.
	 */
	async replenish(
		currentRoster: readonly NativeActorSnapshot[] | Record<string, unknown>[],
		options?: {
			onCleanup?: () => Promise<void> | void;
			dispatchWorker?: (ticket: ClaimedTicket) => Promise<unknown>;
		},
	): Promise<ReplenishmentOutcome> {
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
			// Re-verify RAM before each worker dispatch
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

			if (options?.dispatchWorker) {
				try {
					await options.dispatchWorker(ticket);
				} catch (err) {
					// Worker dispatch failed; record error and halt loop
					return {
						reconciliation,
						memoryAdmission,
						dispatchedTickets,
						dispatchedCount: dispatchedTickets.length,
						blockedTopics: allBlockedTopics,
						status: "error",
						reason: `Failed to dispatch ticket ${ticket.id}: ${err}`,
					};
				}
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
		// 1. If a ticket was bound to this worker, record completion outcome
		if (event.ticketId && fs.existsSync(this.ledgerPath)) {
			const lock = new FileLock(this.ledgerPath);
			await lock.acquire(10000).catch(() => {});
			try {
				const raw = await fs.promises.readFile(this.ledgerPath, "utf-8");
				const ledgerData = JSON.parse(raw) as LedgerFileShape;
				const req = ledgerData.requests?.[event.ticketId];
				if (req) {
					const nowIso = new Date().toISOString();
					if (event.status === "completed" && event.exitCode === 0) {
						// Advance stage: implementation -> QA, or QA -> review
						if (req.state === "implementation") req.state = "QA";
						else if (req.state === "QA") req.state = "review";
						else if (req.state === "review") req.state = "awaiting authorization";
					} else if (event.status === "failed") {
						req.blocker = event.error || `Worker exited with code ${event.exitCode}`;
					}
					req.updated_at = nowIso;
					ledgerData.updated_at = nowIso;
					const tempFile = path.join(
						path.dirname(this.ledgerPath),
						`.tmp-ledger-finish-${Date.now()}-${Math.random().toString(36).slice(2)}.json`,
					);
					await fs.promises.writeFile(tempFile, JSON.stringify(ledgerData, null, 2), "utf-8");
					await fs.promises.rename(tempFile, this.ledgerPath);
				}
			} catch {
				// Non-fatal ledger update error
			} finally {
				await lock.release().catch(() => {});
			}
		}

		// 2. Remove completed worker from roster snapshot
		const updatedRoster = currentRoster.filter(w => {
			if (typeof w === "object" && w !== null && "id" in w) {
				return w.id !== event.agentId;
			}
			return true;
		});
		// 3. Immediately replenish without waiting for operator prompt
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

// Global default instance for runtime convenience
export const topicReplenishmentEngine = new TopicReplenishmentEngine();
