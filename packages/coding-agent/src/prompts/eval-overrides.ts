/**
 * Refuse a `VEYYON_EVAL_PROMPTS` id this build does not have.
 *
 * An unknown id must be fatal rather than ignored. An ignored override means the arm runs
 * the shipped prompt while the results table calls it a treatment — a zero-IV comparison
 * wearing a name, which is worse than a crash because it looks like a result.
 *
 * THE CHECK READS THE GENERATED ID LIST, not the registries. Two reasons. The id space is
 * the whole build's, so an id belonging to a sibling package is accepted here without
 * depending on which registry a given import order happened to construct first — the
 * defect that once killed a valid `tools/bash` override at startup. And prompt assembly is
 * on the launch path, so reaching the aggregate built all four registries and 197 prompt
 * rows to answer a question about an environment variable almost no session sets: the
 * assembler reached 718 modules with that edge and 528 without it.
 *
 * The bench runner performs the same check before it starts a container
 * (`packages/evals/suites/deep-swe/runner/preflight.ts`), so a typo normally costs nothing. This is the
 * backstop for every other way the variable can be set.
 */
import { describeUnknownPromptIds, evalPromptOverrides, formatCount, PROMPT_ID_SHAPE_HINT } from "@veyyon/utils";
import { PROMPT_IDS, PROMPT_REGISTRY_COUNT } from "./ids.generated";

/** Ids the override names that this build has no prompt for. */
export function unknownEvalPromptOverrideIds(): readonly string[] {
	return Object.keys(evalPromptOverrides()).filter(id => !PROMPT_IDS.includes(id));
}

/** Throw with every unknown id, its nearest real ids, and what an id is. */
export function assertEvalPromptOverrideIdsExist(): void {
	const unknown = unknownEvalPromptOverrideIds();
	if (unknown.length === 0) return;
	throw new Error(
		`VEYYON_EVAL_PROMPTS names ${formatCount("prompt id", unknown.length)} this build does not have:\n` +
			`${describeUnknownPromptIds(unknown, PROMPT_IDS)}\n` +
			`${PROMPT_ID_SHAPE_HINT}\n` +
			`\`veyyon prompt --prompts\` lists every id in ${PROMPT_REGISTRY_COUNT} registries.`,
	);
}
