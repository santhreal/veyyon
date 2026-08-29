import { errorMessage, logger, sanitizeText } from "@veyyon/utils";
import type { DaemonBrokerClient } from "../launch/client";
import type { DaemonSnapshot } from "../launch/protocol";
import type { ToolSession } from ".";
import { EXIT_TAIL_BYTES, EXIT_TAIL_LINES, EXIT_WAIT_WINDOW_MS, watches } from "./launch-exit-watch-helpers";
import { formatDuration } from "./render-utils";

class LaunchExitFailure extends Error {}

function watchKey(projectDir: string, name: string): string {
	return `${projectDir}\0${name}`;
}

function exitPhrase(daemon: DaemonSnapshot): string {
	if (daemon.signal) return `was terminated by ${daemon.signal}`;
	if (daemon.exitCode === undefined) return "ended";
	return `exited ${daemon.exitCode}`;
}

function tail(text: string): string {
	const clean = sanitizeText(text).trimEnd();
	if (!clean) return "";
	const lines = clean.split("\n").slice(-EXIT_TAIL_LINES).join("\n");
	return lines.length > EXIT_TAIL_BYTES ? `…${lines.slice(-EXIT_TAIL_BYTES)}` : lines;
}

async function exitNotice(client: DaemonBrokerClient, daemon: DaemonSnapshot, signal: AbortSignal): Promise<string> {
	const ran = formatDuration((daemon.exitedAt ?? Date.now()) - daemon.startedAt);
	const lines = [`Launched process ${daemon.name} ${exitPhrase(daemon)} after ${ran}.`];
	if (daemon.terminatedBy) {
		lines.push(`Terminated by: ${daemon.terminatedBy}${daemon.exitReason ? ` — ${daemon.exitReason}` : ""}`);
	} else if (daemon.exitReason) {
		lines.push(`Reason: ${daemon.exitReason}`);
	}
	let output = "";
	try {
		const logs = await client.request(
			{ op: "logs", name: daemon.name, lines: EXIT_TAIL_LINES, head: false, follow: false, timeoutMs: 5_000 },
			signal,
		);
		if (logs.op === "logs") output = tail(logs.text);
	} catch (error) {
		logger.debug("Launch exit tail unavailable", { name: daemon.name, error: errorMessage(error) });
	}
	if (output) lines.push("", output);
	return lines.join("\n");
}

export function watchLaunchedProcessExit(options: {
	session: ToolSession;
	client: DaemonBrokerClient;
	daemon: DaemonSnapshot;
}): void {
	const { session, client, daemon } = options;
	const manager = session.asyncJobManager;
	if (!manager) return;
	if (daemon.detached) return;
	if (daemon.state === "exited" || daemon.state === "failed") return;
	const key = watchKey(client.projectDir, daemon.name);
	if (watches.has(key)) return;
	try {
		const jobId = manager.register(
			"launch",
			`${daemon.name} (launched process)`,
			async ({ jobId, signal }) => {
				try {
					while (!signal.aborted) {
						const result = await client.request(
							{ op: "wait", name: daemon.name, for: "exit", timeoutMs: EXIT_WAIT_WINDOW_MS },
							signal,
						);
						if (result.op !== "wait") break;
						if (result.timedOut) continue;
						const notice = await exitNotice(client, result.daemon, signal);
						if (result.daemon.signal || (result.daemon.exitCode ?? 0) !== 0) throw new LaunchExitFailure(notice);
						return notice;
					}
					manager.cancel(jobId);
					return "";
				} catch (error) {
					if (error instanceof LaunchExitFailure) throw error;
					logger.debug("Launch exit watch ended early", { name: daemon.name, error: errorMessage(error) });
					manager.cancel(jobId);
					return "";
				} finally {
					if (watches.get(key) === jobId) watches.delete(key);
				}
			},
			{ ownerId: session.getAgentId?.() ?? undefined },
		);
		watches.set(key, jobId);
	} catch (error) {
		logger.debug("Launch exit watch not registered", { name: daemon.name, error: errorMessage(error) });
	}
}

export function releaseLaunchExitWatch(session: ToolSession, projectDir: string, name: string): void {
	const key = watchKey(projectDir, name);
	const jobId = watches.get(key);
	if (jobId === undefined) return;
	watches.delete(key);
	session.asyncJobManager?.cancel(jobId);
}

export function resetLaunchExitWatchesForTests(): void {
	watches.clear();
}
