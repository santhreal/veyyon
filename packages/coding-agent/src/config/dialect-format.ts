/**
 * Which tool-call syntax a model gets, resolved from the `tools.format` setting.
 *
 * WHY IT LIVES HERE. This was declared in `sdk.ts`, which is the package's largest module and
 * imports most of it. `system-prompt-builder/gate-inputs.ts` has to answer the same question,
 * because `tools.format` gates prompt text: when a dialect is resolved the prompt describes the
 * syntax inline, and when the provider handles tool calls natively it does not. Importing
 * `sdk.ts` from a module `sdk.ts` imports would close a cycle, so the function moved to the
 * leaf it always belonged in. `sdk.ts` re-exports both names, so nothing that imports them from
 * `@veyyon/coding-agent/sdk` changes.
 *
 * The function is pure and its only dependencies are the catalog's dialect identity helpers,
 * which is what made the move safe rather than a refactor with consequences.
 */

import type { Model } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
import { FALLBACK_DIALECT, preferredDialect } from "@veyyon/catalog/identity";

/** What `tools.format` may be set to: pick automatically, force native, or name a dialect. */
export type DialectFormat = "auto" | "native" | Dialect;

/**
 * The dialect to teach a model, or `undefined` when the provider takes tool calls natively.
 *
 * `undefined` is the native case rather than an error: the caller reads it as "send a real
 * `tools` parameter and put no syntax in the prompt". `auto` trusts the catalog unless the model
 * says `supportsTools: false`, and an unclassified model that cannot do native tools falls back
 * to `glm` rather than the catalog's own fallback, because the catalog's is a last resort for
 * identification while this is a choice about what a model can actually parse.
 */
export function resolveDialect(
	format: DialectFormat,
	model: (Pick<Model, "supportsTools"> & Partial<Pick<Model, "id">>) | undefined,
): Dialect | undefined {
	if (format === "native") return undefined;
	if (format === "auto") {
		if (model?.supportsTools !== false) return undefined;
		if (!model.id) return "glm";
		const preferred = preferredDialect(model.id);
		return preferred === FALLBACK_DIALECT ? "glm" : preferred;
	}
	return format;
}
