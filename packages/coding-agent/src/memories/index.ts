import type { Database } from "bun:sqlite";
import type * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ApiKey, type Context, completeSimple, type Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { clampThinkingLevelForModel } from "@veyyon/catalog/model-thinking";
import { emptyCost } from "@veyyon/catalog/models";
import {
	clampLow,
	getAgentDbPath,
	isEnoent,
	isRecord,
	logger,
	parseJsonlLenient,
	prompt,
	readdirIfPresent,
} from "@veyyon/utils";
import { isSessionFileName, sessionFileStem } from "@veyyon/utils/session-file";

/**
 * Clamp an internal fixed memory-pass effort to the model's ladder, saying so
 * when the level moves. Memory passes request Low/Medium by convention; rows
 * with a narrower accepted set (e.g. GLM-5.2 high/max) shift the level, and a
 * silent shift is how effort drift goes unnoticed.
 */
function clampMemoryEffort(model: Model, requested: Effort): Effort | undefined {
	const clamped = clampThinkingLevelForModel(model, requested);
	if (clamped !== requested) {
		logger.warn("Memory pass effort is not accepted by the model; using the nearest supported level", {
			model: `${model.provider}/${model.id}`,
			requested,
			using: clamped ?? "provider default",
		});
	}
	return clamped;
}

import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../config/model-roles";
import type { Settings } from "../config/settings";

// The path layout lives in its own leaf: this module reaches 558 modules (it asks a model to
// summarise a session), and `internal-urls/memory-protocol` needs only the root. Re-exported so
// every existing caller keeps asking this file for it.
export { getMemoryRoot } from "./paths";

import type { MemoryBackendSaveInput, MemoryBackendSaveResult } from "../memory-backend/types";
import { memoriesPrompts } from "../prompts/memories/rows";
import type { AgentSession } from "../session/agent-session";
import { getMemoryRoot } from "./paths";
import {
	claimStage1Jobs,
	clearMemoryData as clearMemoryDataInDb,
	closeMemoryDb,
	enqueueGlobalWatermark,
	heartbeatGlobalJob,
	listStage1OutputsForGlobal,
	type MemoryThread,
	markGlobalPhase2Failed,
	markGlobalPhase2FailedUnowned,
	markGlobalPhase2Succeeded,
	markStage1Failed,
	markStage1SucceededNoOutput,
	markStage1SucceededWithOutput,
	openMemoryDb,
	type Stage1Claim,
	type Stage1OutputRow,
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "./storage";

interface MemoryRuntimeConfig {
	enabled: boolean;
	maxRolloutsPerStartup: number;
	maxRolloutAgeDays: number;
	minRolloutIdleHours: number;
	threadScanLimit: number;
	maxRawMemoriesForGlobal: number;
	stage1Concurrency: number;
	stage1LeaseSeconds: number;
	stage1RetryDelaySeconds: number;
	phase2LeaseSeconds: number;
	phase2RetryDelaySeconds: number;
	phase2HeartbeatSeconds: number;
	rolloutPayloadPercent: number;
	phase1InputTokenLimit: number;
	fallbackTokenLimit: number;
	summaryInjectionTokenLimit: number;
}

const DEFAULTS: MemoryRuntimeConfig = {
	enabled: false,
	maxRolloutsPerStartup: 64,
	maxRolloutAgeDays: 30,
	minRolloutIdleHours: 12,
	threadScanLimit: 300,
	maxRawMemoriesForGlobal: 200,
	stage1Concurrency: 8,
	stage1LeaseSeconds: 120,
	stage1RetryDelaySeconds: 120,
	phase2LeaseSeconds: 180,
	phase2RetryDelaySeconds: 180,
	phase2HeartbeatSeconds: 30,
	rolloutPayloadPercent: 0.7,
	phase1InputTokenLimit: 4_000,
	fallbackTokenLimit: 16_000,
	summaryInjectionTokenLimit: 5_000,
};

interface Stage1Stats {
	claimed: number;
	succeeded: number;
	succeededNoOutput: number;
	failed: number;
	produced: number;
	usage: {
		input: number;
		output: number;
		cacheRead: number;
		cacheWrite: number;
		total: number;
	};
}

interface Stage1OutputSchema {
	raw_memory: string;
	rollout_summary: string;
	rollout_slug: string | null;
}

interface ConsolidationSkillFileSchema {
	path: string;
	content: string;
}

interface ConsolidationSkillSchema {
	name: string;
	content?: string;
	scripts?: ConsolidationSkillFileSchema[];
	templates?: ConsolidationSkillFileSchema[];
	examples?: ConsolidationSkillFileSchema[];
}
interface ConsolidationOutputSchema {
	memory_md: string;
	memory_summary: string;
	skills: ConsolidationSkillSchema[];
}

/**
 * Start the background memory startup pipeline.
 *
 * Skips for ephemeral sessions, subagent sessions, disabled settings, or DB failures.
 */
export function startMemoryStartupTask(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
}): void {
	const { session, settings, modelRegistry, agentDir, taskDepth } = options;
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return;
	if (taskDepth > 0) return;
	if (!session.sessionManager.getSessionFile()) return;

	const dbPath = getAgentDbPath(agentDir);
	try {
		const db = openMemoryDb(dbPath);
		closeMemoryDb(db);
	} catch (error) {
		logger.debug("Memory startup skipped: state DB unavailable", { error: String(error) });
		return;
	}

	void runMemoryStartup({ session, settings, modelRegistry, agentDir, config: cfg }).catch(error => {
		logger.warn("Memory startup failed", { error: String(error) });
	});
}

interface MemoryInstructionSession {
	sessionManager: Pick<AgentSession["sessionManager"], "getSessionFile">;
}

interface MemoryToolDeveloperInstructionsSnapshot {
	summary: string;
	learned: string;
}

interface CachedMemoryToolDeveloperInstructions {
	sessionFile: string | undefined;
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined;
	value: string | undefined;
}

const memoryToolDeveloperInstructionsBySession = new WeakMap<
	MemoryInstructionSession,
	CachedMemoryToolDeveloperInstructions
>();
const memoryToolDeveloperInstructionsByRoot = new Map<string, MemoryToolDeveloperInstructionsSnapshot | undefined>();

function getMemoryInstructionRoot(agentDir: string, settings: Settings): string {
	return getMemoryRoot(agentDir, settings.getCwd());
}

function getMemoryInstructionSessionFile(session: MemoryInstructionSession): string | undefined {
	return session.sessionManager.getSessionFile() ?? undefined;
}

async function readMemoryToolDeveloperInstructionsSnapshot(
	agentDir: string,
	settings: Settings,
): Promise<MemoryToolDeveloperInstructionsSnapshot | undefined> {
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return undefined;
	const memoryRoot = getMemoryInstructionRoot(agentDir, settings);

	let summary = "";
	try {
		summary = (await Bun.file(path.join(memoryRoot, "memory_summary.md")).text()).trim();
	} catch {
		// Missing or unreadable summary — injection is best-effort; fall through
		// so any captured lessons still surface on their own.
	}
	const learned = await readLearnedLessons(memoryRoot);
	return { summary, learned };
}

