import type { AgentMessage } from "@veyyon/agent-core";
import type { AgentSession } from "../session/agent-session";
import type { PresentationLedger } from "./presentation";
import { agentMessageToTranscriptEntry } from "./transcript-conversion";
import type { TranscriptEntry } from "./wire";

/**
 * How often a streaming reply reaches the window, in milliseconds.
 *
 * A provider emits one delta per token chunk, and `StreamingChanged` carries
 * the whole accumulating entry rather than the delta, so converting and
 * serialising one per token costs the square of the reply length on the host,
 * the socket and the window's decoder. The window redraws at the display's
 * rate regardless, so the deltas between two frames are work no operator ever
 * sees.
 *
 * 16 ms is one frame at 60 Hz: the fastest cadence a repaint can consume.
 */
export const STREAM_FRAME_INTERVAL_MS = 16;

/** What a session is holding for the next streaming frame. */
export interface StreamingFrameState {
	/**
	 * The newest assistant message not yet converted. Each is an immutable
	 * snapshot the agent loop already took, so holding the reference and
	 * converting once per frame is what the per-delta conversion was doing
	 * with every intermediate one.
	 */
	message?: AgentMessage;
	/**
	 * A tool result landed, so the held entry's call presentation is stale.
	 * `partial` marks a result still streaming, which regenerates against the
	 * partial output rather than the final one.
	 */
	regenerate?: "final" | "partial";
	/**
	 * The call in flight changed. The run bar reads it off the frame rather
	 * than off the entry, so a call that starts or ends between two deltas is
	 * a frame of its own even when the reply's text has not moved.
	 */
	tool?: boolean;
	timer?: NodeJS.Timeout;
	/** When the last frame was written, so the first delta is not delayed. */
	lastFrameMs?: number;
}

/** What the coalescer reads and writes on the session it is streaming for. */
export interface StreamingFrameSession {
	revision: number;
	agentSession?: AgentSession;
	presentationLedger: PresentationLedger;
	streamingEntry?: string;
	streamingTool?: string;
	streamingAccumulating?: TranscriptEntry;
	streamFrame?: StreamingFrameState;
}

/** The frame the window is sent for one streaming state. */
export type StreamingFrame = {
	StreamingChanged: {
		entry: string;
		tool: string | null;
		accumulating: TranscriptEntry;
		revision: number;
	};
};

function frameState(state: StreamingFrameSession): StreamingFrameState {
	state.streamFrame ??= {};
	return state.streamFrame;
}

/**
 * Converts what is held into the entry the window draws, and clears the hold.
 *
 * Returns nothing when the session is no longer streaming, or when neither a
 * delta nor a tool result has landed since the last frame.
 */
function resolve(state: StreamingFrameSession): TranscriptEntry | undefined {
	const held = frameState(state);
	const entryId = state.streamingEntry;
	if (!entryId) {
		held.message = undefined;
		held.regenerate = undefined;
		held.tool = undefined;
		return undefined;
	}
	if (held.message) {
		const accumulating = agentMessageToTranscriptEntry(held.message, state.revision, entryId, {
			ledger: state.presentationLedger,
			session: state.agentSession,
			isStreaming: true,
		});
		for (const block of accumulating.content) {
			if ("ToolCall" in block) {
				state.presentationLedger.recordCall(block.ToolCall.id, block.ToolCall.name, block.ToolCall.arguments);
			}
		}
		state.streamingAccumulating = accumulating;
		held.message = undefined;
	}
	if (held.regenerate && state.streamingAccumulating) {
		const updated = state.presentationLedger.regenerateCallEntryPresentation(
			state.streamingAccumulating,
			name => state.agentSession?.getToolByName(name),
			held.regenerate === "partial" ? { partial: true } : undefined,
		);
		if (updated) state.streamingAccumulating = updated;
	}
	return state.streamingAccumulating;
}

/**
 * Writes the held streaming state now, if there is any, and starts the next
 * interval from this moment.
 *
 * The interval is measured against the process clock, which is also the one
 * the scheduled frame fires on: two clocks would let a held frame be written
 * at a moment the next interval is measured from.
 */
export function flushStreamingFrame(state: StreamingFrameSession, write: (frame: StreamingFrame) => void): void {
	const held = frameState(state);
	clearTimeout(held.timer);
	held.timer = undefined;
	const pending = held.message !== undefined || held.regenerate !== undefined || held.tool === true;
	const accumulating = resolve(state);
	if (!pending || !accumulating || !state.streamingEntry) return;
	// Cleared only once a frame carries them: a change the window was not
	// sent is still owed to it, and the next flush writes it.
	held.regenerate = undefined;
	held.tool = undefined;
	held.lastFrameMs = Date.now();
	write({
		StreamingChanged: {
			entry: state.streamingEntry,
			tool: state.streamingTool ?? null,
			accumulating,
			revision: state.revision,
		},
	});
}

/** What one streaming event changes about the reply the window is drawing. */
export interface StreamingChange {
	/** The reply so far, as the agent loop snapshotted it. */
	message?: AgentMessage;
	/** A tool result landed, and how much of it there is. */
	regenerate?: "final" | "partial";
	/** The call in flight started or ended. */
	tool?: boolean;
}

/**
 * Holds a streaming change for the next frame.
 *
 * The first change after an idle interval is written immediately, so the
 * first token of a reply is never delayed by the coalescing window; the ones
 * behind it wait for the frame that is already scheduled.
 */
export function pushStreamingFrame(
	state: StreamingFrameSession,
	change: StreamingChange,
	write: (frame: StreamingFrame) => void,
): void {
	if (!state.streamingEntry) return;
	const held = frameState(state);
	if (change.message) held.message = change.message;
	// A final result supersedes a partial one: the call is over, and
	// regenerating against the partial output would draw a truncated result.
	if (change.regenerate === "final" || (change.regenerate && held.regenerate !== "final")) {
		held.regenerate = change.regenerate;
	}
	if (change.tool) held.tool = true;
	if (held.timer) return;

	const since = Date.now() - (held.lastFrameMs ?? Number.NEGATIVE_INFINITY);
	if (since >= STREAM_FRAME_INTERVAL_MS) {
		flushStreamingFrame(state, write);
		return;
	}
	const timer = setTimeout(() => {
		held.timer = undefined;
		flushStreamingFrame(state, write);
	}, STREAM_FRAME_INTERVAL_MS - since);
	// A scheduled frame never holds the process open: the reply it would draw
	// is gone with the session that was streaming it.
	timer.unref?.();
	held.timer = timer;
}

/**
 * Drops what is held without writing it, and disarms the frame it scheduled.
 *
 * This is teardown: a session whose socket is gone has no window to draw in,
 * and a frame left armed fires against it. A reply that ended normally
 * flushes instead, so the window is shown the text the turn finished on.
 */
export function cancelStreamingFrame(state: StreamingFrameSession): void {
	const held = state.streamFrame;
	if (!held) return;
	clearTimeout(held.timer);
	held.timer = undefined;
	held.message = undefined;
	held.regenerate = undefined;
	held.tool = undefined;
}
