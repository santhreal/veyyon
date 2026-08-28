import type { AssistantMessage } from "@veyyon/ai";
import { assistantText } from "@veyyon/ai/utils/message-text";

export type SettleContinuationRoute =
	| "rewind-checkpoint"
	| "plan-mode-decision"
	| "todo-reminder"
	| "verification-evidence"
	| "code-review"
	| "unexpected-stop-retry";

interface SettleContinuationRule {
	holdsForUserAnswer: boolean;
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
	"code-review": {
		holdsForUserAnswer: true,
		why: "Multi-file code mutation review is owed before finalizing; defer when the assistant is waiting on a user answer so we do not talk over the question.",
	},
	"unexpected-stop-retry": {
		holdsForUserAnswer: true,
		why: "A reply that asks the user something is the hardest case the unexpected-stop classifier is asked to judge, and the shape it answers YES on most readily: a question about what to do next reads exactly like a turn that announced an action and stopped short of it. The retry budget is unspent by the deferral, so a genuinely abandoned turn still gets its nudge at the next settle. The gate is checked BEFORE the classifier runs, so a question also costs no classifier call.",
	},
};

export interface SettleContinuationState {
	awaitingUserAnswer: boolean;
}

export function mayContinueAtSettle(route: SettleContinuationRoute, state: SettleContinuationState): boolean {
	if (state.awaitingUserAnswer && SETTLE_CONTINUATION_POLICY[route].holdsForUserAnswer) return false;
	return true;
}

const MARKDOWN_PROMPT_PREFIX_RE = /^(?:>\s*)?(?:(?:[-*+]|\d+[.)])\s+)*/;
const PROMPT_LABEL_RE = /^(?:q(?:uestion)?|ask)\s*\d*\s*[:.)-]\s*/i;

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

function isFenceDelimiter(line: string): boolean {
	return /^(?:```|~~~)/.test(line.trim());
}

function isStructuralTailLine(line: string): boolean {
	const text = line.trim();
	if (text.length === 0) return true;
	if (isFenceDelimiter(text)) return true;
	if (text.startsWith("|")) return true;
	if (/^(?:[-*_]\s*){3,}$/.test(text)) return true;
	if (/^#{1,6}\s/.test(text)) return true;
	return /^(?:[-*+]|\d+[.)])\s+\S/.test(text);
}

const MAX_TAIL_LINES_SCANNED = 40;

export function isAwaitingUserAnswer(message: AssistantMessage): boolean {
	const text = assistantText(message).trim();
	if (!text) return false;
	const lines = text.split(/\r?\n/);
	const floor = Math.max(0, lines.length - MAX_TAIL_LINES_SCANNED);
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
		if (!isStructuralTailLine(line)) return false;
	}
	return false;
}