function renderMemoryToolDeveloperInstructionsSnapshot(
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined,
	settings: Settings,
): string | undefined {
	if (!snapshot) return undefined;
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return undefined;
	if (!snapshot.summary && !snapshot.learned) return undefined;

	const summaryOut = snapshot.summary
		? truncateByApproxTokens(snapshot.summary, cfg.summaryInjectionTokenLimit).trim()
		: "";
	// Lessons share ONE injection budget with the summary so the combined block
	// stays within `summaryInjectionTokenLimit` (~4 chars/token, matching
	// truncateByApproxTokens). With no summary, lessons get the whole budget.
	// Clamp to 0: truncateByApproxTokens appends a marker, so a truncated summary
	// can exceed `limit * 4` chars and drive the remainder negative — when the
	// summary already fills the budget, lessons are simply dropped.
	const learnedBudget = Math.max(0, cfg.summaryInjectionTokenLimit - Math.ceil(summaryOut.length / 4));
	const learnedOut =
		snapshot.learned && learnedBudget > 0 ? truncateByApproxTokens(snapshot.learned, learnedBudget).trim() : "";
	if (!summaryOut && !learnedOut) return undefined;

	return prompt.render(memoriesPrompts["memories/read-path"].text, {
		memory_summary: summaryOut,
		learned: learnedOut,
	});
}

function cacheMemoryToolDeveloperInstructions(
	session: MemoryInstructionSession,
	sessionFile: string | undefined,
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined,
	settings: Settings,
): string | undefined {
	const value = renderMemoryToolDeveloperInstructionsSnapshot(snapshot, settings);
	memoryToolDeveloperInstructionsBySession.set(session, { sessionFile, snapshot, value });
	return value;
}

/**
 * Drop the per-session memory instruction snapshot after explicit memory state
 * changes that must affect the active conversation immediately, such as
 * `/memory clear`.
 */
export function clearMemoryToolDeveloperInstructionsCache(session: MemoryInstructionSession | undefined): void {
	if (session) memoryToolDeveloperInstructionsBySession.delete(session);
}

/**
 * Refresh the active session's consolidated-memory snapshot after startup maintenance.
 *
 * Startup may finish after the first prompt build and write `memory_summary.md`;
 * the active session should see that summary. It must not reread `learned.md`,
 * because a `learn` call racing with startup belongs to the next session's
 * memory prompt, not the active prompt-cache prefix.
 */
export async function refreshMemoryToolDeveloperInstructionsCacheAfterStartup(
	session: MemoryInstructionSession,
	agentDir: string,
	settings: Settings,
): Promise<void> {
	const sessionFile = getMemoryInstructionSessionFile(session);
	const cached = memoryToolDeveloperInstructionsBySession.get(session);
	const current = await readMemoryToolDeveloperInstructionsSnapshot(agentDir, settings);
	const root = getMemoryInstructionRoot(agentDir, settings);
	const baseline = memoryToolDeveloperInstructionsByRoot.get(root);
	const cachedLearned = cached && cached.sessionFile === sessionFile ? cached.snapshot?.learned : undefined;
	const learned = cachedLearned ?? baseline?.learned ?? "";
	const snapshot = current ? { summary: current.summary, learned } : undefined;
	cacheMemoryToolDeveloperInstructions(session, sessionFile, snapshot, settings);
}

/**
 * Build memory usage instructions for prompt injection.
 */
export async function buildMemoryToolDeveloperInstructions(
	agentDir: string,
	settings: Settings,
	session?: MemoryInstructionSession,
): Promise<string | undefined> {
	if (!session) {
		const snapshot = await readMemoryToolDeveloperInstructionsSnapshot(agentDir, settings);
		memoryToolDeveloperInstructionsByRoot.set(getMemoryInstructionRoot(agentDir, settings), snapshot);
		return renderMemoryToolDeveloperInstructionsSnapshot(snapshot, settings);
	}

	const sessionFile = getMemoryInstructionSessionFile(session);
	const cached = memoryToolDeveloperInstructionsBySession.get(session);
	if (cached && cached.sessionFile === sessionFile) return cached.value;

	const snapshot = await readMemoryToolDeveloperInstructionsSnapshot(agentDir, settings);
	return cacheMemoryToolDeveloperInstructions(session, sessionFile, snapshot, settings);
}

/**
 * Clear all persisted memory state and generated artifacts.
 */
export async function clearMemoryData(agentDir: string, cwd: string): Promise<void> {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		clearMemoryDataInDb(db);
	} finally {
		closeMemoryDb(db);
	}
	await fs.rm(getMemoryRoot(agentDir, cwd), { recursive: true, force: true });
}

/**
 * Force-enqueue global consolidation maintenance work.
 */
export function enqueueMemoryConsolidation(agentDir: string, cwd: string, sourceUpdatedAt = unixNow()): void {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		enqueueGlobalWatermark(db, sourceUpdatedAt, cwd, { forceDirtyWhenNotAdvanced: true });
	} finally {
		closeMemoryDb(db);
	}
}

async function runMemoryStartup(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: MemoryRuntimeConfig;
}): Promise<void> {
	await runPhase1(options);
	await runPhase2(options);
	await refreshMemoryToolDeveloperInstructionsCacheAfterStartup(options.session, options.agentDir, options.settings);
	await options.session.refreshBaseSystemPrompt?.("memory-startup");
}

