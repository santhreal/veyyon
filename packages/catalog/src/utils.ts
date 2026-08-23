import { type FetchImpl, wrapFetchForExtraCa } from "@veyyon/utils/tls-fetch";

export { isRecord } from "@veyyon/utils/type-guards";

/**
 * Fetch implementation for catalog discovery probes: the caller's override
 * when given, otherwise global fetch wrapped for `NODE_EXTRA_CA_CERTS`.
 */
export function discoveryFetch(override?: FetchImpl): FetchImpl {
	return override ?? wrapFetchForExtraCa(fetch);
}

export function toNumber(value: unknown): number | undefined {
	if (typeof value === "number" && Number.isFinite(value)) {
		return value;
	}
	if (typeof value === "string" && value.trim()) {
		const parsed = Number(value);
		if (Number.isFinite(parsed)) {
			return parsed;
		}
	}
	return undefined;
}

export function toPositiveNumber(value: unknown, fallback: number): number;
export function toPositiveNumber(value: unknown, fallback: number | null): number | null;
export function toPositiveNumber(value: unknown, fallback: number | null): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : fallback;
}

/** Positive finite number, or `null` when the value is missing/non-positive. */
export function toPositiveNumberOrNull(value: unknown): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : null;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

/**
 * A payload node read as a bag of named fields, or `undefined` for a primitive or `null`.
 *
 * An array qualifies, because a JSON array is an object and a reader that refused one here
 * would reject payloads it accepts today: a bare array where an envelope was expected reads
 * as an envelope with no fields, which is an empty model list rather than a failed response.
 */
export function toFields(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

/**
 * A finite number as the payload wrote it, or `undefined` for anything else.
 *
 * Distinct from {@link toNumber}, which also accepts a numeric string. A discovery payload's
 * token limits are read strictly: `"8192"` there means the service changed its wire shape, and
 * coercing it hides that from whoever has to fix it. `1e400` parses out of JSON as `Infinity`,
 * which is why finiteness is checked here and not left to the caller.
 */
export function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

/**
 * A string, or `undefined` when the value is anything else.
 *
 * Discovery payloads are untyped JSON from a service that changes without notice, so every
 * field a reader wants is read through one of these. They replace a schema library that cost
 * 362ms to evaluate at import and was doing nothing here but `typeof` checks.
 */
export function toStringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

/**
 * A string with non-whitespace content, trimmed. `undefined` for anything else.
 *
 * Two copies of this lived in `discovery/codex.ts` and `provider-models/openai-compat.ts`,
 * disagreeing on their empty answer: one returned `null`, the other `undefined`. A caller
 * chaining `??` past both read the two as one.
 */
export function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

/** An array, or `undefined` when the value is not one. */
export function toArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

/** The string members of an array, or `undefined` when the value is not an array. */
export function toStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

export function isAnthropicOAuthToken(key: string): boolean {
	return key.includes("sk-ant-oat");
}

/**
 * Gateway author prefix ("OpenAI: ", "Z.ai: ", "Arcee AI: ") as emitted by
 * aggregator catalogs (OpenRouter, Kilo, NanoGPT, ZenMux).
 */
const AUTHOR_PREFIX = /^[A-Za-z][A-Za-z0-9 .+&'-]{0,23}: /;

/**
 * Model-extrinsic name decorations: alias markers ("(latest)"), provider
 * attribution ("(Antigravity)"), price tiers ("($$$$)"), and promo/lifecycle
 * tags ("(20% off)", "(retires Jun 5)"). Variant tags that map to distinct
 * wire ids — "(Thinking)", "(free)", "(Fast)", dates, regions, sizes — stay.
 */
const NOISE_TAGS = /\s*\((?:latest|Antigravity|\$+|>?\d+% off|retires [^)]*)\)/g;

/**
 * Normalize a model display name: drop the gateway author prefix and
 * model-extrinsic decorations. Returns the input verbatim when nothing
 * matches (or when stripping would leave an empty name).
 */
export function cleanModelName(name: string): string {
	const cleaned = name.replace(AUTHOR_PREFIX, "").replace(NOISE_TAGS, "").replace(/ {2,}/g, " ").trim();
	return cleaned.length > 0 ? cleaned : name;
}
