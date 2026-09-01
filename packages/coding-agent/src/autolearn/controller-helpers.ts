import type { Settings } from "../config/settings";
import { autolearnPrompts } from "../prompts/autolearn/rows";
import type { AgentSession } from "../session/agent-session";

export const AUTOLEARN_NUDGE_AUTOCONTINUE = autolearnPrompts["autolearn/nudge-autocontinue"].text.trim();
export const DEFAULT_MIN_TOOL_CALLS = 5;

export function buildAutoLearnInstructions(available: { manageSkill: boolean; learn: boolean }): string | null {
	if (!available.manageSkill) return null;
	const parts = [autolearnPrompts["autolearn/guidance"].text.trim()];
	if (available.learn) parts.push(autolearnPrompts["autolearn/guidance-learn"].text.trim());
	return parts.join("\n\n");
}

export interface AutoLearnControllerOptions {
	session: AgentSession;
	settings: Settings;
}
