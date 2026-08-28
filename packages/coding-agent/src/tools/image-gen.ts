import * as os from "node:os";
import type { ApiKey, FetchImpl, Model } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { ProviderHttpError } from "@veyyon/ai/error";
import {
	ANTIGRAVITY_ENDPOINTS,
	ANTIGRAVITY_PRIMARY_ENDPOINT,
	ANTIGRAVITY_SANDBOX_ENDPOINT,
} from "@veyyon/catalog/provider-endpoints";
import {
	CODEX_BASE_URL,
	getCodexAccountId,
	OPENAI_HEADER_VALUES,
	OPENAI_HEADERS,
	URL_PATHS,
} from "@veyyon/catalog/wire/codex";
import { getAntigravityUserAgent } from "@veyyon/catalog/wire/gemini-headers";
import { parseImageMetadata, prompt, readSseJson, trimTrailingSlashes, untilAborted } from "@veyyon/utils";
import packageJson from "../../package.json" with { type: "json" };
import type { ModelRegistry } from "../config/model-registry";
import { settings } from "../config/settings-instance";
import type { CustomTool } from "../extensibility/custom-tools/types";
import { missingXAICredentialsMessage, resolveXAIHttpCredentials, veyyonXAIUserAgent } from "../lib/xai-http";
import { toolsPrompts } from "../prompts/tools/rows";
import { scopedTimeoutSignal } from "../utils/fetch-timeout";
import {
	type AntigravityRequest,
	type AntigravityResponseChunk,
	assemblePrompt,
	assertImageAspectRatioSupported,
	buildNoImageResult,
	buildResponseSummary,
	collectOpenRouterResponseText,
	DEFAULT_ANTIGRAVITY_MODEL,
	DEFAULT_MODEL,
	DEFAULT_OPENAI_BASE_URL,
	DEFAULT_OPENROUTER_MODEL,
	DEFAULT_XAI_IMAGE_MODEL,
	extractOpenRouterImageUrls,
	findImageApiKey,
	type GeminiGenerateContentResponse,
	type GeminiPart,
	type GeminiResponseModality,
	type GeminiUsageMetadata,
	IMAGE_SYSTEM_INSTRUCTION,
	IMAGE_TIMEOUT,
	type ImageGenParams,
	type ImageGenToolDetails,
	type ImageProvider,
	type InlineImageData,
	imageGenSchema,
	loadImageFromUrl,
	OPENAI_IMAGE_MIME_TYPE,
	OPENAI_IMAGE_OUTPUT_FORMAT,
	type OpenAIHostedImageRequest,
	type OpenAIHostedImageResponse,
	type OpenAIHostedImageResult,
	type OpenAIImageGenerationTool,
	type OpenAIInputContent,
	type OpenAIResponseOutput,
	type OpenAISseEvent,
	type OpenRouterContentPart,
	type OpenRouterResponse,
	parseAntigravityCredentials,
	resolveInputImage,
	resolveOpenRouterModel,
	sanitizeImageGenParams,
	saveImagesToTemp,
	toDataUrl,
	type XAIImageReference,
	type XAIImageRequestBase,
	type XAIImageRequestBody,
} from "./image-gen-helpers";

export {
	buildNoImageResult,
	type GeminiResponseModality,
	type ImageGenParams,
	type ImageProvider,
	type ImageProviderPreference,
	imageGenSchema,
	isImageProviderPreference,
	setPreferredImageProvider,
} from "./image-gen-helpers";

function collectResponseText(parts: GeminiPart[]): string | undefined {
	const texts = parts.map(part => part.text).filter((text): text is string => Boolean(text));
	const combined = texts.join("\n").trim();
	return combined.length > 0 ? combined : undefined;
}

function collectInlineImages(parts: GeminiPart[]): InlineImageData[] {
	const images: InlineImageData[] = [];
	for (const part of parts) {
		const data = part.inlineData?.data;
		const mimeType = part.inlineData?.mimeType;
		if (!data || !mimeType) continue;
		images.push({ data, mimeType });
	}
	return images;
}

export function isOpenAIHostedImageModel(model: Model | undefined): model is Model {
	if (!model) return false;
	if (model.provider !== "openai" && model.provider !== "openai-codex") return false;
	if (model.api !== "openai-responses" && model.api !== "openai-codex-responses") return false;
	const modelId = model.id.toLowerCase();
	return modelId.startsWith("gpt-") || modelId === "o3" || modelId.startsWith("o3-");
}

