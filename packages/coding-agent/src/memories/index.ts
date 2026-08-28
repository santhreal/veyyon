import * as fs from "node:fs/promises";
import * as path from "node:path";
import { type ApiKey, type Context, completeSimple, type Model } from "@veyyon/ai";
import { Effort } from "@veyyon/catalog/effort";
import { clampLow, errorMessage, isEnoent, isRecord, logger, prompt, readdirIfPresent } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import { getModelMatchPreferences, resolveModelRoleValue } from "../config/model-resolver";
import { DEFAULT_MODEL_SLOT } from "../config/model-roles";
import type { Settings } from "../config/settings";

export { getMemoryRoot } from "./paths";

import type { MemoryBackendSaveInput, MemoryBackendSaveResult } from "../memory-backend/types";
import { memoriesPrompts } from "../prompts/memories/rows";
import type { AgentSession } from "../session/agent-session";
import {
	type ConsolidationOutputSchema,
	type ConsolidationSkillFileSchema,
	type ConsolidationSkillSchema,
	clampMemoryEffort,
	DEFAULTS,
	extractPersistableMessages,
	type MemoryRuntimeConfig,
	type Stage1OutputSchema,
} from "./index-helpers";
import { getMemoryRoot } from "./paths";
import type { Stage1Claim, Stage1OutputRow } from "./storage";

export {
	buildMemoryToolDeveloperInstructions,
	clearMemoryData,
	clearMemoryToolDeveloperInstructionsCache,
	enqueueMemoryConsolidation,
	refreshMemoryToolDeveloperInstructionsCacheAfterStartup,
	startMemoryStartupTask,
} from "./index-helpers";

export async function runStage1Job(options: {
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
		return { kind: "failed", reason: sanitize(errorMessage(error)) };
	}
}

export async function syncPhase2Artifacts(memoryRoot: string, outputs: Stage1OutputRow[]): Promise<void> {
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

export async function cleanupConsolidatedArtifacts(memoryRoot: string): Promise<void> {
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
		blocks.push(
			`--- unreadable ---\n${unreadable.length} further summaries could not be read: ${unreadable.join(", ")}`,
		);
	}
	return blocks.join("\n\n");
}

export async function runConsolidationModel(options: {
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

export async function applyConsolidation(
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

		for (const [relativePath, content] of Array.from(files.entries()).sort(([a], [b]) => a.localeCompare(b))) {
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

async function listRelativeFiles(rootDir: string, prefix = ""): Promise<string[]> {
	const entries = await readdirIfPresent(rootDir, "existing memory files");
	const files: string[] = [];
	for (const entry of entries) {
		const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
		if (entry.isDirectory()) {
			const subFiles = await listRelativeFiles(path.join(rootDir, entry.name), relative);
			for (let fi = 0; fi < subFiles.length; fi++) files.push(subFiles[fi]!);
			continue;
		}
		if (entry.isFile()) files.push(relative);
	}
	return files;
}

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

export function computeCompletionWatermark(claimedInputWatermark: number, outputs: Stage1OutputRow[]): number {
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
	const sortedExpected = Array.from(expectedKeys).sort();
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
	return Array.from(sanitized.entries())
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
	refresh();
	if (typeof apiKey === "string") return apiKey;
	return async context => {
		const resolved = await apiKey(context);
		refresh();
		return resolved;
	};
}

export function truncateByApproxTokens(text: string, tokenLimit: number): string {
	if (tokenLimit <= 0) return "";
	const maxChars = tokenLimit * 4;
	if (text.length <= maxChars) return text;
	const head = Math.floor(maxChars * 0.6);
	const tail = maxChars - head;
	return `${text.slice(0, head)}\n\n...[truncated]...\n\n${text.slice(-tail)}`;
}

export function computeModelTokenBudget(model: Model, config: MemoryRuntimeConfig): number {
	const maxTokens =
		model.contextWindow !== null && Number.isFinite(model.contextWindow) && model.contextWindow > 0
			? model.contextWindow
			: config.fallbackTokenLimit;
	return Math.max(2048, Math.floor(maxTokens));
}

export async function resolveMemoryModel(options: {
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

export function loadMemoryConfig(settings: Settings): MemoryRuntimeConfig {
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

const LEARNED_LESSONS_FILE = "learned.md";
const MAX_LEARNED_LESSONS = 100;
const MAX_LEARNED_CONTENT_CHARS = 2000;
const MAX_LEARNED_CONTEXT_CHARS = 400;

function neutralizeInjection(text: string): string {
	return text
		.replace(/[\p{Cc}\p{Cf}]/gu, " ")
		.replace(/[<>`]/g, "")
		.replace(/~{2,}/g, "~")
		.replace(/\s+/g, " ")
		.trim();
}

function boundChars(text: string, maxChars: number): string {
	if (text.length <= maxChars) return text;
	const sliced = text.slice(0, maxChars);
	return /[\uD800-\uDBFF]$/.test(sliced) ? sliced.slice(0, -1) : sliced;
}

function normalizeLearnedText(text: string, maxChars: number): string {
	return boundChars(redactSecrets(neutralizeInjection(text)).trim(), maxChars);
}

const learnedWriteChains = new Map<string, Promise<unknown>>();

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

	const run = (learnedWriteChains.get(filePath) ?? Promise.resolve()).then(() => appendLearnedLine(filePath, line));
	const guarded = run.catch(() => {});
	learnedWriteChains.set(filePath, guarded);
	try {
		await run;
	} finally {
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

export async function readLearnedLessons(memoryRoot: string): Promise<string> {
	let raw = "";
	try {
		raw = (await Bun.file(path.join(memoryRoot, LEARNED_LESSONS_FILE)).text()).trim();
	} catch {
		return "";
	}
	if (!raw) return "";
	return raw
		.split("\n")
		.map(line => redactSecrets(neutralizeInjection(line)))
		.join("\n");
}

export function unixNow(): number {
	return Math.floor(Date.now() / 1000);
}

export async function runWithConcurrency<T>(
	items: T[],
	concurrency: number,
	worker: (item: T) => Promise<void>,
): Promise<void> {
	const queue = items.slice();
	const workers = new Array(Math.max(1, concurrency)).fill(0).map(async () => {
		while (queue.length > 0) {
			const item = queue.shift();
			if (!item) return;
			await worker(item);
		}
	});
	await Promise.all(workers);
}
