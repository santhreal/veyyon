import { announceEvalPromptOverrides, applyEvalPromptOverrides } from "./eval-prompt-overrides";
import { nearestNames } from "./levenshtein";

export interface PromptSection {
	readonly id: string;
	readonly name: string | null;
	readonly purpose: string;
	readonly optional: boolean;
}

export interface PromptEntry {
	readonly text: string;
	readonly purpose: string;
	readonly sections?: readonly PromptSection[];
}

export function definePromptRows<const T extends Record<string, PromptEntry>>(rows: T): T {
	const { prompts, appliedIds } = applyEvalPromptOverrides(rows);
	announceEvalPromptOverrides(appliedIds);
	return prompts as T;
}

export function requirePromptFrom<Entry extends PromptEntry>(
	registry: Readonly<Record<string, Entry>>,
	id: string,
	prompts: string,
): Entry {
	const found = Object.hasOwn(registry, id) ? registry[id] : undefined;
	if (found) return found;
	const near = nearestNames(id, Object.keys(registry), 3);
	const suggestion = near.length > 0 ? ` Did you mean ${near.map(name => `"${name}"`).join(", ")}?` : "";
	throw new Error(
		`unknown prompt "${id}" in ${prompts}; an id is the path under that directory without .md.${suggestion}`,
	);
}

export interface PromptRegistryView {
	readonly dir: string;
	readonly prompts: Readonly<Record<string, PromptEntry>>;
	readonly ids: readonly string[];
	require(id: string): PromptEntry;
	has(id: string): boolean;
	fileFor(id: string): string;
}

export interface PromptRegistry<T extends Record<string, PromptEntry> = Record<string, PromptEntry>>
	extends PromptRegistryView {
	readonly prompts: T;
	readonly ids: readonly (keyof T & string)[];
	text(id: keyof T & string): string;
}

export function definePromptRegistry<const T extends Record<string, PromptEntry>>(
	dir: string,
	prompts: T,
): PromptRegistry<T> {
	const { prompts: effective, appliedIds } = applyEvalPromptOverrides(prompts);
	announceEvalPromptOverrides(appliedIds);
	const ids = Object.keys(prompts) as (keyof T & string)[];
	return {
		dir,
		prompts: effective as T,
		ids,
		text: id => effective[id].text,
		require: id => requirePromptFrom(effective, id, dir),
		has: id => Object.hasOwn(effective, id),
		fileFor: id => `${dir}/${id}.md`,
	};
}
