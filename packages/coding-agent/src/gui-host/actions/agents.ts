import type * as net from "node:net";
import { errorMessage } from "@veyyon/utils";
import { AgentLifecycleManager } from "../../registry/agent-lifecycle";
import { AgentRegistry } from "../../registry/agent-registry";
import { agentDisplayState, collectLiveAgents } from "../../registry/live-roster";
import { TaskTool } from "../../task";
import { IrcBus } from "../../task/irc-bus";
import { writeFrame } from "../frames";
import { STREAM_FRAME_INTERVAL_MS } from "../streaming-frames";
import { type ClientSessionState, getOrCreateAgentSession } from "../turns";
import type { AgentMessageView, AgentView } from "../wire";
import type { ActionHandler, ActionHandlersMap } from "./types";

export function clientSessionScope(state: ClientSessionState): string | undefined {
	return (state.sessionManager ?? state.agentSession?.sessionManager)?.getSessionId();
}

export function agentsSection(scope?: string): AgentView[] {
	const registry = AgentRegistry.global();
	const refs = scope !== undefined ? registry.listInScope(scope) : registry.list();
	const byId = new Map(refs.map(ref => [ref.id, ref]));
	// The roster rows carry the call sign, the spawn order a reader scans in and
	// the model the agent is running right now, which the ref records once at
	// registration and never again. The terminal dashboard draws the same rows,
	// so an agent is called the same thing in both hosts.
	//
	// The status is the state a surface NAMES, not the bare `AgentStatus`: an
	// agent stopped at an approval prompt is `running` and reads as one grinding
	// through a build, and one that stopped to let a peer answer is `parked` and
	// reads as one that simply finished.
	return collectLiveAgents(refs).map(agent => {
		const ref = byId.get(agent.id);
		return {
			id: agent.id,
			call_sign: agent.callSign,
			display_name: agent.displayName,
			kind: agent.kind,
			status: agentDisplayState(agent),
			parent: agent.parentId ?? null,
			scope: ref?.scope ?? scope ?? "",
			session: ref?.session ? (ref.session.sessionManager?.getSessionId?.() ?? null) : agent.sessionFile,
			activity: agent.activity ?? null,
			model: agent.model ?? null,
		};
	});
}

export function agentCommsSection(scope?: string): AgentMessageView[] {
	const bus = IrcBus.global();
	const entries = bus.log().filter(entry => AgentRegistry.sameScope(entry.scope, scope));
	return entries.map(entry => ({
		id: entry.message.id,
		from: entry.message.from,
		to: entry.message.to,
		body: entry.message.body,
		at_ms: entry.message.ts,
		reply_to: entry.message.replyTo ?? null,
		outcome: entry.outcome,
		error: entry.error ?? null,
	}));
}

export function subscribeClientAgents(socket: net.Socket, state: ClientSessionState): void {
	if (state.closed || socket.destroyed) return;
	if (state.unsubscribeAgents) return;

	const registry = AgentRegistry.global();
	const bus = IrcBus.global();

	// Both sections ride one timer. A burst of registry events, or one line
	// broadcast to every peer, writes at most one frame per section per
	// interval instead of one per event, and a section the burst did not touch
	// stays out of the frame.
	let agentsDirty = false;
	let commsDirty = false;

	const flush = () => {
		if (state.closed || socket.destroyed) return;
		state.lastAgentsFrameMs = Date.now();
		const currentScope = clientSessionScope(state);
		if (agentsDirty) {
			agentsDirty = false;
			writeFrame(socket, { Snapshot: { Agents: agentsSection(currentScope) } });
		}
		if (commsDirty) {
			commsDirty = false;
			writeFrame(socket, { Snapshot: { AgentComms: agentCommsSection(currentScope) } });
		}
	};

	const schedule = () => {
		if (state.closed || socket.destroyed) return;
		if (state.agentsFrameTimer) return;
		const since = Date.now() - (state.lastAgentsFrameMs ?? Number.NEGATIVE_INFINITY);
		if (since >= STREAM_FRAME_INTERVAL_MS) {
			flush();
			return;
		}
		const timer = setTimeout(() => {
			state.agentsFrameTimer = undefined;
			flush();
		}, STREAM_FRAME_INTERVAL_MS - since);
		timer.unref?.();
		state.agentsFrameTimer = timer;
	};

	const unreg = registry.onChange(event => {
		if (!AgentRegistry.sameScope(event.ref.scope, clientSessionScope(state))) return;
		agentsDirty = true;
		schedule();
	});

	const unbus = bus.onMessage(entry => {
		if (!AgentRegistry.sameScope(entry.scope, clientSessionScope(state))) return;
		commsDirty = true;
		schedule();
	});

	state.unsubscribeAgents = () => {
		if (state.agentsFrameTimer) {
			clearTimeout(state.agentsFrameTimer);
			state.agentsFrameTimer = undefined;
		}
		unreg();
	};
	state.unsubscribeAgentComms = unbus;
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
			Agents: agentsSection(clientSessionScope(ctx.clientState)),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Agent",
			code: "AGENT_REVIVE_FAILED",
			message: errorMessage(error),
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

	subscribeClientAgents(ctx.socket, ctx.clientState);
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
			Agents: agentsSection(clientSessionScope(ctx.clientState)),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Task",
			code: "TASK_SPAWN_FAILED",
			message: errorMessage(error),
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
			Agents: agentsSection(clientSessionScope(ctx.clientState)),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Task",
			code: "TASK_CANCEL_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

const handleRefreshAgents: ActionHandler = async ctx => {
	try {
		const scope = clientSessionScope(ctx.clientState);
		ctx.reply.snapshot({
			Agents: agentsSection(scope),
		});
		ctx.reply.snapshot({
			AgentComms: agentCommsSection(scope),
		});
		ctx.reply.success();
	} catch (error) {
		ctx.reply.failure({
			scope: "Agent",
			code: "AGENTS_REFRESH_FAILED",
			message: errorMessage(error),
			retryable: false,
		});
	}
};

export const agentsActionHandlers: ActionHandlersMap = {
	ReviveAgent: handleReviveAgent as ActionHandler<never>,
	SpawnTask: handleSpawnTask as ActionHandler<never>,
	CancelTask: handleCancelTask as ActionHandler<never>,
	RefreshAgents: handleRefreshAgents as ActionHandler<never>,
};
