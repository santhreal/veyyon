import type { Database } from "bun:sqlite";
import type * as fsNode from "node:fs";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import type { Model } from "@veyyon/ai";
import type { Effort } from "@veyyon/catalog/effort";
import { clampThinkingLevelForModel } from "@veyyon/catalog/model-thinking";
import { emptyCost } from "@veyyon/catalog/models";
import { errorMessage, getAgentDbPath, isRecord, logger, parseJsonlLenient, prompt } from "@veyyon/utils";
import { isSessionFileName, sessionFileStem } from "@veyyon/utils/session-file";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";

export { getMemoryRoot } from "./paths";

import { memoriesPrompts } from "../prompts/memories/rows";
import type { AgentSession } from "../session/agent-session";
import {
	applyConsolidation,
	cleanupConsolidatedArtifacts,
	computeCompletionWatermark,
	computeModelTokenBudget,
	loadMemoryConfig,
	readLearnedLessons,
	resolveMemoryModel,
	runConsolidationModel,
	runStage1Job,
	runWithConcurrency,
	syncPhase2Artifacts,
	truncateByApproxTokens,
	unixNow,
} from "./index";
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
	tryClaimGlobalPhase2Job,
	upsertThreads,
} from "./storage";

export function clampMemoryEffort(model: Model, requested: Effort): Effort | undefined {
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

export interface MemoryRuntimeConfig {
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

export const DEFAULTS: MemoryRuntimeConfig = {
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

export interface Stage1Stats {
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

export interface Stage1OutputSchema {
	raw_memory: string;
	rollout_summary: string;
	rollout_slug: string | null;
}

export interface ConsolidationSkillFileSchema {
	path: string;
	content: string;
}

export interface ConsolidationSkillSchema {
	name: string;
	content?: string;
	scripts?: ConsolidationSkillFileSchema[];
	templates?: ConsolidationSkillFileSchema[];
	examples?: ConsolidationSkillFileSchema[];
}
export interface ConsolidationOutputSchema {
	memory_md: string;
	memory_summary: string;
	skills: ConsolidationSkillSchema[];
}

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

export interface MemoryInstructionSession {
	sessionManager: Pick<AgentSession["sessionManager"], "getSessionFile">;
}

export interface MemoryToolDeveloperInstructionsSnapshot {
	summary: string;
	learned: string;
}

export interface CachedMemoryToolDeveloperInstructions {
	sessionFile: string | undefined;
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined;
	value: string | undefined;
}

export const memoryToolDeveloperInstructionsBySession = new WeakMap<
	MemoryInstructionSession,
	CachedMemoryToolDeveloperInstructions
>();
export const memoryToolDeveloperInstructionsByRoot = new Map<
	string,
	MemoryToolDeveloperInstructionsSnapshot | undefined
>();

export function getMemoryInstructionRoot(agentDir: string, settings: Settings): string {
	return getMemoryRoot(agentDir, settings.getCwd());
}

export function getMemoryInstructionSessionFile(session: MemoryInstructionSession): string | undefined {
	return session.sessionManager.getSessionFile() ?? undefined;
}

export async function readMemoryToolDeveloperInstructionsSnapshot(
	agentDir: string,
	settings: Settings,
): Promise<MemoryToolDeveloperInstructionsSnapshot | undefined> {
	const cfg = loadMemoryConfig(settings);
	if (!cfg.enabled) return undefined;
	const memoryRoot = getMemoryInstructionRoot(agentDir, settings);

	let summary = "";
	try {
		summary = (await Bun.file(path.join(memoryRoot, "memory_summary.md")).text()).trim();
	} catch {}
	const learned = await readLearnedLessons(memoryRoot);
	return { summary, learned };
}

export function renderMemoryToolDeveloperInstructionsSnapshot(
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
	const learnedBudget = Math.max(0, cfg.summaryInjectionTokenLimit - Math.ceil(summaryOut.length / 4));
	const learnedOut =
		snapshot.learned && learnedBudget > 0 ? truncateByApproxTokens(snapshot.learned, learnedBudget).trim() : "";
	if (!summaryOut && !learnedOut) return undefined;

	return prompt.render(memoriesPrompts["memories/read-path"].text, {
		memory_summary: summaryOut,
		learned: learnedOut,
	});
}

export function cacheMemoryToolDeveloperInstructions(
	session: MemoryInstructionSession,
	sessionFile: string | undefined,
	snapshot: MemoryToolDeveloperInstructionsSnapshot | undefined,
	settings: Settings,
): string | undefined {
	const value = renderMemoryToolDeveloperInstructionsSnapshot(snapshot, settings);
	memoryToolDeveloperInstructionsBySession.set(session, { sessionFile, snapshot, value });
	return value;
}

export function clearMemoryToolDeveloperInstructionsCache(session: MemoryInstructionSession | undefined): void {
	if (session) memoryToolDeveloperInstructionsBySession.delete(session);
}

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

export async function clearMemoryData(agentDir: string, cwd: string): Promise<void> {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		clearMemoryDataInDb(db);
	} finally {
		closeMemoryDb(db);
	}
	await fs.rm(getMemoryRoot(agentDir, cwd), { recursive: true, force: true });
}

export function enqueueMemoryConsolidation(agentDir: string, cwd: string, sourceUpdatedAt = unixNow()): void {
	const db = openMemoryDb(getAgentDbPath(agentDir));
	try {
		enqueueGlobalWatermark(db, sourceUpdatedAt, cwd, { forceDirtyWhenNotAdvanced: true });
	} finally {
		closeMemoryDb(db);
	}
}

export async function runMemoryStartup(options: {
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

export async function runPhase1(options: {
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

export async function runPhase2(options: {
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
				reason: errorMessage(error),
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

export function markPhase2FailureWithFallback(
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

export async function collectThreads(session: AgentSession, currentThreadId?: string): Promise<MemoryThread[]> {
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
		} catch {}

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

export type PersistableMemoryRole = "system" | "developer" | "user" | "assistant" | "toolResult";

export interface PersistableMemoryMessage {
	role: PersistableMemoryRole;
	text: string;
	toolName?: "bash" | "eval" | "read" | "grep";
}

export function isPersistableMemoryRole(role: unknown): role is PersistableMemoryRole {
	return role === "system" || role === "developer" || role === "user" || role === "assistant" || role === "toolResult";
}

export function extractMemoryMessageText(message: Record<string, unknown>): string {
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

export function extractPersistableMessages(payload: string): PersistableMemoryMessage[] {
	const rows = parseJsonlLenient(payload);
	if (!Array.isArray(rows)) return [];
	const messages: PersistableMemoryMessage[] = [];
	for (const row of rows) {
		if (!isRecord(row) || row.type !== "message" || !isRecord(row.message)) continue;
		const role = row.message.role;
		if (!isPersistableMemoryRole(role)) continue;

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
