/**
 * `/guided-goal`: the interview that turns a rough objective into one a goal
 * can be set from, run for a window.
 *
 * The interview itself is `runGuidedGoalTurn`, which both hosts share. What
 * differs is where a question is put: the terminal opens an editor, and a
 * window is asked through the interaction ledger, so each step is an ordinary
 * decision card the desktop already draws and answers.
 *
 * The draft is reviewed before it becomes a goal. A window's question carries
 * no prefilled answer, so the review is a choice with the draft written into
 * it rather than an editor holding the text: the objective is started as
 * drafted, replaced with one typed in full, or abandoned.
 */
import {
	GUIDED_GOAL_TURN_LIMIT,
	type GuidedGoalMessage,
	newGuidedGoalSessionId,
	runGuidedGoalTurn,
} from "../goals/guided-setup";
import type { AgentSession } from "../session/agent-session";
import type { InteractionLedger } from "./interactions";

/** The labels the review card offers, in the order it offers them. */
const REVIEW = { start: "Start this goal", change: "Change the objective", cancel: "Cancel" } as const;

/**
 * How the interview ended: with an objective to set, with the operator
 * leaving it, or with the interview out of turns and nothing drafted.
 */
export type GuidedGoalOutcome =
	| { kind: "objective"; objective: string }
	| { kind: "abandoned" }
	| { kind: "unresolved" };

/**
 * Interviews the operator until an objective is agreed, the turn limit is
 * reached, or a question is left unanswered.
 *
 * A question with no answer ends the interview rather than asking again: the
 * card was dismissed, and re-raising it would put the same card back up.
 */
export async function interviewGuidedGoal(
	ledger: InteractionLedger,
	session: AgentSession,
	initial: string,
): Promise<GuidedGoalOutcome> {
	const messages: GuidedGoalMessage[] = [{ role: "user", content: initial }];
	const sideSessionId = newGuidedGoalSessionId(session);
	let drafted: string | undefined;
	for (let turn = 0; turn < GUIDED_GOAL_TURN_LIMIT; turn++) {
		const result = await runGuidedGoalTurn(session, { messages, sideSessionId });
		if (result.objective?.trim()) drafted = result.objective.trim();
		if (result.kind === "ready") return review(ledger, result.objective.trim());
		messages.push({ role: "assistant", content: result.question });
		const answer = (await ledger.text(result.question))?.trim();
		if (!answer) return { kind: "abandoned" };
		messages.push({ role: "user", content: answer });
	}
	// Out of turns with a draft in hand: the interview did not converge, and
	// the draft is still what it understood, so it is offered rather than
	// discarded.
	return drafted ? review(ledger, drafted) : { kind: "unresolved" };
}

/** Puts `objective` to the operator and reports what to do with it. */
async function review(ledger: InteractionLedger, objective: string): Promise<GuidedGoalOutcome> {
	const chosen = await ledger.choice(`Guided goal\n\n${objective}`, [REVIEW.start, REVIEW.change, REVIEW.cancel]);
	if (chosen === REVIEW.start) return { kind: "objective", objective };
	if (chosen !== REVIEW.change) return { kind: "abandoned" };
	const replacement = (await ledger.text("Type the objective to run instead"))?.trim();
	return replacement ? { kind: "objective", objective: replacement } : { kind: "abandoned" };
}