async function runPhase1(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: MemoryRuntimeConfig;
}): Promise<void> {
	const { session, modelRegistry, agentDir, config } = options;
	const db = openMemoryDb(getAgentDbPath(agentDir));
	const nowSec = unixNow();
	const workerId = `memory-${process.pid}`;
	const memoryRoot = getMemoryRoot(agentDir, session.sessionManager.getCwd());
	const currentThreadId = session.sessionManager.getSessionId();

	try {
		const threads = await collectThreads(session, currentThreadId);
		upsertThreads(db, threads);

		const phase1Model = await resolveMemoryModel({
			modelRegistry,
			session,
			fallbackRole: "default",
		});
		if (!phase1Model) {
			logger.debug("Phase1 skipped: no model available");
			return;
		}
		const phase1ApiKey = await modelRegistry.getApiKey(phase1Model, session.sessionId);
		if (!phase1ApiKey) {
			logger.debug("Phase1 skipped: no API key for phase1 model", {
				provider: phase1Model.provider,
				model: phase1Model.id,
			});
			return;
		}

		const claims = claimStage1Jobs(db, {
			nowSec,
			threadScanLimit: config.threadScanLimit,
			maxRolloutsPerStartup: config.maxRolloutsPerStartup,
			maxRolloutAgeDays: config.maxRolloutAgeDays,
			minRolloutIdleHours: config.minRolloutIdleHours,
			leaseSeconds: config.stage1LeaseSeconds,
			runningConcurrencyCap: config.stage1Concurrency,
			workerId,
			excludeThreadIds: currentThreadId ? [currentThreadId] : [],
		});
		if (claims.length === 0) return;

		const stats: Stage1Stats = {
			claimed: claims.length,
			succeeded: 0,
			succeededNoOutput: 0,
			failed: 0,
			produced: 0,
			usage: emptyCost(),
		};
		const obfuscateProviderText = (text: string): string => session.obfuscateProviderText(text);

		await runWithConcurrency(claims, config.stage1Concurrency, async claim => {
			const result = await runStage1Job({
				claim,
				model: phase1Model,
				apiKey: modelRegistry.resolver(phase1Model, session.sessionId),
				modelMaxTokens: computeModelTokenBudget(phase1Model, config),
				config,
				metadata: session.agent?.metadataForProvider(phase1Model.provider),
				obfuscateProviderText,
			});

			if (result.kind === "failed") {
				logger.error("Memory phase1 stage1 job failed", {
					threadId: claim.threadId,
					rolloutPath: claim.rolloutPath,
					reason: result.reason,
				});
				markStage1Failed(db, {
					threadId: claim.threadId,
					ownershipToken: claim.ownershipToken,
					retryDelaySeconds: config.stage1RetryDelaySeconds,
					reason: result.reason,
					nowSec: unixNow(),
				});
				stats.failed += 1;
				return;
			}

			if (result.kind === "no_output") {
				markStage1SucceededNoOutput(db, {
					threadId: claim.threadId,
					ownershipToken: claim.ownershipToken,
					sourceUpdatedAt: claim.sourceUpdatedAt,
					nowSec: unixNow(),
					cwd: claim.cwd,
				});
				stats.succeededNoOutput += 1;
				return;
			}

			markStage1SucceededWithOutput(db, {
				threadId: claim.threadId,
				ownershipToken: claim.ownershipToken,
				sourceUpdatedAt: claim.sourceUpdatedAt,
				rawMemory: result.output.rawMemory,
				rolloutSummary: result.output.rolloutSummary,
				rolloutSlug: result.output.rolloutSlug,
				nowSec: unixNow(),
				cwd: claim.cwd,
			});
			stats.succeeded += 1;
			stats.produced += 1;
			if (result.usage) {
				stats.usage.input += result.usage.input;
				stats.usage.output += result.usage.output;
				stats.usage.cacheRead += result.usage.cacheRead;
				stats.usage.cacheWrite += result.usage.cacheWrite;
				stats.usage.total += result.usage.totalTokens || 0;
			}
		});

		logger.debug("Memory phase1 completed", {
			memoryRoot,
			claimed: stats.claimed,
			succeeded: stats.succeeded,
			succeededNoOutput: stats.succeededNoOutput,
			failed: stats.failed,
			produced: stats.produced,
			usage: stats.usage,
		});
	} finally {
		closeMemoryDb(db);
	}
}

async function runPhase2(options: {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	config: MemoryRuntimeConfig;
}): Promise<void> {
	const { session, modelRegistry, agentDir, config } = options;
	const cwd = session.sessionManager.getCwd();
	const db = openMemoryDb(getAgentDbPath(agentDir));
	const nowSec = unixNow();
	const workerId = `memory-${process.pid}`;
	const memoryRoot = getMemoryRoot(agentDir, cwd);

	try {
		const claimResult = tryClaimGlobalPhase2Job(db, {
			workerId,
			leaseSeconds: config.phase2LeaseSeconds,
			nowSec,
			cwd,
		});
		if (claimResult.kind !== "claimed") return;

		const claim = claimResult.claim;
		const outputs = listStage1OutputsForGlobal(db, config.maxRawMemoriesForGlobal, cwd);
		const newWatermark = computeCompletionWatermark(claim.inputWatermark, outputs);

		await syncPhase2Artifacts(memoryRoot, outputs);
		if (outputs.length === 0) {
			await cleanupConsolidatedArtifacts(memoryRoot);
			const marked = markGlobalPhase2Succeeded(db, {
				ownershipToken: claim.ownershipToken,
				newWatermark,
				nowSec: unixNow(),
				cwd,
			});
			if (!marked) {
				logger.warn("Phase2 empty-input completion lost ownership", { memoryRoot });
			}
			return;
		}

		const phase2Model = await resolveMemoryModel({
			modelRegistry,
			session,
			fallbackRole: "smol",
		});
		if (!phase2Model) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: "No model available for phase2",
				memoryRoot,
				cwd,
			});
			return;
		}
		const phase2ApiKey = await modelRegistry.getApiKey(phase2Model, session.sessionId);
		if (!phase2ApiKey) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: "No API key available for phase2",
				memoryRoot,
				cwd,
			});
			return;
		}

		let heartbeatLostOwnership = false;
		const heartbeat = setInterval(() => {
			const ok = heartbeatGlobalJob(db, {
				ownershipToken: claim.ownershipToken,
				leaseSeconds: config.phase2LeaseSeconds,
				nowSec: unixNow(),
				cwd,
			});
			if (!ok) {
				heartbeatLostOwnership = true;
				clearInterval(heartbeat);
			}
		}, config.phase2HeartbeatSeconds * 1000);

		const obfuscateProviderText = (text: string): string => session.obfuscateProviderText(text);

		try {
			const consolidated = await runConsolidationModel({
				memoryRoot,
				model: phase2Model,
				apiKey: modelRegistry.resolver(phase2Model, session.sessionId),
				metadata: session.agent?.metadataForProvider(phase2Model.provider),
				obfuscateProviderText,
			});
			await applyConsolidation(memoryRoot, consolidated);
			if (heartbeatLostOwnership) {
				throw new Error("Phase2 lease ownership lost before completion");
			}
			const marked = markGlobalPhase2Succeeded(db, {
				ownershipToken: claim.ownershipToken,
				newWatermark,
				nowSec: unixNow(),
				cwd,
			});
			if (!marked) {
				throw new Error("Phase2 could not mark success: ownership lost");
			}
		} catch (error) {
			markPhase2FailureWithFallback(db, {
				claim,
				retryDelaySeconds: config.phase2RetryDelaySeconds,
				reason: String(error),
				memoryRoot,
				cwd,
				error,
			});
		} finally {
			clearInterval(heartbeat);
		}
	} finally {
		closeMemoryDb(db);
	}
}

function markPhase2FailureWithFallback(
	db: Database,
	params: {
		claim: { ownershipToken: string; inputWatermark: number };
		retryDelaySeconds: number;
		reason: string;
		memoryRoot: string;
		cwd: string;
		error?: unknown;
	},
): void {
	const { claim, retryDelaySeconds, reason, memoryRoot, cwd, error } = params;
	const nowSec = unixNow();
	const strictFailed = markGlobalPhase2Failed(db, {
		ownershipToken: claim.ownershipToken,
		retryDelaySeconds,
		reason,
		nowSec,
		cwd,
	});
	if (strictFailed) return;

	const unownedFailed = markGlobalPhase2FailedUnowned(db, {
		retryDelaySeconds,
		reason,
		nowSec,
		cwd,
	});
	if (!unownedFailed) {
		logger.warn("Phase2 could not mark failure (ownership lost and unowned fallback skipped)", {
			error: error ? String(error) : undefined,
			memoryRoot,
			reason,
			inputWatermark: claim.inputWatermark,
		});
	}
}

