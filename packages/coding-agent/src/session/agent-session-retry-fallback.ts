/**
 * Retry fallback chains: the `provider/model` selector syntax the setting is
 * written in, the parse and format of one, and the resolution of the chain
 * that covers a failing model and the candidates that follow it.
 */

import type { ThinkingLevel } from "@veyyon/agent-core";
import type { Model } from "@veyyon/ai";
import { isRecord } from "@veyyon/utils";
import {
	formatModelSelectorValue,
	formatModelString,
	formatModelStringWithRouting,
	parseModelString,
} from "../config/model-resolver";
import { type ConfiguredThinkingLevel, concreteThinkingLevel } from "../thinking";

/** `retry.fallbackChains` config: chain key (role name or model selector) → ordered fallback selectors. */
export type RetryFallbackChains = Record<string, string[]>;

export type RetryFallbackRevertPolicy = "never" | "cooldown-expiry";

export interface RetryFallbackSelector {
	raw: string;
	provider: string;
	id: string;
	thinkingLevel: ThinkingLevel | undefined;
}

export interface ActiveRetryFallbackState {
	/** Chain key that produced this fallback: a model-role name or a model-selector key. */
	role: string;
	originalSelector: string;
	originalThinkingLevel: ConfiguredThinkingLevel | undefined;
	lastAppliedFallbackThinkingLevel: ConfiguredThinkingLevel | undefined;
	pinned: boolean;
}

export function parseRetryFallbackSelector(
	selector: string,
	modelLookup?: { find(provider: string, id: string): Model | undefined },
): RetryFallbackSelector | undefined {
	const trimmed = selector.trim();
	if (!trimmed) return undefined;
	const parsed = parseModelString(trimmed, {
		allowMaxSuffix: true,
		allowAutoAlias: true,
		isLiteralModelId: (provider, id) => modelLookup?.find(provider, id) !== undefined,
	});
	if (!parsed) return undefined;
	return {
		raw: trimmed,
		provider: parsed.provider,
		id: parsed.id,
		thinkingLevel: concreteThinkingLevel(parsed.thinkingLevel),
	};
}

/**
 * `retry.fallbackChains` keys are either model-role names (`smol`, `default`)
 * or model selectors (`provider/model-id[:thinking]`). Role names never
 * contain a slash, so its presence marks a model-keyed chain whose primary is
 * the key itself — the chain follows the model across role reassignments.
 */
export function isRetryFallbackModelKey(key: string): boolean {
	return key.includes("/");
}

/**
 * A `provider/*` fallback-chain key: matches any active model of that provider,
 * so one entry covers every current and future model behind the provider.
 */
export function isRetryFallbackWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

export function formatRetryFallbackSelector(model: Model, thinkingLevel: ThinkingLevel | undefined): string {
	return formatModelSelectorValue(formatModelStringWithRouting(model), thinkingLevel);
}

export function formatRetryFallbackBaseSelector(selector: RetryFallbackSelector): string {
	return `${selector.provider}/${selector.id}`;
}

/** The model lookups chain resolution and validation read. */
export interface RetryFallbackModelLookup {
	find(provider: string, id: string): Model | undefined;
	getAll(): readonly Model[];
}

/**
 * The configured `retry.fallbackChains` value with every chain that is not an
 * array, and every entry that is not a string, dropped. A value that is not a
 * mapping reads as no chains. This is the only reader of the raw setting that
 * hands chains on; {@link retryFallbackChainWarnings} reports what it drops.
 */
export function sanitizeRetryFallbackChains(value: unknown): RetryFallbackChains {
	if (!isRecord(value) || Array.isArray(value)) return {};
	const chains: RetryFallbackChains = {};
	for (const key in value) {
		const chain = value[key];
		if (!Array.isArray(chain)) continue;
		chains[key] = chain.filter((entry): entry is string => typeof entry === "string");
	}
	return chains;
}

/**
 * {@link sanitizeRetryFallbackChains} with the `default` chain copied to every
 * role in `roles` that has no chain of its own.
 */
export function retryFallbackChainsForRoles(value: unknown, roles: Iterable<string>): RetryFallbackChains {
	const chains = sanitizeRetryFallbackChains(value);
	const defaultChain = chains.default;
	if (defaultChain) {
		for (const role of roles) {
			if (role !== "default" && chains[role] === undefined) chains[role] = defaultChain;
		}
	}
	return chains;
}

