import type { AgentEvent } from "@veyyon/agent-core";
import type { Api, Model } from "@veyyon/ai";
import { collapseWhitespace, isRecord, truncate } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import { formatModelSelectorValue, formatModelStringWithRouting, resolveModelOverride } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import type { AgentSessionEvent } from "../session/agent-session";
import type { ConfiguredThinkingLevel } from "../thinking";
import "../tools/yield";
import { ToolAbortError } from "../tools/tool-errors";

export type { YieldItem } from "./types";

export function countNewlines(text: string): number {
	let count = 0;
	for (let i = 0; i < text.length; i++) {
		if (text.charCodeAt(i) === 0x0a) count++;
	}
	return count;
}

export const MCP_CALL_TIMEOUT_MS = 60_000;

export const SOFT_REQUEST_BUDGET: Record<string, number> = {
	scout: 100,
	sonic: 100,
	default: 200,
};

export const BUDGET_STOP_GRACE_REQUESTS = 5;

export function buildBudgetNotice(requests: number, budget: number): string {
	return `[budget notice] You have used ${requests} requests in this run (soft budget: ${budget}). Wrap up now: finish the current step and yield your final report. At ${Math.ceil(budget * 1.5)} requests the run is force-stopped and you will be asked to yield whatever you have.`;
}

export function formatSalvageSnippet(text: string, maxLength = 500): string {
	return truncate(collapseWhitespace(text), maxLength);
}

export function resolveEffectiveSubagentThinkingLevel(
	explicitThinkingLevel: boolean,
	resolvedThinkingLevel: ConfiguredThinkingLevel | undefined,
	configuredThinkingLevel: ConfiguredThinkingLevel | undefined,
): ConfiguredThinkingLevel | undefined {
	return explicitThinkingLevel ? resolvedThinkingLevel : (configuredThinkingLevel ?? resolvedThinkingLevel);
}

export const agentEventTypes = new Set<AgentEvent["type"]>([
	"agent_start",
	"agent_end",
	"turn_start",
	"turn_end",
	"message_start",
	"message_update",
	"message_end",
	"tool_execution_start",
	"tool_execution_update",
	"tool_execution_end",
]);

export const isAgentEvent = (event: AgentSessionEvent): event is AgentEvent =>
	agentEventTypes.has(event.type as AgentEvent["type"]);

export function normalizeModelPatterns(value: string | string[] | undefined): string[] {
	if (!value) return [];
	if (Array.isArray(value)) {
		return value.map(entry => entry.trim()).filter(Boolean);
	}
	return value
		.split(",")
		.map(entry => entry.trim())
		.filter(Boolean);
}

export const SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX = "subagent:";

export interface SubagentRetryFallbackCandidate {
	model: Model<Api>;
	selector: string;
}

export function resolveSubagentRetryFallbackCandidates(
	modelPatterns: string[],
	modelRegistry: ModelRegistry,
	settings: Settings,
): SubagentRetryFallbackCandidate[] {
	const candidates: SubagentRetryFallbackCandidate[] = [];
	const seen = new Set<string>();
	for (const pattern of modelPatterns) {
		const resolved = resolveModelOverride([pattern], modelRegistry, settings);
		if (!resolved.model) continue;
		const selector = resolved.explicitThinkingLevel
			? formatModelSelectorValue(formatModelStringWithRouting(resolved.model), resolved.thinkingLevel)
			: formatModelStringWithRouting(resolved.model);
		if (seen.has(selector)) continue;
		seen.add(selector);
		candidates.push({ model: resolved.model, selector });
	}
	return candidates;
}

export function installSubagentRetryFallbackChain(args: {
	settings: Settings;
	id: string;
	candidates: SubagentRetryFallbackCandidate[];
	model: Model<Api> | undefined;
	authFallbackUsed: boolean;
}): string | undefined {
	const { settings, id, candidates, model, authFallbackUsed } = args;
	if (!model || authFallbackUsed || candidates.length <= 1) return undefined;

	const selectedIndex = candidates.findIndex(
		candidate => candidate.model.provider === model.provider && candidate.model.id === model.id,
	);
	if (selectedIndex < 0) return undefined;
	const fallbackSelectors = candidates.slice(selectedIndex + 1).map(candidate => candidate.selector);
	if (fallbackSelectors.length === 0) return undefined;

	const role = `${SUBAGENT_RETRY_FALLBACK_ROLE_PREFIX}${id}`;
	const modelRoles: Record<string, string> = {};
	const existingRoles = settings.getModelRoles();
	for (const existingRole in existingRoles) {
		const selector = existingRoles[existingRole];
		if (selector) {
			modelRoles[existingRole] = selector;
		}
	}
	modelRoles[role] = candidates[selectedIndex].selector;
	settings.override("modelRoles", modelRoles);
	const fallbackChains: Record<string, string[]> = {
		[role]: fallbackSelectors,
	};
	const existingFallbackChains = settings.get("retry.fallbackChains");
	for (const existingRole in existingFallbackChains) {
		if (existingRole !== role) {
			fallbackChains[existingRole] = existingFallbackChains[existingRole];
		}
	}
	settings.override("retry.fallbackChains", fallbackChains);
	return role;
}

export function withAbortTimeout<T>(
	promise: Promise<T>,
	timeoutMs: number,
	signal?: AbortSignal,
	timeoutController?: AbortController,
): Promise<T> {
	if (signal?.aborted) {
		return Promise.reject(new ToolAbortError());
	}

	const { promise: wrappedPromise, resolve, reject } = Promise.withResolvers<T>();
	let settled = false;
	const timeoutId = setTimeout(() => {
		if (settled) return;
		settled = true;
		timeoutController?.abort(new DOMException(`MCP tool call timed out after ${timeoutMs}ms`, "TimeoutError"));
		reject(new Error(`MCP tool call timed out after ${timeoutMs}ms`));
	}, timeoutMs);

	const onAbort = () => {
		if (settled) return;
		settled = true;
		clearTimeout(timeoutId);
		timeoutController?.abort();
		reject(new ToolAbortError());
	};

	if (signal) {
		signal.addEventListener("abort", onAbort, { once: true });
	}

	promise.then(resolve, reject).finally(() => {
		if (signal) signal.removeEventListener("abort", onAbort);
		clearTimeout(timeoutId);
	});

	return wrappedPromise;
}

export function getReportFindingKey(value: unknown): string | null {
	if (!isRecord(value)) return null;
	const title = typeof value.title === "string" ? value.title : null;
	const filePath = typeof value.file_path === "string" ? value.file_path : null;
	const lineStart = typeof value.line_start === "number" ? value.line_start : null;
	const lineEnd = typeof value.line_end === "number" ? value.line_end : null;
	const priority = typeof value.priority === "string" ? value.priority : null;
	if (!title || !filePath || lineStart === null || lineEnd === null) {
		return null;
	}
	return `${filePath}:${lineStart}:${lineEnd}:${priority ?? ""}:${title}`;
}
