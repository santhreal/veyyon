import type * as net from "node:net";
import { writeFrame } from "./frames";
import type { ClientSessionState } from "./turns";

/**
 * Reports the prompts the session is holding: the steering prompts, which
 * enter the running turn at its next boundary, and the follow-ups, which run
 * after it ends. Agent-authored queue entries are not among them; the session
 * filters those out of `getQueuedMessages`.
 *
 * A frame stating the same two queues as the last one written for the session
 * is skipped, so the events that end a turn cost one frame rather than one
 * each. A report carrying `restored` answers a `DequeueQueuedPrompt` and is
 * always written.
 */
export function reportQueuedPrompts(
	socket: net.Socket,
	state: ClientSessionState,
	options?: { restored?: string },
): void {
	const manager = state.sessionManager ?? state.agentSession?.sessionManager;
	const session = manager?.getSessionId();
	if (!session) return;

	const queued = state.agentSession?.getQueuedMessages();
	const steering = queued ? [...queued.steering] : [];
	const followUp = queued ? [...queued.followUp] : [];
	const restored = options?.restored ?? null;

	const signature = `${session}:${JSON.stringify(steering)}:${JSON.stringify(followUp)}`;
	if (restored === null && state.lastQueuedPromptsSignature === signature) return;
	state.lastQueuedPromptsSignature = signature;

	writeFrame(socket, {
		Snapshot: { QueuedPrompts: { session, steering, follow_up: followUp, restored } },
	});
}
