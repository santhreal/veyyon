import type { AgentTool, AgentToolContext, AgentToolResult, AgentToolUpdateCallback } from "@veyyon/agent-core";
import { instrumentedCompleteSimple, resolveTelemetry } from "@veyyon/agent-core";
import { type Api, completeSimple, type Model, type ToolExample } from "@veyyon/ai";
import { withAuth } from "@veyyon/ai/auth-retry";
import { prompt } from "@veyyon/utils";
import { extractTextContent } from "../commit/utils";

import { expandRoleAlias, getModelMatchPreferences, resolveModelFromString } from "../config/model-resolver";
import { toolsPrompts } from "../prompts/tools/rows";
import {
	ImageInputTooLargeError,
	type LoadedImageInput,
	loadImageInput,
	MAX_IMAGE_INPUT_BYTES,
	webpExclusionForModel,
} from "../utils/image-loading";
import type { ToolSession } from "./index";
import type { InspectImageParams, InspectImageToolDetails } from "./inspect-image-helpers";

import {
	inspectImageFilesystemTargets,
	inspectImageSchema,
	loadAttachmentReferenceInput,
	parseImageAttachmentReference,
} from "./inspect-image-helpers";
import { ToolError } from "./tool-errors";

export { inspectImageFilesystemTargets };

export class InspectImageTool implements AgentTool<typeof inspectImageSchema, InspectImageToolDetails> {
	readonly name = "inspect_image";
	readonly approval = "read" as const;
	// `inspect_image` reads a file by path like `read`, so it joins the cwd
	// boundary: an out-of-cwd image prompts in non-yolo modes. See cwd-boundary.ts.
	readonly filesystemTargets = (args: unknown): string[] => inspectImageFilesystemTargets(args);
	readonly label = "InspectImage";
	readonly loadMode = "discoverable";
	readonly summary = "Describe or analyze an image file";
	readonly description: string;
	readonly parameters = inspectImageSchema;
	readonly strict = false;

	readonly examples: readonly ToolExample<typeof inspectImageSchema.infer>[] = [
		{
			caption: "OCR with strict formatting",
			call: {
				path: "screenshots/error.png",
				question: "Extract all visible text verbatim. Return as bullet list in reading order.",
			},
		},
		{
			caption: "Screenshot debugging",
			call: {
				path: "screenshots/settings.png",
				question:
					"Identify the likely cause of the disabled Save button. Return: (1) observations, (2) likely cause, (3) confidence.",
			},
		},
		{
			caption: "Scene/object question",
			call: {
				path: "photos/shelf.jpg",
				question:
					"List all clearly visible product labels and their shelf positions (top/middle/bottom). If unreadable, say unreadable.",
			},
		},
	];

	constructor(
		private readonly session: ToolSession,
		private readonly completeImageRequest: typeof completeSimple = completeSimple,
	) {
		this.description = prompt.render(toolsPrompts["tools/inspect-image"].text);
	}

	async execute(
		_toolCallId: string,
		params: InspectImageParams,
		signal?: AbortSignal,
		_onUpdate?: AgentToolUpdateCallback<InspectImageToolDetails>,
		_context?: AgentToolContext,
	): Promise<AgentToolResult<InspectImageToolDetails>> {
		if (this.session.settings.get("images.blockImages")) {
			throw new ToolError(
				"Image submission is disabled by settings (images.blockImages=true). Disable it to use inspect_image.",
			);
		}

		const modelRegistry = this.session.modelRegistry;
		if (!modelRegistry) {
			throw new ToolError("Model registry is unavailable for inspect_image.");
		}

		const availableModels = modelRegistry.getAvailable();
		if (availableModels.length === 0) {
			throw new ToolError("No models available for inspect_image.");
		}

		const matchPreferences = getModelMatchPreferences(this.session.settings);
		const resolvePattern = (pattern: string | undefined): Model<Api> | undefined => {
			if (!pattern) return undefined;
			const expanded = expandRoleAlias(pattern, this.session.settings);
			return resolveModelFromString(expanded, availableModels, matchPreferences);
		};

		const activeModelPattern = this.session.getActiveModelString?.() ?? this.session.getModelString?.();
		const model =
			resolvePattern("@vision") ??
			resolvePattern("@default") ??
			resolvePattern(activeModelPattern) ??
			availableModels[0];
		if (!model) {
			throw new ToolError("Unable to resolve a model for inspect_image.");
		}

		if (!model.input.includes("image")) {
			throw new ToolError(
				`Resolved model ${model.provider}/${model.id} does not support image input. Configure a vision-capable model for modelRoles.vision.`,
			);
		}

		const apiKey = await modelRegistry.getApiKey(model);
		if (!apiKey) {
			throw new ToolError(
				`No API key available for ${model.provider}/${model.id}. Configure credentials for this provider or choose another vision-capable model.`,
			);
		}

		let imageInput: LoadedImageInput | null;
		const autoResize = this.session.settings.get("images.autoResize");
		const excludeWebP = webpExclusionForModel(model);
		const attachmentReference = parseImageAttachmentReference(params.path);
		try {
			if (attachmentReference) {
				imageInput = await loadAttachmentReferenceInput({
					path: params.path,
					reference: attachmentReference,
					attachments: this.session.getImageAttachments?.() ?? [],
					autoResize,
					excludeWebP,
				});
			} else {
				imageInput = await loadImageInput({
					path: params.path,
					cwd: this.session.cwd,
					autoResize,
					maxBytes: MAX_IMAGE_INPUT_BYTES,
					excludeWebP,
				});
			}
		} catch (error) {
			if (error instanceof ImageInputTooLargeError) {
				throw new ToolError(error.message);
			}
			throw error;
		}

		if (!imageInput) {
			throw new ToolError("inspect_image only supports PNG, JPEG, GIF, and WEBP files detected by file content.");
		}

		const buildProviderContext = () => {
			const providerQuestion = this.session.obfuscateProviderText?.(params.question) ?? params.question;
			return {
				systemPrompt: [prompt.render(toolsPrompts["tools/inspect-image-system"].text)],
				messages: [
					{
						role: "user" as const,
						content: [
							{ type: "image" as const, data: imageInput.data, mimeType: imageInput.mimeType },
							{ type: "text" as const, text: providerQuestion },
						],
						timestamp: Date.now(),
					},
				],
			};
		};
		const credential = modelRegistry.resolver(model, this.session.getSessionId?.() ?? undefined);
		const telemetry = resolveTelemetry(this.session.getTelemetry?.(), this.session.getSessionId?.() ?? undefined);
		const response = await instrumentedCompleteSimple(
			model,
			buildProviderContext(),
			{ signal },
			{
				telemetry,
				oneshotKind: "inspect_image",
				completeImpl: (attemptModel, _staleContext, attemptOptions) =>
					withAuth(
						credential,
						key =>
							this.completeImageRequest(attemptModel, buildProviderContext(), {
								...attemptOptions,
								apiKey: key,
							}),
						{ signal },
					),
			},
		);

		if (response.stopReason === "error") {
			throw new ToolError(response.errorMessage ?? "inspect_image request failed.");
		}
		if (response.stopReason === "aborted") {
			throw new ToolError("inspect_image request aborted.");
		}

		const text = extractTextContent(response);
		if (!text) {
			throw new ToolError("inspect_image model returned no text output.");
		}

		return {
			content: [{ type: "text", text }],
			details: {
				model: `${model.provider}/${model.id}`,
				imagePath: imageInput.resolvedPath,
				mimeType: imageInput.mimeType,
			},
		};
	}
}

export { inspectImageToolRenderer } from "./inspect-image-renderer";
