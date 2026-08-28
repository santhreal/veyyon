/** Refuse a `VEYYON_EVAL_PROMPTS` id this build does not have. An unknown id must be fatal rather than ignored. An ignored override means the arm runs */
import { describeUnknownPromptIds, evalPromptOverrides, PROMPT_ID_SHAPE_HINT } from "@veyyon/utils";
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
		`VEYYON_EVAL_PROMPTS names ${unknown.length} prompt id(s) this build does not have:\n` +
			`${describeUnknownPromptIds(unknown, PROMPT_IDS)}\n` +
			`${PROMPT_ID_SHAPE_HINT}\n` +
			`\`veyyon prompt --prompts\` lists every id in ${PROMPT_REGISTRY_COUNT} registries.`,
	);
}
