import type { DaemonBrokerClient } from "../../launch/client";
import type { ProcessView } from "../wire";
import type { ActionContext } from "./types";

export function ensureProcessFollowers(ctx: ActionContext): Map<string, () => void> {
	if (!ctx.clientState.processFollowers) {
		ctx.clientState.processFollowers = new Map<string, () => void>();
		ctx.socket.once("close", () => {
			if (ctx.clientState.processFollowers) {
				for (const abort of ctx.clientState.processFollowers.values()) {
					abort();
				}
				ctx.clientState.processFollowers.clear();
			}
		});
	}
	return ctx.clientState.processFollowers;
}

export function handleSupervisorError(ctx: ActionContext, error: unknown): void {
	ctx.reply.failure({
		scope: "Terminal",
		code: "PROCESS_SUPERVISOR_UNAVAILABLE",
		message: error instanceof Error ? error.message : String(error),
		retryable: true,
	});
}

export function requireProcessId(ctx: ActionContext, processId?: string): boolean {
	if (!processId) {
		ctx.reply.failure({
			scope: "Terminal",
			code: "INVALID_ARGUMENTS",
			message: `${ctx.actionTag} requires a process_id parameter`,
			retryable: false,
		});
		return false;
	}
	return true;
}

export async function mapProcessesView(ctx: ActionContext, client: DaemonBrokerClient): Promise<ProcessView[]> {
	const listResult = await client.request({ op: "list" });
	if (listResult.op !== "list") {
		throw new Error(`Unexpected daemon response: ${listResult.op}`);
	}
	const processes: ProcessView[] = [];

	for (const daemon of listResult.daemons) {
		let application = "";
		let args: string[] = [];
		let cwd = ctx.cwd;
		try {
			const desc = await client.request({ op: "describe", name: daemon.name });
			if (desc.op === "describe") {
				application = desc.spec.application;
				args = desc.spec.args;
				cwd = desc.spec.cwd;
			}
		} catch {
			// Describe may fail if the daemon completed during iteration
		}
		processes.push({
			name: daemon.name,
			pid: daemon.pid ?? null,
			status: daemon.state,
			application,
			args,
			cwd,
			lifetime: daemon.detached ? "detached" : daemon.persist ? "broker-shutdown" : "last-client-exit",
			started_at_ms: daemon.startedAt,
			exit_code: daemon.exitCode ?? null,
			terminated_by: daemon.terminatedBy ?? null,
		});
	}

	for (const completion of listResult.completions) {
		processes.push({
			name: completion.name,
			pid: null,
			status: "exited",
			application: "",
			args: [],
			cwd: ctx.cwd,
			lifetime: "last-client-exit",
			started_at_ms: completion.startedAt,
			exit_code: completion.exitCode ?? null,
			terminated_by: completion.terminatedBy ?? null,
		});
	}

	return processes;
}

export async function emitProcessesSnapshot(ctx: ActionContext, client: DaemonBrokerClient): Promise<void> {
	const processes = await mapProcessesView(ctx, client);
	ctx.clientState.revision += 1;
	ctx.reply.snapshot({ Processes: processes });
}

export function splitLogLines(text: string): string[] {
	if (text.length === 0) {
		return [];
	}
	return text.replace(/\r?\n$/, "").split(/\r?\n/);
}
