import { isDashscopeCompatibleModeUrl } from "@veyyon/catalog/hosts";
import { isQwenModelId } from "@veyyon/catalog/identity";

import type { ImageContent, Model, TextContent } from "../types";

export const NON_VISION_IMAGE_PLACEHOLDER = "[image omitted: model does not support vision]";

export function partitionVisionContent(
	content: ReadonlyArray<TextContent | ImageContent>,
	supportsImages: boolean,
): { textBlocks: TextContent[]; imageBlocks: ImageContent[]; omittedImages: boolean } {
	const textBlocks: TextContent[] = [],
		imageBlocks: ImageContent[] = [];
	let omittedImages = false;
	for (const block of content) {
		if (block.type === "text") textBlocks.push(block);
		else if (block.type === "image") {
			if (supportsImages) imageBlocks.push(block);
			else omittedImages = true;
		}
	}
	return { textBlocks, imageBlocks, omittedImages };
}

export function joinTextWithImagePlaceholder(text: string, omittedImages: boolean): string {
	return [text.length > 0 ? text : null, omittedImages ? NON_VISION_IMAGE_PLACEHOLDER : null]
		.filter(s => s !== null)
		.join("\n");
}

/** Detect text-only Qwen models on DashScope's `compatible-mode` endpoint that reject multimodal content. Covers `qwen*-max` and `qwen*-coder*` (issue #1859). */
export function isDashscopeCompatibleModeTextOnlyQwen(model: Model<"openai-completions">): boolean {
	if (!isDashscopeCompatibleModeUrl(model.baseUrl)) {
		return false;
	}
	const id = model.id.toLowerCase();
	if (!isQwenModelId(model.id)) return false;
	return /\bqwen(?:[\d.]+)?-max\b/.test(id) || /\bqwen(?:[\d.]+)?-coder\b/.test(id);
}
