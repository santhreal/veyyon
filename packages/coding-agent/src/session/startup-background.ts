/**
 * Work a session starts in the background once it exists, so its first frame and first request do
 * not wait on it: the Codex websocket prewarm, the language server warmup and the memory backend's
 * hydration.
 */

import type { Model, ProviderSessionState } from "@veyyon/ai";
import { getOpenAICodexTransportDetails } from "@veyyon/ai/providers/openai-codex/session-state";
import { loadOpenAICodexResponses } from "@veyyon/ai/providers/register-builtins";
import { errorMessage, logger } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import type { LspStartupServerInfo, LspWarmupResult } from "../lsp";
import { LSP_STARTUP_EVENT_CHANNEL, type LspStartupEvent } from "../lsp/startup-events";
import { resolveMemoryBackend } from "../memory/backend";
import type { EventBus } from "../utils/event-bus";
import type { AgentSession } from "./agent-session";
import type { CreateAgentSessionOptions } from "./factory-options";

/** What {@link prewarmCodexTransport} reads. */
export interface CodexPrewarmInput {
	model: Model | undefined;
	modelRegistry: ModelRegistry;
	sessionId: string;
	preferWebsockets: boolean | undefined;
	providerSessionState: Map<string, ProviderSessionState>;
}

/**
 * Open the Codex websocket in the background when the session's model is served over one, so the
 * first request does not pay the handshake. Does nothing for any other model, or without a key; a
 * failed prewarm is logged at debug level and the first request connects on its own. The Codex client
 * loads inside the background task, so a session on any other model never evaluates it.
 */
export function prewarmCodexTransport(input: CodexPrewarmInput): void {
	if (input.model?.api !== "openai-codex-responses") return;
	// `.api` equality does not narrow the generic; the guard makes this cast sound.
	const model = input.model as Model<"openai-codex-responses">;
	const transport = getOpenAICodexTransportDetails(model, {
		sessionId: input.sessionId,
		baseUrl: model.baseUrl,
		preferWebsockets: input.preferWebsockets,
		providerSessionState: input.providerSessionState,
	});
	if (!transport.websocketPreferred) return;
	void (async () => {
		try {
			const apiKey = await input.modelRegistry.getApiKey(model, input.sessionId);
			if (!apiKey) return;
			const { prewarmOpenAICodexResponses } = await loadOpenAICodexResponses();
			await logger.time("prewarmOpenAICodexResponses", prewarmOpenAICodexResponses, model, {
				apiKey,
				sessionId: input.sessionId,
				preferWebsockets: input.preferWebsockets,
				providerSessionState: input.providerSessionState,
			});
		} catch (error) {
			logger.debug("Codex websocket prewarm failed", {
				error: errorMessage(error),
				provider: model.provider,
				model: model.id,
			});
		}
	})();
}

/** The two startup entry points of the `lsp` module, which the caller imports lazily. */
export interface LspStartup {
	discoverStartupLspServers: (cwd: string, status?: LspStartupServerInfo["status"]) => LspStartupServerInfo[];
	warmupLspServers: (cwd: string) => Promise<LspWarmupResult>;
}

/** What {@link startLspServers} reads. */
export interface LspStartupInput {
	cwd: string;
	settings: Settings;
	eventBus: EventBus;
}

/**
 * The language servers a session lists at startup.
 *
 * With `lsp.lazy` each recognized server is listed as "available" and starts on first use: the lsp
 * tool, or an edit or write touching a matching file type. Otherwise every server starts warming up
 * in the background; each returned entry is updated in place when the warmup settles, and the
 * outcome is emitted on the event bus unless `startup.quiet` is set.
 */
export function startLspServers(lsp: LspStartup, input: LspStartupInput): LspStartupServerInfo[] {
	if (input.settings.get("lsp.lazy")) return lsp.discoverStartupLspServers(input.cwd, "available");
	const servers = lsp.discoverStartupLspServers(input.cwd);
	if (servers.length > 0) void warmUpLspServers(lsp, servers, input);
	return servers;
}

async function warmUpLspServers(
	lsp: LspStartup,
	servers: LspStartupServerInfo[],
	input: LspStartupInput,
): Promise<void> {
	const quiet = input.settings.get("startup.quiet");
	let event: LspStartupEvent;
	try {
		const result = await logger.time("warmupLspServers", lsp.warmupLspServers, input.cwd);
		const serversByName = new Map(result.servers.map(server => [server.name, server] as const));
		for (const server of servers) {
			const next = serversByName.get(server.name);
			if (!next) continue;
			server.status = next.status;
			server.fileTypes = next.fileTypes;
			server.error = next.error;
		}
		event = { type: "completed", servers: result.servers };
	} catch (error) {
		const errorText = errorMessage(error);
		logger.warn("LSP server warmup failed", { cwd: input.cwd, error: errorText });
		for (const server of servers) {
			server.status = "error";
			server.error = errorText;
		}
		event = { type: "failed", error: errorText };
	}
	if (!quiet) input.eventBus.emit(LSP_STARTUP_EVENT_CHANNEL, event);
}

/** What {@link deferMemoryStartup} reads. */
export interface MemoryStartupInput {
	session: AgentSession;
	settings: Settings;
	modelRegistry: ModelRegistry;
	agentDir: string;
	taskDepth: number;
	options: Pick<CreateAgentSessionOptions, "parentHindsightSessionState" | "parentMnemopiSessionState">;
}

/**
 * Start the memory backend as work the session's first turn awaits. The start is hydration, not boot:
 * it opens a database and installs this session's state, and no frame reads either. Every tool call and
 * spawn is inside a turn, while the first frame paints without it. A failed start is logged and the
 * session runs on.
 */
export function deferMemoryStartup(input: MemoryStartupInput): void {
	input.session.deferStartupWork(
		logger
			.time("startMemoryStartupTask", () => startMemoryBackend(input))
			.catch(error => {
				logger.warn("memory backend startup failed", { error: errorMessage(error) });
			}),
	);
}

async function startMemoryBackend(input: MemoryStartupInput): Promise<void> {
	const memoryBackend = await resolveMemoryBackend(input.settings);
	await memoryBackend.start({
		session: input.session,
		settings: input.settings,
		modelRegistry: input.modelRegistry,
		agentDir: input.agentDir,
		taskDepth: input.taskDepth,
		parentHindsightSessionState: input.options.parentHindsightSessionState,
		parentMnemopiSessionState: input.options.parentMnemopiSessionState,
	});
}