async function collectThreads(session: AgentSession, currentThreadId?: string): Promise<MemoryThread[]> {
	const sessionDir = session.sessionManager.getSessionDir();
	const files = await fs.readdir(sessionDir);
	const threads: MemoryThread[] = [];
	for (const name of files) {
		if (!isSessionFileName(name)) continue;
		const fullPath = path.join(sessionDir, name);
		let stat: fsNode.Stats;
		try {
			stat = await fs.stat(fullPath);
		} catch {
			continue;
		}
		let cwd = "";
		let id = sessionFileStem(name);
		try {
			const fileText = await Bun.file(fullPath).text();
			let sawTitleSlot = false;
			for (const rawLine of fileText.split(/\r?\n/)) {
				const line = rawLine.trim();
				if (!line) continue;
				const parsed = parseJsonlLenient<Record<string, unknown>>(line);
				const header = Array.isArray(parsed) && parsed.length > 0 ? parsed[0] : undefined;
				if (!sawTitleSlot && header?.type === "title") {
					sawTitleSlot = true;
					continue;
				}
				if (header?.type === "session") {
					if (typeof header.cwd === "string") cwd = header.cwd;
					if (typeof header.id === "string") id = header.id;
				}
				break;
			}
		} catch {
			// ignore malformed session files
		}

		if (currentThreadId && id === currentThreadId) continue;
		threads.push({
			id,
			updatedAt: Math.floor(stat.mtimeMs / 1000),
			rolloutPath: fullPath,
			cwd,
			sourceKind: "cli",
		});
	}
	return threads;
}

type PersistableMemoryRole = "system" | "developer" | "user" | "assistant" | "toolResult";

interface PersistableMemoryMessage {
	role: PersistableMemoryRole;
	text: string;
	toolName?: "bash" | "eval" | "read" | "grep";
}

function isPersistableMemoryRole(role: unknown): role is PersistableMemoryRole {
	return role === "system" || role === "developer" || role === "user" || role === "assistant" || role === "toolResult";
}

function extractMemoryMessageText(message: Record<string, unknown>): string {
	const content = message.content;
	if (typeof content === "string") return content;
	if (!Array.isArray(content)) return "";
	const text: string[] = [];
	for (const item of content) {
		if (!isRecord(item) || item.type !== "text" || typeof item.text !== "string") continue;
		text.push(item.text);
	}
	return text.join("\n");
}

function extractPersistableMessages(payload: string): PersistableMemoryMessage[] {
	const rows = parseJsonlLenient(payload);
	if (!Array.isArray(rows)) return [];
	const messages: PersistableMemoryMessage[] = [];
	for (const row of rows) {
		if (!isRecord(row) || row.type !== "message" || !isRecord(row.message)) continue;
		const role = row.message.role;
		if (!isPersistableMemoryRole(role)) continue;

		// The memory model is a text-only summarizer. Project the untrusted persisted message onto
		// this raw allowlist before any provider attempt. Image bytes, provider replay payloads,
		// tool arguments, details, signatures, and arbitrary nested fields are discarded here;
		// allowlisted strings stay raw until the per-attempt builder sanitizes them.
		const text = extractMemoryMessageText(row.message);
		if (role === "toolResult") {
			const toolName = row.message.toolName;
			if (toolName !== "bash" && toolName !== "eval" && toolName !== "read" && toolName !== "grep") continue;
			if (text.length === 0) continue;
			messages.push({ role, toolName, text });
			continue;
		}
		messages.push({ role, text });
	}
	return messages;
}

async function runStage1Job(options: {
	claim: Stage1Claim;
	model: Model;
	apiKey: ApiKey;
	modelMaxTokens: number;
	config: MemoryRuntimeConfig;
	metadata?: Record<string, unknown>;
	obfuscateProviderText?: (text: string) => string;
}): Promise<
	| {
			kind: "output";
			output: { rawMemory: string; rolloutSummary: string; rolloutSlug: string | null };
			usage?: { input: number; output: number; cacheRead: number; cacheWrite: number; totalTokens?: number };
	  }
	| { kind: "no_output" }
	| { kind: "failed"; reason: string }
> {
	const { claim, model, apiKey, modelMaxTokens, config } = options;
	const sanitize = options.obfuscateProviderText ?? ((text: string) => text);
	try {
		const rolloutRaw = await Bun.file(claim.rolloutPath).text();
		const rawPersisted = extractPersistableMessages(rolloutRaw);
		const budgetTokens = Math.min(
			config.phase1InputTokenLimit,
			Math.floor(modelMaxTokens * config.rolloutPayloadPercent),
		);
		const rawSystemPrompt = memoriesPrompts["memories/stage_one_system"].text;
		const providerContext: Context = { messages: [] };
		const refreshProviderContext = (): void => {
			// Rebuild from the raw allowlisted projection after every credential await. Sanitizing
			// each complete string before JSON serialization and head-tail truncation prevents
			// either lossy step from splitting a secret into no-longer-matchable fragments.
			const providerItems = rawPersisted.flatMap(item => {
				const text = sanitize(item.text);
				if (item.role === "toolResult" && text.length > 32_000) return [];
				return [{ ...item, text }];
			});
			const serializedItems = JSON.stringify(providerItems);
			const truncatedItems = truncateByApproxTokens(serializedItems, budgetTokens);
			const inputPrompt = prompt.render(memoriesPrompts["memories/stage_one_input"].text, {
				thread_id: sanitize(claim.threadId),
				response_items_json: truncatedItems,
			});
			providerContext.systemPrompt = [sanitize(rawSystemPrompt)];
			providerContext.messages = [
				{
					role: "user",
					content: [{ type: "text", text: sanitize(inputPrompt) }],
					timestamp: Date.now(),
				},
			];
		};
		const response = await completeSimple(model, providerContext, {
			apiKey: refreshProviderContextForApiKey(apiKey, refreshProviderContext),
			metadata: options.metadata,
			maxTokens: clampLow(Math.floor(modelMaxTokens * 0.2), 1024, 4096),
			reasoning: clampMemoryEffort(model, Effort.Low),
		});

		if (response.stopReason === "error") {
			return { kind: "failed", reason: sanitize(response.errorMessage || "stage1 model error") };
		}
		const text = response.content
			.filter((c): c is { type: "text"; text: string } => c.type === "text")
			.map(c => c.text)
			.join("\n")
			.trim();
		const parsed = parseJsonObject(text);
		if (!parsed) {
			return { kind: "failed", reason: "stage1 JSON parse failure" };
		}
		const schemaOutput = parseStage1OutputSchema(parsed);
		if (!schemaOutput) {
			return { kind: "failed", reason: "stage1 JSON schema validation failure" };
		}

		const rawMemory = redactSecrets(schemaOutput.raw_memory).trim();
		const rolloutSummary = redactSecrets(schemaOutput.rollout_summary).trim();
		const rolloutSlug = schemaOutput.rollout_slug === null ? null : redactSecrets(schemaOutput.rollout_slug).trim();
		if (!rawMemory || !rolloutSummary) {
			return { kind: "no_output" };
		}
		return {
			kind: "output",
			output: {
				rawMemory,
				rolloutSummary,
				rolloutSlug: rolloutSlug || null,
			},
			usage: response.usage,
		};
	} catch (error) {
		return { kind: "failed", reason: sanitize(String(error)) };
	}
}

