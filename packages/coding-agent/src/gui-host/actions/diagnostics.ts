import * as os from "node:os";
import { mcpManagerInstance } from "../../mcp/manager-instance";
import { computeContextBreakdown } from "../../session/context-usage";
import { sessionEntryToTranscriptEntry, sessionHeaderToView } from "../session-bridge";
import { getOrCreateAgentSession } from "../turns";
import type { UsageTotals } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

/**
 * Real diagnostic snapshot shape returned by RefreshDiagnostics:
 * {
 *   sources: Array<{
 *     name: string;
 *     status: "ok" | "error" | "warning" | "disabled";
 *     message?: string;
 *     last_error?: string | null;
 *   }>;
 *   host: {
 *     platform: string;
 *     arch: string;
 *     node_version: string;
 *     uptime_seconds: number;
 *     memory: {
 *       rss_bytes: number;
 *       heap_total_bytes: number;
 *       heap_used_bytes: number;
 *       external_bytes: number;
 *     };
 *     os: {
 *       type: string;
 *       release: string;
 *       total_memory_bytes: number;
 *       free_memory_bytes: number;
 *     };
 *   };
 * }
 */
export interface DiagnosticSourceInfo {
	name: string;
	status: "ok" | "error" | "warning" | "disabled";
	message?: string;
	last_error?: string | null;
}

export interface DiagnosticsSnapshot {
	sources: DiagnosticSourceInfo[];
	host: {
		platform: string;
		arch: string;
		node_version: string;
		uptime_seconds: number;
		memory: NodeJS.MemoryUsage;
		os: {
			type: string;
			release: string;
			total_memory_bytes: number;
			free_memory_bytes: number;
		};
	};
}

export function collectDiagnostics(_session?: unknown): DiagnosticsSnapshot {
	const sources: DiagnosticSourceInfo[] = [];

	sources.push({
		name: "lsp",
		status: "ok",
	});

	try {
		const manager = mcpManagerInstance();
		if (manager) {
			const serverNames = manager.getAllServerNames();
			let hasError = false;
			let errorMessage = "";
			let lastErrorDetail = "";
			for (const name of serverNames) {
				const lastError = manager.getLastError(name);
				if (lastError) {
					hasError = true;
					errorMessage = `Server '${name}' error`;
					lastErrorDetail = lastError;
					break;
				}
			}
			if (hasError) {
				sources.push({
					name: "mcp",
					status: "error",
					message: errorMessage,
					last_error: lastErrorDetail,
				});
			} else {
				sources.push({
					name: "mcp",
					status: "ok",
				});
			}
		} else {
			sources.push({
				name: "mcp",
				status: "ok",
			});
		}
	} catch {
		sources.push({
			name: "mcp",
			status: "ok",
		});
	}

	sources.push({
		name: "process_supervisor",
		status: "ok",
	});

	return {
		sources,
		host: {
			platform: process.platform,
			arch: process.arch,
			node_version: process.version,
			uptime_seconds: Math.floor(process.uptime()),
			memory: process.memoryUsage(),
			os: {
				type: os.type(),
				release: os.release(),
				total_memory_bytes: os.totalmem(),
				free_memory_bytes: os.freemem(),
			},
		},
	};
}

const handleRefreshDiagnostics: ActionHandler = ctx => {
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Diagnostics: collectDiagnostics(ctx.clientState.agentSession),
	});
	ctx.reply.success();
};

interface RetryDiagnosticSourcePayload {
	source?: string;
}

