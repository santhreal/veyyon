import { errorMessage, logger, sanitizeText } from "@veyyon/utils";
import type { DaemonBrokerClient } from "../launch/client";
import type { DaemonSnapshot } from "../launch/protocol";
import type { ToolSession } from ".";
import { formatDuration } from "./render-utils";

/**
 * A supervised process that ends on its own reports that end the way an async
 * bash job does, instead of waiting to be asked.
 *
 * `launch start` returns as soon as the process is spawned (or ready), and
 * nothing afterwards said the process had finished: the only way to learn it
 * was to call `wait`, which blocks a turn, or to poll `logs`. So "start it and
 * go do other work" — the reason to background anything — was exactly what
 * `launch` could not do, and a finite command handed to it (a test gate, a
 * build) trapped the caller in a poll loop it had no way to leave. The exit is
 * now a background job: it lands as a follow-up with the exit code and the tail
 * of the output.
 *
 * A stop or a restart the caller asked for is not news, so those cancel the
 * watch instead of delivering it.
 */

/** One `wait` request per window; the loop re-issues until the process exits. */
const EXIT_WAIT_WINDOW_MS = 5 * 60_000;
/** Tail carried in the completion notice, in lines and in bytes. */
const EXIT_TAIL_LINES = 60;
const EXIT_TAIL_BYTES = 8_000;

/** `${projectDir}\0${name}` → job id, so a stop can find the watch to cancel. */
const watches = new Map<string, string>();

/** Carries a completed exit notice out of the watch as a failed job. */
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
	if (daemon.exitReason) lines.push(`Reason: ${daemon.exitReason}`);
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

/**
 * Report the exit of `daemon` as a background job on the session that started
 * it. A process already in a terminal state is not watched (the start result
 * carried its outcome), and neither is a detached one, which outlives the
 * session that would receive the notice.
 */
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
	// A watch must never be the reason a start fails: the job cap, a disposed
	// manager and a broker that goes away all leave the process running and the
	// caller able to reach it by name.
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
						// A process that did not end cleanly is a failed job, the same as a
						// backgrounded command with a non-zero exit: the text is identical,
						// the status is what a reader scanning the job list sees.
						if (result.daemon.signal || (result.daemon.exitCode ?? 0) !== 0) throw new LaunchExitFailure(notice);
						return notice;
					}
					// Cancelled: the caller stopped or restarted it, or the session is
					// tearing down. A cancelled job delivers nothing.
					manager.cancel(jobId);
					return "";
				} catch (error) {
					// A process that ended badly IS the report; everything else here
					// (the broker forgot the process, went away, the request was
					// aborted) is news about the watch, not about the process.
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

/** Drop the watch on `name`: its end was asked for, so it is not reported. */
export function releaseLaunchExitWatch(session: ToolSession, projectDir: string, name: string): void {
	const key = watchKey(projectDir, name);
	const jobId = watches.get(key);
	if (jobId === undefined) return;
	watches.delete(key);
	session.asyncJobManager?.cancel(jobId);
}

/** Test seam: forget every watch this process is holding. */
export function resetLaunchExitWatchesForTests(): void {
	watches.clear();
}
