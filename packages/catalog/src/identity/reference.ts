/**
 * Proxy/reseller reference lookup: given a custom model id served through a
 * proxy (`[Kiro] claude-opus-4-8`, `gpt-5.4:cloud`, `vendor/claude-sonnet-4-6-thinking`),
 * find the bundled upstream model so missing pricing/capability metadata can be
 * inherited while keeping the custom transport.
 *
 * Kept separate from canonical-id resolution (`./equivalence`): this lookup
 * may strip `search`-style markers and prefers cache-pricing-complete
 * references, both of which would be wrong for canonical coalescing.
 */
import type { Api, Model } from "../types";
import { getBracketStrippedModelIdCandidates, getLongestModelLikeIdSegment, getModelLikeIdSegments } from "./id";
import { REFERENCE_TRAILING_MARKER_PATTERN } from "./markers";

export type ModelReferenceCandidate = Pick<Model<Api>, "id" | "provider" | "cost"> &
	Partial<Pick<Model<Api>, "contextWindow" | "maxTokens">>;

export interface ModelReferenceIndex<TCandidate extends ModelReferenceCandidate = Model<Api>> {
	exact: Map<string, TCandidate>;
	suffixAlias: Map<string, TCandidate>;
}

/** What {@link resolveModelReference} reads from an index: a reference per exact key and per suffix alias. */
export interface ModelReferenceLookup<TCandidate extends ModelReferenceCandidate = Model<Api>> {
	exact: { get(key: string): TCandidate | undefined };
	suffixAlias: { get(key: string): TCandidate | undefined };
}

// xai-oauth subscription entries carry zero public pricing and inflated maxTokens;
// keep them provider-local so they cannot outrank paid/public Grok references.
export function isZeroCostXaiOAuthReference(candidate: ModelReferenceCandidate): boolean {
	return (
		candidate.provider === "xai-oauth" &&
		candidate.cost.input === 0 &&
		candidate.cost.output === 0 &&
		candidate.cost.cacheRead === 0 &&
		candidate.cost.cacheWrite === 0
	);
}

