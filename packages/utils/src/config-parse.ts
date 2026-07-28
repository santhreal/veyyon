import * as path from "node:path";
import { YAML } from "bun";

/**
 * Parse a config file's text as YAML or JSON, choosing by its extension.
 *
 * It lives in its own module rather than in `json.ts` because it is the only
 * thing there that reaches for `Bun.YAML`, and `json.ts` is on the collab web
 * client's import graph: a `bun` builtin anywhere on that graph fails the
 * browser bundle outright ("Browser build cannot import Bun builtin"). Splitting
 * it keeps the JSON helpers usable in a browser and costs the two config readers
 * one import path.
 *
 * Every config surface in the product accepts both spellings, so every reader needs this one decision.
 * The LSP and DAP config readers each had a byte-identical private copy of it, which is a spelling of
 * "both files accept `.yaml`, `.yml` and everything else as JSON" that nothing kept in agreement.
 *
 * The YAML parser is Bun's, which is what both copies used, so moving the function changes no
 * behaviour. (`packages/utils` reaches YAML two ways -- `Bun.YAML` here, in `frontmatter.ts` and in
 * `dirs.ts`, the `yaml` package in `yaml-sync.ts` -- which is its own ONE PLACE question, recorded in
 * the backlog rather than settled by a drive-by change here.)
 *
 * Parse errors are NOT swallowed. A malformed config must reach the caller so it can name the file and
 * the line: a reader that returned null here would silently ignore a config the user is looking at.
 */
export function parseJsonOrYamlByExtension(content: string, filePath: string): unknown {
	const extension = path.extname(filePath).toLowerCase();
	if (extension === ".yaml" || extension === ".yml") {
		return YAML.parse(content) as unknown;
	}
	return JSON.parse(content) as unknown;
}
