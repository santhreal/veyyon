/**
 * Every prompt registry a model can be sent from, in one list.
 *
 * A package owns its own prompts, so there is one registry per package that ships them,
 * and "which prompts does this product send" is a question about all of them at once.
 * `veyyon prompt --prompts` (the operator-facing listing) and the bench runner's check of
 * an arm's prompt overrides both need that complete view, and neither can build it safely
 * on its own. Declared here so the answer exists exactly once — the listing used to hold
 * its own copy, which is how the compaction prompts, the dialect format guides and the
 * hashline patch language were absent from a list that looked complete.
 *
 * NOTHING ON THE LAUNCH PATH IMPORTS THIS FILE. Its own graph is 250 modules — every
 * registry in four packages and the 197 prompt rows behind them — on the path a session
 * walks before it draws anything. The refusal at prompt assembly reads the generated id
 * list instead (`prompts/eval-overrides.ts`), which took prompt assembly from 718 modules
 * to 528, and `a-launch-does-not-build-every-prompt-registry.test.ts` fails if an edge to
 * this file returns.
 *
 * `@veyyon/bench`'s benchmark prompts are deliberately NOT here. They are asked
 * by a measurement harness, not by the agent, and the agent must not depend on the
 * harness that scores it.
 */
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import type { PromptRegistryView } from "@veyyon/utils";
import { codingAgentPrompts } from "./registry";

/**
 * The registries, coding-agent first.
 *
 * Order is meaningful in one place: a lookup miss is reported against the first
 * registry, whose ids are the ones an operator is most likely to have been typing, so a
 * near-miss suggestion comes from 160 candidates rather than from fourteen format guides.
 */
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
