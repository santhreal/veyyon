/** How many tokens the session is holding, by category. This is accounting, not drawing. It lived under `modes/utils/` next to the panel */

import { type AgentMessage, countTokens } from "@veyyon/agent-core";
import type { CompactionSettings } from "@veyyon/agent-core/compaction";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { Tool as AiTool, ContextSnapshot, Model } from "@veyyon/ai";
import type { SessionTelemetryDetail } from "@veyyon/ai/instrumentation";
import { stripSchemaDescriptions, toolWireSchema } from "@veyyon/ai/utils/schema";
// Imported from their owners rather than the `@veyyon/utils` barrel: this module is on `tools/read.ts`'s reach graph through `session/agent-session.ts`, and
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { resolveContextLimit } from "../config/compaction-strategy";
import { shouldInlineToolDescriptors } from "../config/inline-tool-descriptors-mode";
import type { Skill } from "../extensibility/skills";
import type { Tool } from "../tools";
import type { AgentSession } from "./agent-session";

export interface ContextSnapshotAttribution {
	storedMessagesTokens: number;
	tailTokens: number;
	promptTokensSource: "provider" | "estimate";
	compactionEntryId?: string;
}
/** Split an already-computed prompt total into stored-message and request-tail estimates. Clamping the tail to the message subtotal makes the relationship */
export function estimateContextSnapshotAttribution(
	promptTokens: number,
	nonMessageTokens: number,
	tailTokens: number,
	promptTokensSource: ContextSnapshotAttribution["promptTokensSource"],
	compactionEntryId?: string,
): ContextSnapshotAttribution {
	const messageTokens = Math.max(0, promptTokens - nonMessageTokens);
	const normalizedTailTokens = Math.min(messageTokens, Math.max(0, tailTokens));
	return {
		storedMessagesTokens: messageTokens - normalizedTailTokens,
		tailTokens: normalizedTailTokens,
		promptTokensSource,
		compactionEntryId,
	};
}

/** Build the persisted per-turn context record at the canonical telemetry detail. The caller supplies totals it already computed for request accounting. This */
export function buildContextSnapshot(
	promptTokens: number,
	nonMessageTokens: number,
	detail: SessionTelemetryDetail,
	attribution: ContextSnapshotAttribution,
): ContextSnapshot {
	if (detail !== "rich" && detail !== "ultra") return { promptTokens, nonMessageTokens };

	const snapshot: ContextSnapshot = {
		promptTokens,
		nonMessageTokens,
		storedMessagesTokens: attribution.storedMessagesTokens,
		tailTokens: attribution.tailTokens,
		promptTokensSource: attribution.promptTokensSource,
		nonMessageTokensEstimated: true,
		storedMessagesTokensEstimated: true,
		tailTokensEstimated: true,
	};
	if (detail === "ultra" && attribution.compactionEntryId) {
		snapshot.compactionEntryId = attribution.compactionEntryId;
	}
	return snapshot;
}

export type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

export interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
	/** Bytes this session has kept OUT of the request, cumulative across every turn so far. */
	elidedBytes: { wirePaths: number; thoughtSignatures: number };
}

const EMPTY_STRING_PARTS: readonly string[] = [];
const EMPTY_TOOLS: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">> = [];
const EMPTY_SKILLS: readonly Skill[] = [];

/** Memoize wire-schema JSON per stable `parameters` object — tool defs are
 *  replaced wholesale via setTools, never mutated in place. */
const toolWireJsonByParameters = new WeakMap<object, string>();
/** Same memo for the pruned form. Keyed separately: one `parameters` object now
 *  has two wire encodings and they must not evict each other. */
const prunedToolWireJsonByParameters = new WeakMap<object, string>();

function wireSchemaJsonFragment(
	tool: Pick<Tool, "name" | "description" | "parameters">,
	pruneDescriptions = false,
): string {
	const parameters = tool.parameters;
	const cache = pruneDescriptions ? prunedToolWireJsonByParameters : toolWireJsonByParameters;
	if (parameters !== null && typeof parameters === "object") {
		const cached = cache.get(parameters);
		if (cached !== undefined) return cached;
	}
	try {
		const wireTool: AiTool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as AiTool["parameters"],
		};
		const wire = toolWireSchema(wireTool) ?? {};
		const json = JSON.stringify(pruneDescriptions ? stripSchemaDescriptions(wire as Record<string, unknown>) : wire);
		if (parameters !== null && typeof parameters === "object") {
			cache.set(parameters, json);
		}
		return json;
	} catch (error) {
		// Estimation must not crash the usage panel, but counting this tool
		// as ~0 tokens silently understates context usage — warn once per tool.
		if (!wireJsonFailureWarned.has(tool.name)) {
			wireJsonFailureWarned.add(tool.name);
			logger.warn("tool wire-schema serialization failed; context usage understates this tool", {
				tool: tool.name,
				error: errorMessage(error),
			});
		}
		return "{}";
	}
}
const wireJsonFailureWarned = new Set<string>();

