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

export {
	ADVISOR_TRANSCRIPT_FILENAME,
	ADVISOR_TRANSCRIPT_STEM,
	isAdvisorTranscriptName,
} from "@veyyon/utils/session-file";

export function advisorTranscriptFilename(slug: string): string {
	return slug ? sessionFileName(`${ADVISOR_TRANSCRIPT_STEM}.${slug}`) : ADVISOR_TRANSCRIPT_FILENAME;
}

export class AdvisorTranscriptRecorder {
	#manager: SessionManager | undefined;
	#file: string | undefined;
	#filename: string;
	#queue: Promise<void>;

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

	record(message: AgentMessage): void {
		let persisted: Message;
		switch (message.role) {
			case "assistant":
			case "toolResult":
				persisted = message;
				break;
			case "user":
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

	flush(): Promise<void> {
		return this.#enqueueResult(async () => {
			if (this.#manager) await this.#manager.flush();
		});
	}

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
		this.#queue = next.catch(() => {});
		return next;
	}
}
