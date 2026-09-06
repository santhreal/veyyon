import * as path from "node:path";
import { daemonClientForProject } from "../../launch/client";
import type { DaemonRestartPolicy, DaemonSignal, DaemonSpec } from "../../launch/protocol";
import { writeFrame } from "../frames";
import type { ProcessView } from "../wire";
import {
	emitProcessesSnapshot,
	ensureProcessFollowers,
	handleSupervisorError,
	requireProcessId,
	splitLogLines,
} from "./process-session";
import type { ActionHandler, ActionHandlersMap } from "./types";

export * from "./process-session";

const handleRefreshProcesses: ActionHandler = async ctx => {
	try {
		const client = await daemonClientForProject(ctx.cwd);
		await emitProcessesSnapshot(ctx, client);
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessLogsPayload {
	process_id?: string;
	follow?: boolean;
}

const handleProcessLogs: ActionHandler<ProcessLogsPayload | undefined> = async (ctx, payload) => {
	if (!requireProcessId(ctx, payload?.process_id)) {
		return;
	}

	const processId = payload!.process_id!;
	const followers = ensureProcessFollowers(ctx);
	const existingFollower = followers.get(processId);
	if (existingFollower) {
		existingFollower();
		followers.delete(processId);
	}

	try {
		const client = await daemonClientForProject(ctx.cwd);
		const result = await client.request({
			op: "logs",
			name: processId,
			lines: 100,
			head: false,
			follow: false,
			timeoutMs: 5000,
		});
		if (result.op !== "logs") {
			throw new Error(`Unexpected daemon response: ${result.op}`);
		}

		ctx.reply.snapshot({
			ProcessLogs: {
				process: processId,
				lines: splitLogLines(result.text),
				cursor: result.cursor,
				reset: true,
			},
		});
		ctx.reply.success();

		if (payload?.follow && result.state !== "exited" && result.state !== "failed") {
			const abortController = new AbortController();
			const abort = () => abortController.abort();
			followers.set(processId, abort);

			let cursor = result.cursor;
			void (async () => {
				while (!abortController.signal.aborted && !ctx.socket.destroyed) {
					try {
						const nextResult = await client.request(
							{
								op: "logs",
								name: processId,
								lines: 100,
								head: false,
								follow: true,
								cursor,
								timeoutMs: 15000,
							},
							abortController.signal,
						);
						if (abortController.signal.aborted || ctx.socket.destroyed || nextResult.op !== "logs") {
							break;
						}
						cursor = nextResult.cursor;
						if (nextResult.text && nextResult.text.length > 0) {
							writeFrame(ctx.socket, {
								Snapshot: {
									ProcessLogs: {
										process: processId,
										lines: splitLogLines(nextResult.text),
										cursor: nextResult.cursor,
										reset: false,
									},
								},
							});
						}
						if (nextResult.state === "exited" || nextResult.state === "failed") {
							break;
						}
					} catch {
						break;
					}
				}
				if (followers.get(processId) === abort) {
					followers.delete(processId);
				}
			})();
		}
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessSendPayload {
	process_id?: string;
	data?: number[];
}

const handleProcessSend: ActionHandler<ProcessSendPayload | undefined> = async (ctx, payload) => {
	if (!requireProcessId(ctx, payload?.process_id)) {
		return;
	}

	try {
		const data = payload?.data ? Buffer.from(payload.data).toString("utf8") : "";
		const client = await daemonClientForProject(ctx.cwd);
		await client.request({ op: "send", name: payload!.process_id!, data });
		await emitProcessesSnapshot(ctx, client);
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessSignalPayload {
	process_id?: string;
	signal?: string;
}

const handleProcessSignal: ActionHandler<ProcessSignalPayload | undefined> = async (ctx, payload) => {
	if (!requireProcessId(ctx, payload?.process_id)) {
		return;
	}
	if (!payload?.signal) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "INVALID_ARGUMENTS",
			message: "ProcessSignal requires a signal parameter",
			retryable: false,
		});
		return;
	}

	try {
		const client = await daemonClientForProject(ctx.cwd);
		await client.request({
			op: "send",
			name: payload.process_id!,
			signal: payload.signal as DaemonSignal,
		});
		await emitProcessesSnapshot(ctx, client);
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessStopPayload {
	process_id?: string;
}

const handleProcessStop: ActionHandler<ProcessStopPayload | undefined> = async (ctx, payload) => {
	if (!requireProcessId(ctx, payload?.process_id)) {
		return;
	}

	try {
		const client = await daemonClientForProject(ctx.cwd);
		await client.request({ op: "stop", name: payload!.process_id!, timeoutMs: 5000 });
		await emitProcessesSnapshot(ctx, client);
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessRestartPayload {
	process_id?: string;
}

const handleProcessRestart: ActionHandler<ProcessRestartPayload | undefined> = async (ctx, payload) => {
	if (!requireProcessId(ctx, payload?.process_id)) {
		return;
	}

	try {
		const client = await daemonClientForProject(ctx.cwd);
		await client.request({ op: "restart", name: payload!.process_id! });
		await emitProcessesSnapshot(ctx, client);
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessStartPayload {
	command?: string;
	application?: string;
	name?: string;
	args?: string[];
	cwd?: string;
	env?: Record<string, string>;
	ready?: {
		log?: string;
		port?: number;
		host?: string;
		timeout?: number;
	};
	restart?: DaemonRestartPolicy;
	persist?: boolean;
	detached?: boolean;
	pty?: boolean;
}

const handleProcessStart: ActionHandler<ProcessStartPayload | undefined> = async (ctx, payload) => {
	const app = payload?.application || payload?.command;
	if (!app) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "INVALID_ARGUMENTS",
			message: "ProcessStart requires a command or application parameter",
			retryable: false,
		});
		return;
	}

	try {
		const client = await daemonClientForProject(ctx.cwd);
		const name = payload?.name || path.basename(app);
		const targetCwd = payload?.cwd ? path.resolve(ctx.cwd, payload.cwd) : ctx.cwd;
		const detached = payload?.detached ?? false;
		const pty = detached ? false : (payload?.pty ?? true);
		let ready: DaemonSpec["ready"];
		if (payload?.ready) {
			ready = {
				log: payload.ready.log,
				port: payload.ready.port,
				host: payload.ready.host,
				timeoutMs: payload.ready.timeout ?? 30000,
			};
		}

		const spec: DaemonSpec = {
			name,
			application: app,
			args: payload?.args ?? [],
			env: payload?.env ?? {},
			cwd: targetCwd,
			pty,
			restart: payload?.restart ?? "no",
			persist: payload?.persist ?? false,
			detached,
			ready,
		};

		await client.request({
			op: "start",
			spec,
		});
		await emitProcessesSnapshot(ctx, client);
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessWaitPayload {
	process_id?: string;
}

const handleProcessWait: ActionHandler<ProcessWaitPayload | undefined> = async (ctx, payload) => {
	if (!requireProcessId(ctx, payload?.process_id)) {
		return;
	}

	try {
		const client = await daemonClientForProject(ctx.cwd);
		await client.request({ op: "wait", name: payload!.process_id!, for: "exit", timeoutMs: 30000 });
		await emitProcessesSnapshot(ctx, client);
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

interface ProcessDescribePayload {
	process_id?: string;
}

const handleProcessDescribe: ActionHandler<ProcessDescribePayload | undefined> = async (ctx, payload) => {
	if (!requireProcessId(ctx, payload?.process_id)) {
		return;
	}

	try {
		const client = await daemonClientForProject(ctx.cwd);
		const result = await client.request({ op: "describe", name: payload!.process_id! });
		if (result.op !== "describe") {
			throw new Error(`Unexpected daemon response: ${result.op}`);
		}
		const view: ProcessView = {
			name: result.daemon.name,
			pid: result.daemon.pid ?? null,
			status: result.daemon.state,
			application: result.spec.application,
			args: result.spec.args,
			cwd: result.spec.cwd,
			lifetime: result.daemon.detached ? "detached" : result.daemon.persist ? "broker-shutdown" : "last-client-exit",
			started_at_ms: result.daemon.startedAt,
			exit_code: result.daemon.exitCode ?? null,
			terminated_by: result.daemon.terminatedBy ?? null,
		};
		ctx.clientState.revision += 1;
		ctx.reply.snapshot({
			Processes: [view],
		});
		ctx.reply.success();
	} catch (error) {
		handleSupervisorError(ctx, error);
	}
};

export const processesActionHandlers: ActionHandlersMap = {
	RefreshProcesses: handleRefreshProcesses as ActionHandler<never>,
	ProcessLogs: handleProcessLogs as ActionHandler<never>,
	ProcessSend: handleProcessSend as ActionHandler<never>,
	ProcessSignal: handleProcessSignal as ActionHandler<never>,
	ProcessStop: handleProcessStop as ActionHandler<never>,
	ProcessRestart: handleProcessRestart as ActionHandler<never>,
	ProcessStart: handleProcessStart as ActionHandler<never>,
	ProcessWait: handleProcessWait as ActionHandler<never>,
	ProcessDescribe: handleProcessDescribe as ActionHandler<never>,
};
