/**
 * Tiny-model UI labels for spawned subagents.
 */
import { logger, prompt } from "@veyyon/utils";
import type { ModelRegistry } from "../config/model-registry";
import type { Settings } from "../config/settings";
import { subagentPrompts } from "../prompts/subagent/rows";
import type { SideCompleteImpl } from "../session/side-complete";
import { ONLINE_TINY_TITLE_MODEL_KEY } from "../tiny/models";
import { generateSessionTitle } from "../utils/title-generator";

const TASK_LABEL_SYSTEM_PROMPT = prompt.render(subagentPrompts["subagent/task-label"].text);

/** Compresses a delegated assignment into a one-sentence UI label via the tiny title model — fired by the executor spawn path because the task wire schema no longer carries a `description`; null on empty input or failure. */
export async function generateTaskLabel(
	assignment: string,
	registry: ModelRegistry,
	settings: Settings,
	sessionId?: string,
	obfuscateProviderText?: (text: string) => string,
	completeImpl?: SideCompleteImpl,
): Promise<string | null> {
	const trimmedAssignment = assignment.trim();
	if (!trimmedAssignment) return null;
	// Online title generation must receive the raw assignment so its live
	// transform runs before trim/title preprocessing. Keep the established
	// trimmed input for local-only tiny models, which never cross a provider
	// boundary and must retain their existing behavior.
	const text = settings.get("providers.tinyModel") === ONLINE_TINY_TITLE_MODEL_KEY ? assignment : trimmedAssignment;
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
			completeImpl,
		);
	} catch {
		logger.debug("task-label: generation failed", { sessionId });
		return null;
	}
}
