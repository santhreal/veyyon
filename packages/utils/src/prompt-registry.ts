/**
 * Core prompt registry contract and types shared across packages.
 * Provides a single shape for registering and resolving prompt files and their sections.
 */
import { announceEvalPromptOverrides, applyEvalPromptOverrides } from "./eval-prompt-overrides";
import { nearestNames } from "./levenshtein";

/**
 * A banner-delimited region of a prompt.
 * Shared interface across all packages for describing structured prompt sections.
 */
export interface PromptSection {
	readonly id: string;
	/**
	 * The banner's name line without formatting, or `null` if unbannered.
	 */
	readonly name: string | null;
	/** One line on what the section carries, so a registry is self-describing. */
	readonly purpose: string;
	/**
	 * Whether this section may be omitted from an assembled prompt.
	 * Used by inspection tests to distinguish optional features from broken prompt assembly.
	 */
	readonly optional: boolean;
}

/** One prompt: its text, what it is for, and how it divides. */
export interface PromptEntry {
	readonly text: string;
	/** One line on what this prompt does, so the registry reads as a list rather than a directory. */
	readonly purpose: string;
	/** Present only where a prompt has addressable regions; absent means one undivided body. */
	readonly sections?: readonly PromptSection[];
}

/**
 * Declares a directory's prompt rows, applying any active eval prompt overrides.
 * Text is substituted at read time so every consumer sees the effective prompt.
 */
export function definePromptRows<const T extends Record<string, PromptEntry>>(rows: T): T {
	const { prompts, appliedIds } = applyEvalPromptOverrides(rows);
	announceEvalPromptOverrides(appliedIds);
	return prompts as T;
}

/**
 * Looks up a prompt by id in the given registry, throwing if not found.
 *
 * @param registry package prompt table
 * @param id path under the package prompts directory without `.md`
 * @param prompts prompt directory name for error messages
 */
export function requirePromptFrom<Entry extends PromptEntry>(
	registry: Readonly<Record<string, Entry>>,
	id: string,
	prompts: string,
): Entry {
	// `Object.hasOwn` rather than a plain index, because an index consults the
	// prototype: `registry["toString"]` finds `Object.prototype.toString` and returns
	// a truthy FUNCTION, so a caller carrying an id from a config field or a bad parse
	// got a function where a row belonged and `.text` on it was `undefined`. That is
	// the empty-prompt bug this function exists to prevent, arriving by the one route
	// the guard did not cover.
	const found = Object.hasOwn(registry, id) ? registry[id] : undefined;
	if (found) return found;
	// The near misses, not the whole table: a typo in one of 160 ids is answered by
	// three candidates, where a full listing is a wall the reader has to search.
	const near = nearestNames(id, Object.keys(registry), 3);
	const suggestion = near.length > 0 ? ` Did you mean ${near.map(name => `"${name}"`).join(", ")}?` : "";
	throw new Error(
		`unknown prompt "${id}" in ${prompts}; an id is the path under that directory without .md.${suggestion}`,
	);
}

/**
 * Self-describing view over a package's prompt registry and derived helpers.
 * Encapsulates prompt lookup, presence checks, and file path resolution.
 */
export interface PromptRegistryView {
	/**
	 * Repository-relative directory the ids are paths under, stated once here.
	 *
	 * Repository-relative rather than absolute so it can be printed to an operator and
	 * pasted into an editor, which is what `veyyon prompt --prompt <id>` does with it.
	 */
	readonly dir: string;
	/** The rows, keyed by id. */
	readonly prompts: Readonly<Record<string, PromptEntry>>;
	/** Every registered id, for enumeration (inspection commands, coverage checks). */
	readonly ids: readonly string[];
	/** A prompt by an id that is not statically known, refusing an unknown one. */
	require(id: string): PromptEntry;
	/** Whether this registry holds the id, so a caller can pick between registries. */
	has(id: string): boolean;
	/**
	 * Where a registered prompt's file lives, COMPUTED from its id.
	 *
	 * An earlier registry stored this beside each row as a string the compiler cannot
	 * see, so a rename left a row describing a file that was not there. Since the id IS
	 * the path under {@link dir}, one line reconstructs it and the two cannot disagree.
	 */
	fileFor(id: string): string;
}

/**
 * Typed prompt registry with statically-known prompt ids.
 * Narrower variant of {@link PromptRegistryView} preserving literal key types.
 */
export interface PromptRegistry<T extends Record<string, PromptEntry> = Record<string, PromptEntry>>
	extends PromptRegistryView {
	/** The rows, with literal keys, so `prompts["some/id"].text` typechecks. */
	readonly prompts: T;
	/** Every registered id, narrowed to the ids that exist. */
	readonly ids: readonly (keyof T & string)[];
	/**
	 * Returns the text of a registered prompt by literal or dynamic id.
	 */
	text(id: keyof T & string): string;
}

/**
 * Builds a typed prompt registry from a table of prompt rows.
 *
 * @param dir repository-relative directory holding prompt markdown files
 * @param prompts prompt row map keyed by relative path without `.md`
 */
export function definePromptRegistry<const T extends Record<string, PromptEntry>>(
	dir: string,
	prompts: T,
): PromptRegistry<T> {
	// The production path is the identity path. A registry is read once per tool per
	// turn, so an unconditional spread or a per-read sweep would be paid by every
	// session to serve a benchmark that is not running; with no override set,
	// `applyEvalPromptOverrides` hands back this very table and the accessors below
	// close over it directly.
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