const handleRetryDiagnosticSource: ActionHandler<RetryDiagnosticSourcePayload | undefined> = async (ctx, payload) => {
	if (!payload?.source) {
		ctx.reply.failure({
			scope: "Diagnostic",
			code: "INVALID_ARGUMENTS",
			message: "RetryDiagnosticSource requires a source parameter",
			retryable: false,
		});
		return;
	}

	if (payload.source === "mcp") {
		try {
			const manager = mcpManagerInstance();
			if (manager) {
				await manager.discoverAndConnect();
			}
		} catch {
			// Best-effort reconnect
		}
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Diagnostics: collectDiagnostics(ctx.clientState.agentSession),
		});
		ctx.reply.success();
		return;
	}

	ctx.reply.failure({
		scope: "Diagnostic",
		code: "DIAGNOSTIC_SOURCE_NOT_RETRYABLE",
		message: `Diagnostic source '${payload.source}' is not retryable`,
		retryable: false,
	});
};

interface ClearOutputPayload {
	session?: string;
}

const handleClearOutput: ActionHandler<ClearOutputPayload | undefined> = async (ctx, _payload) => {
	try {
		const agent = ctx.clientState.agentSession ?? (await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx));
		await agent.newSession();
		const sm = agent.sessionManager;

		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			ActiveSession: { revision: ctx.clientState.revision, value: sessionHeaderToView(sm.getHeader()) },
		});

		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Transcript: {
				revision: ctx.clientState.revision,
				value: sm.getEntries().map(e => sessionEntryToTranscriptEntry(e, ctx.clientState.revision)),
			},
		});

		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Session",
			code: "CLEAR_OUTPUT_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface GetUsagePayload {
	session?: string | null;
}

const handleGetUsage: ActionHandler<GetUsagePayload | undefined> = async (ctx, payload) => {
	const session = ctx.clientState.agentSession ?? (await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx));

	if (!session) {
		ctx.reply.failure({
			scope: "Usage",
			code: "NO_ACTIVE_SESSION",
			message: "No active session available",
			retryable: false,
		});
		return;
	}

	const stats = session.getSessionStats();
	const tokens = stats.tokens;
	const costMicroUsd = typeof stats.cost === "number" ? Math.round(stats.cost * 1_000_000) : null;

	const totals: UsageTotals = {
		input_tokens: tokens.input,
		output_tokens: tokens.output,
		cache_read_tokens: tokens.cacheRead,
		cache_write_tokens: tokens.cacheWrite,
		orchestration_tokens: 0,
		premium_requests: stats.premiumRequests ?? 0,
		cost_microusd: costMicroUsd,
	};

	ctx.clientState.revision += 1;
	ctx.reply.snapshot({
		Usage: {
			session: session.sessionId ?? payload?.session ?? "",
			totals,
		},
	});
	ctx.reply.success();
};

interface GetContextBreakdownPayload {
	session?: string;
}

const handleGetContextBreakdown: ActionHandler<GetContextBreakdownPayload | undefined> = async (ctx, payload) => {
	const session = ctx.clientState.agentSession ?? (await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx));

	if (!session) {
		ctx.reply.failure({
			scope: "Diagnostic",
			code: "NO_ACTIVE_SESSION",
			message: "No active session available",
			retryable: false,
		});
		return;
	}

	try {
		const breakdown = computeContextBreakdown(session);
		const categories = breakdown.categories.map(cat => ({
			name: cat.label,
			tokens: cat.tokens,
		}));
		const totalTokens = categories.reduce((sum, c) => sum + c.tokens, 0);

		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			ContextBreakdown: {
				session: session.sessionId ?? payload?.session ?? "",
				total_tokens: totalTokens,
				limit_tokens: breakdown.contextWindow > 0 ? breakdown.contextWindow : null,
				categories,
			},
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Diagnostic",
			code: "CONTEXT_BREAKDOWN_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

export const diagnosticsActionHandlers: ActionHandlersMap = {
	RefreshDiagnostics: handleRefreshDiagnostics as ActionHandler<never>,
	RetryDiagnosticSource: handleRetryDiagnosticSource as ActionHandler<never>,
	ClearOutput: handleClearOutput as ActionHandler<never>,
	GetUsage: handleGetUsage as ActionHandler<never>,
	GetContextBreakdown: handleGetContextBreakdown as ActionHandler<never>,
};
