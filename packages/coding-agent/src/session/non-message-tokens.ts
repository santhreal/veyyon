/**
 * The non-message half of the context accounting: system prompt, system context,
 * tool schemas and skills.
 *
 * SEPARATE FROM `context-usage.ts` BECAUSE THE STATUS ROW IMPORTS IT. The message
 * half sums `session.messages` through `estimateTokens`, which is
 * `@veyyon/agent-core/compaction` — the compaction engine, 105ms of module
 * evaluation. The launch card paints the row before a session exists, so the row
 * reaching that engine put the whole of compaction on the path to the first frame.
 * Nothing here tokenizes a message, so nothing here needs it.
 *
 * Every import below names the leaf that owns the symbol rather than a package
 * barrel, for the same reason: this module is on the launch path now.
 */

import { countTokens } from "@veyyon/agent-core/tokenizer";
import type { Tool as AiTool } from "@veyyon/ai";
import { stripSchemaDescriptions, toolWireSchema } from "@veyyon/ai/utils/schema/wire";
import * as logger from "@veyyon/utils/logger";
import { errorMessage } from "@veyyon/utils/type-guards";
import { shouldInlineToolDescriptors } from "../config/inline-tool-descriptors-mode";
import type { Skill } from "../extensibility/skills";
import type { Tool } from "../tools";
import type { AgentSession } from "./agent-session";

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

/**
 * Whether this session's requests ship tool schemas WITHOUT their descriptions.
 *
 * When the full catalog is rendered into the system prompt, the provider-bound
 * specs are pruned so the text rides the wire once rather than twice. Counting
 * the registry instead of the pruned form overstated the tool half by about
 * 11.5k tokens per turn on Gemini, which is the only family `auto` inlines. That
 * total is not cosmetic: it feeds the compaction scaling ratio, where an
 * inflated value keeps `keepRecentTokens` high, so each pass frees less and the
 * session returns to the threshold sooner.
 */
function prunesToolDescriptions(session: AgentSession): boolean {
	return shouldInlineToolDescriptors(session.settings?.get("inlineToolDescriptors"), session.model?.id);
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
	const toolsTokens = estimateToolSchemaTokens(session.agent?.state?.tools ?? EMPTY_TOOLS, entry.prune);
	const systemPromptParts = session.systemPrompt ?? EMPTY_STRING_PARTS;
	const systemContextTokens = countTokens(systemPromptParts.slice(1));
	const systemPromptTokens = Math.max(0, countTokens(systemPromptParts[0] ?? "") - skillsTokens);
	const breakdown = { skillsTokens, toolsTokens, systemContextTokens, systemPromptTokens };
	entry.breakdown = breakdown;
	return breakdown;
}
