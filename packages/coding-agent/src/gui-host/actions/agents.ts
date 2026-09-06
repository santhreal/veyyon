import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import { TaskTool } from "../../task";
import { writeFrame } from "../frames";
import { getOrCreateAgentSession } from "../turns";
import type { AgentView } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

export function agentsSection(cwd?: string): AgentView[] {
	const registry = AgentRegistry.global();
	const refs = cwd ? registry.listInScope(cwd) : registry.list();
	return refs.map(ref => ({
		id: ref.id,
		display_name: ref.displayName,
		kind: ref.kind,
		status: ref.status,
		parent: ref.parentId ?? null,
		scope: ref.scope ?? cwd ?? "",
		session: ref.session ? ref.session.sessionManager.getSessionId() : (ref.sessionFile ?? null),
	}));
}

interface ReviveAgentPayload {
	agent_id?: string;
}

const handleReviveAgent: ActionHandler<ReviveAgentPayload | undefined> = async (ctx, payload) => {
	if (!payload?.agent_id) {
		ctx.reply.failure({
			scope: "Agent",
			code: "INVALID_ARGUMENTS",
			message: "ReviveAgent requires an agent_id parameter",
			retryable: false,
		});
		return;
	}

	const registry = AgentRegistry.global();
	const ref = registry.get(payload.agent_id);
	if (!ref) {
		ctx.reply.failure({
			scope: "Agent",
			code: "AGENT_NOT_FOUND",
			message: `Agent '${payload.agent_id}' was not found in registry`,
			retryable: false,
		});
		return;
	}

	try {
		await AgentLifecycleManager.global().ensureLive(payload.agent_id);
		ctx.reply.snapshot({
			Agents: agentsSection(ctx.cwd),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Agent",
			code: "AGENT_REVIVE_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface SpawnTaskPayload {
	task?: string;
	agent?: string;
	name?: string;
}

const handleSpawnTask: ActionHandler<SpawnTaskPayload | undefined> = async (ctx, payload) => {
	if (!payload?.task?.trim()) {
		ctx.reply.failure({
			scope: "Task",
			code: "INVALID_ARGUMENTS",
			message: "SpawnTask requires a task parameter",
			retryable: false,
		});
		return;
	}

	if (!ctx.clientState.unsubscribeAgents) {
		ctx.clientState.unsubscribeAgents = AgentRegistry.global().onChange(() => {
			writeFrame(ctx.socket, {
				Snapshot: {
					Agents: agentsSection(ctx.cwd),
				},
			});
		});
	}
	try {
		const parentSession = await getOrCreateAgentSession(ctx.clientState, ctx.socket, ctx);

		const taskTool = await TaskTool.create({
			cwd: ctx.cwd,
			hasUI: false,
			getSessionFile: () => parentSession.sessionManager.getSessionFile() ?? null,
			getSessionSpawns: () => null,
			getSessionId: () => parentSession.sessionManager.getSessionId?.() ?? null,
			settings: parentSession.settings,
			authStorage: parentSession.modelRegistry.authStorage,
			modelRegistry: parentSession.modelRegistry,
			asyncJobManager: parentSession.asyncJobManager,
		});
		const toolCallId = `task-${Bun.randomUUIDv7()}`;
		const result = await taskTool.execute(toolCallId, {
			task: payload.task,
			agent: payload.agent,
			name: payload.name,
		});
		const errorText = result.content.find(part => part.type === "text")?.text ?? "";
		if (
			result.isError ||
			(result.details?.results.length === 0 &&
				(errorText.includes("Cannot spawn") ||
					errorText.includes("Unknown agent") ||
					errorText.includes("disabled") ||
					errorText.includes("failed") ||
					errorText.includes("matches no available model")))
		) {
			ctx.reply.failure({
				scope: "Task",
				code: "TASK_SPAWN_FAILED",
				message: errorText || "Task spawn failed",
				retryable: false,
			});
			return;
		}

		ctx.reply.snapshot({
			Agents: agentsSection(ctx.cwd),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Task",
			code: "TASK_SPAWN_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

interface CancelTaskPayload {
	task_id?: string;
}

const handleCancelTask: ActionHandler<CancelTaskPayload | undefined> = async (ctx, payload) => {
	if (!payload?.task_id) {
		ctx.reply.failure({
			scope: "Task",
			code: "INVALID_ARGUMENTS",
			message: "CancelTask requires a task_id parameter",
			retryable: false,
		});
		return;
	}

	const registry = AgentRegistry.global();
	const ref = registry.get(payload.task_id);
	if (!ref) {
		ctx.reply.failure({
			scope: "Task",
			code: "TASK_NOT_FOUND",
			message: `Task '${payload.task_id}' was not found`,
			retryable: false,
		});
		return;
	}

	try {
		await AgentLifecycleManager.global().terminate(payload.task_id, "Cancelled by user");
		if (ctx.clientState.agentSession?.asyncJobManager) {
			ctx.clientState.agentSession.asyncJobManager.cancel(payload.task_id);
		}
		ctx.reply.snapshot({
			Agents: agentsSection(ctx.cwd),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Task",
			code: "TASK_CANCEL_FAILED",
			message: error instanceof Error ? error.message : String(error),
			retryable: false,
		});
	}
};

export const agentsActionHandlers: ActionHandlersMap = {
	ReviveAgent: handleReviveAgent as ActionHandler<never>,
	SpawnTask: handleSpawnTask as ActionHandler<never>,
	CancelTask: handleCancelTask as ActionHandler<never>,
};