export function getOpenAIHostedImageProvider(model: Model): ImageProvider {
	return model.api === "openai-codex-responses" || model.provider === "openai-codex" ? "openai-codex" : "openai";
}

function resolveOpenAIImageSize(aspectRatio: string | undefined, imageSize: string | undefined): string | undefined {
	if (imageSize) return imageSize;
	switch (aspectRatio) {
		case "1:1":
			return "1024x1024";
		case "3:4":
		case "9:16":
			return "1024x1536";
		case "4:3":
		case "16:9":
			return "1536x1024";
		default:
			return undefined;
	}
}

function buildOpenAIHostedImageRequest(
	model: Model,
	promptText: string,
	params: ImageGenParams,
	inputImages: InlineImageData[],
	stream: boolean,
): OpenAIHostedImageRequest {
	const content: OpenAIInputContent[] = [{ type: "input_text", text: promptText }];
	for (const image of inputImages) {
		content.push({ type: "input_image", detail: "auto", image_url: toDataUrl(image) });
	}

	const size = resolveOpenAIImageSize(params.aspect_ratio, params.image_size);
	const tool: OpenAIImageGenerationTool = {
		type: "image_generation",
		action: inputImages.length > 0 ? "edit" : "generate",
		output_format: OPENAI_IMAGE_OUTPUT_FORMAT,
		...(size ? { size } : {}),
	};

	return {
		model: model.id,
		input: [{ role: "user", content }],
		tools: [tool],
		tool_choice: { type: "image_generation" },
		store: false,
		...(stream
			? {
					instructions:
						"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.",
				}
			: {}),
		...(stream ? { stream: true } : {}),
	};
}

function createOpenAIInlineImage(data: string): InlineImageData {
	const bytes = Buffer.from(data, "base64");
	const mimeType = parseImageMetadata(bytes)?.mimeType ?? OPENAI_IMAGE_MIME_TYPE;
	return { data, mimeType };
}

function collectOpenAIHostedImageResult(response: OpenAIHostedImageResponse): OpenAIHostedImageResult {
	const images: InlineImageData[] = [];
	const textParts: string[] = [];
	let revisedPrompt: string | undefined;

	for (const output of response.output ?? []) {
		if (output.type === "image_generation_call") {
			if (output.result) {
				images.push(createOpenAIInlineImage(output.result));
			}
			if (output.revised_prompt) {
				revisedPrompt = output.revised_prompt;
			}
			continue;
		}

		for (const part of output.content ?? []) {
			if (part.type === "output_text" && part.text) {
				textParts.push(part.text);
			} else if (part.type === "refusal" && part.refusal) {
				textParts.push(part.refusal);
			}
		}
	}

	const responseText = textParts.join("\n").trim();
	return {
		images,
		revisedPrompt,
		responseText: responseText.length > 0 ? responseText : undefined,
		usage: response.usage,
	};
}

function parseProviderErrorMessage(rawText: string): string {
	try {
		const parsed = JSON.parse(rawText) as { error?: { message?: string } };
		return parsed.error?.message ?? rawText;
	} catch {
		return rawText;
	}
}

function getOpenAIBaseUrl(model: Model): string {
	const fallback =
		model.api === "openai-codex-responses" || model.provider === "openai-codex"
			? CODEX_BASE_URL
			: DEFAULT_OPENAI_BASE_URL;
	return trimTrailingSlashes(model.baseUrl || fallback);
}

