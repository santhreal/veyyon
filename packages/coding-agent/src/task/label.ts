/**
 * Tiny-model UI labels for spawned subagents.
 */
import { errorMessage, logger, prompt } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { subagentPrompts } from "../prompts/subagent/rows";
import { generateSessionTitle } from "../utils/title-generator";

const TASK_LABEL_SYSTEM_PROMPT = prompt.render(subagentPrompts["subagent/task-label"].text);

/** Compresses a delegated assignment into a one-sentence UI label via the tiny title model — fired by the executor spawn path because the task wire schema no longer carries a `description`; null on empty input or failure. */
export async function generateTaskLabel(
	assignment: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	obfuscateProviderText?: (text: string) => string,
): Promise<string | null> {
	const text = assignment.trim();
	if (!text) return null;
	try {
		return await generateSessionTitle(
			text,
			registry,
			settings,
			sessionId,
			undefined,
			undefined,
			TASK_LABEL_SYSTEM_PROMPT,
			obfuscateProviderText,
		);
	} catch (err) {
		logger.debug("task-label: generation failed", {
			sessionId,
			error: errorMessage(err),
		});
		return null;
	}
}
