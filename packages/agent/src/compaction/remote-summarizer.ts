/** Optional remote summarizer endpoint for the `summary` compaction strategy. */

import { ProviderHttpError } from "@veyyon/ai/error/classes";
import { parseAzureDeploymentNameMap } from "@veyyon/ai/providers/openai-shared";
import type { FetchImpl, Model } from "@veyyon/ai/types";
import { $env, logger, scopedTimeoutSignal, stringifyJson } from "@veyyon/utils";

/** Re-exported for callers that already import compaction transports from here. */
export * from "./legacy-provider-native";

/** Hard ceiling on a remote summarizer call. A hung connection or a body a */
export const REMOTE_COMPACTION_TIMEOUT_MS = 180_000;

/** Bound the non-2xx body written into the log line below. */
const MAX_REMOTE_ERROR_DETAIL_CHARS = 4096;

export interface RemoteCompactionRequest {
	systemPrompt: string;
	prompt: string;
}

export interface RemoteCompactionResponse {
	summary: string;
	shortSummary?: string;
}

/** Wire model id for a chat-completions summarizer, honoring Azure deployment mapping. */
function resolveRemoteSummarizerModel(model: Model): string {
	const requestModel = model.requestModelId ?? model.id;
	if (model.api !== "azure-openai-responses") return requestModel;
	return parseAzureDeploymentNameMap($env.AZURE_OPENAI_DEPLOYMENT_NAME_MAP).get(requestModel) ?? requestModel;
}

/** POST a conversation to a remote summarizer and return its summary text. */
export async function requestRemoteCompaction(
	endpoint: string,
	request: RemoteCompactionRequest,
	signal?: AbortSignal,
	opts?: {
		fetch?: FetchImpl;
		timeoutMs?: number;
		model?: Model;
		apiKey?: string;
		sanitizeErrorText?: (text: string) => string;
	},
): Promise<RemoteCompactionResponse> {
	let endpointPath = endpoint;
	try {
		endpointPath = new URL(endpoint).pathname;
	} catch {
		// Keep the raw endpoint for relative/custom fetch implementations.
	}
	const isChatCompletions = /\/chat\/completions\/?$/.test(endpointPath);
	const headers: Record<string, string> = { "content-type": "application/json" };
	if (isChatCompletions) {
		if (opts?.apiKey) headers.Authorization = `Bearer ${opts.apiKey}`;
		if (opts?.model?.headers) Object.assign(headers, opts.model.headers);
	}

	const body: Record<string, unknown> = isChatCompletions
		? {
				model: opts?.model ? resolveRemoteSummarizerModel(opts.model) : undefined,
				messages: [
					{ role: "system", content: request.systemPrompt },
					{ role: "user", content: request.prompt },
				],
				stream: false,
			}
		: { systemPrompt: request.systemPrompt, prompt: request.prompt };

	// Cap first, then sanitize: the redactor scans the string it is given, so
	// bounding the input also bounds that scan on a multi-megabyte HTML body.
	const sanitizeErrorText = (text: string): string => {
		const capped =
			text.length <= MAX_REMOTE_ERROR_DETAIL_CHARS
				? text
				: `${text.slice(0, MAX_REMOTE_ERROR_DETAIL_CHARS)} [truncated, ${text.length} chars total]`;
		if (!opts?.sanitizeErrorText) return capped;
		try {
			const sanitized = opts.sanitizeErrorText(capped);
			return typeof sanitized === "string" ? sanitized : "[redacted]";
		} catch {
			return "[redacted]";
		}
	};

	// The fence spans the body read too — a middlebox can drop the connection
	// after headers and only the armed signal interrupts `response.json()`. The
	// scoped handle clears its timer on settle; `timeoutMs <= 0` disables it.
	const timeoutMs = opts?.timeoutMs ?? REMOTE_COMPACTION_TIMEOUT_MS;
	const requestTimeout = timeoutMs > 0 ? scopedTimeoutSignal(timeoutMs, signal) : undefined;
	try {
		const response = await (opts?.fetch ?? fetch)(endpoint, {
			method: "POST",
			headers,
			body: stringifyJson(body),
			signal: requestTimeout?.signal ?? signal,
		});

		if (!response.ok) {
			// The STATUS is the failure being reported, and the body is extra context for it. A body that
			// cannot be read (already consumed, connection dropped mid-read) must not replace an HTTP 500 with
			// a read error, so it degrades to empty -- and the warning below still names the endpoint and the
			// status, so nothing about the failure is lost, only the detail that was never readable.
			const errorText = sanitizeErrorText(await response.text().catch(() => ""));
			const statusText = sanitizeErrorText(response.statusText);
			logger.warn("Remote summarizer failed", {
				endpoint,
				status: response.status,
				statusText,
				errorText,
			});
			throw new ProviderHttpError(`Remote compaction failed (${response.status} ${statusText})`, response.status, {
				headers: response.headers,
			});
		}

		if (isChatCompletions) {
			type ChatCompletionsResponse = {
				choices?: Array<{
					message?: {
						content?: string | Array<{ type?: string; text?: string }> | null;
					};
				}>;
			};
			const data = (await response.json()) as ChatCompletionsResponse | undefined;
			const choice = data?.choices?.[0]?.message?.content;
			let summary: string | undefined;
			if (typeof choice === "string") {
				summary = choice;
			} else if (Array.isArray(choice)) {
				summary = choice
					.filter((part): part is { type?: string; text: string } => typeof part?.text === "string")
					.map(part => part.text)
					.join("");
			}
			// Whitespace counts as empty. The summary REPLACES the history it
			// summarizes, so a blank one deletes the conversation and reports
			// success. Same rule the local summarizer applies in `generateSummary`.
			if (typeof summary !== "string" || summary.trim().length === 0) {
				throw new Error(
					"Remote compaction returned an empty summary in choices[0].message.content. The history was NOT compacted.",
				);
			}
			return { summary };
		}

		const data = (await response.json()) as RemoteCompactionResponse | undefined;
		if (!data || typeof data.summary !== "string" || data.summary.trim().length === 0) {
			throw new Error(
				"Remote compaction returned no usable summary text. The history was NOT compacted. Check that the endpoint returns JSON containing a non-empty `summary`.",
			);
		}

		return data;
	} finally {
		requestTimeout?.cancel();
	}
}
