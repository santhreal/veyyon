import * as fs from "node:fs/promises";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { mcpManagerInstance } from "../mcp/manager-instance";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { createMCPProxyTools, createSubagentSettingsForCwd } from "./executor";

export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	enableLsp: boolean;
}

export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
		if (!peek?.init) return undefined;
		try {
			await fs.stat(peek.cwd);
		} catch {
			return undefined;
		}
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && !seen.has(parentId)) {
			const parent = registry.get(parentId);
			if (parentId === MAIN_AGENT_ID || parent?.kind === "main") break;
			seen.add(parentId);
			taskDepth++;
			parentId = parent?.parentId;
		}
		return async () => {
			const current = await SessionManager.peekSessionInit(sessionFile);
			if (!current?.init) {
				throw new Error(`Cannot revive ${ref.id}: persisted session contract is missing`);
			}
			try {
				await fs.stat(current.cwd);
			} catch {
				throw new Error(`Cannot revive ${ref.id}: persisted working directory is unavailable`);
			}
			const reopened = await SessionManager.open(sessionFile, undefined, undefined, {
				initialCwd: current.cwd,
				suppressBreadcrumb: true,
			});
			const runtimeCwd = reopened.getCwd();
			const init = current.init;
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager) reopened.adoptArtifactManager(artifactManager);
			const mcpManager = mcpManagerInstance();
			const mcpProxyTools = mcpManager ? createMCPProxyTools(mcpManager) : [];
			const { createAgentSession } = await import("../sdk");
			const { session } = await createAgentSession({
				cwd: runtimeCwd,
				authStorage: ctx.authStorage,
				modelRegistry: ctx.modelRegistry,
				settings: await createSubagentSettingsForCwd(
					ctx.settings,
					runtimeCwd,
					init.readSummarize === false ? { "read.summarize.enabled": false } : undefined,
				),
				sessionManager: reopened,
				agentId: ref.id,
				agentDisplayName: ref.displayName,
				parentTaskPrefix: ref.id,
				parentAgentId: ref.parentId,
				taskDepth,
				maxNestedSpawnDepth: init.maxNestedSpawnDepth ?? Math.max(0, taskDepth - 1),
				toolNames: init.tools,
				outputSchema: init.outputSchema,
				requireYieldTool: true,
				systemPrompt: () => [init.systemPrompt],
				spawns: init.spawns ?? "",
				hasUI: false,
				enableLsp: ctx.enableLsp,
				enableMCP: !mcpManager,
				mcpManager,
				customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
			});
			await session.setActiveToolsByName(init.tools);
			session.subscribe(event => {
				if (event.type === "agent_start") registry.setStatus(ref.id, "running");
				else if (event.type === "agent_end") registry.setStatus(ref.id, "idle");
			});
			return session;
		};
	};
}
