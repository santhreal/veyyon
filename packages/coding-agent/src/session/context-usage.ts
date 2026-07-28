/**
 * How many tokens the session is holding, by category.
 *
 * This is accounting, not drawing. It lived under `modes/utils/` next to the panel
 * that renders it, which put a number the session engine needs behind the terminal
 * UI: `session/agent-session.ts` imported it, and the layering gate had to carry a
 * standing exception saying so. The panel is still in `modes/utils/context-usage.ts`
 * and imports from here.
 *
 * The category rows carry an id and a token count and no colour or glyph. Those are
 * the panel's choice, keyed on the id, so a second surface can report the same
 * numbers without inheriting the grid's palette.
 */

import { type AgentMessage, countTokens } from "@veyyon/agent-core";
import type { CompactionSettings } from "@veyyon/agent-core/compaction";
import { estimateTokens } from "@veyyon/agent-core/compaction";
import type { Tool as AiTool, Model } from "@veyyon/ai";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
// Imported from their owners rather than the `@veyyon/utils` barrel: this module is
// on `tools/read.ts`'s reach graph through `session/agent-session.ts`, and
// `test/architecture/leveraged-imports-stay-cut.test.ts` asserts that graph does not
// pull the barrel's 81 leaves in behind two names.
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { resolveContextLimit } from "../config/compaction-strategy";
import type { Skill } from "../extensibility/skills";
import type { Tool } from "../tools";
import type { AgentSession } from "./agent-session";

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
	/**
	 * Bytes this session has kept OUT of the request, cumulative across every
	 * turn so far.
	 *
	 * The panel above it answers "what is in my context". This answers "what is
	 * not, and why", which is the other half and was previously invisible: two
	 * mechanisms were quietly shrinking every request and the only way to know
	 * either was working was to read the source. A saving nobody can see is a
	 * saving nobody notices break.
	 */
	elidedBytes: { wirePaths: number; thoughtSignatures: number };
}

const EMPTY_STRING_PARTS: readonly string[] = [];
const EMPTY_TOOLS: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">> = [];
const EMPTY_SKILLS: readonly Skill[] = [];

/** Memoize wire-schema JSON per stable `parameters` object — tool defs are
 *  replaced wholesale via setTools, never mutated in place. */
const toolWireJsonByParameters = new WeakMap<object, string>();

