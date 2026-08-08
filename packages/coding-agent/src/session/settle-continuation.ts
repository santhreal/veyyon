/**
 * Who may re-wake the agent after it settles, and when it must not.
 *
 * A turn that ends with a question to the user is finished: the next thing that
 * should happen is the user typing. Four different guards in the `agent_end`
 * tail can schedule an autonomous continuation instead (an active checkpoint
 * demanding a rewind, plan mode demanding an `ask`/`resolve`, an unfinished
 * todo board, missing verification evidence), and each one used to decide the
 * question on its own. Only the todo reminder ever looked, so whether a reply
 * that ended in a question was answered by the user or immediately overwritten
 * by another agent turn depended on which of the four happened to be armed.
 * That is the "reinvoked randomly, not consistent" behaviour: the trigger is
 * hidden state, not anything the user did.
 *
 * So the decision has one owner. The tail computes "is this reply waiting on the
 * user" ONCE, and every route consults {@link mayContinueAtSettle} with its own
 * id. A route that is added later cannot compile without a row in
 * {@link SETTLE_CONTINUATION_POLICY}, which is the point: the next guard has to
 * state its answer instead of inheriting whatever the default happened to be.
 */
import type { AssistantMessage } from "@veyyon/ai";
import { assistantText } from "@veyyon/ai/utils/message-text";

/** Every autonomous continuation the settle tail can schedule. */
export type SettleContinuationRoute =
	| "rewind-checkpoint"
	| "plan-mode-decision"
	| "todo-reminder"
	| "verification-evidence";

interface SettleContinuationRule {
	/**
	 * Whether this route defers while the reply is a question to the user.
	 *
	 * Deferring is not dropping: the guard's own state (checkpoint, plan mode,
	 * the todo board, the evidence ledger) survives the settle, so the route
	 * fires at the next settle that is not waiting on an answer.
	 */
	holdsForUserAnswer: boolean;
	/** Why that answer, for whoever adds the next route. */
	why: string;
}

export const SETTLE_CONTINUATION_POLICY: Record<SettleContinuationRoute, SettleContinuationRule> = {
	"rewind-checkpoint": {
		holdsForUserAnswer: true,
		why: "The checkpoint stays open across the user's answer, so the rewind demand loses nothing by waiting; overriding the question instead answers it on the user's behalf.",
	},
	"plan-mode-decision": {
		holdsForUserAnswer: true,
		why: "A plan-mode reply that asks the user something IS the consultation the forced ask/resolve exists to produce. Forcing a tool call over it discards the question and burns one of the three reminders.",
	},
	"todo-reminder": {
		holdsForUserAnswer: true,
		why: "An open board is not abandonment while the agent is blocked on an answer, and the reminder counter is unspent, so the nudge still lands at the next settle.",
	},
	"verification-evidence": {
		holdsForUserAnswer: true,
		why: "The mutation is already recorded in the ledger, so the reminder is still owed after the user replies. It must be checked BEFORE the ledger is drained, or the deferral spends the one reminder it was holding.",
	},
};

/** The settle facts every route consults, read once per `agent_end`. */
export interface SettleContinuationState {
	/** Whether the reply that just landed hands the turn back to the user. */
	awaitingUserAnswer: boolean;
}

/**
 * Whether `route` may schedule a continuation at this settle.
 *
 * The only fact today is whether the reply is waiting on the user, but it
 * arrives as a state object so a later condition is one field consulted by
 * every route rather than another private check inside one of them.
 */
export function mayContinueAtSettle(route: SettleContinuationRoute, state: SettleContinuationState): boolean {
	if (state.awaitingUserAnswer && SETTLE_CONTINUATION_POLICY[route].holdsForUserAnswer) return false;
	return true;
}

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;

/**
 * The word a question opens with, when it ends in a question mark.
 *
 * Exported as data rather than buried in a pattern because the defect this module
 * exists for was a detector that recognised too little. A vocabulary someone can
 * enumerate is a vocabulary a test can hold to its claims, so narrowing it fails
 * a suite instead of quietly narrowing the guard.
 */
export const QUESTION_OPENERS = [
	"what",
	"which",
	"when",
	"where",
	"why",
	"how",
	"who",
	"whom",
	"whose",
	"do",
	"does",
	"did",
	"can",
	"could",
	"would",
	"will",
	"should",
	"is",
	"are",
	"am",
	"may",
	"shall",
] as const;

/** Asking for an answer outright, with or without a question mark. */
export const REQUEST_CUES = [
	"confirm",
	"reply",
	"choose",
	"pick",
	"decide",
	"advise",
	"answer",
	"let me know",
	"tell me",
] as const;

/** Saying the turn is over without asking anything: the agent is now waiting. */
export const WAITING_CUES = [
	"wait for you",
	"wait for your",
	"wait on you",
	"wait on your",
	"waiting for you",
	"waiting for your",
	"waiting on you",
	"waiting on your",
	"standing by",
	"holding for you",
	"holding for your",
	"holding off for you",
	"holding off for your",
	"holding off until you",
	"holding off until your",
] as const;

