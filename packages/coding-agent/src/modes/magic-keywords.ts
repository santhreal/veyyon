import { containsOrchestrate, highlightOrchestrate } from "./orchestrate";
import { containsUltrathink, highlightUltrathink } from "./ultrathink";
import { containsWorkflow, highlightWorkflow } from "./workflow";

/** Gradient-highlight every magic keyword ("ultrathink", "orchestratez", "workflowz") that appears as standalone prose, skipping any occurrence inside a */
export function highlightMagicKeywords(text: string, resetTo?: string, phase?: number): string {
	return highlightWorkflow(
		highlightOrchestrate(highlightUltrathink(text, resetTo, phase), resetTo, phase),
		resetTo,
		phase,
	);
}

/** The tokens that trigger a magic keyword, in one place. A TRIGGER IS A TOKEN NOBODY TYPES BY ACCIDENT. Each of these carries a hidden */
export const MAGIC_KEYWORD_TOKENS: readonly string[] = ["ultrathink", "orchestratez", "workflowz"];

/** Cheap test for "does this text contain any magic keyword as standalone prose?". Short-circuits on a substring probe before paying for the markdown-aware */
export function hasMagicKeyword(text: string): boolean {
	let probe = false;
	for (const token of MAGIC_KEYWORD_TOKENS) {
		if (text.includes(token)) {
			probe = true;
			break;
		}
	}
	if (!probe) return false;
	return containsUltrathink(text) || containsOrchestrate(text) || containsWorkflow(text);
}
