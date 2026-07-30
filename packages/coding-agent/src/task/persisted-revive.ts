import * as fs from "node:fs/promises";

import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { mcpManagerInstance } from "../mcp/manager-instance";
import type { PersistedSubagentReviverFactory } from "../registry/agent-lifecycle";
import { AgentRegistry, MAIN_AGENT_ID } from "../registry/agent-registry";
// Loaded on demand where the revive happens. See the note in `./executor`: a
// static import of `../sdk`, the composition root, is what put this module in a
// 54-module cycle.
import type { AgentSession } from "../session/agent-session";
import type { AuthStorage } from "../session/auth-storage";
import { SessionManager } from "../session/session-manager";
import { createMCPProxyTools, createSubagentSettingsForCwd } from "./executor";

/**
 * Ambient context the reviver needs at revive time. The parent artifact
 * manager is read live so a later `/new` is followed rather than snapshotted;
 * the revived session's cwd comes from its own persisted header. Auth, models,
 * and settings are process-stable and captured by reference.
 */
export interface PersistedSubagentReviveContext {
	session: AgentSession;
	authStorage: AuthStorage;
	modelRegistry: ModelRegistry;
	settings: Settings;
	/** LSP policy of the top-level session; revived subagents inherit it rather than defaulting on. */
	enableLsp: boolean;
}

/**
 * Build the factory the {@link AgentLifecycleManager} uses to cold-revive a
 * `parked` subagent ref restored from disk (the roster's persisted scan, collab mirror, or a
 * resumed process). Such a ref carries a sessionFile but no in-memory adoption —
 * the executor's live reviver closure died with the process/turn that spawned
 * it — so `ensureLive` (IRC sends, hub focus) would otherwise refuse it.
 *
 * This rebuilds the subagent the same way `--resume` rebuilds a session: reopen
 * the JSONL and replay it through {@link createAgentSession}. The catch is that
 * resume restores only conversation/model from the file — the runtime contract
 * (tools / system prompt / output schema / kind) is built from options, so a
 * bare reopen would resurrect a wrong (top-level) session. We source that
 * contract from the persisted `session_init` entry instead, and mirror the
 * executor's subagent wiring (MCP proxy tools, depth-derived gating,
 * yield-required, active-tool clamp, registry status sync).
 */
export function createPersistedSubagentReviverFactory(
	ctx: PersistedSubagentReviveContext,
): PersistedSubagentReviverFactory {
	const registry = AgentRegistry.global();
	return async ref => {
		const sessionFile = ref.sessionFile;
		if (!sessionFile) return undefined;
		const peek = await SessionManager.peekSessionInit(sessionFile);
		// No persisted contract (pre-session_init file) or the recorded workspace
		// is gone (isolated/merged worktree, moved dir): leave it transcript-only
		// (history://) rather than resurrect a wrong or broken session.
		if (!peek?.init) return undefined;
		try {
			await fs.stat(peek.cwd);
		} catch {
			// The recorded workspace is unreachable (deleted worktree, moved directory, unmounted share),
			// which is the second half of the condition documented above: reviving a session whose cwd is
			// gone would run its tools against the wrong tree, so it stays transcript-only via history://.
			return undefined;
		}
		// taskDepth drives real capability gating (task-spawn allowance, memory
		// startup, …); derive it from the persisted parent chain rather than
		// assuming a fixed level.
		let taskDepth = 1;
		let parentId = ref.parentId;
		const seen = new Set<string>();
		while (parentId && parentId !== MAIN_AGENT_ID && !seen.has(parentId)) {
			seen.add(parentId);
			taskDepth++;
			parentId = registry.get(parentId)?.parentId;
		}
		return async () => {
			// Re-peek and re-open on EVERY invocation. This closure is reusable,
			// and /move rewrites the persisted header after the factory first
			// discovered it; retaining the factory-time peek would resurrect the
			// old workspace and its project policy forever.
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
			// SessionManager.open owns cwd restoration and validation. Everything
			// in the rebuilt runtime, including settings discovery, must use this
			// one authority rather than either peek snapshot.
			const runtimeCwd = reopened.getCwd();
			const init = current.init;
			const artifactManager = ctx.session.sessionManager.getArtifactManager();
			if (artifactManager) reopened.adoptArtifactManager(artifactManager);
			// Reuse the parent's live MCP connections via proxy tools (no
			// re-discovery), exactly as the executor does for live subagents.
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
				// Older files did not persist the resolved per-agent cap. Revive
				// them as leaves rather than silently granting new spawn capacity.
				maxNestedSpawnDepth: init.maxNestedSpawnDepth ?? Math.max(0, taskDepth - 1),
				toolNames: init.tools,
				outputSchema: init.outputSchema,
				requireYieldTool: true,
				systemPrompt: () => [init.systemPrompt],
				// Old files predate persisted spawns: deny re-spawning rather than let
				// createAgentSession default to wildcard ("*").
				spawns: init.spawns ?? "",
				hasUI: false,
				enableLsp: ctx.enableLsp,
				enableMCP: !mcpManager,
				mcpManager,
				customTools: mcpProxyTools.length > 0 ? mcpProxyTools : undefined,
			});
			// Clamp the active set to the persisted list: createAgentSession's
			// `alwaysInclude` can re-add non-defaultInactive extension/custom tools
			// the original run didn't carry. Unknown/missing names are ignored.
			await session.setActiveToolsByName(init.tools);
			// Cold revives must drive registry status themselves — createAgentSession
			// doesn't wire this generically (the live path does it in the executor).
			// Without it the idle-TTL timer never clears on a turn and the lifecycle
			// could park the agent mid-run.
			session.subscribe(event => {
				if (event.type === "agent_start") registry.setStatus(ref.id, "running");
				else if (event.type === "agent_end") registry.setStatus(ref.id, "idle");
			});
			return session;
		};
	};
}