/**
 * A cue's spaces match any run of whitespace, so a wrapped line reads the same as
 * a straight one, and an apostrophe is optional to cover `ill` for `i'll`.
 */
function cueAlternation(cues: readonly string[]): string {
	return cues
		.map(cue =>
			cue
				.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
				.replace(/'/g, "'?")
				.replace(/ /g, "\\s+"),
		)
		.join("|");
}

const QUESTION_PROMPT_RE = new RegExp(`^(?:${QUESTION_OPENERS.join("|")})\\b`, "i");
const USER_DIRECTED_PROMPT_RE = /\b(?:you|your|we|our)\b/i;
const USER_RESPONSE_CUE_RE = new RegExp(
	`^(?:please\\s+)?(?:${cueAlternation(REQUEST_CUES)})\\b|^(?:i'?(?:ll|m)\\s+|i\\s+am\\s+)?(?:${cueAlternation(WAITING_CUES)})\\b`,
	"i",
);

interface PromptLine {
	text: string;
	hadPromptLabel: boolean;
}

function promptLine(line: string): PromptLine {
	const withoutMarkdownPrefix = line.trim().replace(MARKDOWN_PROMPT_PREFIX_RE, "").trim();
	const withoutPromptLabel = withoutMarkdownPrefix.replace(PROMPT_LABEL_RE, "").trim();
	return {
		text: withoutPromptLabel,
		hadPromptLabel: withoutPromptLabel !== withoutMarkdownPrefix,
	};
}

function isQuestionPromptLine(line: string): boolean {
	const candidate = promptLine(line);
	if (!/[?？]\s*$/.test(candidate.text)) return false;
	return (
		candidate.hadPromptLabel ||
		QUESTION_PROMPT_RE.test(candidate.text) ||
		USER_DIRECTED_PROMPT_RE.test(candidate.text)
	);
}

function isResponseCueLine(line: string): boolean {
	const candidate = promptLine(line)
		.text.replace(/[.!?。！？]+$/, "")
		.trim();
	return USER_RESPONSE_CUE_RE.test(candidate);
}

/** Opening or closing line of a Markdown code fence. */
function isFenceDelimiter(line: string): boolean {
	return /^(?:```|~~~)/.test(line.trim());
}

/**
 * A trailing line that carries no sentence of its own: the answer choices,
 * table, rule or fence that a question is followed by.
 *
 * The detector used to test the strict last line, so the single most common
 * shape of an actual question to the user went undetected:
 *
 *     Which storage backend do you want?
 *     - SQLite: file-local, no server
 *     - Postgres: relational, needs a server
 *
 * The last line there is an option, not a question, and every route read that
 * as "the agent is done talking" and continued the run over the top of it.
 * Option lines are skipped so the question above them is the line that decides.
 * A list item that is itself a question still decides, because the walk tests
 * each line before skipping it.
 */
function isStructuralTailLine(line: string): boolean {
	const text = line.trim();
	if (text.length === 0) return true;
	// Fence delimiter, table row, horizontal rule, heading.
	if (isFenceDelimiter(text)) return true;
	if (text.startsWith("|")) return true;
	if (/^(?:[-*_]\s*){3,}$/.test(text)) return true;
	if (/^#{1,6}\s/.test(text)) return true;
	// A list item or numbered step. `promptLine` strips these markers, so a
	// question written as a bullet is caught by the test that runs first.
	return /^(?:[-*+]|\d+[.)])\s+\S/.test(text);
}

/** How far back the walk looks for the line that ends the reply's prose. */
const MAX_TAIL_LINES_SCANNED = 40;

/**
 * Whether this reply hands the turn back to the user.
 *
 * True when the last prose line asks the user something or cues a reply, with
 * the answer choices, tables and code fences that trail such a question skipped
 * rather than treated as the end of the message.
 */
export function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	// Trim is load-bearing: a trailing newline would make the last line empty.
	// The shared @veyyon/ai assistantText leaves trimming to the caller.
	const text = assistantText(message).trim();
	if (!text) return false;
	const lines = text.split(/\r?\n/);
	const floor = Math.max(0, lines.length - MAX_TAIL_LINES_SCANNED);
	// A trailing fenced block is diff, code or output, so its body is not prose
	// and must not decide. Walking upward, the first delimiter met is the block's
	// closer, and everything up to its opener is skipped wholesale.
	let insideFence = false;
	for (let index = lines.length - 1; index >= floor; index--) {
		const line = lines[index]?.trim();
		if (line === undefined) continue;
		if (isFenceDelimiter(line)) {
			insideFence = !insideFence;
			continue;
		}
		if (insideFence) continue;
		if (isQuestionPromptLine(line) || isResponseCueLine(line)) return true;
		// The first line that carries prose of its own decides, so a reply that
		// ends in an ordinary sentence is not read as a question just because
		// one appeared earlier in the message.
		if (!isStructuralTailLine(line)) return false;
	}
	return false;
}
