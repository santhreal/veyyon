/**
 * `/btw`: a question answered from the session's own context, beside the work.
 *
 * The question reuses the conversation the session already holds and adds
 * nothing to it: `runEphemeralTurn` builds its request from a snapshot, sends
 * no tools, and leaves the session's history and its file untouched. So the
 * answer is sent to the window and recorded nowhere, the way a command's
 * output is, and reloading the transcript drops it.
 *
 * It runs beside a turn rather than against it. The side request carries its
 * own provider lineage, so a question asked while the agent is mid-tool-call
 * is answered without steering or queueing anything.
 */
import type { Socket } from "node:net";
import { errorMessage, prompt } from "@veyyon/utils";
import { sideChannelPrompts } from "../prompts/side-channel/rows";
import type { AgentSession } from "../session/agent-session";
import { writeFrame } from "./frames";
import type { ClientSessionState } from "./turns";
import type { TranscriptEntry } from "./wire";

/**
 * How often a growing answer is re-stated to the window.
 *
 * A provider emits deltas by the token, and one frame per token draws the
 * same paragraph a hundred times. The interval is the streaming reply's own:
 * fast enough to read as typing, slow enough that the window redraws once per
 * frame rather than once per word.
 */
const REDRAW_INTERVAL_MS = 80;

/** The two entries a side question writes, named by what the window draws. */
type SideEntryKind = "side_question" | "side_answer";

function sideEntry(
	state: ClientSessionState,
	id: string,
	kind: SideEntryKind,
	text: string,
	error?: string,
): TranscriptEntry {
	state.revision += 1;
	return {
		id,
		parent: null,
		revision: state.revision,
		timestamp_ms: Date.now(),
		role: "Custom",
		content: [{ Text: { text } }],
		meta: error === undefined ? null : { provider: null, model: null, stop_reason: null, error, usage: null },
		raw_discriminator: kind,
		raw: { text },
	};
}

/**
 * Ask the question and stream the answer back.
 *
 * Resolves with the answer, so a caller reports the request as done when the
 * answer is whole rather than when the request was accepted; a failure is
 * thrown for the caller to report, and is drawn on the answer entry too, so
 * the window states it where the answer would have been.
 */
export async function answerSideQuestion(
	socket: Socket,
	state: ClientSessionState,
	session: AgentSession,
	question: string,
): Promise<string> {
	const askedAt = state.revision + 1;
	const questionId = `side-question-${askedAt}`;
	const answerId = `side-answer-${askedAt}`;
	writeFrame(socket, {
		TranscriptAppended: {
			revision: state.revision + 1,
			entries: [sideEntry(state, questionId, "side_question", question)],
		},
	});
	const empty = sideEntry(state, answerId, "side_answer", "");
	writeFrame(socket, { TranscriptAppended: { revision: empty.revision, entries: [empty] } });

	let answer = "";
	let drawnAt = 0;
	const restate = (text: string, error?: string): void => {
		const entry = sideEntry(state, answerId, "side_answer", text, error);
		writeFrame(socket, { TranscriptUpdated: { revision: entry.revision, entry } });
	};
	try {
		const { replyText } = await session.runEphemeralTurn({
			promptText: prompt.render(sideChannelPrompts["side-channel/btw-user"].text, { question }),
			onTextDelta: delta => {
				answer += delta;
				const now = Date.now();
				if (now - drawnAt < REDRAW_INTERVAL_MS) return;
				drawnAt = now;
				restate(answer);
			},
		});
		restate(replyText);
		return replyText;
	} catch (error) {
		const failure = errorMessage(error);
		restate(`The side question was not answered: ${failure}`, failure);
		throw error;
	}
}
