import * as os from "node:os";
import * as path from "node:path";
import type { AgentToolResult } from "@veyyon/agent-core";
import type { ApiKey, FetchImpl, Model } from "@veyyon/ai";
import { getEnvApiKey } from "@veyyon/ai/env-api-key";
import { $env, isEnoent, Snowflake } from "@veyyon/utils";
import { type } from "arktype";
import { isAuthenticated } from "../config/auth-state";
import type { ModelRegistry } from "../config/model-registry";
import { resolveXAIHttpCredentials } from "../lib/xai-http";
import { canonicalizeImageContent } from "../utils/image-resize";
import { getOpenAIHostedImageProvider, isOpenAIHostedImageModel } from "./image-gen";
import { resolveReadPath } from "./path-utils";

export const DEFAULT_MODEL = "gemini-3-pro-image-preview";
export const DEFAULT_OPENROUTER_MODEL = "google/gemini-3-pro-image-preview";
export const DEFAULT_ANTIGRAVITY_MODEL = "gemini-3-pro-image";
export const DEFAULT_XAI_IMAGE_MODEL = "grok-imagine-image";
export const IMAGE_TIMEOUT = 3 * 60 * 1000; // 3 minutes
export const MAX_IMAGE_SIZE = 35 * 1024 * 1024;
export const DEFAULT_OPENAI_BASE_URL = "https://api.openai.com/v1";
export const OPENAI_IMAGE_OUTPUT_FORMAT = "webp";
export const OPENAI_IMAGE_MIME_TYPE = "image/webp";

export const IMAGE_SYSTEM_INSTRUCTION =
	"You are an AI image generator. Generate images based on user descriptions. Focus on creating high-quality, visually appealing images that match the user's request.";

export type ImageProvider = "antigravity" | "gemini" | "openai" | "openai-codex" | "openrouter" | "xai";
export type ImageProviderPreference = Exclude<ImageProvider, "openai-codex"> | "auto";

export interface ImageApiKey {
	provider: ImageProvider;
	apiKey: ApiKey;
	projectId?: string;
	model?: Model;
}

export const COMMON_IMAGE_ASPECT_RATIOS = ["1:1", "3:4", "4:3", "9:16", "16:9"] as const;
export const XAI_IMAGE_ASPECT_RATIOS = [...COMMON_IMAGE_ASPECT_RATIOS, "3:2", "2:3"] as const;
export const COMMON_IMAGE_ASPECT_RATIO_SET = new Set<string>(COMMON_IMAGE_ASPECT_RATIOS);
export const IMAGE_PROVIDER_PREFERENCES = new Set<string>([
	"auto",
	"antigravity",
	"gemini",
	"openai",
	"openrouter",
	"xai",
]);

export const responseModalitySchema = type('"IMAGE" | "TEXT"');

export const aspectRatioSchema = type.enumerated(...XAI_IMAGE_ASPECT_RATIOS).describe("aspect ratio");
export const imageSizeSchema = type('"1024x1024" | "1536x1024" | "1024x1536"').describe("image size");

export const inputImageSchema = type({
	"path?": type("string").describe("input image path"),
	"data?": type("string").describe("base64 image data"),
	"mime_type?": type("string").describe("mime type"),
});

export const imageGenSchema = type({
	subject: type("string").describe("main subject"),
	"action?": type("string").describe("what subject is doing"),
	"scene?": type("string").describe("location or environment"),
	"composition?": type("string").describe("camera angle and framing"),
	"lighting?": type("string").describe("lighting setup"),
	"style?": type("string").describe("artistic style"),
	"text?": type("string").describe("text to render"),
	"changes?": type("string[]").describe("edits to make"),
	"aspect_ratio?": aspectRatioSchema,
	"image_size?": imageSizeSchema,
	"input?": inputImageSchema.array().describe("input images"),
});
export type ImageGenParams = typeof imageGenSchema.infer;
export type GeminiResponseModality = typeof responseModalitySchema.infer;

export function assemblePrompt(params: ImageGenParams): string {
	const parts: string[] = [];

	const subjectParts = [params.subject];
	if (params.action) subjectParts.push(params.action);
	if (params.scene) subjectParts.push(params.scene);
	parts.push(subjectParts.join(", "));

	if (params.composition) parts.push(params.composition);
	if (params.lighting) parts.push(params.lighting);
	if (params.style) parts.push(params.style);

	let prompt = `${parts.map(p => p.replace(/[.!,;:]+$/, "")).join(". ")}.`;

	if (params.text) {
		prompt += `\n\nText: ${params.text}`;
	}

	if (params.changes?.length) {
		prompt += `\n\nChanges:\n${params.changes.map(c => `- ${c}`).join("\n")}`;
	}

	return prompt;
}