function wireSchemaJsonFragment(tool: Pick<Tool, "name" | "description" | "parameters">): string {
	const parameters = tool.parameters;
	if (parameters !== null && typeof parameters === "object") {
		const cached = toolWireJsonByParameters.get(parameters);
		if (cached !== undefined) return cached;
	}
	try {
		const wireTool: AiTool = {
			name: tool.name,
			description: tool.description,
			parameters: tool.parameters as AiTool["parameters"],
		};
		const json = JSON.stringify(toolWireSchema(wireTool) ?? {});
		if (parameters !== null && typeof parameters === "object") {
			toolWireJsonByParameters.set(parameters, json);
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
): number {
	const fragments: string[] = [];
	for (const tool of tools) {
		fragments.push(tool.name, tool.description, wireSchemaJsonFragment(tool));
	}
	return countTokens(fragments);
}

/**
 * Compute just the NON-MESSAGE token total: system prompt (with its skills
 * section subtracted, since skills are tokenized separately) + system context
 * (the rest of the system-prompt array) + tools + skills.
 *
 * Exposed so callers like `StatusLineComponent` can cache the non-message
 * total separately from the message total. Non-message inputs (skills,
 * tools, system prompt) change rarely; the message list grows on every
 * streaming turn. Splitting the two lets the caller refresh each on its own
 * cadence — non-message recomputed only when the inputs identity changes,
 * messages walked incrementally as new entries append.
 */
// Non-message inputs (system prompt, tools, skills) change rarely — at most
// once per turn via setSystemPrompt/setTools — but the per-turn compaction and
// threshold paths call these helpers several times: getContextBreakdown calls
// both, and #estimateStoredContextTokens adds a third. Memoize on the identity
// of the three input arrays so the expensive parts (system-prompt tokenization
// and the per-tool JSON.stringify(toolWireSchema) inside estimateToolSchemaTokens)
// run at most once per input change rather than per call. The identity keys are
// the same stable references the StatusLineComponent cache already trusts
// (setSystemPrompt/setTools replace the array reference rather than mutating it).
interface NonMessageTokenCache {
	systemPromptRef: readonly string[];
	toolsRef: ReadonlyArray<Pick<Tool, "name" | "description" | "parameters">>;
	skillsRef: readonly Skill[];
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
	let entry = nonMessageTokenCache.get(session);
	if (
		entry &&
		entry.systemPromptRef === systemPromptRef &&
		entry.toolsRef === toolsRef &&
		entry.skillsRef === skillsRef
	) {
		return entry;
	}
	entry = { systemPromptRef, toolsRef, skillsRef, tokens: undefined, breakdown: undefined };
	nonMessageTokenCache.set(session, entry);
	return entry;
}

export function computeNonMessageTokens(session: AgentSession): number {
	const entry = nonMessageTokenCacheEntry(session);
	if (entry.tokens !== undefined) return entry.tokens;
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const tools = session.agent?.state?.tools ?? EMPTY_TOOLS;
	const tokens = countTokens(systemPromptParts) + estimateToolSchemaTokens(tools);
	entry.tokens = tokens;
	return tokens;
}

/**
 * Incremental cache for {@link computeStoredMessagesTokens} (P5, BACKLOG perf
 * hotspots). `estimateTokens` itself already memoizes each message's token
 * count by identity (see `estimateTokens`/`tokenEstimateCache` in
 * `@veyyon/agent-core/compaction`), but the pre-prompt, mid-turn, and
 * post-turn compaction checks each re-summed the FULL `session.messages`
 * array on every call — an O(n) history walk repeated several times per turn
 * even when nothing in the history had changed since the last call.
 *
 * `settledLength`/`settledSum` cover `[0, settledLength)` for the current
 * `messagesRef`. The array's last slot is deliberately excluded from the
 * settled range and re-read every call: `agent-loop.ts` replaces
 * `messages[messages.length - 1]` in place while streaming (partial → final
 * assistant message), which keeps the same array reference and length but
 * swaps the message identity — folding that slot into the settled sum would
 * silently return a stale estimate. Any reference change or length shrink
 * (rewind, `Agent#pop`, compaction replacing the array) resets the cache.
 */
interface StoredMessagesTokenCache {
	messagesRef: AgentMessage[];
	settledLength: number;
	settledSum: number;
}

const storedMessagesTokenCache = new WeakMap<AgentSession, StoredMessagesTokenCache>();

/**
 * Local token estimate of `session.messages` alone (no non-message or
 * pending-message contribution — callers add those separately, mirroring
 * {@link computeNonMessageTokens}). See {@link StoredMessagesTokenCache} for
 * why the array's last slot is always re-measured rather than cached.
 */
export function computeStoredMessagesTokens(
	session: AgentSession,
	options?: { excludeEncryptedReasoning?: boolean },
): number {
	const messages = session.messages ?? [];
	const settledLength = Math.max(0, messages.length - 1);

	let cache = storedMessagesTokenCache.get(session);
	if (!cache || cache.messagesRef !== messages || cache.settledLength > settledLength) {
		cache = { messagesRef: messages, settledLength: 0, settledSum: 0 };
	}
	for (let i = cache.settledLength; i < settledLength; i++) {
		cache.settledSum += estimateTokens(messages[i]!, options);
	}
	cache.settledLength = settledLength;
	storedMessagesTokenCache.set(session, cache);

	const lastMessage = messages.length > 0 ? messages[messages.length - 1] : undefined;
	const lastTokens = lastMessage ? estimateTokens(lastMessage, options) : 0;
	return cache.settledSum + lastTokens;
}

/**
 * Shared helper for the four non-message token totals used by
 * `computeContextBreakdown` (/context panel). Keep this category split stable:
 * the status-line fast path intentionally uses the equivalent collapsed total
 * in `computeNonMessageTokens`.
 */
export function computeNonMessageBreakdown(session: AgentSession): {
	skillsTokens: number;
	toolsTokens: number;
	systemContextTokens: number;
	systemPromptTokens: number;
} {
	const entry = nonMessageTokenCacheEntry(session);
	if (entry.breakdown) return entry.breakdown;
	const skillsTokens = estimateSkillsTokens(session.skills ?? EMPTY_SKILLS);
	const toolsTokens = estimateToolSchemaTokens(session.agent?.state?.tools ?? EMPTY_TOOLS);
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const systemContextTokens = countTokens(systemPromptParts.slice(1));
	const systemPromptTokens = Math.max(0, countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.breakdown = breakdown;
	return breakdown;
}

/**
 * Compute a breakdown of estimated context usage by category for the active
 * session and model.
 */
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

	// The buffer is the room between the fire point and the window: the part of the
	// window auto-compaction will not let you use. `resolveContextLimit` is the one
	// owner of where that point is, shared with the status-line gauge, so the panel
	// and the gauge cannot disagree about whether compaction will fire.
	//
	// There is no invented buffer when it will not fire. This used to substitute
	// `effectiveReserveTokens` whenever the computed buffer came out zero and
	// `compaction.enabled` was set — so a session with `strategy: "off"` was shown a
	// labelled "Autocompact buffer" that nothing would ever enforce, and the panel
	// disagreed with the status line, which correctly denominates against the whole
	// window in that configuration. A displayed reserve no mechanism honours is the
	// same class of bug as printing the fire point where the window belongs.
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
