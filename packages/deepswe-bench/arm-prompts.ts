import { allPromptIds } from "@veyyon/coding-agent/prompts/all-registries";
import { describeUnknownPromptIds, PROMPT_ID_SHAPE_HINT } from "@veyyon/utils";

export function knownPromptIds(): readonly string[] {
	return [...allPromptIds()].sort();
}

export function promptOverrideIdError(
	arm: string,
	overrides: Readonly<Record<string, unknown>>,
	known: readonly string[] = knownPromptIds(),
): string | null {
	const unknownIds = Object.keys(overrides).filter(id => !known.includes(id));
	if (unknownIds.length === 0) return null;

	return (
		`arm "${arm}" arms/${arm}.prompts.yml names ${unknownIds.length} prompt id(s) that no registry holds:\n` +
		`${describeUnknownPromptIds(unknownIds, known)}\n` +
		`${PROMPT_ID_SHAPE_HINT}\n` +
		`Fix: run \`veyyon prompt --prompts\` to list all ${known.length} ids, or drop the key.`
	);
}
