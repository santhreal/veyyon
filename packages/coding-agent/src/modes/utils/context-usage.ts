import { type AgentMessage, countTokens } from "@veyyon/agent-core";
import type { CompactionSettings } from "@veyyon/agent-core/compaction";
import { effectiveReserveTokens, estimateTokens, resolveThresholdTokens } from "@veyyon/agent-core/compaction";
import type { Tool as AiTool, Model } from "@veyyon/ai";
import { toolWireSchema } from "@veyyon/ai/utils/schema";
import { errorMessage, formatCount, formatNumber, logger } from "@veyyon/utils";
import type { Skill } from "../../extensibility/skills";
import type { AgentSession } from "../../session/agent-session";
import type { Tool } from "../../tools";
import type { theme as Theme } from "../theme/theme";

const GRID_COLS = 20;
const GRID_ROWS = 10;
const GRID_CELLS = GRID_COLS * GRID_ROWS;
const GRID_GUTTER = "   ";

const CELL_FILLED = "⛁";
const CELL_FILLED_MESSAGES = "⛃";
const CELL_FREE = "⛶";
const CELL_BUFFER = "⛝";

type CategoryId = "systemPrompt" | "systemContext" | "systemTools" | "skills" | "messages";

interface CategoryInfo {
	id: CategoryId;
	label: string;
	tokens: number;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel";
	glyph: string;
}

export interface ContextBreakdown {
	model: Model | undefined;
	contextWindow: number;
	categories: CategoryInfo[];
	usedTokens: number;
	autoCompactBufferTokens: number;
	freeTokens: number;
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
		{ id: "systemPrompt", label: "System prompt", tokens: systemPromptTokens, color: "accent", glyph: CELL_FILLED },
		{ id: "systemTools", label: "System tools", tokens: toolsTokens, color: "warning", glyph: CELL_FILLED },
		{
			id: "systemContext",
			label: "System context",
			tokens: systemContextTokens,
			color: "customMessageLabel",
			glyph: CELL_FILLED,
		},
		{ id: "skills", label: "Skills", tokens: skillsTokens, color: "success", glyph: CELL_FILLED },
		{
			id: "messages",
			label: "Messages",
			tokens: messagesTokens,
			color: "userMessageText",
			glyph: CELL_FILLED_MESSAGES,
		},
	];

	let autoCompactBufferTokens = 0;
	if (contextWindow > 0) {
		const compactionSettings = session.settings.getGroup("compaction") as CompactionSettings;
		if (compactionSettings.enabled && compactionSettings.strategy !== "off") {
			const threshold = resolveThresholdTokens(contextWindow, compactionSettings);
			autoCompactBufferTokens = Math.max(0, contextWindow - threshold);
		} else {
			autoCompactBufferTokens = 0;
		}
		// Even when fully disabled, fall back to a sensible reserve floor for display.
		if (autoCompactBufferTokens === 0 && compactionSettings.enabled) {
			autoCompactBufferTokens = effectiveReserveTokens(contextWindow, compactionSettings);
		}
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
	};
}

interface CellSpec {
	glyph: string;
	color: "accent" | "warning" | "success" | "userMessageText" | "customMessageLabel" | "muted" | "dim";
}

function planCells(breakdown: ContextBreakdown): CellSpec[] {
	const cells: CellSpec[] = [];
	const window = breakdown.contextWindow;

	if (window <= 0) {
		for (let i = 0; i < GRID_CELLS; i++) {
			cells.push({ glyph: CELL_FREE, color: "dim" });
		}
		return cells;
	}

	const tokensPerCell = window / GRID_CELLS;

	const ratioCells = (tokens: number): number => {
		if (tokens <= 0) return 0;
		return Math.max(1, Math.round(tokens / tokensPerCell));
	};

	const categoryCounts = breakdown.categories.map(category => ({
		category,
		count: ratioCells(category.tokens),
	}));

	let bufferCount = ratioCells(breakdown.autoCompactBufferTokens);

	let usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);

	// Prevent the visualization from over-running the grid.
	const maxUsable = GRID_CELLS - bufferCount;
	if (usedCount > maxUsable) {
		// Scale categories proportionally down to fit.
		let overflow = usedCount - maxUsable;
		// Trim from the largest categories first to preserve visibility for small ones.
		const order = [...categoryCounts].sort((a, b) => b.count - a.count);
		for (const entry of order) {
			while (overflow > 0 && entry.count > 1) {
				entry.count -= 1;
				overflow -= 1;
			}
		}
		usedCount = categoryCounts.reduce((sum, c) => sum + c.count, 0);
		if (usedCount + bufferCount > GRID_CELLS) {
			bufferCount = Math.max(0, GRID_CELLS - usedCount);
		}
	}

	for (const { category, count } of categoryCounts) {
		for (let i = 0; i < count; i++) {
			cells.push({ glyph: category.glyph, color: category.color });
		}
	}

	const freeCount = Math.max(0, GRID_CELLS - cells.length - bufferCount);
	for (let i = 0; i < freeCount; i++) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	for (let i = 0; i < bufferCount; i++) {
		cells.push({ glyph: CELL_BUFFER, color: "warning" });
	}

	// Pad to exactly GRID_CELLS in case rounding undershot.
	while (cells.length < GRID_CELLS) {
		cells.push({ glyph: CELL_FREE, color: "dim" });
	}
	return cells.slice(0, GRID_CELLS);
}

