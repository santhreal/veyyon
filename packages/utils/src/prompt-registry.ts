/**
 * What a prompt registry IS, for every package that ships prompts.
 *
 * A registry is one module that imports every `.md` its package sends a model and
 * lists it with an id and a purpose. The import IS the registration, so the file's
 * location exists exactly once and typechecks, and a row cannot describe a document
 * that is not there.
 *
 * WHY THE CONTRACT LIVES HERE AND NOT IN A REGISTRY. Four packages ship prompts
 * (`coding-agent`, `agent-core`, `ai`, `metaharness`) and each needs the same row
 * type. Written per package that is four declarations of one concept, which is the
 * failure this file exists to end: `PromptEntry` was already declared twice, and the
 * two copies had diverged — the `agent-core` copy had no `sections` field, so a
 * prompt registered there could not describe how it divides even when it did.
 *
 * `@veyyon/utils` is the only package all four already depend on, and the contract
 * needs nothing from any of them, so it is a leaf: registries import the shape, and
 * nothing here knows what a particular prompt says.
 *
 * The banner GRAMMAR (how a section's name is written and recognised) is a separate
 * concern and lives with the parser that reads it. This file describes what a row
 * claims; the grammar decides what the bytes look like.
 */

import { nearestNames } from "./levenshtein";

/**
 * A banner-delimited region of a prompt — ANY prompt in the product.
 *
 * The one description of what a section is. Registries build their row types on it:
 * the system prompt's `section-registry.ts` adds `source` and `input`, every other
 * registry uses it as-is. They were separate interfaces, both exported as
 * `PromptSection` from sibling modules, so a reader importing "the" `PromptSection`
 * got whichever their editor offered, and each had grown a field the other lacked.
 */
export interface PromptSection {
	readonly id: string;
	/**
	 * The banner's name line, or `null` for a section with no banner.
	 *
	 * The NAME, never the rendered banner. The banner grammar owns the underline, so
	 * a row cannot ship a width of its own and the name stays readable without
	 * parsing it back out of a two-line string.
	 */
	readonly name: string | null;
	/** One line on what the section carries, so a registry is self-describing. */
	readonly purpose: string;
	/**
	 * Whether this section is allowed to be absent from an assembled prompt.
	 *
	 * The field that makes an inspection meaningful, and it is a CLAIM rather than a
	 * note: an absent optional section is a feature being off, an absent required one
	 * means assembly broke, and a reader who cannot tell those apart cannot tell a
	 * correct minimal prompt from a truncated one.
	 *
	 * `system-prompt-section-presence.test.ts` holds the system prompt's rows to that
	 * in both directions, so the flag cannot quietly become decoration: a required
	 * section must render with the barest possible options, and an optional one must
	 * be absent until its input is supplied.
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
 * A prompt looked up by an id that is not statically known.
 *
 * THROWS rather than returning undefined, and that is the whole point of the
 * function. An unknown id degrading to a missing prompt means the model silently
 * receives nothing where instructions belonged, which reads downstream as the model
 * ignoring its brief rather than as the bug it is. Every registry uses this one
 * lookup so no package can quietly answer the same question with `?? ""`.
 *
 * @param registry the package's prompt table
 * @param id the path under that package's `src/prompts/`, without `.md`
 * @param prompts where the ids come from, named in the error so the reader can look
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
 * A package's prompts, and everything derivable from them.
 *
 * WHY A DESCRIPTOR AND NOT FIVE EXPORTS PER PACKAGE. The registry's whole claim is that
 * a prompt's location exists exactly ONCE, as an import the compiler checks. The
 * DIRECTORY those ids are paths under was then written down four and five times: in the
 * registry, in `veyyon prompt`'s table of registries, in the coverage suite's owner
 * list, in that suite's CLI counterpart, and in the generated prompt inventory. The
 * inventory's copy had already gone stale, listing three directories under a doc comment
 * claiming one per package, while two packages' prompts were missing from it entirely.
 * That is the same defect the registry replaced, one level up: the set of registries had
 * no owner, so every consumer restated it.
 *
 * A registry now says where it lives once, and a consumer takes the descriptor instead
 * of a path it typed itself. The derivations that were hand-written per package come
 * with it: the id list, the text lookup, the refusing lookup, and the file path.
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
 * One package's registry, with its ids known statically.
 *
 * SPLIT FROM {@link PromptRegistryView} because a generic consumer cannot hold this type.
 * `text` takes `keyof T & string`, which makes the parameter contravariant in `T`, so a
 * `PromptRegistry<the coding agent's 163 rows>` is not assignable to a
 * `PromptRegistry<Record<string, PromptEntry>>` and a list of every registry would not
 * typecheck. The view is what crossing registries needs, and it is the smaller surface:
 * an id held in a variable goes through `require`, which refuses an unknown one, so the
 * generic path cannot reach for a prompt without handling its absence.
 */
export interface PromptRegistry<T extends Record<string, PromptEntry> = Record<string, PromptEntry>>
	extends PromptRegistryView {
	/** The rows, with literal keys, so `prompts["some/id"].text` typechecks. */
	readonly prompts: T;
	/** Every registered id, narrowed to the ids that exist. */
	readonly ids: readonly (keyof T & string)[];
	/**
	 * The text of a registered prompt.
	 *
	 * `prompts[id].text` is equivalent and preferred where the id is a literal. This
	 * exists for the paths that carry an id in a variable, where the indexed form would
	 * otherwise widen to `string`.
	 */
	text(id: keyof T & string): string;
}

/**
 * Build a package's prompt registry from its rows.
 *
 * The `const` type parameter is what makes one construct do the work of two: it infers
 * the object's keys as literals AND checks each row against {@link PromptEntry}, which
 * is exactly what `as const satisfies Record<string, PromptEntry>` did at each call site.
 * A plain (non-`const`) parameter would widen every key to `string` and leave the id
 * union with no members to derive, which is the same widening an explicit
 * `readonly PromptEntry[]` annotation causes on a section list.
 *
 * @param dir repository-relative directory holding the `.md` files, without a trailing slash
 * @param prompts every row, keyed by the file's path under `dir` without `.md`
 */
export function definePromptRegistry<const T extends Record<string, PromptEntry>>(
	dir: string,
	prompts: T,
): PromptRegistry<T> {
	const ids = Object.keys(prompts) as (keyof T & string)[];
	return {
		dir,
		prompts,
		ids,
		text: id => prompts[id].text,
		require: id => requirePromptFrom(prompts as Record<string, PromptEntry>, id, dir),
		has: id => Object.hasOwn(prompts, id),
		fileFor: id => `${dir}/${id}.md`,
	};
}
