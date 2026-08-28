import * as path from "node:path";
import {
	type AgentTelemetry,
	type AgentTelemetryConfig,
	instrumentedCompleteSimple,
	resolveTelemetry,
} from "@veyyon/agent-core";
import type { Api, completeSimple, ImageContent, Model, TextContent } from "@veyyon/ai";
import { logger, prompt, toError } from "@veyyon/utils";
import { extractTextContent } from "../commit/utils";
import type { ModelRegistry } from "../config/model-registry";
import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import type { Settings } from "../config/settings";
import { type LocalProtocolOptions, resolveLocalRoot } from "../internal-urls/local-protocol";
import { toolsPrompts } from "../prompts/tools/rows";
import { canonicalizeImageContent } from "./image-resize";

const ONESHOT_KIND = "image_attachment_describe";

const NO_VISION_MODEL_NOTE =
	"[No vision-capable model is configured, so this image could not be described automatically. " +
	"The image was saved; configure a vision model role (modelRoles.vision) and use the inspect_image tool to analyze it.]";

const DESCRIPTION_UNAVAILABLE_NOTE =
	"[Image description unavailable: the vision model returned no usable text. The image was saved for further analysis.]";

export type VisionFallbackRegistry = Pick<ModelRegistry, "getAvailable" | "getApiKey" | "resolver">;

export interface DescribeAttachedImagesDeps {
	activeModel: Model<Api>;
	modelRegistry: VisionFallbackRegistry;
	settings: Settings;
	localProtocolOptions: LocalProtocolOptions;
	activeModelString?: string;
	telemetryConfig?: AgentTelemetryConfig;
	sessionId?: string;
	completeImpl?: typeof completeSimple;
}

function extensionForMime(mimeType: string): string {
	const subtype = mimeType.split("/")[1]?.toLowerCase() ?? "";
	switch (subtype) {
		case "jpeg":
		case "jpg":
			return "jpg";
		case "png":
			return "png";
		case "gif":
			return "gif";
		case "webp":
			return "webp";
		default: {
			const sanitized = subtype.replace(/[^a-z0-9]/g, "");
			return sanitized || "png";
		}
	}
}

function imageFileName(image: ImageContent): string {
	const hash = Bun.hash(image.data).toString(16);
	return `image-${hash}.${extensionForMime(image.mimeType)}`;
}

async function saveImage(image: ImageContent, localRoot: string): Promise<string> {
	const fileName = imageFileName(image);
	const filePath = path.join(localRoot, fileName);
	await Bun.write(filePath, Buffer.from(image.data, "base64"));
	return `local://${fileName}`;
}

function formatImageBlock(localUrl: string, description: string): string {
	return `<image path="${localUrl}">\n${description}\n</image>`;
}

function resolveVisionModel(deps: DescribeAttachedImagesDeps): Model<Api> | undefined {
	const available = deps.modelRegistry.getAvailable();
	if (available.length === 0) return undefined;
	const preferences = getModelMatchPreferences(deps.settings);
	const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
		if (!pattern) return undefined;
		const expanded = expandRoleAlias(pattern, deps.settings);
		const model = resolveModelFromString(expanded, available, preferences);
		return model?.input.includes("image") ? model : undefined;
	};
	return (
		resolvePattern("@vision") ??
		resolvePattern("@default") ??
		resolvePattern(deps.activeModelString) ??
		available.find(model => model.input.includes("image"))
	);
}

async function describeImage(
	image: ImageContent,
	visionModel: Model<Api>,
	deps: DescribeAttachedImagesDeps,
	telemetry: AgentTelemetry | undefined,
	signal: AbortSignal | undefined,
): Promise<string | null> {
	try {
		const providerImage = await canonicalizeImageContent(image);
		const response = await instrumentedCompleteSimple(
			visionModel,
			{
				systemPrompt: [prompt.render(toolsPrompts["tools/image-attachment-describe-system"].text)],
				messages: [
					{
						role: "user",
						content: [
							{ type: "image", data: providerImage.data, mimeType: providerImage.mimeType },
							{ type: "text", text: prompt.render(toolsPrompts["tools/image-attachment-describe"].text) },
						],
						timestamp: Date.now(),
					},
				],
			},
			{ apiKey: deps.modelRegistry.resolver(visionModel, deps.sessionId), signal },
			{ telemetry, oneshotKind: ONESHOT_KIND, completeImpl: deps.completeImpl },
		);
		if (response.stopReason === "error" || response.stopReason === "aborted") {
			logger.warn("image attachment description did not complete", {
				stopReason: response.stopReason,
				model: `${visionModel.provider}/${visionModel.id}`,
			});
			return null;
		}
		const text = extractTextContent(response).trim();
		return text.length > 0 ? text : null;
	} catch (err) {
		logger.warn("image attachment description failed", {
			error: toError(err).message,
			model: `${visionModel.provider}/${visionModel.id}`,
		});
		return null;
	}
}

export async function describeAttachedImagesForTextModel(
	images: readonly ImageContent[],
	deps: DescribeAttachedImagesDeps,
	signal?: AbortSignal,
): Promise<TextContent[]> {
	const localRoot = resolveLocalRoot(deps.localProtocolOptions);
	const visionModel = resolveVisionModel(deps);
	const apiKey = visionModel ? await deps.modelRegistry.getApiKey(visionModel, deps.sessionId) : undefined;
	const canDescribe = Boolean(visionModel && apiKey);
	const telemetry = resolveTelemetry(deps.telemetryConfig, deps.sessionId);

	return Promise.all(
		images.map(async (image): Promise<TextContent> => {
			const localUrl = await saveImage(image, localRoot);
			let description: string;
			if (canDescribe && visionModel) {
				description =
					(await describeImage(image, visionModel, deps, telemetry, signal)) ?? DESCRIPTION_UNAVAILABLE_NOTE;
			} else {
				description = NO_VISION_MODEL_NOTE;
			}
			return { type: "text", text: formatImageBlock(localUrl, description) };
		}),
	);
}