function percentString(part: number, whole: number, fractionDigits = 1): string {
	if (whole <= 0) return "0%";
	const pct = (part / whole) * 100;
	if (pct > 0 && pct < 0.05) return "<0.1%";
	return `${pct.toFixed(fractionDigits)}%`;
}

function buildLegendLines(breakdown: ContextBreakdown, theme: typeof Theme): string[] {
	const lines: string[] = [];
	const { model, contextWindow, categories, usedTokens, autoCompactBufferTokens, freeTokens } = breakdown;

	const modelName = model?.name ?? model?.id ?? "no model";
	const modelId = model?.id ?? "unknown";
	const windowLabel = formatNumber(contextWindow).toLowerCase();

	lines.push(theme.bold(`${modelName}`) + theme.fg("dim", ` (${windowLabel} context)`));
	lines.push(theme.fg("muted", `${modelId}[${windowLabel}]`));
	lines.push(
		`${theme.bold(formatNumber(usedTokens))}${theme.fg("dim", `/${windowLabel} tokens`)}` +
			theme.fg("muted", ` (${percentString(usedTokens, contextWindow)})`),
	);
	lines.push("");
	lines.push(theme.fg("muted", "Estimated usage by category"));

	for (const category of categories) {
		const dot = theme.fg(category.color, category.glyph);
		const label = category.label;
		const tokens = formatNumber(category.tokens);
		const pct = percentString(category.tokens, contextWindow);
		lines.push(`${dot} ${label}: ${theme.bold(tokens)} ${theme.fg("dim", `tokens (${pct})`)}`);
	}

	const freeDot = theme.fg("dim", CELL_FREE);
	lines.push(
		`${freeDot} Free space: ${theme.bold(formatNumber(freeTokens))} ${theme.fg("dim", `(${percentString(freeTokens, contextWindow)})`)}`,
	);

	if (autoCompactBufferTokens > 0) {
		const bufferDot = theme.fg("warning", CELL_BUFFER);
		lines.push(
			`${bufferDot} Autocompact buffer: ${theme.bold(formatNumber(autoCompactBufferTokens))} ${theme.fg(
				"dim",
				`tokens (${percentString(autoCompactBufferTokens, contextWindow)})`,
			)}`,
		);
	}

	return lines;
}

/**
 * Render a colorful context-usage panel as ANSI text. Output is a series of
 * lines pairing the grid (left) with the legend (right).
 */
export function renderContextUsage(breakdown: ContextBreakdown, theme: typeof Theme): string {
	if (breakdown.contextWindow <= 0) {
		return theme.fg("muted", "Context usage is unavailable: no model is selected for this session.");
	}

	const cells = planCells(breakdown);
	const legend = buildLegendLines(breakdown, theme);

	const totalLines = Math.max(GRID_ROWS, legend.length);
	const lines: string[] = [];

	for (let row = 0; row < totalLines; row++) {
		let gridSegment = "";
		if (row < GRID_ROWS) {
			const rowCells: string[] = [];
			for (let col = 0; col < GRID_COLS; col++) {
				const cell = cells[row * GRID_COLS + col];
				rowCells.push(theme.fg(cell.color, cell.glyph));
			}
			gridSegment = rowCells.join(" ");
		} else {
			// Pad with blanks the same visible width as a grid row so legend lines
			// past the grid stay aligned with their column.
			const blank = " ".repeat(GRID_COLS * 2 - 1);
			gridSegment = blank;
		}

		const legendSegment = legend[row] ?? "";
		const line = legendSegment.length > 0 ? `${gridSegment}${GRID_GUTTER}${legendSegment}` : gridSegment;
		lines.push(line);
	}

	return lines.join("\n");
}
