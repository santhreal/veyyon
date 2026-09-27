/**
 * The background-job manager a top-level session owns, and how a finished job's output reaches the
 * conversation as a follow-up.
 */

import * as fs from "node:fs/promises";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import { errorMessage, logger } from "@veyyon/utils";
import { type AsyncJob, AsyncJobManager } from "../async";
import type { Settings } from "../config/settings";
import { type CreateAgentSessionOptions, isInProcessChildSession } from "./factory-options";

/** A follow-up at most this long carries the whole result. */
const INLINE_RESULT_MAX_CHARS = 12_000;
/** A longer one carries this much, and the rest as an artifact. */
const PREVIEW_MAX_CHARS = 4_000;

/**
 * `result` as a follow-up message carries it: whole when it fits inline, else a preview and an
 * `artifact://` holding the full output. The preview alone when no artifact can be written.
 */
export async function formatAsyncFollowUp(
	result: string,
	sessionManager: Pick<SessionManager, "allocateArtifactPath">,
): Promise<string> {
	if (result.length <= INLINE_RESULT_MAX_CHARS) return result;
	const preview = `${result.slice(0, PREVIEW_MAX_CHARS)}\n\n[Output truncated. Showing first ${PREVIEW_MAX_CHARS.toLocaleString()} characters.]`;
	try {
		const { path: artifactPath, id: artifactId } = await sessionManager.allocateArtifactPath("async");
		if (artifactPath && artifactId) {
			await fs.writeFile(artifactPath, result);
			return `${preview}\nFull output: artifact://${artifactId}`;
		}
	} catch (error) {
		logger.warn("Failed to persist async follow-up artifact", { error: errorMessage(error) });
	}
	return preview;
}

/** The session a finished job's follow-up is delivered to, absent until it is constructed. */
export interface AsyncFollowUpTarget {
	deliverAsyncJobResult(jobId: string, text: string, job?: AsyncJob): unknown;
}

/** What {@link createOwnedAsyncJobManager} reads. */
export interface OwnedAsyncJobsInput {
	options: Pick<CreateAgentSessionOptions, "parentTaskPrefix">;
	settings: Settings;
	sessionManager: Pick<SessionManager, "allocateArtifactPath">;
	target: () => AsyncFollowUpTarget | undefined;
}

/**
 * A new AsyncJobManager when this session owns one, else undefined.
 *
 * Only the first top-level session in a process owns one. A spawned agent shares its parent's
 * through `AsyncJobManager.instance()`, and a second top-level session started in-process (the
 * agent-creation architect) shares the live singleton: its own manager would be disposed with it
 * and take the owning session's `task` and `bash` async paths down (issue #1923), or sit orphaned
 * with nothing routed to it. A job that finishes before the session exists, or whose delivery was
 * suppressed while its output was formatted, is not delivered.
 */
export function createOwnedAsyncJobManager(input: OwnedAsyncJobsInput): AsyncJobManager | undefined {
	if (isInProcessChildSession(input.options) || AsyncJobManager.instance()) return undefined;
	const manager: AsyncJobManager = new AsyncJobManager({
		maxRunningJobs: Math.min(100, Math.max(1, input.settings.get("async.maxJobs") ?? 100)),
		onJobComplete: async (jobId, result, job) => {
			const target = input.target();
			if (!target || manager.isDeliverySuppressed(jobId)) return;
			const followUp = await formatAsyncFollowUp(result, input.sessionManager);
			if (manager.isDeliverySuppressed(jobId)) return;
			target.deliverAsyncJobResult(jobId, followUp, job);
		},
	});
	return manager;
}
