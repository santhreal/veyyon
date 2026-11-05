/**
 * The steers and follow-ups waiting on the agent's queues: what a typed message, an RPC or SDK
 * follow-up or a custom message delivered mid-turn puts there, when a resting session drains them
 * into a turn of its own, what the queue chip counts, and which of them the editor takes back on a
 * dequeue or an interrupt.
 *
 * This is a session collaborator. It holds the count of prompts waiting for the agent to go idle and
 * the order queued messages are delivered in, and reaches the session only through
 * {@link QueuedMessagesHost}.
 * The queues themselves are the agent's.
 */
import type { AgentMessage } from "@veyyon/agent-core";
import type { ImageContent, MessageAttribution, TextContent } from "@veyyon/ai";
import {
	isAdvisorCard,
	isDisplayableQueuedMessage,
	isHiddenUserCompanion,
	isUserQueuedMessage,
	queueChipText,
	type RestoredQueuedMessage,
	toRestoredQueuedMessage,
} from "../agent-session-queue";
import type { CustomMessage } from "../messages";
import type { AdvisorRoster } from "./advisor-roster";

/**
 * The slice of the agent loop the queues are read and written through. `Agent` satisfies this
 * structurally; the transcript is read for its tail alone.
 */
export interface QueueAgent {
	readonly state: { readonly messages: readonly AgentMessage[] };
	steer(message: AgentMessage): void;
	followUp(message: AgentMessage): void;
	peekSteeringQueue(): readonly AgentMessage[];
	peekFollowUpQueue(): readonly AgentMessage[];
	replaceQueues(steering: AgentMessage[], followUp: AgentMessage[]): void;
	hasQueuedMessages(): boolean;
}

/** What {@link QueuedMessages} needs from the session that owns it. */
export interface QueuedMessagesHost {
	agent: QueueAgent;
	/** Whether a turn is running, whose own queue polls deliver what is queued. */
	isStreaming(): boolean;
	/** Whether an auto-retry is between attempts; its next attempt delivers what is queued. */
	isRetrying(): boolean;
	/** The latch a user interrupt sets on auto-resume, which a queued user message lifts. */
	advisors: Pick<AdvisorRoster, "allowAutoResume" | "autoResumeSuppressed">;
	/** The text and images of a message as the active model takes them, with the hidden companion describing the images to a text-only model. */
	textWithImages(
		text: string,
		images: ImageContent[] | undefined,
	): Promise<{ content: (TextContent | ImageContent)[]; imageDescriptionNotice: CustomMessage | undefined }>;
	/**
	 * Schedule `agent.continue()` after the current prompt returns. The session reads as streaming
	 * from this call until the continuation settles, so a drain requested meanwhile is a no-op.
	 */
	scheduleContinue(): void;
	/** How many hidden messages wait for the next turn, which the queue chip counts too. */
	nextTurnCount(): number;
}

export class QueuedMessages {
	readonly #host: QueuedMessagesHost;
	/**
	 * Prompts refused as busy and waiting for the agent to go idle. Each is a turn already committed
	 * to, held by nothing the queues can see: the hidden next-turn message was pulled from its queue
	 * the moment it was scheduled. Counted as queued work so an `agent_end` handler asking whether
	 * anything is coming reads the turn that is.
	 */
	#waitingOnIdle = 0;
	/** Settles once every message handed to {@link deliverInOrder} so far is delivered or has failed. */
	#delivered: Promise<void> = Promise.resolve();

	constructor(host: QueuedMessagesHost) {
		this.#host = host;
	}

	/**
	 * Deliver prepared messages in the order they were handed over. Preparing one (normalizing its
	 * images, describing them to a text-only model) takes as long as its images make it take, and a
	 * message delivered as soon as it was ready overtook an earlier one still preparing. Preparations
	 * proceed concurrently; `deliver` runs once `prepared` settles and every earlier `deliver` has run,
	 * and a failed preparation holds its place until those have. A promise `deliver` returns (a turn it
	 * started) is handed back without holding later deliveries for it.
	 */
	async deliverInOrder<T, R>(prepared: Promise<T>, deliver: (value: T) => R): Promise<R> {
		const earlier = this.#delivered;
		const delivered = Promise.withResolvers<void>();
		this.#delivered = delivered.promise;
		try {
			const value = await prepared;
			await earlier;
			return deliver(value);
		} finally {
			void earlier.then(delivered.resolve);
		}
	}