async function syncPhase2Artifacts(memoryRoot: string, outputs: Stage1OutputRow[]): Promise<void> {
	const summariesDir = path.join(memoryRoot, "rollout_summaries");
	await fs.mkdir(summariesDir, { recursive: true });

	const keepFiles = new Set<string>();
	for (const row of outputs) {
		const stem = formatRolloutFilename(row.threadId, row.rolloutSlug);
		const filename = `${stem}.md`;
		keepFiles.add(filename);
		const body = [`thread_id: ${row.threadId}`, `updated_at: ${row.sourceUpdatedAt}`, "", row.rolloutSummary].join(
			"\n",
		);
		await Bun.write(path.join(summariesDir, filename), `${body.trim()}\n`);
	}

	const currentFiles = await fs.readdir(summariesDir).catch(() => [] as string[]);
	for (const file of currentFiles) {
		if (!file.endsWith(".md")) continue;
		if (keepFiles.has(file)) continue;
		await fs.rm(path.join(summariesDir, file), { force: true });
	}

	const rawBody = buildRawMemoriesMarkdown(outputs);
	await Bun.write(path.join(memoryRoot, "raw_memories.md"), rawBody);
}

async function cleanupConsolidatedArtifacts(memoryRoot: string): Promise<void> {
	await fs.rm(path.join(memoryRoot, "MEMORY.md"), { force: true });
	await fs.rm(path.join(memoryRoot, "memory_summary.md"), { force: true });
	await fs.rm(path.join(memoryRoot, "skills"), { recursive: true, force: true });
}

function buildRawMemoriesMarkdown(outputs: Stage1OutputRow[]): string {
	if (outputs.length === 0) {
		return "# Raw Memories\n\nNo raw memories yet.\n";
	}

	const blocks = outputs.map(row => {
		const header = [`## ${row.threadId}`, `updated_at: ${row.sourceUpdatedAt}`, ""].join("\n");
		return `${header}${row.rawMemory.trim()}\n`;
	});
	return `# Raw Memories\n\n${blocks.join("\n")}`;
}

/**
 * The rollout-summary section of the consolidation prompt.
 *
 * EVERY SENTENCE THIS RETURNS IS READ BY THE MODEL AS FACT, which is why neither failure below may end
 * at "No rollout summaries yet.". Two swallows used to do exactly that: `fs.readdir(dir).catch(() => [])`
 * turned a permission error into an empty listing, and `.text().catch(() => "")` turned an unreadable
 * summary into an empty one. A run whose summaries were all present but unreadable therefore told the
 * model that nothing had ever been summarised, and consolidation rewrote long-term memory from that
 * premise. Memory loss with no operator-visible cause.
 *
 * So the distinction is between "asked, and there are none" and "could not ask". A missing directory is
 * the first and keeps the concise answer, because it is the ordinary first-run state. Anything else is
 * the second: it reaches the log with the failing path and the reason, AND the returned text says the
 * section is unknown rather than empty. Exported so
 * `test/memories/rollout-summaries-never-report-unreadable-as-absent.test.ts` can assert the exact
 * sentences, since the sentence is what the model reads.
 */
export async function readRolloutSummaries(memoryRoot: string): Promise<string> {
	const summariesDir = path.join(memoryRoot, "rollout_summaries");
	let names: string[];
	try {
		names = await fs.readdir(summariesDir);
	} catch (error) {
		if (isEnoent(error)) return "No rollout summaries yet.";
		logger.warn("Memory rollout summaries could not be listed", { dir: summariesDir, error: String(error) });
		return "Rollout summaries exist but could not be read; treat this section as unknown, not empty.";
	}
	const summaryNames = names.filter(name => name.endsWith(".md")).sort((a, b) => a.localeCompare(b));
	if (summaryNames.length === 0) return "No rollout summaries yet.";

	const blocks: string[] = [];
	const unreadable: string[] = [];
	for (const name of summaryNames) {
		let text: string;
		try {
			text = await Bun.file(path.join(summariesDir, name)).text();
		} catch (error) {
			// Named individually so an operator can fix the specific file. A summary that is PRESENT and
			// empty is a different thing and is skipped below without a word: it was written with no
			// content, and reporting it as unreadable would send someone after a file that is fine.
			logger.warn("Memory rollout summary could not be read", { file: name, error: String(error) });
			unreadable.push(name);
			continue;
		}
		if (!text.trim()) continue;
		blocks.push(`--- ${name} ---\n${text.trim()}`);
	}
	if (blocks.length === 0) {
		if (unreadable.length > 0) {
			return `${unreadable.length} rollout summaries exist but could not be read; treat this section as unknown, not empty.`;
		}
		return "No rollout summaries yet.";
	}
	if (unreadable.length > 0) {
		// The mixed case is the likely one and the hardest to notice, because the section LOOKS populated.
		// The gap is named in the same text the model reads, not only in the log.
		blocks.push(
			`--- unreadable ---\n${unreadable.length} further summaries could not be read: ${unreadable.join(", ")}`,
		);
	}
	return blocks.join("\n\n");
}

async function runConsolidationModel(options: {
	memoryRoot: string;
	model: Model;
	apiKey: ApiKey;
	metadata?: Record<string, unknown>;
	obfuscateProviderText?: (text: string) => string;
}): Promise<{
	memoryMd: string;
	memorySummary: string;
	skills: Array<{
		name: string;
		content: string;
		scripts: ConsolidationSkillFileSchema[];
		templates: ConsolidationSkillFileSchema[];
		examples: ConsolidationSkillFileSchema[];
	}>;
}> {
	const { memoryRoot, model, apiKey } = options;
	const sanitize = options.obfuscateProviderText ?? ((text: string) => text);
	// Keep the complete source strings intact across awaited I/O. The attempt builder below
	// resolves the live sanitizer only after credentials and before truncation/rendering.
	const rawMemories = await Bun.file(path.join(memoryRoot, "raw_memories.md")).text();
	const rawRolloutSummaries = await readRolloutSummaries(memoryRoot);
	const rawSystemPrompt = memoriesPrompts["memories/consolidation_system"].text;
	const providerContext: Context = { messages: [] };
	const refreshProviderContext = (): void => {
		const input = prompt.render(memoriesPrompts["memories/consolidation"].text, {
			raw_memories: truncateByApproxTokens(sanitize(rawMemories), 20_000),
			rollout_summaries: truncateByApproxTokens(sanitize(rawRolloutSummaries), 12_000),
		});
		providerContext.systemPrompt = [sanitize(rawSystemPrompt)];
		providerContext.messages = [
			{
				role: "user",
				content: [{ type: "text", text: sanitize(input) }],
				timestamp: Date.now(),
			},
		];
	};
	const response = await completeSimple(model, providerContext, {
		apiKey: refreshProviderContextForApiKey(apiKey, refreshProviderContext),
		metadata: options.metadata,
		maxTokens: 8192,
		reasoning: clampMemoryEffort(model, Effort.Medium),
	});
	if (response.stopReason === "error") {
		throw new Error(sanitize(response.errorMessage || "phase2 model error"));
	}
	const text = response.content
		.filter((c): c is { type: "text"; text: string } => c.type === "text")
		.map(c => c.text)
		.join("\n")
		.trim();
	const parsed = parseJsonObject(text);
	if (!parsed) throw new Error("phase2 JSON parse failure");
	const schemaOutput = parseConsolidationOutputSchema(parsed);
	if (!schemaOutput) throw new Error("phase2 JSON schema validation failure");
	const memoryMd = redactSecrets(schemaOutput.memory_md).trim();
	const memorySummary = redactSecrets(schemaOutput.memory_summary).trim();
	const skills = schemaOutput.skills
		.map(item => {
			const name = sanitizeSkillName(item.name.trim());
			const content = redactSecrets(item.content ?? "").trim();
			if (!name || !content) return null;
			return {
				name,
				content,
				scripts: sanitizeConsolidationSkillFiles(item.scripts, "scripts"),
				templates: sanitizeConsolidationSkillFiles(item.templates, "templates"),
				examples: sanitizeConsolidationSkillFiles(item.examples, "examples"),
			};
		})
		.filter(
			(
				item,
			): item is {
				name: string;
				content: string;
				scripts: ConsolidationSkillFileSchema[];
				templates: ConsolidationSkillFileSchema[];
				examples: ConsolidationSkillFileSchema[];
			} => item !== null,
		);
	if (!memoryMd || !memorySummary) {
		throw new Error("phase2 returned empty consolidated memory");
	}
	return { memoryMd, memorySummary, skills };
}

