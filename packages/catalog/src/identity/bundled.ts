/**
 * Memoized proxy-reference index over the bundled model catalog.
 *
 * Lazy: walking every bundled model (~12K) triggers thinking enrichment, so the
 * walk is deferred off module load and performed once. Consumers that need
 * non-bundled reference data use the pure builder directly
 * ({@link buildModelReferenceIndex}).
 */
import {
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	iterateBundledModelMetadata,
	type GeneratedProvider,
} from "../models";
import type { Api, Model } from "../types";
import {
	buildModelReferenceIndex,
	type ModelReferenceCandidate,
	type ModelReferenceIndex,
	resolveModelReference,
} from "./reference";

let bundledModels: readonly Model<Api>[] | undefined;

function getBundledModelList(): readonly Model<Api>[] {
	bundledModels ??= getBundledProviders().flatMap(
		provider => getBundledModels(provider as Parameters<typeof getBundledModels>[0]) as Model<Api>[],
	);
	return bundledModels;
}

let referenceIndex: ModelReferenceIndex | undefined;
let metadataReferenceIndex: ModelReferenceIndex<ModelReferenceCandidate> | undefined;

/** Proxy-reference index over the bundled catalog. */
export function getBundledModelReferenceIndex(): ModelReferenceIndex {
	referenceIndex ??= buildModelReferenceIndex(getBundledModelList());
	return referenceIndex;
}

/**
 * Resolve a (possibly proxied/affixed) model id to its bundled upstream reference,
 * enriching only the matched model's provider rather than the entire catalog.
 */
export function resolveBundledModelReference(modelId: string): Model<Api> | undefined {
	if (referenceIndex) {
		return resolveModelReference(modelId, referenceIndex);
	}
	metadataReferenceIndex ??= buildModelReferenceIndex(iterateBundledModelMetadata());
	const candidate = resolveModelReference(modelId, metadataReferenceIndex);
	if (!candidate) {
		return undefined;
	}
	return getBundledModel(candidate.provider as GeneratedProvider, candidate.id);
}
