import { type FetchImpl, wrapFetchForExtraCa } from "@veyyon/utils/tls-fetch";

export { isRecord } from "@veyyon/utils/type-guards";

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

export function toPositiveNumberOrNull(value: unknown): number | null {
	const parsed = toNumber(value);
	return parsed !== undefined && parsed > 0 ? parsed : null;
}

export function toBoolean(value: unknown): boolean | undefined {
	return typeof value === "boolean" ? value : undefined;
}

export function toFields(value: unknown): Record<string, unknown> | undefined {
	return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : undefined;
}

export function toFiniteNumber(value: unknown): number | undefined {
	return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

export function toStringValue(value: unknown): string | undefined {
	return typeof value === "string" ? value : undefined;
}

export function toNonEmptyString(value: unknown): string | undefined {
	if (typeof value !== "string") {
		return undefined;
	}
	const trimmed = value.trim();
	return trimmed.length > 0 ? trimmed : undefined;
}

export function toArray(value: unknown): unknown[] | undefined {
	return Array.isArray(value) ? value : undefined;
}

export function toStringArray(value: unknown): string[] | undefined {
	return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : undefined;
}

export function isAnthropicOAuthToken(key: string): boolean {
	return key.includes("sk-ant-oat");
}

const AUTHOR_PREFIX = /^[A-Za-z][A-Za-z0-9 .+&'-]{0,23}: /;
const NOISE_TAGS = /\s*\((?:latest|Antigravity|\$+|>?\d+% off|retires [^)]*)\)/g;

export function cleanModelName(name: string): string {
	const cleaned = name.replace(AUTHOR_PREFIX, "").replace(NOISE_TAGS, "").replace(/ {2,}/g, " ").trim();
	return cleaned.length > 0 ? cleaned : name;
}
