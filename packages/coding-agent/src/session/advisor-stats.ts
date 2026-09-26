/**
 * Advisor spend and context: the figures `/advisor status` and the status panel show, read off each
 * advisor agent's own transcript, and the status line built from them.
 *
 * Spend is the sum of every assistant message's usage. Context is the prompt size the latest usable
 * assistant message reported plus an estimate for the messages after it, or an estimate of the
 * whole transcript when no such message exists yet.
 */

import type { AgentMessage } from "@veyyon/agent-core";
import { calculatePromptTokens } from "@veyyon/agent-core/compaction/compaction";
import { estimateTokens } from "@veyyon/agent-core/compaction/token-estimate";
import type { AssistantMessage, Model } from "@veyyon/ai";
import type { AdvisorStats, PerAdvisorStat } from "./agent-session-types";

/** What one advisor's figures are read from: its display name and its agent's live state. */
export interface AdvisorStatSource {
	readonly name: string;
	readonly agent: {
		readonly state: {
			readonly model: Model;
			readonly messages: readonly AgentMessage[];
		};
	};
}

/** The figures for every live advisor and their totals. `configured` is the session's advisor setting. */
export function collectAdvisorStats(configured: boolean, sources: readonly AdvisorStatSource[]): AdvisorStats {
	const advisors = sources.map(perAdvisorStat);
	const tokens = { input: 0, output: 0, reasoning: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
	const messages = { user: 0, assistant: 0, total: 0 };
	if (advisors.length === 0) {
		return {
			configured,
			active: false,
			contextWindow: 0,
			contextTokens: 0,
			tokens,
			cost: 0,
			messages,
			advisors: [],
		};
	}
	let cost = 0;
	let contextTokens = 0;
	for (const a of advisors) {
		tokens.input += a.tokens.input;
		tokens.output += a.tokens.output;
		tokens.reasoning += a.tokens.reasoning;
		tokens.cacheRead += a.tokens.cacheRead;
		tokens.cacheWrite += a.tokens.cacheWrite;
		tokens.total += a.tokens.total;
		messages.user += a.messages.user;
		messages.assistant += a.messages.assistant;
		messages.total += a.messages.total;
		cost += a.cost;
		contextTokens += a.contextTokens;
	}
	// Single-advisor displays read the top-level model/window directly; surface the
	// first advisor's so the legacy status line stays byte-identical.
	return {
		configured,
		active: true,
		model: advisors[0].model,
		contextWindow: advisors[0].contextWindow,
		contextTokens,
		tokens,
		cost,
		messages,
		advisors,
	};
}

/** One advisor's slice: tokens, cost, context and message counts. */
function perAdvisorStat(advisor: AdvisorStatSource): PerAdvisorStat {
	const model = advisor.agent.state.model;
	const messages = advisor.agent.state.messages;
	const contextTokens = estimateAdvisorContextTokens(messages);
	let input = 0;
	let output = 0;
	let reasoning = 0;
	let cacheRead = 0;
	let cacheWrite = 0;
	let totalTokens = 0;
	let cost = 0;
	let user = 0;
	let assistant = 0;
	for (const message of messages) {
		if (message.role === "user") user++;
		if (message.role === "assistant") {
			assistant++;
			const assistantMsg = message as AssistantMessage;
			input += assistantMsg.usage.input;
			output += assistantMsg.usage.output;
			reasoning += assistantMsg.usage.reasoningTokens ?? 0;
			cacheRead += assistantMsg.usage.cacheRead;
			cacheWrite += assistantMsg.usage.cacheWrite;
			totalTokens += assistantMsg.usage.totalTokens;
			cost += assistantMsg.usage.cost.total;
		}
	}
	return {
		name: advisor.name,
		model,
		contextWindow: model.contextWindow ?? 0,
		contextTokens,
		tokens: { input, output, reasoning, cacheRead, cacheWrite, total: totalTokens },
		cost,
		messages: { user, assistant, total: messages.length },
	};
}

/**
 * An advisor's current context tokens. The latest non-aborted, non-error assistant message with
 * usage supplies the prompt size, plus an estimate for every message after it; without one, every
 * message is estimated.
 */
function estimateAdvisorContextTokens(messages: readonly AgentMessage[]): number {
	let lastUsageIndex: number | null = null;
	let lastUsage: AssistantMessage["usage"] | undefined;
	for (let i = messages.length - 1; i >= 0; i--) {
		const msg = messages[i];
		if (msg.role === "assistant") {
			const assistantMsg = msg as AssistantMessage;
			if (assistantMsg.stopReason !== "aborted" && assistantMsg.stopReason !== "error" && assistantMsg.usage) {
				lastUsage = assistantMsg.usage;
				lastUsageIndex = i;
				break;
			}
		}
	}
	if (!lastUsage || lastUsageIndex === null) {
		let estimated = 0;
		for (const message of messages) {
			estimated += estimateTokens(message);
		}
		return estimated;
	}
	let trailingTokens = 0;
	for (let i = lastUsageIndex + 1; i < messages.length; i++) {
		trailingTokens += estimateTokens(messages[i]);
	}
	return calculatePromptTokens(lastUsage) + trailingTokens;
}

/** The advisor status line for ACP and text output. */
export function formatAdvisorStatus(stats: AdvisorStats): string {
	if (!stats.active) {
		return stats.configured
			? "Advisor setting is enabled, but no model is assigned to the 'advisor' role."
			: "Advisor is disabled.";
	}
	if (stats.advisors.length <= 1) {
		const s = stats.advisors[0];
		const contextLine =
			s.contextWindow > 0
				? `Context: ${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} tokens (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
				: `Context: ${s.contextTokens.toLocaleString()} tokens`;
		const spendParts = [`${s.tokens.input.toLocaleString()} input`, `${s.tokens.output.toLocaleString()} output`];
		if (s.tokens.cacheRead > 0) spendParts.push(`${s.tokens.cacheRead.toLocaleString()} cache read`);
		if (s.tokens.cacheWrite > 0) spendParts.push(`${s.tokens.cacheWrite.toLocaleString()} cache write`);
		const spendLine = `Spend: ${spendParts.join(", ")}, $${s.cost.toFixed(4)}`;
		return `Advisor is enabled (${s.model.provider}/${s.model.id}). ${contextLine}. ${spendLine}.`;
	}
	const lines = [`Advisors enabled (${stats.advisors.length}):`];
	for (const s of stats.advisors) {
		const ctx =
			s.contextWindow > 0
				? `${s.contextTokens.toLocaleString()} / ${s.contextWindow.toLocaleString()} (${Math.round((s.contextTokens / s.contextWindow) * 100)}%)`
				: `${s.contextTokens.toLocaleString()}`;
		lines.push(`  • ${s.name} (${s.model.provider}/${s.model.id}) — context ${ctx} tokens, $${s.cost.toFixed(4)}`);
	}
	lines.push(
		`Totals: ${stats.tokens.input.toLocaleString()} input, ${stats.tokens.output.toLocaleString()} output, $${stats.cost.toFixed(4)}.`,
	);
	return lines.join("\n");
}