async function applyConsolidation(
	memoryRoot: string,
	consolidated: {
		memoryMd: string;
		memorySummary: string;
		skills: Array<{
			name: string;
			content: string;
			scripts: ConsolidationSkillFileSchema[];
			templates: ConsolidationSkillFileSchema[];
			examples: ConsolidationSkillFileSchema[];
		}>;
	},
): Promise<void> {
	await Bun.write(path.join(memoryRoot, "MEMORY.md"), `${consolidated.memoryMd.trim()}\n`);
	await Bun.write(path.join(memoryRoot, "memory_summary.md"), `${consolidated.memorySummary.trim()}\n`);
	const skillsDir = path.join(memoryRoot, "skills");
	await fs.mkdir(skillsDir, { recursive: true });
	const keep = new Set<string>();
	for (const skill of consolidated.skills) {
		const dir = path.join(skillsDir, skill.name);
		keep.add(skill.name);
		await fs.mkdir(dir, { recursive: true });
		const files = new Map<string, string>();
		files.set("SKILL.md", `${skill.content.trim()}\n`);
		for (const item of skill.scripts) {
			files.set(path.posix.join("scripts", item.path), `${item.content.trim()}\n`);
		}
		for (const item of skill.templates) {
			files.set(path.posix.join("templates", item.path), `${item.content.trim()}\n`);
		}
		for (const item of skill.examples) {
			files.set(path.posix.join("examples", item.path), `${item.content.trim()}\n`);
		}

		for (const [relativePath, content] of [...files.entries()].sort(([a], [b]) => a.localeCompare(b))) {
			await Bun.write(path.join(dir, ...relativePath.split("/")), content);
		}

		const keepFiles = new Set(files.keys());
		const existingFiles = await listRelativeFiles(dir);
		for (const relativePath of existingFiles) {
			if (keepFiles.has(relativePath)) continue;
			await fs.rm(path.join(dir, ...relativePath.split("/")), { force: true });
		}
		await pruneEmptyDirectories(dir);
	}
	const dirs = await fs.readdir(skillsDir, { withFileTypes: true }).catch(() => []);
	for (const dirent of dirs) {
		if (!dirent.isDirectory()) continue;
		if (keep.has(dirent.name)) continue;
		await fs.rm(path.join(skillsDir, dirent.name), { recursive: true, force: true });
	}
}

/**
 * Every file under `rootDir`, as paths relative to it.
 *
 * `readdirIfPresent` rather than a bare catch: absence is an answer here (a memory root with no skills
 * directory yet), and any OTHER failure is logged with the directory rather than read as "empty". The
 * caller diffs this list against what consolidation produced and deletes what is missing from it, so an
 * unlistable directory silently reported as empty would mean nothing gets deleted. That is the safe
 * direction, and it is still worth a line: the alternative is a stale skill file nobody can explain.
 */
async function listRelativeFiles(rootDir: string, prefix = ""): Promise<string[]> {
	const entries = await readdirIfPresent(rootDir, "existing memory files");
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			files.push(...(await listRelativeFiles(path.join(rootDir, entry.name), relative)));
			continue;
		}
		if (entry.isFile()) files.push(relative);
	}
	return files;
}

/**
 * Remove directories under `rootDir` that consolidation left empty.
 *
 * THE LISTING FAILURE IS NOT AN EMPTY DIRECTORY, and reading it as one deleted live data. The old code
 * listed the child with `.catch(() => [])` and then removed any child whose listing was empty, so a
 * directory that could not be listed (a permission change, a half-mounted NFS path) was removed
 * RECURSIVELY along with everything in it. A skills directory full of captured lessons could go that
 * way, and the only trace was that it was gone. Now an unlistable directory is reported and SKIPPED:
 * this function's job is removing what is empty, and it cannot know that about a directory it could not
 * read.
 */
async function pruneEmptyDirectories(rootDir: string): Promise<void> {
	const entries = await readdirIfPresent(rootDir, "empty memory directories to prune");
	for (const entry of entries) {
		if (!entry.isDirectory()) continue;
		const child = path.join(rootDir, entry.name);
		await pruneEmptyDirectories(child);
		let childEntries: string[];
		try {
			childEntries = await fs.readdir(child);
		} catch (error) {
			if (!isEnoent(error)) {
				logger.warn("Memory directory could not be listed; leaving it in place", {
					dir: child,
					error: String(error),
				});
			}
			continue;
		}
		if (childEntries.length === 0) {
			await fs.rm(child, { recursive: true, force: true });
		}
	}
}

function computeCompletionWatermark(claimedInputWatermark: number, outputs: Stage1OutputRow[]): number {
	const maxOutputWatermark = outputs.reduce((max, row) => Math.max(max, row.sourceUpdatedAt), claimedInputWatermark);
	return Math.max(claimedInputWatermark, maxOutputWatermark);
}

function formatRolloutFilename(threadId: string, rolloutSlug: string | null): string {
	if (!rolloutSlug) return threadId;
	const normalized = rolloutSlug
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "_")
		.replace(/_+$/g, "")
		.slice(0, 20);
	if (!normalized) return threadId;
	return `${threadId}-${normalized}`;
}

function parseJsonObject(text: string): Record<string, unknown> | undefined {
	if (!text) return undefined;
	try {
		const parsed = JSON.parse(text) as unknown;
		if (isRecord(parsed)) {
			return parsed as Record<string, unknown>;
		}
	} catch {
		const match = text.match(/\{[\s\S]*\}/);
		if (!match) return undefined;
		try {
			const parsed = JSON.parse(match[0]) as unknown;
			if (isRecord(parsed)) {
				return parsed as Record<string, unknown>;
			}
		} catch {
			return undefined;
		}
	}
	return undefined;
}