function getOpenAIResponsesUrl(model: Model): string {
	const baseUrl = getOpenAIBaseUrl(model);
	if (model.api !== "openai-codex-responses" && model.provider !== "openai-codex") {
		return `${baseUrl}/responses`;
	}
	const baseWithSlash = baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`;
	return new URL(URL_PATHS.RESPONSES.slice(1), baseWithSlash)
		.toString()
		.replace(URL_PATHS.RESPONSES, URL_PATHS.CODEX_RESPONSES);
}

function buildOpenAIImageHeaders(model: Model, apiKey: string, sessionId: string | undefined): Headers {
	const headers = new Headers(model.headers ?? {});
	headers.set("Content-Type", "application/json");
	headers.set("Authorization", `Bearer ${apiKey}`);

	if (model.api === "openai-codex-responses" || model.provider === "openai-codex") {
		const accountId = getCodexAccountId(apiKey);
		headers.delete("x-api-key");
		if (accountId) {
			headers.set(OPENAI_HEADERS.ACCOUNT_ID, accountId);
		}
		headers.set(OPENAI_HEADERS.BETA, OPENAI_HEADER_VALUES.BETA_RESPONSES);
		headers.set(OPENAI_HEADERS.ORIGINATOR, OPENAI_HEADER_VALUES.ORIGINATOR_CODEX);
		headers.set("User-Agent", `pi/${packageJson.version} (${os.platform()} ${os.release()}; ${os.arch()})`);
		if (sessionId) {
			headers.set(OPENAI_HEADERS.CONVERSATION_ID, sessionId);
			headers.set(OPENAI_HEADERS.SESSION_ID, sessionId);
		}
	}

	return headers;
}

async function parseOpenAIHostedImageSse(response: Response, signal?: AbortSignal): Promise<OpenAIHostedImageResult> {
	if (!response.body) {
		throw new Error("No response body");
	}

	const fallbackOutput: OpenAIResponseOutput[] = [];
	let completedResponse: OpenAIHostedImageResponse | undefined;

	for await (const event of readSseJson<OpenAISseEvent>(response.body, signal)) {
		if (event.type === "error") {
			const message = event.error?.message ?? event.message ?? "OpenAI image request failed";
			throw new Error(message);
		}
		if (event.type === "response.failed") {
			const message = event.response?.error?.message ?? "OpenAI image request failed";
			throw new Error(message);
		}
		if (event.type === "response.output_item.done" && event.item) {
			fallbackOutput.push(event.item);
		}
		if ((event.type === "response.completed" || event.type === "response.done") && event.response) {
			completedResponse = event.response;
		}
	}

	return collectOpenAIHostedImageResult(
		completedResponse?.output?.length
			? completedResponse
			: { output: fallbackOutput, usage: completedResponse?.usage },
	);
}

async function generateOpenAIHostedImage(
	apiKey: string,
	model: Model,
	params: ImageGenParams,
	promptText: string,
	inputImages: InlineImageData[],
	fetchImpl: FetchImpl,
	signal: AbortSignal | undefined,
	sessionId: string | undefined,
): Promise<OpenAIHostedImageResult> {
	const stream = model.api === "openai-codex-responses" || model.provider === "openai-codex";
	const requestBody = buildOpenAIHostedImageRequest(model, promptText, params, inputImages, stream);
	const response = await fetchImpl(getOpenAIResponsesUrl(model), {
		method: "POST",
		headers: buildOpenAIImageHeaders(model, apiKey, sessionId),
		body: JSON.stringify(requestBody),
		signal,
	});

	if (!response.ok) {
		const errorText = await response.text();
		throw Object.assign(
			new Error(`OpenAI image request failed (${response.status}): ${parseProviderErrorMessage(errorText)}`),
			{ status: response.status },
		);
	}

	const contentType = response.headers.get("content-type") ?? "";
	if (stream || contentType.includes("text/event-stream")) {
		return parseOpenAIHostedImageSse(response, signal);
	}

	const data = (await response.json()) as OpenAIHostedImageResponse;
	return collectOpenAIHostedImageResult(data);
}

function combineParts(response: GeminiGenerateContentResponse): GeminiPart[] {
	const parts: GeminiPart[] = [];
	for (const candidate of response.candidates ?? []) {
		const candidateParts = candidate.content?.parts ?? [];
		for (let pi = 0; pi < candidateParts.length; pi++) parts.push(candidateParts[pi]!);
	}
	return parts;
}

function buildAntigravityRequest(
	prompt: string,
	model: string,
	projectId: string,
	aspectRatio: string | undefined,
	imageSize: string | undefined,
	inputImages: InlineImageData[],
): AntigravityRequest {
	const parts: Array<{ text?: string; inlineData?: InlineImageData }> = [];
	for (const image of inputImages) {
		parts.push({ inlineData: image });
	}
	parts.push({ text: prompt });

	const imageConfig = aspectRatio || imageSize ? { aspectRatio: aspectRatio, imageSize: imageSize } : undefined;

	return {
		project: projectId,
		model,
		request: {
			contents: [{ role: "user", parts }],
			systemInstruction: { parts: [{ text: IMAGE_SYSTEM_INSTRUCTION }] },
			generationConfig: {
				responseModalities: ["IMAGE"],
				imageConfig,
				candidateCount: 1,
			},
			safetySettings: [
				{ category: "HARM_CATEGORY_HARASSMENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_HATE_SPEECH", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_SEXUALLY_EXPLICIT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_DANGEROUS_CONTENT", threshold: "BLOCK_ONLY_HIGH" },
				{ category: "HARM_CATEGORY_CIVIC_INTEGRITY", threshold: "BLOCK_ONLY_HIGH" },
			],
		},
		requestType: "agent",
		requestId: `agent-${Date.now()}-${Math.random().toString(36).slice(2, 11)}`,
		userAgent: "antigravity",
	};
}

const XAI_MAX_EDIT_IMAGES = 3;

function resolveXAIResolution(imageSize: string | undefined): "1k" | "2k" {
	if (!imageSize || imageSize === "1024x1024") return "1k";
	return "2k";
}

function buildXAIEditPayload(base: XAIImageRequestBase, images: readonly InlineImageData[]): XAIImageRequestBody {
	const refs: readonly XAIImageReference[] = images.map(img => ({
		type: "image_url",
		url: toDataUrl(img),
	}));
	const [first, ...rest] = refs;
	if (first === undefined) return base; // unreachable: caller checked images.length > 0
	return rest.length === 0 ? { ...base, image: first } : { ...base, images: refs };
}

interface AntigravitySseResult {
	images: InlineImageData[];
	text: string[];
	usage?: GeminiUsageMetadata;
}

async function parseAntigravitySseForImage(response: Response, signal?: AbortSignal): Promise<AntigravitySseResult> {
	if (!response.body) {
		throw new Error("No response body");
	}

	const textParts: string[] = [];
	const images: InlineImageData[] = [];
	let usage: GeminiUsageMetadata | undefined;

	for await (const chunk of readSseJson<AntigravityResponseChunk>(response.body, signal)) {
		const responseData = chunk.response;
		if (!responseData) continue;
		if (!responseData.candidates) continue;
		for (const candidate of responseData.candidates) {
			const parts = candidate.content?.parts;
			if (!parts) continue;
			for (const part of parts) {
				if (part.text) {
					textParts.push(part.text);
				}
				const inlineData = part.inlineData;
				if (inlineData?.data && inlineData.mimeType) {
					images.push({ data: inlineData.data, mimeType: inlineData.mimeType });
				}
			}
		}
		if (responseData.usageMetadata) {
			usage = responseData.usageMetadata;
		}
	}

	return { images, text: textParts, usage };
}

export const imageGenTool: CustomTool<typeof imageGenSchema, ImageGenToolDetails> & {
	readonly loadMode: "discoverable";
} = {
	name: "generate_image",
	label: "GenerateImage",
	strict: false,
	approval: "write",
	loadMode: "discoverable",
	description: prompt.render(toolsPrompts["tools/image-gen"].text),
	parameters: imageGenSchema,
	async execute(_toolCallId, params, _onUpdate, ctx, signal) {
		return untilAborted(signal, async () => {
			const sessionId = ctx.sessionManager.getSessionId();
			const apiKey = await findImageApiKey(ctx.modelRegistry, ctx.model, sessionId);
			if (!apiKey) {
				throw new Error(
					"No image API credentials found. Use a GPT Responses/Codex model with OpenAI credentials, login with google-antigravity or xAI Grok OAuth, or set XAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY, or GOOGLE_API_KEY.",
				);
			}

			const provider = apiKey.provider;
			const model =
				provider === "openai" || provider === "openai-codex"
					? (apiKey.model?.id ?? "gpt")
					: provider === "antigravity"
						? DEFAULT_ANTIGRAVITY_MODEL
						: provider === "openrouter"
							? DEFAULT_OPENROUTER_MODEL
							: provider === "xai"
								? DEFAULT_XAI_IMAGE_MODEL
								: DEFAULT_MODEL;
			const resolvedModel = provider === "openrouter" ? resolveOpenRouterModel(model) : model;
			assertImageAspectRatioSupported(provider, params.aspect_ratio);
			const cwd = ctx.sessionManager.getCwd();

			const resolvedImages: InlineImageData[] = [];
			if (params.input?.length) {
				for (const input of params.input) {
					resolvedImages.push(await resolveInputImage(input, cwd));
				}
			}

			const requestTimeout = scopedTimeoutSignal(IMAGE_TIMEOUT, signal);
			const requestSignal = requestTimeout.signal;
			try {
				const fetchImpl = ctx.fetch ?? fetch;
				const assembleProviderPrompt = (): string => {
					const transform = ctx.obfuscateProviderText;
					if (!transform) return assemblePrompt(params);
					return transform(assemblePrompt(sanitizeImageGenParams(params, transform)));
				};

				if (provider === "openai" || provider === "openai-codex") {
					if (!apiKey.model) {
						throw new Error("Missing active GPT model for OpenAI image generation");
					}

					const hostedModel = apiKey.model;
					const hostedKey: ApiKey = ctx.modelRegistry.resolver(hostedModel, sessionId);

					const parsed = await withAuth(
						hostedKey,
						key =>
							generateOpenAIHostedImage(
								key,
								hostedModel,
								params,
								assembleProviderPrompt(),
								resolvedImages,
								fetchImpl,
								requestSignal,
								sessionId,
							),
						{ signal: requestSignal },
					);

					if (parsed.images.length === 0) {
						return buildNoImageResult({
							provider,
							model,
							responseText: parsed.responseText,
							details: { revisedPrompt: parsed.revisedPrompt, usage: parsed.usage },
						});
					}

					const imagePaths = await saveImagesToTemp(parsed.images);

					return {
						content: [
							{ type: "text", text: buildResponseSummary(provider, model, imagePaths, parsed.responseText) },
						],
						details: {
							provider,
							model,
							imageCount: parsed.images.length,
							imagePaths,
							images: parsed.images,
							responseText: parsed.responseText,
							revisedPrompt: parsed.revisedPrompt,
							usage: parsed.usage,
						},
					};
				}

				if (provider === "antigravity") {
					if (!apiKey.projectId) {
						throw new Error("Missing projectId in antigravity credentials");
					}

					const antigravityKey: ApiKey = ctx.modelRegistry.resolver("google-antigravity", {
						sessionId,
						modelId: DEFAULT_ANTIGRAVITY_MODEL,
					});

					const response = await withAuth(
						antigravityKey,
						async key => {
							const rotated = parseAntigravityCredentials(key);
							const bearer = rotated?.accessToken ?? key;
							const projectId = rotated?.projectId ?? apiKey.projectId!;

							let endpoints: string[] = ANTIGRAVITY_ENDPOINTS.slice();
							try {
								const mode = settings.get("providers.antigravityEndpoint");
								if (mode === "production") {
									endpoints = [ANTIGRAVITY_PRIMARY_ENDPOINT];
								} else if (mode === "sandbox") {
									endpoints = [ANTIGRAVITY_SANDBOX_ENDPOINT];
								}
							} catch {}

							let resp: Response | undefined;
							let lastError: Error | undefined;

							for (let i = 0; i < endpoints.length; i++) {
								const endpoint = endpoints[i];
								const isLastEndpoint = i === endpoints.length - 1;
								try {
									const requestBody = buildAntigravityRequest(
										assembleProviderPrompt(),
										model,
										projectId,
										params.aspect_ratio,
										params.image_size,
										resolvedImages,
									);
									resp = await fetchImpl(`${endpoint}/v1internal:streamGenerateContent?alt=sse`, {
										method: "POST",
										headers: {
											Authorization: `Bearer ${bearer}`,
											"Content-Type": "application/json",
											Accept: "text/event-stream",
											"User-Agent": getAntigravityUserAgent(),
										},
										body: JSON.stringify(requestBody),
										signal: requestSignal,
									});

									if (resp.ok) {
										break;
									}

									const errorText = await resp.text();
									lastError = new ProviderHttpError(
										`Antigravity image request failed (${resp.status}): ${parseProviderErrorMessage(errorText)}`,
										resp.status,
										{ headers: resp.headers },
									);

									if (resp.status === 429 || (resp.status >= 500 && resp.status < 600)) {
										if (!isLastEndpoint) {
											continue;
										}
									}
									break;
								} catch (error) {
									lastError = error as Error;
									if (isLastEndpoint) {
										break;
									}
								}
							}

							if (!resp?.ok) {
								throw lastError ?? new Error("Antigravity image generation failed");
							}

							return resp;
						},
						{ signal: requestSignal },
					);

					const parsed = await parseAntigravitySseForImage(response, requestSignal);
					const responseText = parsed.text.length > 0 ? parsed.text.join(" ") : undefined;

					if (parsed.images.length === 0) {
						return buildNoImageResult({ provider, model, responseText, details: { usage: parsed.usage } });
					}

					const imagePaths = await saveImagesToTemp(parsed.images);

					return {
						content: [{ type: "text", text: buildResponseSummary(provider, model, imagePaths, responseText) }],
						details: {
							provider,
							model,
							imageCount: parsed.images.length,
							imagePaths,
							images: parsed.images,
							responseText,
							usage: parsed.usage,
						},
					};
				}

				if (provider === "xai") {
					if (!ctx.modelRegistry) {
						throw new Error("Missing modelRegistry for xAI image generation");
					}
					const xaiCreds = await resolveXAIHttpCredentials(ctx.modelRegistry, resolvedModel);
					if (!xaiCreds) {
						throw new Error(missingXAICredentialsMessage("no image can be generated"));
					}

					const aspectRatio = params.aspect_ratio ?? "1:1";
					const xaiResolution = resolveXAIResolution(params.image_size);

					const isEdit = resolvedImages.length > 0;
					if (isEdit && resolvedImages.length > XAI_MAX_EDIT_IMAGES) {
						throw new Error(
							`xAI image edits accept up to ${XAI_MAX_EDIT_IMAGES} reference images; got ${resolvedImages.length}.`,
						);
					}

					const xaiEndpoint = isEdit ? "/images/edits" : "/images/generations";

					const xaiKey: ApiKey = ctx.modelRegistry.resolver(xaiCreds.provider, {
						sessionId,
						baseUrl: xaiCreds.baseURL,
					});

					const xaiRawText = await withAuth(
						xaiKey,
						async key => {
							const xaiBaseBody: XAIImageRequestBase = {
								model: resolvedModel,
								prompt: assembleProviderPrompt(),
								aspect_ratio: aspectRatio,
								resolution: xaiResolution,
								n: 1,
								response_format: "b64_json",
							};
							const xaiBody: XAIImageRequestBody = isEdit
								? buildXAIEditPayload(xaiBaseBody, resolvedImages)
								: xaiBaseBody;
							const resp = await fetchImpl(`${xaiCreds.baseURL}${xaiEndpoint}`, {
								method: "POST",
								headers: {
									Authorization: `Bearer ${key}`,
									"Content-Type": "application/json",
									"User-Agent": veyyonXAIUserAgent(),
								},
								body: JSON.stringify(xaiBody),
								signal: requestSignal,
							});
							const rawText = await resp.text();
							if (!resp.ok) {
								throw new ProviderHttpError(
									`xAI image request failed (${resp.status}): ${parseProviderErrorMessage(rawText)}`,
									resp.status,
									{ headers: resp.headers },
								);
							}
							return rawText;
						},
						{ signal: requestSignal },
					);

					const xaiData = JSON.parse(xaiRawText) as {
						data?: Array<{ b64_json?: string; url?: string }>;
					};
					const xaiInlineImages: InlineImageData[] = [];
					for (const entry of xaiData.data ?? []) {
						if (entry.b64_json) {
							const bytes = Buffer.from(entry.b64_json, "base64");
							const mimeType = parseImageMetadata(bytes)?.mimeType ?? "image/png";
							xaiInlineImages.push({ data: entry.b64_json, mimeType });
						} else if (entry.url) {
							xaiInlineImages.push(await loadImageFromUrl(entry.url, fetchImpl, requestSignal));
						}
					}

					if (xaiInlineImages.length === 0) {
						return buildNoImageResult({ provider, model: resolvedModel });
					}

					const xaiImagePaths = await saveImagesToTemp(xaiInlineImages);

					return {
						content: [
							{ type: "text", text: buildResponseSummary(provider, resolvedModel, xaiImagePaths, undefined) },
						],
						details: {
							provider,
							model: resolvedModel,
							imageCount: xaiInlineImages.length,
							imagePaths: xaiImagePaths,
							images: xaiInlineImages,
						},
					};
				}

				if (provider === "openrouter") {
					const rawText = await withAuth(
						apiKey.apiKey,
						async key => {
							const contentParts: OpenRouterContentPart[] = [{ type: "text", text: assembleProviderPrompt() }];
							for (const image of resolvedImages) {
								contentParts.push({ type: "image_url", image_url: { url: toDataUrl(image) } });
							}
							const requestBody = {
								model: resolvedModel,
								messages: [{ role: "user" as const, content: contentParts }],
							};
							const resp = await fetchImpl("https://openrouter.ai/api/v1/chat/completions", {
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									Authorization: `Bearer ${key}`,
									"HTTP-Referer": "https://veyyon.dev/",
									"X-OpenRouter-Title": "Veyyon",
									"X-OpenRouter-Categories": "cli-agent",
								},
								body: JSON.stringify(requestBody),
								signal: requestSignal,
							});
							const text = await resp.text();
							if (!resp.ok) {
								throw new ProviderHttpError(
									`OpenRouter image request failed (${resp.status}): ${parseProviderErrorMessage(text)}`,
									resp.status,
									{ headers: resp.headers },
								);
							}
							return text;
						},
						{ signal: requestSignal },
					);

					const data = JSON.parse(rawText) as OpenRouterResponse;
					const message = data.choices?.[0]?.message;
					const responseText = collectOpenRouterResponseText(message);
					const imageUrls = extractOpenRouterImageUrls(message);
					const inlineImages: InlineImageData[] = [];
					for (const imageUrl of imageUrls) {
						inlineImages.push(await loadImageFromUrl(imageUrl, fetchImpl, requestSignal));
					}

					if (inlineImages.length === 0) {
						return buildNoImageResult({ provider, model: resolvedModel, responseText });
					}

					const imagePaths = await saveImagesToTemp(inlineImages);

					return {
						content: [
							{ type: "text", text: buildResponseSummary(provider, resolvedModel, imagePaths, responseText) },
						],
						details: {
							provider,
							model: resolvedModel,
							imageCount: inlineImages.length,
							imagePaths,
							images: inlineImages,
							responseText,
						},
					};
				}

				const generationConfig: {
					responseModalities: GeminiResponseModality[];
					imageConfig?: { aspectRatio?: string; imageSize?: string };
				} = {
					responseModalities: ["IMAGE"],
				};

				if (params.aspect_ratio || params.image_size) {
					generationConfig.imageConfig = {
						aspectRatio: params.aspect_ratio,
						imageSize: params.image_size,
					};
				}

				const rawText = await withAuth(
					apiKey.apiKey,
					async key => {
						const parts = resolvedImages.map(image => ({ inlineData: image })) as Array<{
							text?: string;
							inlineData?: InlineImageData;
						}>;
						parts.push({ text: assembleProviderPrompt() });
						const requestBody = {
							contents: [{ role: "user" as const, parts }],
							generationConfig,
						};
						const resp = await fetchImpl(
							`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`,
							{
								method: "POST",
								headers: {
									"Content-Type": "application/json",
									"x-goog-api-key": key,
								},
								body: JSON.stringify(requestBody),
								signal: requestSignal,
							},
						);
						const text = await resp.text();
						if (!resp.ok) {
							throw new ProviderHttpError(
								`Gemini image request failed (${resp.status}): ${parseProviderErrorMessage(text)}`,
								resp.status,
								{ headers: resp.headers },
							);
						}
						return text;
					},
					{ signal: requestSignal },
				);

				const data = JSON.parse(rawText) as GeminiGenerateContentResponse;
				const responseParts = combineParts(data);
				const responseText = collectResponseText(responseParts);
				const inlineImages = collectInlineImages(responseParts);

				if (inlineImages.length === 0) {
					const blockReason = data.promptFeedback?.blockReason;
					return buildNoImageResult({
						provider,
						model,
						reason: blockReason ? `the prompt was blocked (${blockReason})` : undefined,
						responseText,
						details: { promptFeedback: data.promptFeedback, usage: data.usageMetadata },
					});
				}

				const imagePaths = await saveImagesToTemp(inlineImages);

				return {
					content: [{ type: "text", text: buildResponseSummary(provider, model, imagePaths, responseText) }],
					details: {
						provider,
						model,
						imageCount: inlineImages.length,
						imagePaths,
						images: inlineImages,
						responseText,
						promptFeedback: data.promptFeedback,
						usage: data.usageMetadata,
					},
				};
			} finally {
				requestTimeout.cancel();
			}
		});
	},
};

export async function getImageGenTools(
	_modelRegistry?: ModelRegistry,
	_activeModel?: Model,
): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}

export async function getImageGenToolsWithRegistry(
	_modelRegistry: ModelRegistry,
	_activeModel?: Model,
): Promise<Array<CustomTool<typeof imageGenSchema, ImageGenToolDetails>>> {
	return [imageGenTool];
}
