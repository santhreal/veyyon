/**
 * Every prompt registry a model can be sent from, in one list.
 *
 * A package owns its own prompts, so there is one registry per package that ships
 * them, and "which prompts does this product send" is a question about all of them at
 * once. Two callers need that complete view and neither can build it safely on its own:
 * `veyyon prompt --prompts` (the operator-facing listing) and the eval-only prompt
 * override, which can only tell a typo from a sibling package's id once every registry
 * is known. Declared here so the answer exists exactly once — the listing used to hold
 * its own copy, which is how the compaction prompts, the dialect format guides and the
 * hashline patch language were absent from a list that looked complete.
 *
 * `@veyyon/metaharness`'s benchmark prompts are deliberately NOT here. They are asked
 * by a measurement harness, not by the agent, and the agent must not depend on the
 * harness that scores it.
 */
import { agentCorePrompts } from "@veyyon/agent-core/prompts/registry";
import { aiPrompts } from "@veyyon/ai/prompts/registry";
import { hashlinePrompts } from "@veyyon/hashline/prompts/registry";
import {
	describeUnknownPromptIds,
	PROMPT_ID_SHAPE_HINT,
	type PromptRegistryView,
	unclaimedEvalPromptOverrideIds,
} from "@veyyon/utils";
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

/**
 * Refuse a `VEYYON_EVAL_PROMPTS` id that no registry holds.
 *
 * WHY HERE AND NOT IN THE REGISTRY. A single registry cannot distinguish a typo from an
 * id a sibling owns, and guessing produced the worst outcome an eval has: the first
 * version refused from inside `definePromptRegistry`, `@veyyon/ai`'s registry is built
 * before this package's, and a valid `tools/bash` override therefore killed the agent at
 * startup in every trial of the arm. This list is the complete id space, so here the
 * question has an answer.
 *
 * An unknown id must be fatal rather than ignored. An ignored override means the arm
 * runs the shipped prompt while the results table calls it a treatment — a zero-IV
 * comparison wearing a name, which is worse than a crash because it looks like a result.
 *
 * The bench runner performs the same check before it starts a container
 * (`packages/deepswe-bench/arm-prompts.ts`), so a typo normally costs nothing. This is
 * the backstop for every other way the variable can be set.
 */
export function assertEvalPromptOverridesClaimed(): void {
	const unclaimed = unclaimedEvalPromptOverrideIds();
	if (unclaimed.length === 0) return;
	throw new Error(
		`VEYYON_EVAL_PROMPTS names ${unclaimed.length} prompt id(s) no registry holds:\n` +
			`${describeUnknownPromptIds(unclaimed, allPromptIds())}\n` +
			`${PROMPT_ID_SHAPE_HINT}\n` +
			`\`veyyon prompt --prompts\` lists every id in ${PROMPT_REGISTRIES.length} registries.`,
	);
}