	/**
	 * Queue a message the user wrote as a steer or a follow-up, behind the hidden companion that
	 * describes its images to a text-only model. A queued user message (an RPC, SDK or collab steer or
	 * follow-up, or a message typed while streaming) is a deliberate resume, so it lifts the auto-resume
	 * latch a user interrupt set.
	 */
	async queueUser(text: string, images: ImageContent[] | undefined, mode: "steer" | "followUp"): Promise<void> {
		this.#host.advisors.allowAutoResume();
		await this.deliverInOrder(this.#host.textWithImages(text, images), ({ content, imageDescriptionNotice }) => {
			const agent = this.#host.agent;
			if (mode === "followUp") {
				if (imageDescriptionNotice) agent.followUp(imageDescriptionNotice);
				agent.followUp({ role: "user", content, attribution: "user", timestamp: Date.now() });
			} else {
				if (imageDescriptionNotice) agent.steer(imageDescriptionNotice);
				agent.steer({ role: "user", content, steering: true, attribution: "user", timestamp: Date.now() });
			}
			this.scheduleDrain();
		});
	}

	/**
	 * Queue a hidden developer follow-up. Unlike {@link queueUser} it leaves the auto-resume latch
	 * alone, since an agent-initiated message is not the user resuming; the plan-approval flow lands
	 * its execution directive this way behind a queued user turn.
	 */
	async queueDeveloperFollowUp(
		text: string,
		images: ImageContent[] | undefined,
		attribution: MessageAttribution,
	): Promise<void> {
		await this.deliverInOrder(this.#host.textWithImages(text, images), ({ content, imageDescriptionNotice }) => {
			if (imageDescriptionNotice) this.#host.agent.followUp(imageDescriptionNotice);
			this.#host.agent.followUp({ role: "developer", content, attribution, timestamp: Date.now() });
			this.scheduleDrain();
		});
	}

	/** Put `message` on the steering or the follow-up queue, scheduling no drain. */
	enqueue(message: AgentMessage, mode: "steer" | "followUp"): void {
		if (mode === "followUp") this.#host.agent.followUp(message);
		else this.#host.agent.steer(message);
	}

	/**
	 * Schedule a turn that drains the queues of a resting session. A message queued after the agent
	 * loop's final queue poll, or left behind by an abort, has no loop left to deliver it; this starts
	 * one when {@link canAutoContinueForFollowUp} allows. A burst of queued messages starts one turn:
	 * the first call leaves the session streaming, so the rest wait for that turn's queue polls.
	 */
	scheduleDrain(): void {
		if (!this.canAutoContinueForFollowUp() || !this.#host.agent.hasQueuedMessages()) return;
		this.#host.scheduleContinue();
	}

	/** Whether a resting session may start a turn on its queued messages. */
	canAutoContinueForFollowUp(): boolean {
		const host = this.#host;
		if (host.isStreaming()) return false;
		if (host.isRetrying()) return false;
		// A queued steer resumes from ANY tail: Agent.continue() runs #runLoop(undefined),
		// whose initial steering poll injects the steer before the first provider call, so the
		// request tail becomes the steer (valid) regardless of any injected custom / bashExecution
		// / pythonExecution record a user interrupt left as the literal transcript tail. This is
		// why a queued user steer stranded behind a preserved advisor card (or a flushed IRC aside
		// / eval execution record) still resumes — no tail-role enumeration needed.
		if (host.agent.peekSteeringQueue().length > 0) return true;
		// Follow-up-only auto-resume stays suppressed while a deliberate user interrupt is in effect
		// (the advisor roster's auto-resume suppression, cleared on the next user prompt): the user stopped, so their
		// queued follow-up waits for an explicit resume — even if an interleaving IRC wake turn has
		// since left a provider-valid tail.
		if (host.advisors.autoResumeSuppressed) return false;
		// Follow-up-only resume has no steer to inject, so Agent.continue() continues from the
		// existing context tail — which must itself be a valid provider tail. An injected
		// non-conversational tail (advisor card → `developer`, bash/python execution) would make
		// the first model call invalid, so leave the follow-up queued for the next explicit resume.
		const messages = host.agent.state.messages;
		const last = messages[messages.length - 1];
		return last?.role === "assistant" || last?.role === "toolResult";
	}

	/** Run `wait` counted as a prompt waiting for the agent to go idle; see {@link count}. */
	async whileWaitingOnIdle(wait: () => Promise<void>): Promise<void> {
		this.#waitingOnIdle += 1;
		try {
			await wait();
		} finally {
			this.#waitingOnIdle -= 1;
		}
	}

	/**
	 * Clear the queues and return the user-restorable messages (text plus any attached images).
	 * Only user-authored messages (plain user turns, `attribution:"user"` custom like `/skill`) are
	 * returned for editor restore. Other queued messages stay queued so a continuing stream still
	 * delivers them — except on `forInterrupt` (Esc+abort), where only advisor cards are kept (an
	 * abort preserves them as visible advice) and every other non-user steer (hidden goal/plan/budget,
	 * IRC/extension asides) is dropped, so the drain a settle runs cannot auto-resume the run the
	 * user just interrupted (it fires only while the agent has queued messages). Plain Alt+Up dequeue
	 * preserves those non-user steers.
	 */
	clear(options?: { forInterrupt?: boolean }): {
		steering: RestoredQueuedMessage[];
		followUp: RestoredQueuedMessage[];
	} {
		const agent = this.#host.agent;
		const steeringAll = agent.peekSteeringQueue();
		const followUpAll = agent.peekFollowUpQueue();
		const steering = steeringAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const followUp = followUpAll.filter(isUserQueuedMessage).map(toRestoredQueuedMessage);
		const keep: (m: AgentMessage) => boolean = options?.forInterrupt
			? isAdvisorCard
			: m => !isUserQueuedMessage(m) && !isHiddenUserCompanion(m);
		agent.replaceQueues(steeringAll.filter(keep), followUpAll.filter(keep));
		return { steering, followUp };
	}

	/**
	 * Pending displayable messages: steering, follow-up and next-turn messages, and prompts waiting
	 * for the agent to go idle. Reflects queued work, advisor cards included; the user-restorable
	 * subset is what {@link chips} and {@link clear} return.
	 */
	get count(): number {
		const agent = this.#host.agent;
		return (
			agent.peekSteeringQueue().filter(isDisplayableQueuedMessage).length +
			agent.peekFollowUpQueue().filter(isDisplayableQueuedMessage).length +
			this.#host.nextTurnCount() +
			this.#waitingOnIdle
		);
	}

	/** The chip text of each user-restorable queued message, steering and follow-up apart. */
	chips(): { steering: readonly string[]; followUp: readonly string[] } {
		const agent = this.#host.agent;
		return {
			steering: agent.peekSteeringQueue().filter(isUserQueuedMessage).map(queueChipText),
			followUp: agent.peekFollowUpQueue().filter(isUserQueuedMessage).map(queueChipText),
		};
	}

	/**
	 * Pop the last user-restorable queued message, steering first, then follow-up, stepping over
	 * agent-authored ones (advisor cards, hidden/internal steers). The hidden companions queued right
	 * before it go with it; companions of other queued prompts stay put.
	 */
	popLast(): RestoredQueuedMessage | undefined {
		const agent = this.#host.agent;
		const steering = agent.peekSteeringQueue();
		const followUp = agent.peekFollowUpQueue();
		const fromSteer = lastUserIndex(steering);
		if (fromSteer >= 0) {
			agent.replaceQueues(removeWithCompanions(steering, fromSteer), followUp.slice());
			return toRestoredQueuedMessage(steering[fromSteer]);
		}
		const fromFollowUp = lastUserIndex(followUp);
		if (fromFollowUp >= 0) {
			agent.replaceQueues(steering.slice(), removeWithCompanions(followUp, fromFollowUp));
			return toRestoredQueuedMessage(followUp[fromFollowUp]);
		}
		return undefined;
	}
}

function lastUserIndex(queue: readonly AgentMessage[]): number {
	for (let i = queue.length - 1; i >= 0; i--) {
		if (isUserQueuedMessage(queue[i])) return i;
	}
	return -1;
}

/** `queue` without the user message at `userIndex` and the contiguous hidden companions queued right before it. */
function removeWithCompanions(queue: readonly AgentMessage[], userIndex: number): AgentMessage[] {
	let start = userIndex;
	while (start > 0 && isHiddenUserCompanion(queue[start - 1])) start--;
	const next = queue.slice();
	next.splice(start, userIndex - start + 1);
	return next;
}