function parseStage1OutputSchema(value: Record<string, unknown>): Stage1OutputSchema | undefined {
	if (!hasExactKeys(value, ["rollout_summary", "rollout_slug", "raw_memory"])) return undefined;
	if (typeof value.rollout_summary !== "string") return undefined;
	if (!(typeof value.rollout_slug === "string" || value.rollout_slug === null)) return undefined;
	if (typeof value.raw_memory !== "string") return undefined;
	return {
		rollout_summary: value.rollout_summary,
		rollout_slug: value.rollout_slug,
		raw_memory: value.raw_memory,
	};
}

function parseConsolidationOutputSchema(value: Record<string, unknown>): ConsolidationOutputSchema | undefined {
	if (!hasExactKeys(value, ["memory_md", "memory_summary", "skills"])) return undefined;
	if (typeof value.memory_md !== "string") return undefined;
	if (typeof value.memory_summary !== "string") return undefined;
	if (!Array.isArray(value.skills)) return undefined;
	const skills: ConsolidationSkillSchema[] = [];
	for (const item of value.skills) {
		if (!isRecord(item)) return undefined;
		const data = item as Record<string, unknown>;
		if (!hasExactKeys(data, ["name", "content", "scripts", "templates", "examples"], true)) return undefined;
		if (typeof data.name !== "string") return undefined;
		if (!(typeof data.content === "string" || data.content === undefined)) return undefined;
		const scripts = parseConsolidationSkillFileArray(data.scripts);
		const templates = parseConsolidationSkillFileArray(data.templates);
		const examples = parseConsolidationSkillFileArray(data.examples);
		if (!scripts || !templates || !examples) return undefined;
		skills.push({
			name: data.name,
			content: data.content,
			scripts,
			templates,
			examples,
		});
	}
	return {
		memory_md: value.memory_md,
		memory_summary: value.memory_summary,
		skills,
	};
}

function hasExactKeys(value: Record<string, unknown>, expectedKeys: string[], allowMissing = false): boolean {
	const sortedKeys = Object.keys(value).sort();
	const sortedExpected = [...expectedKeys].sort();
	if (!allowMissing && sortedKeys.length !== sortedExpected.length) return false;
	for (const key of sortedKeys) {
		if (!sortedExpected.includes(key)) return false;
	}
	if (allowMissing) return true;
	for (let i = 0; i < sortedExpected.length; i += 1) {
		if (sortedKeys[i] !== sortedExpected[i]) return false;
	}
	return true;
}