// Prefer the reference with the largest limits and complete cache pricing, then
// first-party OpenAI entries.
function shouldReplaceReference<TCandidate extends ModelReferenceCandidate>(
	existing: TCandidate | undefined,
	candidate: TCandidate,
): boolean {
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

/**
 * Build a reference index from a model catalog (typically the bundled models).
 * Pure: callers are responsible for memoizing the result.
 */
export function buildModelReferenceIndex(models: Iterable<Model<Api>>): ModelReferenceIndex;
export function buildModelReferenceIndex<TCandidate extends ModelReferenceCandidate>(
	models: Iterable<TCandidate>,
): ModelReferenceIndex<TCandidate>;
export function buildModelReferenceIndex<TCandidate extends ModelReferenceCandidate = Model<Api>>(
	models: Iterable<TCandidate>,
): ModelReferenceIndex<TCandidate> {
	const exact = new Map<string, TCandidate>();
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

function buildSuffixAliasMap<TCandidate extends ModelReferenceCandidate>(
	exactReferences: ReadonlyMap<string, TCandidate>,
): Map<string, TCandidate> {
	const aliases = new Map<string, TCandidate>();
	for (const reference of exactReferences.values()) {
		const alias = suffixAliasKey(reference.id);
		if (alias === undefined) {
			continue;
		}
		if (shouldReplaceReference(aliases.get(alias), reference)) {
			aliases.set(alias, reference);
		}
	}
	return aliases;
}

/** The suffix-alias key of a reference id: the longest model-like segment after its last slash. */
function suffixAliasKey(id: string): string | undefined {
	const slashIndex = id.lastIndexOf("/");
	return slashIndex === -1 ? undefined : getLongestModelLikeIdSegment(id.slice(slashIndex + 1));
}

/** One or more catalog ordinals; a key reached by one model, the common case, holds a bare number. */
type Ordinals = number | number[];

function addOrdinal(map: Map<string, Ordinals>, key: string, ordinal: number): void {
	const existing = map.get(key);
	if (existing === undefined) map.set(key, ordinal);
	else if (typeof existing === "number") map.set(key, [existing, ordinal]);
	else existing.push(ordinal);
}

/**
 * The same lookups {@link buildModelReferenceIndex} answers over `ids.map(candidateAt)`, built from
 * the ids alone: a lookup reads, through `candidateAt`, only the candidates whose id reaches its key.
 * `ids[i]` must be the id of `candidateAt(i)`, and the ids must be in the order the eager builder
 * would iterate the candidates, since ties keep the earlier reference. Each candidate is read once.
 */
export function createLazyModelReferenceIndex<TCandidate extends ModelReferenceCandidate>(
	ids: readonly string[],
	candidateAt: (ordinal: number) => TCandidate,
): ModelReferenceLookup<TCandidate> {
	const exactOrdinals = new Map<string, Ordinals>();
	// Keyed by each id's own alias. The eager builder keys a group's winner by the winner's alias, and
	// every member of a group has the same alias: the group is one lowercase id, and the alias is
	// lowercase. So the groups a key reaches are the groups of the ids listed under it.
	const aliasOrdinals = new Map<string, Ordinals>();
	for (let ordinal = 0; ordinal < ids.length; ordinal++) {
		const id = ids[ordinal];
		addOrdinal(exactOrdinals, normalizeReferenceKey(id), ordinal);
		const alias = suffixAliasKey(id);
		if (alias !== undefined) addOrdinal(aliasOrdinals, alias, ordinal);
	}
	const read = new Map<number, TCandidate>();
	const readCandidate = (ordinal: number): TCandidate => {
		let candidate = read.get(ordinal);
		if (candidate === undefined) {
			candidate = candidateAt(ordinal);
			read.set(ordinal, candidate);
		}
		return candidate;
	};
	// The eager exact entry of a group: its winner, and the ordinal that inserted it (the first member
	// not excluded), which places the group in the eager map's iteration order.
	const exactEntry = (group: string): { reference: TCandidate; inserted: number } | undefined => {
		const ordinals = exactOrdinals.get(group);
		if (ordinals === undefined) return undefined;
		let reference: TCandidate | undefined;
		let inserted = -1;
		const count = typeof ordinals === "number" ? 1 : ordinals.length;
		for (let i = 0; i < count; i++) {
			const ordinal = typeof ordinals === "number" ? ordinals : ordinals[i];
			const candidate = readCandidate(ordinal);
			if (isZeroCostXaiOAuthReference(candidate)) continue;
			if (reference === undefined) inserted = ordinal;
			if (shouldReplaceReference(reference, candidate)) reference = candidate;
		}
		return reference === undefined ? undefined : { reference, inserted };
	};
	return {
		exact: {
			get(key: string): TCandidate | undefined {
				return exactEntry(key)?.reference;
			},
		},
		suffixAlias: {
			get(key: string): TCandidate | undefined {
				const ordinals = aliasOrdinals.get(key);
				if (ordinals === undefined) return undefined;
				const groups = new Set<string>();
				const entries: Array<{ reference: TCandidate; inserted: number }> = [];
				const count = typeof ordinals === "number" ? 1 : ordinals.length;
				for (let i = 0; i < count; i++) {
					const group = normalizeReferenceKey(ids[typeof ordinals === "number" ? ordinals : ordinals[i]]);
					if (groups.has(group)) continue;
					groups.add(group);
					const entry = exactEntry(group);
					if (entry !== undefined) entries.push(entry);
				}
				entries.sort((left, right) => left.inserted - right.inserted);
				let alias: TCandidate | undefined;
				for (const { reference } of entries) {
					if (shouldReplaceReference(alias, reference)) alias = reference;
				}
				return alias;
			},
		},
	};
}

function stripReferenceTrailingMarker(candidate: string): string | undefined {
	const match = REFERENCE_TRAILING_MARKER_PATTERN.exec(candidate);
	return match ? candidate.slice(0, match.index) : undefined;
}

const CLOUD_SUFFIXES = [":cloud", "-cloud"] as const;

/**
 * Queue the ids `candidate` reduces to: each affix, segment, separator and spelling a proxy may add or
 * change. `key` is the candidate's lookup key, its lowercase spelling.
 */
function queueReducedIds(candidate: string, key: string, queue: string[]): void {
	for (const stripped of getBracketStrippedModelIdCandidates(candidate)) {
		queue.push(stripped);
	}
	for (const segment of getModelLikeIdSegments(candidate)) {
		queue.push(segment);
	}

	for (const suffix of CLOUD_SUFFIXES) {
		if (key.endsWith(suffix)) {
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

	if (key !== candidate) {
		queue.push(key);
	}

	const strippedMarker = stripReferenceTrailingMarker(candidate);
	if (strippedMarker) {
		queue.push(strippedMarker);
	}
}

/**
 * Resolve a (possibly proxied/affixed) model id to its bundled upstream reference.
 *
 * Candidate ids are tried breadth-first from `modelId`, and a candidate is reduced only after it
 * missed: an id the catalog holds as served reads one key and derives nothing. Each candidate is
 * reduced once and each lookup key is read once; a key a candidate in another case already missed
 * misses again, so it is not read twice.
 */
export function resolveModelReference<TCandidate extends ModelReferenceCandidate = Model<Api>>(
	modelId: string,
	index: ModelReferenceLookup<TCandidate>,
): TCandidate | undefined {
	const reduced = new Set<string>();
	const missed = new Set<string>();
	const queue = [modelId];
	for (let next = 0; next < queue.length; next += 1) {
		const candidate = queue[next]?.trim();
		if (!candidate || reduced.has(candidate)) continue;
		reduced.add(candidate);
		const key = candidate.toLowerCase();
		if (!missed.has(key)) {
			const reference = index.exact.get(key) ?? index.suffixAlias.get(key);
			if (reference) return reference;
			missed.add(key);
		}
		queueReducedIds(candidate, key, queue);
	}
	return undefined;
}
