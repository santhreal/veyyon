import * as path from "node:path";
import type { AgentMessage } from "@veyyon/agent-core";
import type { Message, UserMessage } from "@veyyon/ai";
import { logger } from "@veyyon/utils";
import {
	ADVISOR_TRANSCRIPT_FILENAME,
	ADVISOR_TRANSCRIPT_STEM,
	isSessionFileName,
	sessionFileName,
	sessionFileStem,
} from "@veyyon/utils/session-file";
import { SessionManager } from "../session/session-manager";

/**
 * The advisor transcript naming contract, owned by `@veyyon/utils/session-file` and re-exported here.
 *
 * It lives there because `@veyyon/stats` classifies a transcript as the advisor's by matching this name and
 * cannot import the coding agent, so it had declared the same filename itself. The stem is chosen so it
 * cannot collide with a task subagent's `<id>.jsonl` (task ids are reserved against this exact stem in
 * {@link AgentOutputManager}).
 */
export {
	ADVISOR_TRANSCRIPT_FILENAME,
	ADVISOR_TRANSCRIPT_STEM,
	isAdvisorTranscriptName,
} from "@veyyon/utils/session-file";

/**
 * Transcript filename for an advisor: `__advisor.jsonl` for the legacy/default
 * advisor (empty slug), `__advisor.<slug>.jsonl` for a named advisor. The `.`
 * separator keeps named files out of the output manager's `-<n>` bump namespace.
 */
export function advisorTranscriptFilename(slug: string): string {
	return slug ? sessionFileName(`${ADVISOR_TRANSCRIPT_STEM}.${slug}`) : ADVISOR_TRANSCRIPT_FILENAME;
}

/**
 * Append-only persister for an advisor agent's transcript.
 *
 * The advisor is a passive reviewer with its own model usage, so — like a task
 * subagent — its turns are written to a JSONL inside the owning session's
 * artifacts dir (`<session>/__advisor.jsonl`, `<session>/<SubId>/__advisor.jsonl`
 * for subagent advisors). That single file gives the advisor model proper usage
 * attribution in `veyyon stats` (the stats parser scans the session dir
 * recursively) and a read-only transcript in the Control Center, without making the
 * advisor a registered, messageable peer.
 *
 * The target is derived from the *session file* (`getSessionFile()`), never
 * `getArtifactsDir()` — subagents adopt the parent's artifact manager, so the
 * artifacts dir points at the parent root and every subagent advisor would
 * collide. The file path is resolved synchronously when a message finalizes and
 * captured for the queued write, so a `/new`, resume, or session switch in
 * flight can never misattribute an old advisor turn into the new session's file.
 * On such a switch the previous writer is closed and the new file opened on the
 * next recorded turn. The recorder never truncates: the advisor's in-memory
 * context resets/compacts independently, but every billed turn is appended here.
 */
export class AdvisorTranscriptRecorder {
	#manager: SessionManager | undefined;
	#file: string | undefined;
	#filename: string;
	/** Serializes the async open/close against synchronous appends so records land in order. */
	#queue: Promise<void>;

	/**
	 * @param filename Transcript filename within the session dir. Defaults to
	 *   `__advisor.jsonl`; named advisors pass `__advisor.<slug>.jsonl` via
	 *   {@link advisorTranscriptFilename}.
	 * @param after Optional barrier the queue starts behind — used on the advisor
	 *   on→off→on toggle so a fresh recorder's first `open` waits for the prior
	 *   recorder's `close` and the two never hold the same file at once.
	 */
	constructor(
		private readonly resolveSessionFile: () => string | undefined,
		private readonly resolveCwd: () => string,
		filename: string = ADVISOR_TRANSCRIPT_FILENAME,
		after?: Promise<unknown>,
	) {
		this.#filename = filename;
		this.#queue = after
			? after.then(
					() => {},
					() => {},
				)
			: Promise.resolve();
	}

	/**
	 * Persist one finalized advisor message. Assistant turns carry the usage the
	 * stats parser reads; tool results round out the Hub transcript; user deltas
	 * (the advisor's "session update" prompts) are persisted but flagged
	 * `synthetic`/agent-attributed so they never inflate user-message metrics.
	 * Non-conversational message kinds are skipped.
	 */
	record(message: AgentMessage): void {
		let persisted: Message;
		switch (message.role) {
			case "assistant":
			case "toolResult":
				persisted = message;
				break;
			case "user":
				// Clone so the live advisor message stays untouched; mark synthetic so
				// stats' user-message metrics skip these agent-internal review prompts.
				persisted = { ...(message as UserMessage), synthetic: true, attribution: "agent" };
				break;
			default:
				return;
		}
		const sessionFile = this.resolveSessionFile();
		if (!sessionFile || !isSessionFileName(sessionFile)) return;
		const file = path.join(sessionFileStem(sessionFile), this.#filename);
		const cwd = this.resolveCwd();
		this.#enqueue(async () => {
			if (file !== this.#file) {
				await this.#closeManager();
				this.#manager = await SessionManager.open(file, undefined, undefined, {
					initialCwd: cwd,
					suppressBreadcrumb: true,
				});
				this.#file = file;
			}
			this.#manager?.appendMessage(persisted);
		});
	}

	/** Flush pending writes (best-effort). */
	flush(): Promise<void> {
		return this.#enqueueResult(async () => {
			if (this.#manager) await this.#manager.flush();
		});
	}

	/** Flush and close the writer, releasing the session file. */
	close(): Promise<void> {
		return this.#enqueueResult(() => this.#closeManager());
	}

	async #closeManager(): Promise<void> {
		const manager = this.#manager;
		this.#manager = undefined;
		this.#file = undefined;
		if (!manager) return;
		try {
			await manager.close();
		} catch (err) {
			logger.debug("advisor transcript close failed", { err: String(err) });
		}
	}

	#enqueue(work: () => Promise<void>): void {
		this.#queue = this.#queue.then(work, work).catch(err => {
			logger.debug("advisor transcript record failed", { err: String(err) });
		});
	}

	#enqueueResult(work: () => Promise<void>): Promise<void> {
		const next = this.#queue.then(work, work);
		// `next` is returned and carries the failure to the caller; the queue copy must resolve so one failed
		// record does not reject every later one. Note `then(work, work)`: the queue continues either way.
		this.#queue = next.catch(() => {});
		return next;
	}
}
