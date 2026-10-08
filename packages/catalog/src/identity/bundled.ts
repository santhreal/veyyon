/**
 * Proxy-reference lookup over the bundled model catalog.
 *
 * A scalar lookup ({@link resolveBundledModelReference}) reads the catalog's model ids and parses
 * only the models whose ids reach the lookup's keys, then enriches the matched model's provider. The
 * full index ({@link getBundledModelReferenceIndex}) enriches every provider and is built once, on
 * first request. Consumers that need non-bundled reference data use the pure builder directly
 * ({@link buildModelReferenceIndex}).
 */
import {
	type BundledModelKeys,
	type GeneratedProvider,
	getBundledModel,
	getBundledModels,
	getBundledProviders,
	readBundledModelKeys,
} from "../models";
import type { Api, Model } from "../types";
import {
	buildModelReferenceIndex,
	createLazyModelReferenceIndex,
	type ModelReferenceCandidate,
	type ModelReferenceIndex,
	type ModelReferenceLookup,
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

/**
 * The lookup over one read of the catalog's model ids. Keyed weakly: the read is released when the
 * task that made it ends, and the lookup and the records it parsed go with it.
 */
const metadataLookups = new WeakMap<BundledModelKeys, ModelReferenceLookup<ModelReferenceCandidate>>();

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
	const keys = readBundledModelKeys();
	let lookup = metadataLookups.get(keys);
	if (lookup === undefined) {
		lookup = createLazyModelReferenceIndex(keys.ids, keys.candidateAt);
		metadataLookups.set(keys, lookup);
	}
	const candidate = resolveModelReference(modelId, lookup);
	if (!candidate) {
		return undefined;
	}
	return getBundledModel(candidate.provider as GeneratedProvider, candidate.id);
}
