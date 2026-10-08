import { isZeroCostXaiOAuthReference } from "../identity/reference";
import { getBundledModels, getBundledProviders } from "../models";
import type { Api, Model, ModelSpec } from "../types";

/**
 * Project a built `Model` back to spec stage: `compat` becomes the verbatim
 * sparse override record (`compatConfig`), never the resolved view. Discovery
 * mappers spread these references into the specs they hand to the model
 * manager, which rebuilds via `buildModel`.
 */
export function toModelSpec<TApi extends Api>(model: Model<TApi>): ModelSpec<TApi> {
	const { compat: _compat, compatConfig, ...rest } = model;
	return { ...rest, compat: compatConfig } as ModelSpec<TApi>;
}

export function createBundledReferenceMap<TApi extends Api>(
	provider: Parameters<typeof getBundledModels>[0],
): Map<string, ModelSpec<TApi>> {
	const references = new Map<string, ModelSpec<TApi>>();
	for (const model of getBundledModels(provider)) {
		references.set(model.id, toModelSpec(model as Model<TApi>));
	}
	return references;
}

/**
 * Resolve a discovered model id to its bundled spec: the provider's own reference first, then the
 * best reference any bundled provider holds. The cross-provider index builds every bundled provider's
 * models, so it is built on the first id `providerRefs` misses, not when the resolver is created: a
 * model manager's options are created for providers that never run a discovery.
 */
export function createReferenceResolver<TApi extends Api>(
	providerRefs: Map<string, ModelSpec<TApi>>,
): (modelId: string) => ModelSpec<TApi> | undefined {
	let globalRefs: Map<string, Model<Api>> | undefined;
	return (modelId: string) => {
		const providerRef = providerRefs.get(modelId);
		if (providerRef) return providerRef;
		globalRefs ??= buildGlobalReferences();
		const globalRef = globalRefs.get(modelId);
		return globalRef ? toModelSpec(globalRef as Model<TApi>) : undefined;
	};
}

function buildGlobalReferences(): Map<string, Model<Api>> {
	const globalRefs = new Map<string, Model<Api>>();
	for (const provider of getBundledProviders()) {
		for (const model of getBundledModels(provider as Parameters<typeof getBundledModels>[0])) {
			const candidate = model as Model<Api>;
			if (isZeroCostXaiOAuthReference(candidate)) {
				continue;
			}
			const existing = globalRefs.get(candidate.id);
			if (!existing) {
				globalRefs.set(candidate.id, candidate);
			} else if (candidate.contextWindow !== existing.contextWindow) {
				if ((candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0)) {
					globalRefs.set(candidate.id, candidate);
				}
			} else if (candidate.maxTokens !== existing.maxTokens) {
				if ((candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0)) {
					globalRefs.set(candidate.id, candidate);
				}
			} else if (existing.provider !== "openai" && candidate.provider === "openai") {
				globalRefs.set(candidate.id, candidate);
			}
		}
	}
	return globalRefs;
}