/** One warning per malformed or unresolvable key and entry of a configured `retry.fallbackChains` value. */
export function retryFallbackChainWarnings(value: unknown, models: RetryFallbackModelLookup): string[] {
	if (value === undefined) return [];
	if (!isRecord(value) || Array.isArray(value)) {
		return ["retry.fallbackChains must be a mapping of role names or model selectors to selector arrays."];
	}
	const warnings: string[] = [];
	const providerExists = (provider: string) => models.getAll().some(model => model.provider === provider);
	for (const key in value) {
		const chain = value[key];
		const keyKind = isRetryFallbackModelKey(key) ? "model" : "role";
		if (keyKind === "model") {
			if (isRetryFallbackWildcardKey(key)) {
				if (!providerExists(key.slice(0, -2))) {
					warnings.push(`retry.fallbackChains wildcard key references unknown provider: ${key}`);
				}
			} else {
				const parsedKey = parseRetryFallbackSelector(key, models);
				if (!parsedKey) {
					warnings.push(`Invalid model selector key in retry.fallbackChains: ${key}`);
				} else if (!models.find(parsedKey.provider, parsedKey.id)) {
					warnings.push(`retry.fallbackChains key references unknown model: ${key}`);
				}
			}
		}
		if (!Array.isArray(chain)) {
			warnings.push(`Fallback chain for ${keyKind} '${key}' must be an array of selector strings.`);
			continue;
		}
		for (const selector of chain) {
			if (typeof selector !== "string") {
				warnings.push(`Fallback chain for ${keyKind} '${key}' contains a non-string selector.`);
				continue;
			}
			if (isRetryFallbackWildcardKey(selector)) {
				if (!providerExists(selector.slice(0, -2))) {
					warnings.push(`Fallback chain for ${keyKind} '${key}' references unknown provider: ${selector}`);
				}
				continue;
			}
			const parsed = parseRetryFallbackSelector(selector, models);
			if (!parsed) {
				warnings.push(`Invalid fallback selector format in ${keyKind} '${key}': ${selector}`);
			} else if (!models.find(parsed.provider, parsed.id)) {
				warnings.push(`Fallback chain for ${keyKind} '${key}' references unknown model: ${selector}`);
			}
		}
	}
	return warnings;
}

/** What chain resolution reads: the chains, the role assignments, the registry and the active model. */
export interface RetryFallbackChainSource {
	/** Sanitized chains, as {@link retryFallbackChainsForRoles} returns them. */
	readonly chains: RetryFallbackChains;
	/** The selector assigned to a model role, when one is. */
	modelRole(role: string): string | undefined;
	readonly models: RetryFallbackModelLookup;
	/** The model the failing turn ran on. */
	readonly activeModel: Model | undefined;
}

/**
 * The failing selector in every spelling a chain entry may match it by: as
 * written, without routing (`plain`), and as `provider/id` for each.
 */
interface CurrentRetryFallbackSelector {
	readonly raw: string;
	readonly parsed: RetryFallbackSelector | undefined;
	readonly plain: string | undefined;
	readonly base: string | undefined;
	readonly plainBase: string | undefined;
}

function describeCurrentSelector(source: RetryFallbackChainSource, raw: string): CurrentRetryFallbackSelector {
	const parsed = parseRetryFallbackSelector(raw, source.models);
	if (!parsed) return { raw, parsed, plain: undefined, base: undefined, plainBase: undefined };
	const plain = source.activeModel
		? formatModelSelectorValue(formatModelString(source.activeModel), parsed.thinkingLevel)
		: undefined;
	const plainBase =
		plain && plain !== raw ? formatRetryFallbackBaseSelector(parseRetryFallbackSelector(plain) ?? parsed) : undefined;
	return { raw, parsed, plain, base: formatRetryFallbackBaseSelector(parsed), plainBase };
}

/** The model a chain key names as its primary: the key itself, or the model its role is assigned. */
export function retryFallbackPrimarySelector(
	source: RetryFallbackChainSource,
	key: string,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(key)) return undefined;
	if (isRetryFallbackModelKey(key)) return parseRetryFallbackSelector(key, source.models);
	const configuredSelector = source.modelRole(key);
	return configuredSelector ? parseRetryFallbackSelector(configuredSelector, source.models) : undefined;
}

/** Whether a non-empty `default` chain exists with no model assigned to the `default` role. */
function defaultChainHasNoPrimary(source: RetryFallbackChainSource): boolean {
	const defaultChain = source.chains.default;
	return (
		defaultChain !== undefined &&
		defaultChain.length > 0 &&
		retryFallbackPrimarySelector(source, "default") === undefined
	);
}