export function sanitizeImageGenParams(params: ImageGenParams, transform: (text: string) => string): ImageGenParams {
	return {
		...params,
		subject: transform(params.subject),
		action: params.action === undefined ? undefined : transform(params.action),
		scene: params.scene === undefined ? undefined : transform(params.scene),
		composition: params.composition === undefined ? undefined : transform(params.composition),
		lighting: params.lighting === undefined ? undefined : transform(params.lighting),
		style: params.style === undefined ? undefined : transform(params.style),
		text: params.text === undefined ? undefined : transform(params.text),
		changes: params.changes?.map(transform),
	};
}

export interface GeminiInlineData {
	data?: string;
	mimeType?: string;
}

export interface GeminiPart {
	text?: string;
	inlineData?: GeminiInlineData;
}

export interface GeminiCandidate {
	content?: { parts?: GeminiPart[] };
}

export interface GeminiSafetyRating {
	category?: string;
	probability?: string;
}

export interface GeminiPromptFeedback {
	blockReason?: string;
	safetyRatings?: GeminiSafetyRating[];
}

export interface GeminiUsageMetadata {
	promptTokenCount?: number;
	candidatesTokenCount?: number;
	totalTokenCount?: number;
}

export interface GeminiGenerateContentResponse {
	candidates?: GeminiCandidate[];
	promptFeedback?: GeminiPromptFeedback;
	usageMetadata?: GeminiUsageMetadata;
}

export interface OpenAIResponsesUsage {
	input_tokens?: number;
	output_tokens?: number;
	total_tokens?: number;
}

export type ImageUsageMetadata = GeminiUsageMetadata | OpenAIResponsesUsage;

export type OpenAIImageAction = "edit" | "generate";

export interface OpenAIInputTextContent {
	type: "input_text";
	text: string;
}

export interface OpenAIInputImageContent {
	type: "input_image";
	detail: "auto";
	image_url: string;
}

export type OpenAIInputContent = OpenAIInputTextContent | OpenAIInputImageContent;

export interface OpenAIImageGenerationTool {
	type: "image_generation";
	action: OpenAIImageAction;
	output_format: typeof OPENAI_IMAGE_OUTPUT_FORMAT;
	size?: string;
}

export interface OpenAIHostedImageRequest {
	model: string;
	instructions?: string;
	input: Array<{ role: "user"; content: OpenAIInputContent[] }>;
	tools: OpenAIImageGenerationTool[];
	tool_choice: { type: "image_generation" };
	store: false;
	stream?: boolean;
}

export interface OpenAIImageGenerationCall {
	id?: string;
	type: "image_generation_call";
	result?: string;
	revised_prompt?: string;
	status?: string;
}

export interface OpenAIOutputText {
	type: "output_text" | "refusal";
	text?: string;
	refusal?: string;
}

export interface OpenAIOutputMessage {
	id?: string;
	type: "message";
	content?: OpenAIOutputText[];
}

export type OpenAIResponseOutput = OpenAIImageGenerationCall | OpenAIOutputMessage;

export interface OpenAIHostedImageResponse {
	output?: OpenAIResponseOutput[];
	usage?: OpenAIResponsesUsage;
	error?: { code?: string; message?: string };
}

export interface OpenAISseEvent {
	type?: string;
	item?: OpenAIResponseOutput;
	response?: OpenAIHostedImageResponse;
	code?: string;
	message?: string;
	error?: { code?: string; message?: string };
}

export interface OpenAIHostedImageResult {
	images: InlineImageData[];
	responseText?: string;
	revisedPrompt?: string;
	usage?: OpenAIResponsesUsage;
}

export interface OpenRouterImageUrl {
	url: string;
}

export interface OpenRouterContentPart {
	type: "text" | "image_url";
	text?: string;
	image_url?: OpenRouterImageUrl;
}

export interface OpenRouterMessage {
	content?: string | OpenRouterContentPart[];
	images?: Array<string | { image_url?: OpenRouterImageUrl }>;
}

export interface OpenRouterChoice {
	message?: OpenRouterMessage;
}

export interface OpenRouterResponse {
	choices?: OpenRouterChoice[];
}

