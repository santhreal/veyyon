/**
 * The reminders a settling turn can be sent before it finishes: rewind an open checkpoint, prove the
 * edits with verification evidence (`edit.afterEdit: verify`), and review them
 * (`edit.afterEdit: review`).
 *
 * This is a session collaborator. It holds the verification evidence ledger the session records tool
 * executions and user turns into. Each check that sends a reminder appends it to the live context,
 * records the verification and review reminders in the session log, and schedules the continuation
 * that answers it, through {@link FinalizeRemindersHost}. Whether a settle may continue at all
 * (`mayContinueAtSettle`) is read by the caller before each check, since a check spends the ledger's
 * reminder as it reads it.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { SessionManager } from "@veyyon/kernel/session/session-manager";
import type { Settings } from "../../config/settings";
import type { CustomMessage } from "../messages";
import {
	CODE_REVIEW_REMINDER_TYPE,
	VERIFICATION_EVIDENCE_REMINDER_TYPE,
	VerificationEvidenceLedger,
} from "../verification-evidence-ledger";

const REWIND_REMINDER = [
	"<system-warning>",
	"You are in an active checkpoint. You MUST call rewind with your investigation findings before yielding. Do NOT yield without completing the checkpoint.",
	"</system-warning>",
].join("\n");

/** The live context slice the reminders read and append to. `Agent` satisfies this. */
export interface FinalizeRemindersAgent {
	readonly state: { readonly messages: readonly AgentMessage[] };
	appendMessage(message: AgentMessage): void;
}

/** What {@link FinalizeReminders} needs from the session that holds it. */
export interface FinalizeRemindersHost {
	readonly agent: FinalizeRemindersAgent;
	readonly sessionStore: Pick<SessionManager, "appendCustomMessageEntry">;
	/** Read at every settle, so a settings change applies to the next one. */
	readonly settings: Pick<Settings, "get">;
	/** A spawned agent is sent neither the verification nor the review reminder. */
	isSpawned(): boolean;
	/** Whether a checkpoint is open and its rewind report is still owed. */
	awaitingRewind(): boolean;
	/** Schedule the continuation that answers a reminder, in the current prompt generation. */
	scheduleContinue(): void;
	/** The session's active tool names, so the verification reminder names only checks it can run. */
	activeToolNames(): Iterable<string>;
}

export class FinalizeReminders {
	/** Tool executions and user turns, read by the verification and review reminders. */
	readonly evidence: VerificationEvidenceLedger;
	readonly #host: FinalizeRemindersHost;

	constructor(host: FinalizeRemindersHost) {
		this.#host = host;
		this.evidence = new VerificationEvidenceLedger(() => host.activeToolNames());
	}

	/** Remind an agent with an open checkpoint to rewind before it yields. `true` when sent. */
	rewindBeforeYield(): boolean {
		const host = this.#host;
		if (!host.awaitingRewind()) return false;
		host.agent.appendMessage({
			role: "developer",
			content: [{ type: "text", text: REWIND_REMINDER }],
			attribution: "agent",
			timestamp: Date.now(),
		});
		host.scheduleContinue();
		return true;
	}

	/** Send the ledger's verification reminder under `edit.afterEdit: verify`. `true` when sent. */
	verificationBeforeFinalize(): boolean {
		if (this.#host.isSpawned() || this.#host.settings.get("edit.afterEdit") !== "verify") return false;
		return this.#send(VERIFICATION_EVIDENCE_REMINDER_TYPE, this.evidence.takeFinalizationReminder());
	}

	/**
	 * Send the ledger's review reminder under `edit.afterEdit: review`, naming only the calls the
	 * model can still read. `true` when sent.
	 */
	codeReviewBeforeFinalize(): boolean {
		if (this.#host.isSpawned() || this.#host.settings.get("edit.afterEdit") !== "review") return false;
		const inContext = new Set<string>();
		for (const message of this.#host.agent.state.messages) {
			if (message.role !== "assistant") continue;
			for (const part of message.content) {
				if (part.type === "toolCall") inContext.add(part.id);
			}
		}
		return this.#send(
			CODE_REVIEW_REMINDER_TYPE,
			this.evidence.takeCodeReviewReminder(id => inContext.has(id)),
		);
	}

	/** Append a hidden reminder to the live context and the session log, then schedule its answer. */
	#send(customType: string, reminder: string | undefined): boolean {
		if (!reminder) return false;
		const host = this.#host;
		const message: CustomMessage = {
			role: "custom",
			customType,
			content: reminder,
			display: false,
			attribution: "agent",
			timestamp: Date.now(),
		};
		host.agent.appendMessage(message);
		host.sessionStore.appendCustomMessageEntry(customType, reminder, false, undefined, "agent");
		host.scheduleContinue();
		return true;
	}
}
