/** Per-provider retry policy. The retry loop used to run one global policy for every backend: ten attempts, */

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

/** Where a resolved field came from. Carried so the UI can explain a policy the operator did not set and does not otherwise have any way to discover. */
export type RetryPolicySource = "global" | "provider-default" | "config";

/** Ceiling on one attempt's backoff, before the operator's own `retry.maxDelayMs`. */
export const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
/** How much of a computed backoff jitter may remove. Never adds. */
export const RETRY_BACKOFF_JITTER_RATIO = 0.25;

/** Exponential backoff for one retry attempt, jittered downward. `attempt` is 1-based: the first attempt waits `baseDelayMs`, the second twice */
export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

/** How long to wait before continuing a turn the transport killed inside a tool batch that cannot be replayed. */
export function unreplayableContinueDelayMs(policy: RetryPolicy, attempt: number): number {
	const backoffMs = calculateRetryBackoffDelayMs(policy.baseDelayMs, attempt);
	return policy.maxDelayMs > 0 ? Math.min(backoffMs, policy.maxDelayMs) : backoffMs;
}

export interface ResolvedRetryPolicy extends RetryPolicy {
	/** The most specific layer that contributed a field, for display. */
	source: RetryPolicySource;
	/** The `retry.perProvider` or built-in key that matched, when one did. */
	matchedKey?: string;
}

/** Built-in per-provider policy, keyed by provider id. A backend earns an entry here only when its retry economics genuinely differ */
export const PROVIDER_RETRY_DEFAULTS: Readonly<Record<string, RetryPolicyOverride>> = {
	/** Cursor runs its agent loop on its own side, and a failure usually arrives only after that loop has been working for a while. Ten retries of a */
	cursor: { maxRetries: 3, baseDelayMs: 2000 },
	/** Devin is the same shape as Cursor and more so: turns are longer, and the transport is a bare Connect stream with no timeout of its own, so a failed */
	devin: { maxRetries: 2, baseDelayMs: 3000 },
};

/** A `provider/*` key covers every model of that provider, present and future. */
function isWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

/** Score how specifically a key addresses a model, so the most specific entry wins regardless of the order the operator happened to write them in. Object */
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

/** Pick the single most specific override addressing this model. Deliberately not a merge across matching keys: a `provider/*` entry and a */
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
		if (!contributes(override)) continue;
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

/** Resolve the retry policy for one model. `global` is the `retry.*` settings group; `configured` is `retry.perProvider`. */
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
	if (selected) {
		policy = applyOverride(policy, selected.override);
		source = "config";
		matchedKey = selected.key;
	}

	return { ...policy, source, matchedKey };
}

/** Human-readable explanation of why a policy is what it is, for the UI. `undefined` when the policy is just the global settings, which the operator */
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