export interface AntigravityRequest {
	project: string;
	model: string;
	request: {
		contents: Array<{ role: "user"; parts: Array<{ text?: string; inlineData?: InlineImageData }> }>;
		systemInstruction?: { parts: Array<{ text: string }> };
		generationConfig?: {
			responseModalities?: GeminiResponseModality[];
			imageConfig?: { aspectRatio?: string; imageSize?: string };
			candidateCount?: number;
		};
		safetySettings?: Array<{ category: string; threshold: string }>;
	};
	requestType?: string;
	userAgent?: string;
	requestId?: string;
}

export interface XAIImageReference {
	readonly type: "image_url";
	readonly url: string;
}

export interface XAIImageRequestBase {
	readonly model: string;
	readonly prompt: string;
	readonly aspect_ratio: string;
	readonly resolution: "1k" | "2k";
	readonly n: number;
	readonly response_format: "b64_json" | "url";
}

export type XAIImageRequestBody =
	| (XAIImageRequestBase & { readonly image?: never; readonly images?: never })
	| (XAIImageRequestBase & { readonly image: XAIImageReference; readonly images?: never })
	| (XAIImageRequestBase & { readonly images: readonly XAIImageReference[]; readonly image?: never });

export interface AntigravityResponseChunk {
	response?: {
		candidates?: Array<{
			content?: {
				role: string;
				parts?: Array<{
					text?: string;
					inlineData?: { mimeType?: string; data?: string };
				}>;
			};
		}>;
		usageMetadata?: GeminiUsageMetadata;
	};
}

export interface ImageGenToolDetails {
	provider: ImageProvider;
	model: string;
	imageCount: number;
	imagePaths: string[];
	images: InlineImageData[];
	responseText?: string;
	promptFeedback?: GeminiPromptFeedback;
	revisedPrompt?: string;
	usage?: ImageUsageMetadata;
}

export interface ImageInput {
	path?: string;
	data?: string;
	mime_type?: string;
}

export interface InlineImageData {
	data: string;
	mimeType: string;
}

function normalizeDataUrl(data: string): { data: string; mimeType?: string } {
	const match = data.match(/^data:([^;]+);base64,(.+)$/);
	if (!match) return { data };
	return { data: match[2] ?? "", mimeType: match[1] };
}

export function resolveOpenRouterModel(model: string): string {
	return model.includes("/") ? model : `google/${model}`;
}

export function toDataUrl(image: InlineImageData): string {
	return `data:${image.mimeType};base64,${image.data}`;
}

async function canonicalizeProviderImage(data: string): Promise<InlineImageData> {
	if (Buffer.byteLength(data, "base64") > MAX_IMAGE_SIZE) {
		throw new Error("Image exceeds the provider input size limit.");
	}
	const canonical = await canonicalizeImageContent({ data });
	if (canonical.buffer.byteLength > MAX_IMAGE_SIZE) {
		throw new Error("Image exceeds the provider input size limit after normalization.");
	}
	return { data: canonical.data, mimeType: canonical.mimeType };
}

export async function loadImageFromUrl(
	imageUrl: string,
	fetchImpl: FetchImpl,
	signal?: AbortSignal,
): Promise<InlineImageData> {
	if (imageUrl.startsWith("data:")) {
		const normalized = normalizeDataUrl(imageUrl.trim());
		if (!normalized.mimeType) {
			throw new Error("mime_type is required when providing raw base64 data.");
		}
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return { data: normalized.data, mimeType: normalized.mimeType };
	}

	const response = await fetchImpl(imageUrl, { signal });
	if (!response.ok) {
		const rawText = await response.text();
		throw new Error(`Image download failed (${response.status}): ${rawText}`);
	}
	const contentType = response.headers.get("content-type")?.split(";")[0];
	if (!contentType?.startsWith("image/")) {
		throw new Error(`Unsupported image type from URL: ${imageUrl}`);
	}
	const buffer = await (response as Response & { bytes(): Promise<Uint8Array> }).bytes();
	return { data: buffer.toBase64(), mimeType: contentType };
}

export function collectOpenRouterResponseText(message: OpenRouterMessage | undefined): string | undefined {
	if (!message) return undefined;
	if (typeof message.content === "string") {
		const trimmed = message.content.trim();
		return trimmed.length > 0 ? trimmed : undefined;
	}
	if (Array.isArray(message.content)) {
		const texts = message.content
			.filter(part => part.type === "text")
			.map(part => part.text)
			.filter((text): text is string => Boolean(text));
		const combined = texts.join("\n").trim();
		return combined.length > 0 ? combined : undefined;
	}
	return undefined;
}