export function estimateSkillsTokens(skills: readonly Skill[]): number {
	const fragments: string[] = [];
	for (const skill of skills) {
		// "- name: description\n" wire framing tokenizes ~identically to the
		// concatenated form, so encode each piece separately and sum.
		fragments.push(skill.name, skill.description);
	}
	return countTokens(fragments);
}

export function estimateToolSchemaTokens(
	tools: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>,
	pruneDescriptions = false,
): number {
	const fragments: string[] = [];
	for (const tool of tools) {
		fragments.push(tool.name);
		// The pruned form empties the top-level description and drops the nested
		// schema annotations, so counting either here would bill text the request
		// does not carry.
		if (!pruneDescriptions) fragments.push(tool.description);
		fragments.push(wireSchemaJsonFragment(tool, pruneDescriptions));
	}
	return countTokens(fragments);
}

/** Whether this session's requests ship tool schemas WITHOUT their descriptions. When the full catalog is rendered into the system prompt, the provider-bound */
function prunesToolDescriptions(session: AgentSession): boolean {
	return shouldInlineToolDescriptors(session.settings?.get("inlineToolDescriptors"), session.model?.id);
}

/** Compute just the NON-MESSAGE token total: system prompt (with its skills section subtracted, since skills are tokenized separately) + system context */
// Non-message inputs (system prompt, tools, skills) change rarely — at most once per turn via setSystemPrompt/setTools — but the per-turn compaction and
interface NonMessageTokenCache {
	systemPromptRef: readonly string[];
	toolsRef: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>;
	skillsRef: readonly Skill[];
	prune: boolean;
	tokens: number | undefined;
	breakdown:
		| {
				skillsTokens: number;
				toolsTokens: number;
				systemContextTokens: number;
				systemPromptTokens: number;
		  }
		| undefined;
}

const nonMessageTokenCache = new WeakMap<AgentSession, NonMessageTokenCache>();

function nonMessageTokenCacheEntry(session: AgentSession): NonMessageTokenCache {
	const systemPromptRef = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const toolsRef = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const skillsRef = session.skills ?? EMPTY_SKILLS;
	// The same tools array yields two totals depending on the active model, so a
	// mid-session model switch has to miss this cache rather than serve the
	// previous model's number.
	const prune = prunesToolDescriptions(session);
	let entry = nonMessageTokenCache.get(session);
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		entry.skillsRef === skillsRef &&
		entry.prune === prune
	) {
		return entry;
	}
	entry = { systemPromptRef, toolsRef, skillsRef, prune, tokens: undefined, breakdown: undefined };
	nonMessageTokenCache.set(session, entry);
	return entry;
}

export function computeNonMessageTokens(session: AgentSession): number {
	const entry = nonMessageTokenCacheEntry(session);
	if (entry.tokens !== undefined) return entry.tokens;
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const tokens = countTokens(systemPromptParts) + estimateToolSchemaTokens(tools, entry.prune);
	entry.tokens = tokens;
	return tokens;
}

/** Incremental cache for {@link computeStoredMessagesTokens} (P5, BACKLOG perf hotspots). `estimateTokens` itself already memoizes each message's token */
interface SettledPrefix {
	settledLength: number;
	settledSum: number;
}

interface StoredMessagesTokenCache {
	messagesRef: AgentMessage[];
	default: SettledPrefix;
	noReasoning: SettledPrefix;
}

const storedMessagesTokenCache = new WeakMap<AgentSession, StoredMessagesTokenCache>();

