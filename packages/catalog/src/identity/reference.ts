import type { Api, Model } from "../types";
import { getBracketStrippedModelIdCandidates, getLongestModelLikeIdSegment, getModelLikeIdSegments } from "./id";
import { REFERENCE_TRAILING_MARKER_PATTERN } from "./markers";

export interface ModelReferenceIndex {
	exact: Map<string, Model<Api>>;
	suffixAlias: Map<string, Model<Api>>;
}

export function isZeroCostXaiOAuthReference(candidate: Model<Api>): boolean {
	return (
		candidate.provider === "xai-oauth" &&
		candidate.cost.input === 0 &&
		candidate.cost.output === 0 &&
		candidate.cost.cacheRead === 0 &&
		candidate.cost.cacheWrite === 0
	);
}

function shouldReplaceReference(existing: Model<Api> | undefined, candidate: Model<Api>): boolean {
	if (!existing) return true;
	if (candidate.contextWindow !== existing.contextWindow) {
		return (candidate.contextWindow ?? 0) > (existing.contextWindow ?? 0);
	}
	if (candidate.maxTokens !== existing.maxTokens) {
		return (candidate.maxTokens ?? 0) > (existing.maxTokens ?? 0);
	}
	const existingHasCachePricing = existing.cost.cacheRead > 0 || existing.cost.cacheWrite > 0;
	const candidateHasCachePricing = candidate.cost.cacheRead > 0 || candidate.cost.cacheWrite > 0;
	if (candidateHasCachePricing !== existingHasCachePricing) {
		return candidateHasCachePricing;
	}
	return existing.provider !== "openai" && candidate.provider === "openai";
}

function normalizeReferenceKey(value: string): string {
	return value.trim().toLowerCase();
}

export function buildModelReferenceIndex(models: Iterable<Model<Api>>): ModelReferenceIndex {
	const exact = new Map<string, Model<Api>>();
	for (const candidate of models) {
		if (isZeroCostXaiOAuthReference(candidate)) {
			continue;
		}
		const key = normalizeReferenceKey(candidate.id);
		if (shouldReplaceReference(exact.get(key), candidate)) {
			exact.set(key, candidate);
		}
	}
	return { exact, suffixAlias: buildSuffixAliasMap(exact) };
}

function buildSuffixAliasMap(exactReferences: ReadonlyMap<string, Model<Api>>): Map<string, Model<Api>> {
	const aliases = new Map<string, Model<Api>>();
	for (const reference of exactReferences.values()) {
		const slashIndex = reference.id.lastIndexOf("/");
		if (slashIndex === -1) {
			continue;
		}
		const suffix = reference.id.slice(slashIndex + 1);
		const alias = getLongestModelLikeIdSegment(suffix);
		if (!alias) {
			continue;
		}
		if (shouldReplaceReference(aliases.get(alias), reference)) {
			aliases.set(alias, reference);
		}
	}
	return aliases;
}

function stripReferenceTrailingMarker(candidate: string): string | undefined {
	const match = REFERENCE_TRAILING_MARKER_PATTERN.exec(candidate);
	return match ? candidate.slice(0, match.index) : undefined;
}

function getReferenceCandidateIds(modelId: string): string[] {
	const candidates = new Set<string>();
	const queue = [modelId];
	for (let index = 0; index < queue.length; index += 1) {
		const candidate = queue[index]?.trim();
		if (!candidate || candidates.has(candidate)) continue;
		candidates.add(candidate);

		for (const stripped of getBracketStrippedModelIdCandidates(candidate)) {
			queue.push(stripped);
		}
		for (const segment of getModelLikeIdSegments(candidate)) {
			queue.push(segment);
		}

		for (const suffix of [":cloud", "-cloud"] as const) {
			if (candidate.toLowerCase().endsWith(suffix)) {
				queue.push(candidate.slice(0, -suffix.length));
			}
		}

		const slashIndex = candidate.lastIndexOf("/");
		if (slashIndex !== -1) {
			queue.push(candidate.slice(slashIndex + 1));
		}

		const colonToDash = candidate.replace(/:/g, "-");
		if (colonToDash !== candidate) {
			queue.push(colonToDash);
		}

		const lowercased = candidate.toLowerCase();
		if (lowercased !== candidate) {
			queue.push(lowercased);
		}

		const strippedMarker = stripReferenceTrailingMarker(candidate);
		if (strippedMarker) {
			queue.push(strippedMarker);
		}
	}
	return Array.from(candidates);
}

export function resolveModelReference(modelId: string, index: ModelReferenceIndex): Model<Api> | undefined {
	for (const candidate of getReferenceCandidateIds(modelId)) {
		const key = normalizeReferenceKey(candidate);
		const reference = index.exact.get(key) ?? index.suffixAlias.get(key);
		if (reference) return reference;
	}
	return undefined;
}