export function extractOpenRouterImageUrls(message: OpenRouterMessage | undefined): string[] {
	const urls: string[] = [];
	if (!message) return urls;
	for (const image of message.images ?? []) {
		if (typeof image === "string") {
			urls.push(image);
			continue;
		}
		if (image.image_url?.url) {
			urls.push(image.image_url.url);
		}
	}
	if (Array.isArray(message.content)) {
		for (const part of message.content) {
			if (part.type === "image_url" && part.image_url?.url) {
				urls.push(part.image_url.url);
			}
		}
	}
	return urls;
}

export let preferredImageProvider: ImageProviderPreference = "auto";

export function isImageProviderPreference(value: unknown): value is ImageProviderPreference {
	return typeof value === "string" && IMAGE_PROVIDER_PREFERENCES.has(value);
}

export function setPreferredImageProvider(provider: ImageProviderPreference): void {
	preferredImageProvider = provider;
}
export function assertImageAspectRatioSupported(
	provider: ImageProvider,
	aspectRatio: ImageGenParams["aspect_ratio"],
): void {
	if (!aspectRatio || provider === "xai" || COMMON_IMAGE_ASPECT_RATIO_SET.has(aspectRatio)) {
		return;
	}
	throw new Error(
		`Aspect ratio ${aspectRatio} is only supported by xAI image generation. Set providers.image to xai or use one of ${COMMON_IMAGE_ASPECT_RATIOS.join(", ")}.`,
	);
}

export interface ParsedAntigravityCredentials {
	accessToken: string;
	projectId: string;
}

export function parseAntigravityCredentials(raw: string): ParsedAntigravityCredentials | null {
	try {
		const parsed = JSON.parse(raw) as { token?: string; projectId?: string };
		if (parsed.token && parsed.projectId) {
			return { accessToken: parsed.token, projectId: parsed.projectId };
		}
	} catch {}
	return null;
}

async function findAntigravityCredentials(
	modelRegistry: ModelRegistry,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	const apiKey = await modelRegistry.getApiKeyForProvider("google-antigravity", sessionId, {
		modelId: DEFAULT_ANTIGRAVITY_MODEL,
	});
	if (!apiKey) return null;

	const parsed = parseAntigravityCredentials(apiKey);
	if (!parsed) return null;

	return {
		provider: "antigravity",
		apiKey: parsed.accessToken,
		projectId: parsed.projectId,
	};
}

async function findXAIImageCredentials(modelRegistry?: ModelRegistry): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		const creds = await resolveXAIHttpCredentials(modelRegistry);
		if (creds) return { provider: "xai", apiKey: creds.apiKey };
		return null;
	}
	const apiKey = $env.XAI_API_KEY;
	if (apiKey) return { provider: "xai", apiKey };
	return null;
}

async function findOpenRouterImageCredentials(
	modelRegistry?: ModelRegistry,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		const apiKey = await modelRegistry.getApiKeyForProvider("openrouter", sessionId);
		if (apiKey) return { provider: "openrouter", apiKey: modelRegistry.resolver("openrouter", { sessionId }) };
		return null;
	}
	const apiKey = getEnvApiKey("openrouter");
	if (apiKey) return { provider: "openrouter", apiKey };
	return null;
}

async function findGeminiImageCredentials(
	modelRegistry?: ModelRegistry,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (modelRegistry) {
		const apiKey = await modelRegistry.getApiKeyForProvider("google", sessionId);
		if (apiKey) return { provider: "gemini", apiKey: modelRegistry.resolver("google", { sessionId }) };
	} else {
		const envKey = getEnvApiKey("google");
		if (envKey) return { provider: "gemini", apiKey: envKey };
	}
	const googleKey = $env.GOOGLE_API_KEY;
	if (googleKey) return { provider: "gemini", apiKey: googleKey };
	return null;
}

async function findOpenAIHostedImageCredentials(
	modelRegistry: ModelRegistry | undefined,
	activeModel: Model | undefined,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (!modelRegistry || !isOpenAIHostedImageModel(activeModel)) return null;
	const apiKey = await modelRegistry.getApiKey(activeModel, sessionId);
	if (!isAuthenticated(apiKey)) return null;
	return {
		provider: getOpenAIHostedImageProvider(activeModel),
		apiKey,
		model: activeModel,
	};
}

