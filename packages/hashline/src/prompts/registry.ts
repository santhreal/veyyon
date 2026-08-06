/**
 * The prompt this package sends a model, owned in ONE place.
 *
 * Hashline ships one: the patch language's description, which is what teaches a model
 * to write a hashline edit. It is registered for the same two reasons a package with a
 * hundred prompts registers them.
 *
 * IT IS LISTABLE. `veyyon prompt --prompts` enumerates the registries, so a prompt with
 * no row is a prompt an operator cannot find, and the edit tool's description was the
 * one tool description missing from that list while every other tool's was in it.
 *
 * NOTHING ELSE IMPORTS THE FILE. `packages/hashline/src/prompt.md` is also published
 * through this package's exports map, and the coding agent imported it that way.
 * Publishing the raw file stays: an external consumer embedding hashline in their own
 * agent needs the text, and the subpath is public API. What changes is that consumers
 * inside this repository take it from the row, so the tool description reaches the model
 * through the same lookup every other prompt does, and the coverage check that says
 * "only a registry imports a prompt" holds with no exceptions at all rather than one
 * carved out for this file.
 */
// The owner leaf, not the `@veyyon/utils` barrel: this is the package's ONLY runtime edge into
// utils, so what it costs is what every consumer of this subpath pays.
import { definePromptRegistry, type PromptEntry } from "@veyyon/utils/prompt-registry";
import promptDescription from "../prompt.md" with { type: "text" };

export type { PromptEntry };

/**
 * Every prompt this package sends, by id.
 *
 * The id is the file's path under `src/` without its extension. Other packages key
 * theirs under a `src/prompts/` directory; here the file predates the registry and is
 * published at `@veyyon/hashline/prompt.md`, so moving it would break a public subpath
 * for one prompt's worth of tidiness.
 */
export const hashlinePrompts = definePromptRegistry("packages/hashline/src", {
	prompt: {
		text: promptDescription,
		purpose: "the hashline patch language, as the edit tool's description",
	},
});

/** The rows, for a call site that indexes a literal id. */
export const HASHLINE_PROMPTS = hashlinePrompts.prompts;

/**
 * Nothing else is exported. `hashlinePrompts` already carries the id list, the lookups and
 * the file path, so a package-specific alias for each would be one value under two names.
 * Index `HASHLINE_PROMPTS` where the id is a literal; go through `hashlinePrompts.require`
 * where it is not, because that throws rather than yielding a prompt with no text.
 */
