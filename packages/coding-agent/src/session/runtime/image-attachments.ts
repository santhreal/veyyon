/**
 * Image attachments: the images a message carries, normalized for the model the next request goes
 * to, the hidden description a text-only model reads in their place, and the latest images a tool
 * addresses as `Image #N` or `attachment://N`.
 *
 * This is a session collaborator. It holds no state and reaches the session through
 * {@link ImageAttachmentsHost}.
 */
import type { AgentMessage, AgentTelemetryConfig, ThinkingLevel } from "@veyyon/agent-core";
import type { ImageContent, Model, TextContent } from "@veyyon/ai";
import { errorMessage, logger } from "@veyyon/utils";
import { formatModelString } from "../../config/model-resolver";
import type { Settings } from "../../config/settings";
import type { LocalProtocolOptions } from "../../internal-urls/local-protocol";
import { normalizeModelContextImages } from "../../utils/image-loading";
import { describeAttachedImagesForTextModel, type VisionFallbackRegistry } from "../../utils/image-vision-fallback";
import { IMAGE_ATTACHMENT_DESCRIPTION_TYPE } from "../agent-session-queue";
import type { CustomMessage } from "../messages";

/** What image attachments read from the session. */
export interface ImageAttachmentsHost {
	/** The model the next request goes to; images are normalized for it. */
	model(): Model | undefined;
	/** The agent's messages, oldest first; the latest images are read from the newest that has any. */
	messages(): readonly AgentMessage[];
	/** The session settings, passed through wholesale to the vision fallback. */
	readonly settings: Settings;
	readonly modelRegistry: VisionFallbackRegistry;
	/** The `local://` root an image is saved under before a vision model describes it. */
	readonly localProtocol: LocalProtocolOptions;
	telemetry(): AgentTelemetryConfig | undefined;
	/** The provider-facing session id the vision request is keyed by. */
	sessionId(): string;
	/** The session's effective effort, which a description runs at unless the `vision` helper names one. */
	thinkingLevel(): ThinkingLevel | undefined;
}

/** An image a tool can address, numbered within the message it arrived in. */
export interface ImageAttachment {
	label: string;
	uri: string;
	image: ImageContent;
}

/** A text message's content with its images, and the hidden companion a text-only model reads. */
export interface TextWithImages {
	content: (TextContent | ImageContent)[];
	images: ImageContent[] | undefined;
	imageDescriptionNotice: CustomMessage | undefined;
}

export class ImageAttachments {
	readonly #host: ImageAttachmentsHost;

	constructor(host: ImageAttachmentsHost) {
		this.#host = host;
	}

	/** The images of the newest user or developer message that has any, numbered from 1. */
	latest(): ImageAttachment[] {
		const messages = this.#host.messages();
		for (let i = messages.length - 1; i >= 0; i--) {
			const message = messages[i];
			if (!message || (message.role !== "user" && message.role !== "developer") || !Array.isArray(message.content)) {
				continue;
			}
			const images = message.content.filter((part): part is ImageContent => part.type === "image");
			if (images.length === 0) continue;
			return images.map((image, index) => ({
				label: `Image #${index + 1}`,
				uri: `attachment://${index + 1}`,
				image,
			}));
		}
		return [];
	}

	/**
	 * The content of a text message carrying image attachments: the text, then the images normalized
	 * for the active model. When the model is text-only, the hidden companion describing the images is
	 * returned beside it; the image stays in the message itself.
	 */
	async textWithImages(text: string, images: ImageContent[] | undefined): Promise<TextWithImages> {
		const normalizedImages = await normalizeModelContextImages(images, { model: this.#host.model() });
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }];
		if (!normalizedImages?.length) return { content, images: normalizedImages, imageDescriptionNotice: undefined };
		content.push(...normalizedImages);
		return {
			content,
			images: normalizedImages,
			imageDescriptionNotice: await this.#describe(normalizedImages),
		};
	}

	/** `message` with the images in its content normalized for the active model; the same message when it has none. */
	async normalizeMessage<T extends AgentMessage>(message: T): Promise<T> {
		if (!("content" in message)) return message;
		const content = message.content;
		if (typeof content === "string" || !Array.isArray(content)) return message;
		const parts = content as (TextContent | ImageContent)[];
		const images = parts.filter((part): part is ImageContent => part.type === "image");
		if (images.length === 0) return message;
		const normalizedImages = await normalizeModelContextImages(images, { model: this.#host.model() });
		if (!normalizedImages) return message;
		let imageIndex = 0;
		const normalized = parts.map(part => (part.type === "image" ? normalizedImages[imageIndex++] : part));
		return { ...message, content: normalized } as T;
	}

	/**
	 * A hidden companion message describing image attachments for a text-only model. Each image is
	 * saved under `local://` and a vision-capable model describes it; the descriptions are returned as
	 * a `display: false` custom message (the model reads them, the TUI does not render the blob)
	 * carrying one `<image path="local://…">…</image>` block per image. `undefined` when the active
	 * model accepts images, the feature is off, or no description could be produced. Never throws.
	 */
	async #describe(normalizedImages: ImageContent[]): Promise<CustomMessage | undefined> {
		const model = this.#host.model();
		const settings = this.#host.settings;
		if (
			!model ||
			model.input.includes("image") ||
			settings.get("images.blockImages") ||
			!settings.get("images.describeForTextModels")
		) {
			return undefined;
		}
		let blocks: TextContent[];
		try {
			blocks = await describeAttachedImagesForTextModel(normalizedImages, {
				activeModel: model,
				modelRegistry: this.#host.modelRegistry,
				settings,
				localProtocolOptions: this.#host.localProtocol,
				activeModelString: formatModelString(model),
				telemetryConfig: this.#host.telemetry(),
				sessionId: this.#host.sessionId(),
				thinkingLevel: this.#host.thinkingLevel(),
			});
		} catch (err) {
			logger.warn("image attachment vision fallback failed; image left undescribed", {
				error: errorMessage(err),
			});
			return undefined;
		}
		if (blocks.length === 0) {
			return undefined;
		}
		return {
			role: "custom",
			customType: IMAGE_ATTACHMENT_DESCRIPTION_TYPE,
			content: blocks,
			display: false,
			attribution: "user",
			timestamp: Date.now(),
		};
	}
}
