/**
 * Optional remote summarizer endpoint for the `summary` compaction strategy.
 *
 * This is a transport, not a compaction strategy. Whatever it points at must
 * return summary TEXT, which veyyon stores in the compaction entry exactly like
 * a locally generated summary: readable in the session log, usable by any model,
 * and portable across providers.
 *
 * It deliberately replaces the removed provider-native compaction paths (OpenAI
 * `/responses/compact` and the Responses V2 streaming variant). Those handed the
 * durable history to an opaque provider-side blob that veyyon could not read,
 * that no other provider could replay, and that left a placeholder string where
 * the summary should have been. Compaction now has exactly two strategies —
 * `summary` and `handoff` — and no provider gets a private history format.
 */

import { ProviderHttpError } from "@veyyon/ai/error";
import { parseAzureDeploymentNameMap } from "@veyyon/ai/providers/openai-shared";
import type { FetchImpl, Model } from "@veyyon/ai/types";
import { $env, logger, scopedTimeoutSignal, stringifyJson } from "@veyyon/utils";

/**
 * `preserveData` keys written by the removed provider-native compaction paths.
 *
 * Sessions compacted before the removal still carry these on disk. Nothing can
 * read them anymore, so they are treated as "no usable summary": compaction
 * re-expands the original messages behind such an entry and summarizes them
 * locally, and the dead key is dropped from the new entry rather than copied
 * forward. Keep this list — deleting it would strand those sessions.
 */
export const LEGACY_REMOTE_PRESERVE_KEYS = ["openaiRemoteCompaction", "compactionV2"] as const;

/**
 * Hard ceiling on a remote summarizer call. A hung connection or a body a
 * middlebox never finishes would otherwise stall the whole compaction pipeline
 * forever (frozen maintenance spinner, manual `/compact` queued behind it).
 */
export const REMOTE_COMPACTION_TIMEOUT_MS = 180_000;

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

/**
 * POST a conversation to a remote summarizer and return its summary text.
 *
 * Two wire shapes are auto-selected by endpoint suffix so one
 * `compaction.remoteEndpoint` setting can point at either a purpose-built
 * veyyon summarizer (`{systemPrompt, prompt}` -> `{summary}`) or any
 * OpenAI-compatible chat-completions server (`/chat/completions`,
 * `/v1/chat/completions`, ...) as reported for llama.cpp / vLLM in issue #4630:
 * without this the veyyon payload was rejected with HTTP 400
 * `"'messages' is required"`, compaction fell back to local summarization, and
 * context grew unbounded.
 *
 * When `opts.model` is provided the chat-completions body is tagged with that
 * model's wire id (llama.cpp requires the field) and `opts.apiKey` is forwarded
 * as `Authorization: Bearer`. Callers wrap this in `withAuth` so 401s force a
 * refresh through the standard credential rotation policy.
 */
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

	const sanitizeErrorText = (text: string): string => {
		if (!opts?.sanitizeErrorText) return text;
		try {
			const sanitized = opts.sanitizeErrorText(text);
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
			if (typeof summary !== "string" || summary.length === 0) {
				throw new Error("Remote compaction response missing choices[0].message.content");
			}
			return { summary };
		}

		const data = (await response.json()) as RemoteCompactionResponse | undefined;
		if (!data || typeof data.summary !== "string") {
			throw new Error("Remote compaction response missing summary");
		}

		return data;
	} finally {
		requestTimeout?.cancel();
	}
}