function redactSecrets(input: string): string {
	let out = input;
	const patterns = [
		/(?:sk|pk|rk|tok|key|secret|token|password)[-_A-Za-z0-9]{12,}/g,
		/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/g,
		/(?:AKIA|ASIA)[A-Z0-9]{16}/g,
		// Common provider token prefixes (GitHub, npm, Slack, Google).
		/(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g,
		/github_pat_[A-Za-z0-9_]{20,}/g,
		/npm_[A-Za-z0-9]{30,}/g,
		/xox[baprs]-[A-Za-z0-9-]{10,}/g,
		/AIza[A-Za-z0-9_-]{30,}/g,
	];
	for (const pattern of patterns) {
		out = out.replace(pattern, "[REDACTED]");
	}
	return out;
}

function sanitizeSkillName(name: string): string {
	return name
		.toLowerCase()
		.replace(/[^a-z0-9_-]+/g, "-")
		.replace(/^-+|-+$/g, "")
		.slice(0, 64);
}

function parseConsolidationSkillFileArray(value: unknown): ConsolidationSkillFileSchema[] | undefined {
	if (value === undefined) return [];
	if (!Array.isArray(value)) return undefined;
	const files: ConsolidationSkillFileSchema[] = [];
	for (const item of value) {
		if (!isRecord(item)) return undefined;
		const data = item as Record<string, unknown>;
		if (!hasExactKeys(data, ["path", "content"])) return undefined;
		if (typeof data.path !== "string" || typeof data.content !== "string") return undefined;
		files.push({ path: data.path, content: data.content });
	}
	return files;
}

function sanitizeConsolidationSkillFiles(
	files: ConsolidationSkillFileSchema[] | undefined,
	bucket: "scripts" | "templates" | "examples",
): ConsolidationSkillFileSchema[] {
	if (!files || files.length === 0) return [];
	const sanitized = new Map<string, string>();
	for (const file of files) {
		const relativePath = sanitizeSkillRelativePath(file.path);
		if (!relativePath) continue;
		const content = redactSecrets(file.content).trim();
		if (!content) continue;
		sanitized.set(path.posix.join(bucket, relativePath), content);
	}
	return [...sanitized.entries()]
		.sort(([a], [b]) => a.localeCompare(b))
		.map(([fullPath, content]) => ({
			path: fullPath.slice(bucket.length + 1),
			content,
		}));
}

function sanitizeSkillRelativePath(rawPath: string): string | undefined {
	const normalized = rawPath.replace(/\\/g, "/").trim();
	if (!normalized) return undefined;
	if (normalized.startsWith("/")) return undefined;
	if (normalized.includes("\0")) return undefined;
	if (normalized.includes(":")) return undefined;
	const parts = normalized.split("/").filter(Boolean);
	if (parts.length === 0) return undefined;
	for (const part of parts) {
		if (part === "." || part === "..") return undefined;
		if (!/^[A-Za-z0-9._-]+$/.test(part)) return undefined;
	}
	return parts.join("/");
}

function refreshProviderContextForApiKey(apiKey: ApiKey, refresh: () => void): ApiKey {
	// Populate once for static keys and test seams. Resolver-backed keys refresh again only after
	// every awaited credential resolution, immediately before completeSimple starts that attempt.
	refresh();
	if (typeof apiKey === "string") return apiKey;
	return async context => {
		const resolved = await apiKey(context);
		refresh();
		return resolved;
	};
}

function truncateByApproxTokens(text: string, tokenLimit: number): string {
	if (tokenLimit <= 0) return "";
	const maxChars = tokenLimit * 4;
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-tail)}`;
}

function computeModelTokenBudget(model: Model, config: MemoryRuntimeConfig): number {
	const maxTokens =
		model.contextWindow !== null && Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? model.contextWindow
			: config.fallbackTokenLimit;
	return Math.max(2048, Math.floor(maxTokens));
}

async function resolveMemoryModel(options: {
	modelRegistry: ModelRegistry;
	session: AgentSession;
	fallbackRole: string;
}): Promise<Model | undefined> {
	const { modelRegistry, session, fallbackRole } = options;
	const requestedModel =
		session.settings.getModelRole(fallbackRole) || session.settings.getModelRole(DEFAULT_MODEL_SLOT);
	if (requestedModel) {
		const resolved = resolveModelRoleValue(requestedModel, modelRegistry.getAll(), {
			settings: session.settings,
			matchPreferences: getModelMatchPreferences(session.settings),
		});
		if (resolved.model) return resolved.model;
	}
	return session.model ?? modelRegistry.getAll()[0];
}

function loadMemoryConfig(settings: Settings): MemoryRuntimeConfig {
	return {
		enabled: settings.get("memory.backend") === "local" || settings.get("memories.enabled") === true,
		maxRolloutsPerStartup: settings.get("memories.maxRolloutsPerStartup") ?? DEFAULTS.maxRolloutsPerStartup,
		maxRolloutAgeDays: settings.get("memories.maxRolloutAgeDays") ?? DEFAULTS.maxRolloutAgeDays,
		minRolloutIdleHours: settings.get("memories.minRolloutIdleHours") ?? DEFAULTS.minRolloutIdleHours,
		threadScanLimit: settings.get("memories.threadScanLimit") ?? DEFAULTS.threadScanLimit,
		maxRawMemoriesForGlobal: settings.get("memories.maxRawMemoriesForGlobal") ?? DEFAULTS.maxRawMemoriesForGlobal,
		stage1Concurrency: settings.get("memories.stage1Concurrency") ?? DEFAULTS.stage1Concurrency,
		stage1LeaseSeconds: settings.get("memories.stage1LeaseSeconds") ?? DEFAULTS.stage1LeaseSeconds,
		stage1RetryDelaySeconds: settings.get("memories.stage1RetryDelaySeconds") ?? DEFAULTS.stage1RetryDelaySeconds,
		phase2LeaseSeconds: settings.get("memories.phase2LeaseSeconds") ?? DEFAULTS.phase2LeaseSeconds,
		phase2RetryDelaySeconds: settings.get("memories.phase2RetryDelaySeconds") ?? DEFAULTS.phase2RetryDelaySeconds,
		phase2HeartbeatSeconds: settings.get("memories.phase2HeartbeatSeconds") ?? DEFAULTS.phase2HeartbeatSeconds,
		rolloutPayloadPercent: settings.get("memories.rolloutPayloadPercent") ?? DEFAULTS.rolloutPayloadPercent,
		phase1InputTokenLimit: settings.get("memories.phase1InputTokenLimit") ?? DEFAULTS.phase1InputTokenLimit,
		fallbackTokenLimit: settings.get("memories.fallbackTokenLimit") ?? DEFAULTS.fallbackTokenLimit,
		summaryInjectionTokenLimit:
			settings.get("memories.summaryInjectionTokenLimit") ?? DEFAULTS.summaryInjectionTokenLimit,
	};
}

/**
 * Filename of the captured-lessons file under a project's memory root.
 *
 * Written by the `learn` tool via {@link saveLearnedLesson} and read back by
 * {@link buildMemoryToolDeveloperInstructions}. Deliberately distinct from the
 * consolidation artifacts (`MEMORY.md`, `memory_summary.md`, `skills/`) so a
 * consolidation pass never clobbers manually captured lessons.
 */
const LEARNED_LESSONS_FILE = "learned.md";
/** Newest-first cap on retained lessons, bounding file growth by entry count. */
const MAX_LEARNED_LESSONS = 100;
/** Per-field char caps so a single huge capture can't bloat learned.md. */
const MAX_LEARNED_CONTENT_CHARS = 2000;
const MAX_LEARNED_CONTEXT_CHARS = 400;

/**
 * Strip prompt-injection vectors from a single line of lesson text: control/
 * format chars, angle brackets (`</skills>`), backticks, and `~~~` fences, then
 * collapse whitespace. Applied on BOTH write and read (the block renders
 * unescaped into the system prompt), mirroring managed-skill descriptions.
 */
function neutralizeInjection(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

/** Slice to `maxChars`, dropping a trailing unpaired high surrogate. */
function boundChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const sliced = text.slice(0, maxChars);
	return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

/**
 * Normalize one lesson field for storage: neutralize injection delimiters
 * FIRST, then redact secrets (so delimiter stripping can't reassemble a token
 * the redactor would have caught), then bound the length.
 */
function normalizeLearnedText(text: string, maxChars: number): string {
	return boundChars(redactSecrets(neutralizeInjection(text)).trim(), maxChars);
}

/** Per-path write chains serializing `learned.md` read-modify-write. */
const learnedWriteChains = new Map<string, Promise<unknown>>();

/**
 * Append one lesson to the project's `learned.md` (newest-first, deduped,
 * capped, secret-redacted, injection-neutralized). The file backs the `learn`
 * tool when `memory.backend` is `local`.
 */
export async function saveLearnedLesson(
	agentDir: string,
	cwd: string,
	input: MemoryBackendSaveInput,
): Promise<MemoryBackendSaveResult> {
	const content = normalizeLearnedText(input.content, MAX_LEARNED_CONTENT_CHARS);
	if (!content) {
		return { backend: "local", stored: 0, message: "Empty lesson; nothing stored." };
	}
	const context = input.context ? normalizeLearnedText(input.context, MAX_LEARNED_CONTEXT_CHARS) : "";
	const line = context ? `- ${content} _(context: ${context})_` : `- ${content}`;
	const filePath = path.join(getMemoryRoot(agentDir, cwd), LEARNED_LESSONS_FILE);

	// Serialize the read-modify-write per file: parallel `learn` calls (sibling
	// subagents, or two shared tool calls in one turn) share the project memory
	// root, so an unguarded RMW would let the last writer drop the other's lesson.
	const run = (learnedWriteChains.get(filePath) ?? Promise.resolve()).then(() => appendLearnedLine(filePath, line));
	// `guarded` only keeps the chain alive for the NEXT writer; the failure itself is not swallowed,
	// because `await run` below rethrows it to this caller. Without the guard one failed append would
	// reject every later lesson on the same file.
	const guarded = run.catch(() => {});
	learnedWriteChains.set(filePath, guarded);
	try {
		await run;
	} finally {
		// Drop the entry once this write is the chain tail, so the map does not
		// retain one promise per distinct memory root for the process lifetime.
		if (learnedWriteChains.get(filePath) === guarded) learnedWriteChains.delete(filePath);
	}
	return { backend: "local", stored: 1, message: `Lesson saved to ${LEARNED_LESSONS_FILE}.` };
}

async function appendLearnedLine(filePath: string, line: string): Promise<void> {
	let existing = "";
	try {
		existing = await Bun.file(filePath).text();
	} catch (err) {
		if (!isEnoent(err)) throw err;
	}
	const prior = existing
		.split("\n")
		.map(l => l.trim())
		.filter(l => l.startsWith("- ") && l !== line);
	const lessons = [line, ...prior].slice(0, MAX_LEARNED_LESSONS);
	await Bun.write(filePath, `${lessons.join("\n")}\n`);
}

/**
 * Read `learned.md`, neutralizing each line on read too — a hand-edited or
 * pre-existing file bypasses write-time normalization and the block renders
 * unescaped into the system prompt. Returns "" when absent/unreadable.
 */
async function readLearnedLessons(memoryRoot: string): Promise<string> {
	let raw = "";
	try {
		raw = (await Bun.file(path.join(memoryRoot, LEARNED_LESSONS_FILE)).text()).trim();
	} catch {
		return "";
	}
	if (!raw) return "";
	// Neutralize delimiters THEN redact per line — mirrors the write path so a
	// hand-edited line cannot reassemble a token after delimiter stripping.
	return raw
		.split("\n")
		.map(line => redactSecrets(neutralizeInjection(line)))
		.join("\n");
}

function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}

async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	const queue = [...items];
	const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) return;
			await worker(item);
		}
	});
	await Promise.all(workers);
}
