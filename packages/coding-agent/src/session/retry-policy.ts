/**
 * Per-provider retry policy.
 *
 * The retry loop used to run one global policy for every backend: ten attempts,
 * 500ms base backoff, the same for all. That is a reasonable shape for an
 * ordinary token-streaming API, where a failure is usually a transient 429 or a
 * dropped socket and a retry costs a second or two.
 *
 * It is the wrong shape for a backend that runs its own agent loop remotely.
 * A `cursor-agent` or `devin-agent` turn can occupy the remote agent for
 * minutes before it fails, so ten attempts is not "retry until it works", it is
 * an hour of silent wall time the user is left to interpret as the tool being
 * broken. Fewer attempts, spaced further apart, is the honest policy there.
 *
 * Two layers resolve a policy, most specific first:
 *
 *  1. `retry.perProvider` — operator configuration, keyed exactly like
 *     `retry.fallbackChains` so there is one selector vocabulary to learn:
 *     `provider/model-id`, `provider/*`, or a bare `provider`.
 *  2. {@link PROVIDER_RETRY_DEFAULTS} — what the transport is intrinsically
 *     like, shipped with the product.
 *
 * Anything neither layer specifies falls through to the global `retry.*`
 * settings, so a backend nobody has characterized behaves exactly as before.
 */

import { isRecord } from "@veyyon/utils";

