/** Every prompt registry a model can be sent from, in one list. A package owns its own prompts, so there is one registry per package that ships them, */
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import type { PromptRegistryView } from "@veyyon/utils";
import { codingAgentPrompts } from "./registry";

/** The registries, coding-agent first. Order is meaningful in one place: a lookup miss is reported against the first */
export const PROMPT_REGISTRIES: readonly PromptRegistryView[] = [
	codingAgentPrompts,
	agentCorePrompts,
	aiPrompts,
	hashlinePrompts,
];

/** Every registered prompt id in this build, across every registry. */
export function allPromptIds(): readonly string[] {
	return PROMPT_REGISTRIES.flatMap(registry => registry.ids);
}
