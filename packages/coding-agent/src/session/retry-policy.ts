import { isRecord } from "@veyyon/utils";

export interface RetryPolicy {
	maxRetries: number;
	baseDelayMs: number;
	maxDelayMs: number;
}

export interface RetryPolicyOverride {
	maxRetries?: number;
	baseDelayMs?: number;
	maxDelayMs?: number;
}

export type RetryPolicySource = "global" | "provider-default" | "config";

export const RETRY_BACKOFF_MAX_DELAY_MS = 8_000;
export const RETRY_BACKOFF_JITTER_RATIO = 0.25;

export function calculateRetryBackoffDelayMs(baseDelayMs: number, attempt: number): number {
	const cappedDelayMs = Math.min(Math.max(0, baseDelayMs) * 2 ** Math.max(0, attempt - 1), RETRY_BACKOFF_MAX_DELAY_MS);
	const jitter = 1 - Math.random() * RETRY_BACKOFF_JITTER_RATIO;
	return cappedDelayMs * jitter;
}

export function unreplayableContinueDelayMs(policy: RetryPolicy, attempt: number): number {
	const backoffMs = calculateRetryBackoffDelayMs(policy.baseDelayMs, attempt);
	return policy.maxDelayMs > 0 ? Math.min(backoffMs, policy.maxDelayMs) : backoffMs;
}

export interface ResolvedRetryPolicy extends RetryPolicy {
	source: RetryPolicySource;
	matchedKey?: string;
}

export const PROVIDER_RETRY_DEFAULTS: Readonly<Record<string, RetryPolicyOverride>> = {
	cursor: { maxRetries: 3, baseDelayMs: 2000 },
	devin: { maxRetries: 2, baseDelayMs: 3000 },
};

function isWildcardKey(key: string): boolean {
	return key.endsWith("/*");
}

function keySpecificity(key: string, provider: string, modelId: string): number | undefined {
	const trimmed = key.trim();
	if (!trimmed) return undefined;
	if (isWildcardKey(trimmed)) {
		return trimmed.slice(0, -2) === provider ? 1 : undefined;
	}
	if (trimmed.includes("/")) {
		const slash = trimmed.indexOf("/");
		const keyProvider = trimmed.slice(0, slash);
		const keyModel = trimmed.slice(slash + 1).split(":")[0];
		return keyProvider === provider && keyModel === modelId ? 2 : undefined;
	}
	return trimmed === provider ? 1 : undefined;
}

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

function contributes(override: RetryPolicyOverride): boolean {
	return (
		usableNumber(override.maxRetries) !== undefined ||
		usableNumber(override.baseDelayMs) !== undefined ||
		usableNumber(override.maxDelayMs) !== undefined
	);
}

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