/**
 * Parse one configured chain entry. A `provider/*` entry keeps the failing
 * model's id and swaps the provider (google-antigravity/x → google/x); ids the
 * target provider lacks are skipped by the candidate loop's registry lookup.
 */
function parseChainEntry(
	source: RetryFallbackChainSource,
	entry: string,
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector | undefined {
	if (isRetryFallbackWildcardKey(entry)) {
		if (!current) return undefined;
		const provider = entry.slice(0, -2);
		return { raw: `${provider}/${current.id}`, provider, id: current.id, thinkingLevel: undefined };
	}
	return parseRetryFallbackSelector(entry, source.models);
}

/** `head` followed by the parsed entries of `entries`, each selector once. */
function chainFrom(
	source: RetryFallbackChainSource,
	head: RetryFallbackSelector,
	entries: readonly string[],
	current: RetryFallbackSelector | undefined,
): RetryFallbackSelector[] {
	const seen = new Set<string>([head.raw]);
	const chain = [head];
	for (const entry of entries) {
		const parsed = parseChainEntry(source, entry, current);
		if (!parsed || seen.has(parsed.raw)) continue;
		seen.add(parsed.raw);
		chain.push(parsed);
	}
	return chain;
}

/**
 * Map the failing model selector to the chain key that owns it, by
 * specificity: an exact model-selector key, then a `provider/*` wildcard, then
 * a model role whose current assignment matches, then `default`. Model-oriented
 * keys win over roles so a chain follows the model across role reassignments.
 */
export function resolveRetryFallbackRole(
	source: RetryFallbackChainSource,
	currentSelector: string,
): string | undefined {
	const current = describeCurrentSelector(source, currentSelector);
	if (!current.parsed) return undefined;
	const exactModelKeys: string[] = [];
	const roleKeys: string[] = [];
	for (const key in source.chains) {
		if (!isRetryFallbackModelKey(key)) roleKeys.push(key);
		else if (!isRetryFallbackWildcardKey(key)) exactModelKeys.push(key);
	}
	const matchesCurrent = (primary: RetryFallbackSelector | undefined): boolean => {
		if (!primary) return false;
		if (primary.raw === current.raw || primary.raw === current.plain) return true;
		const base = formatRetryFallbackBaseSelector(primary);
		return base === current.base || base === current.plainBase;
	};

	for (const key of exactModelKeys) {
		if (matchesCurrent(retryFallbackPrimarySelector(source, key))) return key;
	}
	const wildcardKey = `${current.parsed.provider}/*`;
	if (source.chains[wildcardKey]) return wildcardKey;
	for (const key of roleKeys) {
		if (matchesCurrent(retryFallbackPrimarySelector(source, key))) return key;
	}
	return defaultChainHasNoPrimary(source) ? "default" : undefined;
}

/**
 * The selectors of `role`'s chain that come after the failing one, in order.
 * A wildcard key and a `default` chain with no assigned primary take the
 * failing model as their primary. Empty when the chain has nothing past it.
 */
export function findRetryFallbackCandidates(
	source: RetryFallbackChainSource,
	role: string,
	currentSelector: string,
): RetryFallbackSelector[] {
	const current = describeCurrentSelector(source, currentSelector);
	const entries = source.chains[role] ?? [];
	let chain: RetryFallbackSelector[] = [];
	if (isRetryFallbackWildcardKey(role)) {
		chain = current.parsed ? chainFrom(source, current.parsed, entries, current.parsed) : [];
	} else {
		const primary = retryFallbackPrimarySelector(source, role);
		if (primary) {
			chain = chainFrom(source, primary, entries, current.parsed);
		} else if (role === "default" && current.parsed && defaultChainHasNoPrimary(source)) {
			chain = chainFrom(source, current.parsed, entries, current.parsed);
		}
	}
	if (chain.length <= 1) return [];
	const exactIndex = chain.findIndex(selector => selector.raw === current.raw || selector.raw === current.plain);
	if (exactIndex >= 0) return chain.slice(exactIndex + 1);
	if (current.base !== undefined) {
		const baseIndex = chain.findIndex(selector => {
			const selectorBase = formatRetryFallbackBaseSelector(selector);
			return selectorBase === current.base || selectorBase === current.plainBase;
		});
		if (baseIndex >= 0) return chain.slice(baseIndex + 1);
	}
	return chain.slice(1);
}
