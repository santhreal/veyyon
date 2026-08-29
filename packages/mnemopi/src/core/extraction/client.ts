import type { ApiKey, FetchImpl } from "@veyyon/ai";
import { OPENROUTER_API_ENDPOINT } from "@veyyon/catalog/provider-endpoints";

export { OPENROUTER_API_ENDPOINT };

import { withAuth } from "@veyyon/ai/auth-retry";
import * as AIError from "@veyyon/ai/error";
import { trimTrailingSlashes, withScopedTimeoutSignal } from "@veyyon/utils";
import { isRecord } from "@veyyon/utils/type-guards";
import { getMnemopiRuntimeOptions, type MnemopiProviderTextSanitizer } from "../runtime-options";
import type { ChatMessage, ExtractedFact, ExtractionClientOptions } from "./client-helpers";
import {
	authHeader,
	DEFAULT_EXTRACTION_MODEL,
	FALLBACK_MODEL_DELAY_MS,
	FALLBACK_MODELS,
	OPENROUTER_BASE_URL,
	RATE_LIMIT_BACKOFF_BASE_MS,
	RATE_LIMIT_BACKOFF_MAX_MS,
	sanitizeBody,
} from "./client-helpers";
import { extractionDiagnostics } from "./diagnostics";
import { EXTRACTION_SYSTEM_PROMPT, EXTRACTION_USER_TEMPLATE } from "./prompts";

export type { ChatMessage };

export class ExtractionClient {
	model: string;
	apiKey: ApiKey;
	baseUrl: string;
	callCount = 0;
	readonly #fetchImpl: FetchImpl;
	sanitizeProviderText: MnemopiProviderTextSanitizer | undefined;

	constructor(opts: ExtractionClientOptions = {}) {
		this.model = opts.model || DEFAULT_EXTRACTION_MODEL;
		this.apiKey = opts.apiKey ?? process.env.OPENROUTER_API_KEY ?? "";
		this.baseUrl = trimTrailingSlashes(opts.baseUrl || OPENROUTER_BASE_URL);
		this.#fetchImpl = opts.fetch ?? fetch;
		this.sanitizeProviderText = opts.sanitizeProviderText;
	}

	async chat(messages: readonly ChatMessage[], temperature = 0, maxTokens = 4096): Promise<string> {
		const diag = extractionDiagnostics();
		diag.recordAttempt("cloud");
		const models = [this.model, ...FALLBACK_MODELS.filter(m => m !== this.model)];
		let lastError: unknown = null;

		for (const [modelIndex, model] of models.entries()) {
			try {
				const result = await withAuth(this.apiKey, async key => {
					let rateLimitError: unknown = null;
					for (let attempt = 0; attempt < 3; attempt += 1) {
						try {
							return await this.callApi(model, messages, temperature, maxTokens, key);
						} catch (exc) {
							const flags = AIError.classify(exc);
							if (AIError.is(flags, AIError.Flag.UsageLimit) || AIError.is(flags, AIError.Flag.Transient)) {
								rateLimitError = exc;
								if (attempt + 1 < 3) {
									await Bun.sleep(
										Math.min(RATE_LIMIT_BACKOFF_MAX_MS, RATE_LIMIT_BACKOFF_BASE_MS * 2 ** attempt),
									);
									continue;
								}
								break;
							}
							throw exc;
						}
					}
					throw rateLimitError;
				});
				if (result === "") {
					diag.recordNoOutput("cloud");
				}
				return result;
			} catch (exc) {
				lastError = exc;
			}
			if (modelIndex + 1 < models.length) await Bun.sleep(FALLBACK_MODEL_DELAY_MS);
		}

		diag.recordFailure("cloud", lastError, "all_models_failed");
		return "";
	}

	async callApi(
		model: string,
		messages: readonly ChatMessage[],
		temperature: number,
		maxTokens: number,
		apiKey = "",
	): Promise<string> {
		const data = await withScopedTimeoutSignal(60000, async signal => {
			const rawBody = { model, messages, temperature, max_tokens: maxTokens };
			const sanitize = this.sanitizeProviderText ?? getMnemopiRuntimeOptions()?.llm?.sanitizeProviderText;
			const body = sanitize === undefined ? rawBody : sanitizeBody(rawBody, sanitize);
			const response = await this.#fetchImpl(`${this.baseUrl}/chat/completions`, {
				method: "POST",
				headers: authHeader(apiKey),
				body: JSON.stringify(body),
				signal,
			});
			if (!response.ok) {
				throw new Error(`${response.status} ${response.statusText}`.trim());
			}
			return (await response.json()) as {
				choices?: Array<{ message?: { content?: unknown } }>;
			};
		});
		this.callCount += 1;
		const content = data.choices?.[0]?.message?.content;
		return typeof content === "string" ? content : "";
	}

	async extractFacts(messages: readonly ChatMessage[]): Promise<ExtractedFact[]> {
		let conversationText = "";
		for (let i = 0; i < messages.length; i += 1) {
			const msg = messages[i];
			if (msg === undefined) continue;
			const content = msg.content.trim();
			if (content !== "") {
				conversationText += `[${i}] [${msg.role || "unknown"}]: ${content}\n`;
			}
		}
		if (conversationText.trim() === "") {
			return [];
		}

		const userPrompt = EXTRACTION_USER_TEMPLATE.replace("{conversation_text}", () => conversationText);
		const response = await this.chat(
			[
				{ role: "system", content: EXTRACTION_SYSTEM_PROMPT },
				{ role: "user", content: userPrompt },
			],
			0,
			4096,
		);

		const diag = extractionDiagnostics();
		if (response === "") {
			diag.recordCall({ succeeded: false, allEmpty: true });
			return [];
		}

		try {
			const jsonStart = response.indexOf("[");
			const jsonEnd = response.lastIndexOf("]") + 1;
			if (jsonStart >= 0 && jsonEnd > jsonStart) {
				const facts = JSON.parse(response.slice(jsonStart, jsonEnd)) as unknown;
				if (Array.isArray(facts)) {
					if (facts.every(fact => isRecord(fact))) {
						diag.recordSuccess("cloud", facts.length);
						diag.recordCall({ succeeded: true });
						return facts as ExtractedFact[];
					}
					diag.recordFailure("cloud", undefined, "invalid_facts_response");
					diag.recordCall({ succeeded: false, allEmpty: true });
					return [];
				}
			}
			diag.recordFailure("cloud", undefined, "no_facts_in_response");
			diag.recordCall({ succeeded: false, allEmpty: true });
		} catch (exc) {
			diag.recordFailure("cloud", exc, "json_parse_failed");
			diag.recordCall({ succeeded: false });
		}
		return [];
	}
}