/** Local token estimate of `session.messages` alone (no non-message or pending-message contribution — callers add those separately, mirroring */
export function computeStoredMessagesTokens(
	session: AgentSession,
	options?: { excludeEncryptedReasoning?: boolean },
): number {
	const messages = session.messages ?? [];
	const settledLength = Math.max(0, messages.length - 1);

	let cache = storedMessagesTokenCache.get(session);
	if (
		!cache ||
		cache.messagesRef !== messages ||
		cache.default.settledLength > settledLength ||
		cache.noReasoning.settledLength > settledLength
	) {
		cache = {
			messagesRef: messages,
			default: { settledLength: 0, settledSum: 0 },
			noReasoning: { settledLength: 0, settledSum: 0 },
		};
	}
	const slot = options?.excludeEncryptedReasoning ? cache.noReasoning : cache.default;
	for (let i = slot.settledLength; i < settledLength; i++) {
		slot.settledSum += estimateTokens(messages[i]!, options);
	}
	slot.settledLength = settledLength;
	storedMessagesTokenCache.set(session, cache);

	const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
	const lastTokens = lastMessage ? estimateTokens(lastMessage, options) : 0;
	return slot.settledSum + lastTokens;
}

/** Shared helper for the four non-message token totals used by `computeContextBreakdown` (/context panel). Keep this category split stable: */
export function computeNonMessageBreakdown(session: AgentSession): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const entry = nonMessageTokenCacheEntry(session);
	if (entry.breakdown) return entry.breakdown;
	const skillsTokens = estimateSkillsTokens(session.skills ?? EMPTY_SKILLS);
	const toolsTokens = estimateToolSchemaTokens(session.agent?.state?.tools ?? EMPTY_TOOLS, entry.prune);
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const systemContextTokens = countTokens(systemPromptParts.slice(1));
	const systemPromptTokens = Math.max(0, countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.breakdown = breakdown;
	return breakdown;
}

/** Compute a breakdown of estimated context usage by category for the active session and model. */
export function computeContextBreakdown(session: AgentSession): ContextBreakdown {
	const model = session.model;
	const contextWindow = model?.contextWindow ?? 0;

	const breakdown = typeof session.getContextBreakdown === "function" ? session.getContextBreakdown() : undefined;

	let messagesTokens = 0;
	let skillsTokens = 0;
	let toolsTokens = 0;
	let systemContextTokens = 0;
	let systemPromptTokens = 0;
	let usedTokens = 0;

	if (breakdown) {
		messagesTokens = breakdown.messagesTokens;
		skillsTokens = breakdown.skillsTokens;
		toolsTokens = breakdown.systemToolsTokens;
		systemContextTokens = breakdown.systemContextTokens;
		systemPromptTokens = breakdown.systemPromptTokens;
		usedTokens = breakdown.usedTokens;
	} else {
		const convo = session.messages;
		if (convo) {
			for (const message of convo) {
				messagesTokens += estimateTokens(message);
			}
		}
		const nonMessage = computeNonMessageBreakdown(session);
		skillsTokens = nonMessage.skillsTokens;
		toolsTokens = nonMessage.toolsTokens;
		systemContextTokens = nonMessage.systemContextTokens;
		systemPromptTokens = nonMessage.systemPromptTokens;
		usedTokens = skillsTokens + toolsTokens + systemContextTokens + systemPromptTokens + messagesTokens;
	}

	const categories: CategoryInfo[] = [
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens },
		{ id: "systemContext", label: "System context", tokens: systemContextTokens },
		{ id: "skills", label: "Skills", tokens: skillsTokens },
		{ id: "messages", label: "Messages", tokens: messagesTokens },
	];

	// The buffer is the room between the fire point and the window: the part of the window auto-compaction will not let you use. `resolveContextLimit` is the one
	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction") as CompactionSettings;
		const limit = resolveContextLimit(contextWindow, compactionSettings);
		autoCompactBufferTokens = limit.kind === "compaction" ? Math.max(0, contextWindow - limit.tokens) : 0;
	}
	autoCompactBufferTokens = Math.min(autoCompactBufferTokens, Math.max(0, contextWindow - usedTokens));

	const freeTokens = Math.max(0, contextWindow - usedTokens - autoCompactBufferTokens);

	return {
		model,
		contextWindow,
		categories,
		usedTokens,
		autoCompactBufferTokens,
		freeTokens,
		elidedBytes: {
			wirePaths: session.wirePathBytesSaved ?? 0,
			thoughtSignatures: session.thoughtSignatureBytesSaved ?? 0,
		},
	};
}
