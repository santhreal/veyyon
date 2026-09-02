/**
 * WHY:
 * Prompt attachments carry video in addition to images. Every provider in `@veyyon/ai`
 * must handle `VideoContent` explicitly without silent drops:
 * - Google Gemini and OpenAI completions convert `VideoContent` to their native wire format
 *   when the model declares `"video"` input modality.
 * - Non-video models or providers that lack video input support replace `VideoContent` with
 *   `NON_VIDEO_MODEL_PLACEHOLDER` (`[video omitted: model does not support video]`).
 *
 * This suite dynamically enumerates provider files in `packages/ai/src/providers/` at runtime
 * to ensure fail-by-default coverage when new provider integrations are added.
 */

import { describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { buildModel } from "@veyyon/catalog/build";
import { getBundledModel } from "@veyyon/catalog/models";
import type { ModelSpec } from "@veyyon/catalog/types";
import type { Context, Model, UserMessage, VideoContent } from "../src";
import { convertOllamaMessage, convertOpenAICompletionsMessages } from "../src";
import { convertBedrockMessages } from "../src/providers/amazon-bedrock";
import { convertContentBlocks } from "../src/providers/anthropic";
import { buildCursorRootPromptContent, extractText as extractCursorText } from "../src/providers/cursor";
import { buildDevinChatMessagePrompts } from "../src/providers/devin";
import { convertGoogleMessages } from "../src/providers/google-shared";
import { convertResponsesInputContent } from "../src/providers/openai-shared";
import { NON_VIDEO_MODEL_PLACEHOLDER } from "../src/providers/vision-content";

const sampleVideo: VideoContent = {
	type: "video",
	data: "AAAAIGZ0eXBtcDQyAAAAAG1wNDJpc29tYXZjMQ==",
	mimeType: "video/mp4",
};

describe("Provider Video Handling Sweep", () => {
	test("every provider file in src/providers/ is covered by video handling sweep or known classification", async () => {
		const providersDir = path.resolve(import.meta.dirname, "../src/providers");
		const entries = await fs.readdir(providersDir, { withFileTypes: true });
		const tsFiles = entries.filter(entry => entry.isFile() && entry.name.endsWith(".ts")).map(entry => entry.name);

		const testedOrAccountedFor = new Set([
			// Direct message converters tested below
			"google-shared.ts",
			"google.ts",
			"google-vertex.ts",
			"google-gemini-cli.ts",
			"openai-completions.ts",
			"openai-shared.ts",
			"openai-responses.ts",
			"openai-codex-responses.ts",
			"azure-openai-responses.ts",
			"anthropic.ts",
			"amazon-bedrock.ts",
			"ollama.ts",
			"cursor.ts",
			"devin.ts",
			"gitlab-duo-workflow.ts",
			"gitlab-duo.ts",
			"kimi.ts",

			// Wire / schemas / helpers / auth (no standalone message content converters)
			"vision-content.ts",
			"vision-guard.ts",
			"openai-chat-wire.ts",
			"openai-chat-server.ts",
			"openai-chat-server-schema.ts",
			"openai-responses-server.ts",
			"openai-responses-server-schema.ts",
			"openai-responses-wire.ts",
			"openai-prompt-cache.ts",
			"openai-compaction.ts",
			"openai-reasoning-fallback.ts",
			"openai-anthropic-shim.ts",
			"anthropic-wire.ts",
			"anthropic-client.ts",
			"anthropic-messages-server.ts",
			"anthropic-messages-server-schema.ts",
			"aws-credentials.ts",
			"aws-eventstream.ts",
			"aws-sigv4.ts",
			"bedrock-prompt-cache.ts",
			"github-copilot-headers.ts",
			"google-auth.ts",
			"google-types.ts",
			"grammar.ts",
			"mock.ts",
			"pi-native-client.ts",
			"pi-native-server.ts",
			"register-builtins.ts",
			"synthetic.ts",
			"transform-messages.ts",
			"error-message.ts",
		]);

		const uncovered = tsFiles.filter(file => !testedOrAccountedFor.has(file));
		expect(uncovered).toEqual([]);
	});

	test("Google Gemini: converts VideoContent to inlineData when model supports video", () => {
		const videoModel = getBundledModel<"google-generative-ai">("google", "gemini-2.5-flash");

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Check this video:" }, sampleVideo],
					timestamp: 0,
				},
			],
		};

		const contents = convertGoogleMessages(videoModel, context);
		expect(contents.length).toBe(1);
		expect(contents[0]?.parts).toEqual([
			{ text: "Check this video:" },
			{
				inlineData: {
					mimeType: "video/mp4",
					data: sampleVideo.data,
				},
			},
		]);
	});

	test("Google Gemini: replaces VideoContent with placeholder when model lacks video support", () => {
		const nonVideoModel: Model<"google-generative-ai"> = {
			...getBundledModel<"google-generative-ai">("google", "gemini-2.5-flash"),
			input: ["text", "image"],
		};

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Look at video" }, sampleVideo],
					timestamp: 0,
				},
			],
		};

		const contents = convertGoogleMessages(nonVideoModel, context);
		expect(contents.length).toBe(1);
		expect(contents[0]?.parts).toEqual([{ text: "Look at video" }, { text: NON_VIDEO_MODEL_PLACEHOLDER }]);
	});

	test("OpenAI Completions: converts VideoContent to video_url data URL when model supports video", () => {
		const base = getBundledModel("openai", "gpt-4o-mini");
		const videoModel: Model<"openai-completions"> = {
			...buildModel({
				...base,
				api: "openai-completions",
				compat: base.compatConfig,
			} as ModelSpec<"openai-completions">),
			input: ["text", "image", "video"],
		};

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Analyze video" }, sampleVideo],
					timestamp: 0,
				},
			],
		};

		const converted = convertOpenAICompletionsMessages(videoModel, context);
		expect(converted.length).toBe(1);
		expect(converted[0]?.content).toEqual([
			{ type: "text", text: "Analyze video" },
			{
				type: "video_url",
				video_url: {
					url: `data:video/mp4;base64,${sampleVideo.data}`,
				},
			},
		]);
	});

	test("OpenAI Completions: replaces VideoContent with placeholder when model lacks video support", () => {
		const base = getBundledModel("openai", "gpt-4o-mini");
		const nonVideoModel: Model<"openai-completions"> = {
			...buildModel({
				...base,
				api: "openai-completions",
				compat: base.compatConfig,
			} as ModelSpec<"openai-completions">),
			input: ["text", "image"],
		};

		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Analyze video" }, sampleVideo],
					timestamp: 0,
				},
			],
		};

		const converted = convertOpenAICompletionsMessages(nonVideoModel, context);
		expect(converted.length).toBe(1);
		expect(converted[0]?.content).toEqual([
			{ type: "text", text: "Analyze video" },
			{ type: "text", text: NON_VIDEO_MODEL_PLACEHOLDER },
		]);
	});

	test("OpenAI Responses: replaces VideoContent with input_text placeholder", () => {
		const result = convertResponsesInputContent([{ type: "text", text: "Sample text" }, sampleVideo], true, false);
		expect(result).toEqual([
			{ type: "input_text", text: "Sample text" },
			{ type: "input_text", text: NON_VIDEO_MODEL_PLACEHOLDER },
		]);
	});

	test("Anthropic: replaces VideoContent with text placeholder", () => {
		const blocks = convertContentBlocks([{ type: "text", text: "Please review" }, sampleVideo], true);
		expect(blocks).toEqual([
			{ type: "text", text: "Please review" },
			{ type: "text", text: NON_VIDEO_MODEL_PLACEHOLDER },
		]);
	});

	test("Amazon Bedrock: replaces VideoContent with text placeholder", () => {
		const bedrockModel = getBundledModel<"bedrock-converse-stream">(
			"amazon-bedrock",
			"anthropic.claude-3-haiku-20240307-v1:0",
		);
		const context: Context = {
			messages: [
				{
					role: "user",
					content: [{ type: "text", text: "Bedrock video" }, sampleVideo],
					timestamp: 0,
				},
			],
		};
		const converted = convertBedrockMessages(context, bedrockModel, "none");
		expect(converted.length).toBe(1);
		expect(converted[0]?.content).toEqual([{ text: "Bedrock video" }, { text: NON_VIDEO_MODEL_PLACEHOLDER }]);
	});

	test("Ollama: replaces VideoContent with placeholder in plain content", () => {
		const userMsg: UserMessage = {
			role: "user",
			content: [{ type: "text", text: "Ollama test" }, sampleVideo],
			timestamp: 0,
		};
		const converted = convertOllamaMessage(userMsg, false);
		expect(converted.content).toContain(NON_VIDEO_MODEL_PLACEHOLDER);
		expect(converted.content).toContain("Ollama test");
	});

	test("Cursor: replaces VideoContent with placeholder in prompt parts and extractText", () => {
		const parts = buildCursorRootPromptContent([{ type: "text", text: "Cursor prompt" }, sampleVideo]);
		expect(parts).toEqual([
			{ type: "text", text: "Cursor prompt" },
			{ type: "text", text: NON_VIDEO_MODEL_PLACEHOLDER },
		]);

		const text = extractCursorText([{ type: "text", text: "Prefix" }, sampleVideo]);
		expect(text).toBe(`Prefix\n${NON_VIDEO_MODEL_PLACEHOLDER}`);
	});

	test("Devin: replaces VideoContent with placeholder in chat message prompts", () => {
		const prompts = buildDevinChatMessagePrompts(
			[
				{
					role: "user",
					content: [{ type: "text", text: "Devin video task" }, sampleVideo],
					timestamp: 0,
				},
			],
			"test-cascade",
		);
		expect(prompts.length).toBe(1);
		expect(prompts[0]?.prompt).toContain("Devin video task");
		expect(prompts[0]?.prompt).toContain(NON_VIDEO_MODEL_PLACEHOLDER);
	});
});