/** The resolved, fully-populated policy the retry loop runs under. */
export interface RetryPolicy {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

/** A partial policy: every field absent means "inherit from the next layer down". */
export interface RetryPolicyOverride {
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

/**
 * Where a resolved field came from. Carried so the UI can explain a policy the
 * operator did not set and does not otherwise have any way to discover.
 */
export type RetryPolicySource = "global" | "provider-default" | "config";

export interface ResolvedRetryPolicy extends RetryPolicy {
	/** The most specific layer that contributed a field, for display. */
	source: RetryPolicySource;
	/** The `retry.perProvider` or built-in key that matched, when one did. */
	matchedKey?: string;
}

/**
 * Built-in per-provider policy, keyed by provider id.
 *
 * A backend earns an entry here only when its retry economics genuinely differ
 * from an ordinary streaming API, and the entry says why. This is not a place
 * to encode a preference; the global settings are for preferences.
 */
export const PROVIDER_RETRY_DEFAULTS: Readonly<Record<string, RetryPolicyOverride>> = {
	/**
	 * Cursor runs its agent loop on its own side, and a failure usually arrives
	 * only after that loop has been working for a while. Ten retries of a
	 * multi-minute turn is tens of minutes of silence, so cap attempts low and
	 * back off in seconds rather than milliseconds: when a Cursor turn fails,
	 * the cause is far more often capacity or a session fault that needs real
	 * time to clear than a blip that clears in 500ms.
	 */
	cursor: { maxRetries: 3, baseDelayMs: 2000 },
	/**
	 * Devin is the same shape as Cursor and more so: turns are longer, and the
	 * transport is a bare Connect stream with no timeout of its own, so a failed
	 * attempt has already cost the full watchdog budget before we see it.
	 */
	devin: { maxRetries: 2, baseDelayMs: 3000 },
};

/** A `provider/*` key covers every model of that provider, present and future. */
function isWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

/**
 * Score how specifically a key addresses a model, so the most specific entry
 * wins regardless of the order the operator happened to write them in. Object
 * key order is not a policy the user chose, so it must never decide precedence.
 *
 * Returns `undefined` when the key does not address this model at all.
 */
function keySpecificity(key: string, provider: string, modelId: string): number | undefined {
	const trimmed = key.trim();
	if (!trimmed) return undefined;
	if (isWildcardKey(trimmed)) {
		return trimmed.slice(0, -2) === provider ? 1 : undefined;
	}
	if (trimmed.includes("/")) {
		const slash = trimmed.indexOf("/");
		// A selector may carry a `:thinking` suffix; the policy is per model, so
		// match on the base `provider/model-id` and ignore any suffix.
		const keyProvider = trimmed.slice(0, slash);
		const keyModel = trimmed.slice(slash + 1).split(":")[0];
		return keyProvider === provider && keyModel === modelId ? 2 : undefined;
	}
	// A bare provider id, the shorthand for `provider/*`.
	return trimmed === provider ? 1 : undefined;
}

/**
 * Pick the single most specific override addressing this model.
 *
 * Deliberately not a merge across matching keys: a `provider/*` entry and a
 * `provider/model-id` entry describe the same knob at two scopes, and silently
 * blending them would make the effective policy something the operator never
 * wrote down anywhere.
 */
function selectOverride(
	overrides: Record<string, RetryPolicyOverride> | undefined,
	provider: string,
	modelId: string,
): { key: string; override: RetryPolicyOverride } | undefined {
	if (!overrides) return undefined;
	let best: { key: string; override: RetryPolicyOverride; score: number } | undefined;
	for (const key in overrides) {
		const override = overrides[key];
		if (!isRecord(override)) continue;
		const score = keySpecificity(key, provider, modelId);
		if (score === undefined) continue;
		if (!best || score > best.score) best = { key, override, score };
	}
	return best ? { key: best.key, override: best.override } : undefined;
}

/** Keep a malformed config value from turning into `NaN` deadlines downstream. */
function usableNumber(value: number | undefined): number | undefined {
	if (value === undefined) return undefined;
	if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return undefined;
	return value;
}

function applyOverride(base: RetryPolicy, override: RetryPolicyOverride): RetryPolicy {
	return {
		maxRetries: usableNumber(override.maxRetries) ?? base.maxRetries,
		baseDelayMs: usableNumber(override.baseDelayMs) ?? base.baseDelayMs,
		maxDelayMs: usableNumber(override.maxDelayMs) ?? base.maxDelayMs,
	};
}

/** True when the override contributes at least one usable field. */
function contributes(override: RetryPolicyOverride): boolean {
	return (
		usableNumber(override.maxRetries) !== undefined ||
		usableNumber(override.baseDelayMs) !== undefined ||
		usableNumber(override.maxDelayMs) !== undefined
	);
}

/**
 * Resolve the retry policy for one model.
 *
 * `global` is the `retry.*` settings group; `configured` is `retry.perProvider`.
 * Operator config outranks a built-in provider default, which outranks global,
 * and each layer only overrides the fields it actually specifies.
 */
export function resolveRetryPolicy(
	global: RetryPolicy,
	configured: Record<string, RetryPolicyOverride> | undefined,
	model: { provider: string; id: string },
	builtins: Readonly<Record<string, RetryPolicyOverride>> = PROVIDER_RETRY_DEFAULTS,
): ResolvedRetryPolicy {
	let policy = global;
	let source: RetryPolicySource = "global";
	let matchedKey: string | undefined;

	const builtin = builtins[model.provider];
	if (builtin && contributes(builtin)) {
		policy = applyOverride(policy, builtin);
		source = "provider-default";
		matchedKey = model.provider;
	}

	const selected = selectOverride(configured, model.provider, model.id);
	if (selected && contributes(selected.override)) {
		policy = applyOverride(policy, selected.override);
		source = "config";
		matchedKey = selected.key;
	}

	return { ...policy, source, matchedKey };
}

/**
 * Human-readable explanation of why a policy is what it is, for the UI.
 * `undefined` when the policy is just the global settings, which the operator
 * set themselves and does not need explaining.
 */
export function describeRetryPolicySource(policy: ResolvedRetryPolicy): string | undefined {
	switch (policy.source) {
		case "config":
			return `retry.perProvider["${policy.matchedKey}"]`;
		case "provider-default":
			return `${policy.matchedKey} provider default`;
		default:
			return undefined;
	}
}
