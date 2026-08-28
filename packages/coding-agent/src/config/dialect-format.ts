/** Which tool-call syntax a model gets, resolved from the `tools.format` setting. imports most of it. `system-prompt-builder/gate-inputs.ts` has to answer the same question, */

import type { Model } from "@veyyon/ai";
import type { Dialect } from "@veyyon/ai/dialect";
import { FALLBACK_DIALECT, preferredDialect } from "@veyyon/catalog/identity";

/** What `tools.format` may be set to: pick automatically, force native, or name a dialect. */
export type DialectFormat = "auto" | "native" | Dialect;

/** The dialect to teach a model, or `undefined` when the provider takes tool calls natively. `undefined` is the native case rather than an error: the caller reads it as "send a real */
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
