import type { Api, Model } from "@veyyon/ai";
import { resolveModelRoleValue } from "../../../config/model-resolver";

export function barePickerSelector(raw: string | undefined, models: ReadonlyArray<Model<Api>>): string | undefined {
	if (!raw) return undefined;
	const resolved = resolveModelRoleValue(raw, models).model;
	return resolved ? `${resolved.provider}/${resolved.id}` : raw;
}

export function replaceModelChainEntry(
	chain: readonly string[],
	index: number | null,
	value: string,
	models: ReadonlyArray<Model<Api>>,
): string[] | undefined {
	const trimmed = value.trim();
	if (trimmed === "") return undefined;
	const bare = barePickerSelector(trimmed, models);
	const duplicate = chain.some(
		(candidate, candidateIndex) => candidateIndex !== index && barePickerSelector(candidate, models) === bare,
	);
	if (duplicate) return undefined;
	const next = chain.slice();
	if (index === null) {
		next.push(trimmed);
		return next;
	}
	if (!Number.isInteger(index) || index < 0 || index >= next.length) return undefined;
	next[index] = trimmed;
	return next;
}
