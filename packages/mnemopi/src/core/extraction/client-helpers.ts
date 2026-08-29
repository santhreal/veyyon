import type { ApiKey, FetchImpl } from "@veyyon/ai";
import { OPENROUTER_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";
import { trimTrailingSlashes } from "@veyyon/utils";
import { extractionModel } from "../../config";
import type { MnemopiProviderTextSanitizer } from "../runtime-options";

export const DEFAULT_EXTRACTION_MODEL = extractionModel();
export const OPENROUTER_BASE_URL = trimTrailingSlashes(process.env.OPENROUTER_BASE_URL || OPENROUTER_API_ENDPOINT);
export const FALLBACK_MODELS = ["google/gemini-flash-latest"] as const;
export const RATE_LIMIT_BACKOFF_BASE_MS = 1_000;
export const RATE_LIMIT_BACKOFF_MAX_MS = 30_000;
export const FALLBACK_MODEL_DELAY_MS = 1_000;

export interface ChatMessage {
	role: string;
	content: string;
}

export interface ExtractedFact {
	subject?: string;
	predicate?: string;
	object?: string;
	timestamp?: string;
	source?: number;
	confidence?: number;
	[key: string]: unknown;
}

export interface ExtractionClientOptions {
	model?: string | null;
	apiKey?: ApiKey | null;
	baseUrl?: string | null;
	fetch?: FetchImpl;
	sanitizeProviderText?: MnemopiProviderTextSanitizer;
}

export function authHeader(apiKey: string): Record<string, string> {
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (apiKey !== "") {
		headers.Authorization = `Bearer ${apiKey}`;
	}
	return headers;
}

export function sanitizeBody(value: unknown, sanitize: MnemopiProviderTextSanitizer): unknown {
	if (typeof value === "string") {
		try {
			return sanitize(value);
		} catch {
			throw new Error("Mnemopi provider text sanitization failed.");
		}
	}
	if (Array.isArray(value)) return value.map(item => sanitizeBody(item, sanitize));
	if (value === null || typeof value !== "object") return value;
	const copy: Record<string, unknown> = {};
	for (const [rawKey, child] of Object.entries(value)) {
		let key: string;
		try {
			key = sanitize(rawKey);
		} catch {
			throw new Error("Mnemopi provider text sanitization failed.");
		}
		copy[key] = sanitizeBody(child, sanitize);
	}
	return copy;
}