export async function findImageApiKey(
	modelRegistry?: ModelRegistry,
	activeModel?: Model,
	sessionId?: string,
): Promise<ImageApiKey | null> {
	if (preferredImageProvider === "openai") {
		const openAI = await findOpenAIHostedImageCredentials(modelRegistry, activeModel, sessionId);
		if (openAI) return openAI;
	} else if (preferredImageProvider === "antigravity" && modelRegistry) {
		const antigravity = await findAntigravityCredentials(modelRegistry, sessionId);
		if (antigravity) return antigravity;
	} else if (preferredImageProvider === "gemini") {
		const gemini = await findGeminiImageCredentials(modelRegistry, sessionId);
		if (gemini) return gemini;
	} else if (preferredImageProvider === "openrouter") {
		const openRouter = await findOpenRouterImageCredentials(modelRegistry, sessionId);
		if (openRouter) return openRouter;
	} else if (preferredImageProvider === "xai") {
		const xai = await findXAIImageCredentials(modelRegistry);
		if (xai) return xai;
	}

	const openAI = await findOpenAIHostedImageCredentials(modelRegistry, activeModel, sessionId);
	if (openAI) return openAI;

	if (modelRegistry) {
		const antigravity = await findAntigravityCredentials(modelRegistry, sessionId);
		if (antigravity) return antigravity;
	}

	const xai = await findXAIImageCredentials(modelRegistry);
	if (xai) return xai;

	const openRouter = await findOpenRouterImageCredentials(modelRegistry, sessionId);
	if (openRouter) return openRouter;

	const gemini = await findGeminiImageCredentials(modelRegistry, sessionId);
	if (gemini) return gemini;

	return null;
}

async function loadImageFromPath(imagePath: string, cwd: string): Promise<InlineImageData> {
	const resolved = resolveReadPath(imagePath, cwd);
	try {
		const buffer = await Bun.file(resolved).bytes();
		if (buffer.length > MAX_IMAGE_SIZE) {
			throw new Error(`Image file too large: ${imagePath}`);
		}

		return canonicalizeProviderImage(buffer.toBase64());
	} catch (err) {
		if (isEnoent(err)) throw new Error(`Image file not found: ${imagePath}`);
		throw err;
	}
}

export async function resolveInputImage(input: ImageInput, cwd: string): Promise<InlineImageData> {
	if (input.path) {
		return loadImageFromPath(input.path, cwd);
	}

	if (input.data) {
		const normalized = normalizeDataUrl(input.data.trim());
		if (!normalized.data) {
			throw new Error("Image data is empty.");
		}
		return canonicalizeProviderImage(normalized.data);
	}

	throw new Error("input_images entries must include either path or data.");
}

function getExtensionForMime(mimeType: string): string {
	const map: Record<string, string> = {
		"image/png": "png",
		"image/jpeg": "jpg",
		"image/gif": "gif",
		"image/webp": "webp",
	};
	return map[mimeType] ?? "png";
}

async function saveImageToTemp(image: InlineImageData): Promise<string> {
	const ext = getExtensionForMime(image.mimeType);
	const filename = `veyyon-image-${Snowflake.next()}.${ext}`;
	const filepath = path.join(os.tmpdir(), filename);
	await Bun.write(filepath, Buffer.from(image.data, "base64"));
	return filepath;
}

export async function saveImagesToTemp(images: InlineImageData[]): Promise<string[]> {
	return Promise.all(images.map(saveImageToTemp));
}

export function buildResponseSummary(
	provider: ImageProvider,
	model: string,
	imagePaths: string[],
	responseText: string | undefined,
): string {
	const lines = [`Provider: ${provider}`, `Model: ${model}`, `Generated ${imagePaths.length} image(s):`];
	for (const p of imagePaths) {
		lines.push(`  ${p}`);
	}
	if (responseText) {
		lines.push("", responseText.trim());
	}
	return lines.join("\n");
}

export function buildNoImageResult(args: {
	provider: ImageProvider;
	model: string;
	reason?: string;
	responseText?: string;
	details?: Partial<ImageGenToolDetails>;
}): AgentToolResult<ImageGenToolDetails> {
	const { provider, model, reason, responseText } = args;
	const lines = [
		reason
			? `Image generation failed: ${reason}`
			: `Image generation failed: ${provider} (${model}) returned a response with no image in it.`,
	];
	if (responseText?.trim()) lines.push("", responseText.trim());
	lines.push(
		"",
		reason
			? "Retrying the same prompt will fail the same way. Change the prompt, or pick a different provider or model."
			: "This can be transient. Retry once; if it happens again, change the prompt or pick a different provider or model.",
	);
	return {
		isError: true,
		content: [{ type: "text", text: lines.join("\n") }],
		details: {
			provider,
			model,
			imageCount: 0,
			imagePaths: [],
			images: [],
			...(responseText != null ? { responseText } : {}),
			...args.details,
		},
	};
}
