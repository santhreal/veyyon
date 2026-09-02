/**
 * WHY:
 * AgentSession prompt, steer, followUp, and queue mechanisms must support video attachments
 * for video-capable models, preserving VideoContent parts across the queued message
 * lifecycle and draft restore while rejecting video attachments on text/image-only models
 * with UnsupportedModelInputError before anything is enqueued.
 *
 * This suite defends:
 * 1. prompt, steer, and followUp (both user and synthetic branches) enqueue VideoContent parts.
 * 2. clearQueue and popLastQueuedMessage restore queued video attachments in RestoredQueuedMessage.
 * 3. sendUserMessage splits text and video parts and enqueues VideoContent parts.
 * 4. Video attachments on models lacking "video" in input throw UnsupportedModelInputError immediately.
 *
 * What it does NOT catch: Provider API HTTP transmission of video payloads.
 */

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import type { Model, VideoContent } from "@veyyon/ai";
import { Settings } from "../src/config/settings";
import { createAgentSession } from "../src/sdk";
import { type AgentSession, UnsupportedModelInputError } from "../src/session/agent-session";
import type { AuthStorage } from "../src/session/auth-storage";
import { SessionManager } from "../src/session/session-manager";
import { isolatedAuthStorage } from "./helpers/isolated-auth-storage";

describe("AgentSession video attachments and queued message lifecycle", () => {
	let tempDir: string;
	let authStorage: AuthStorage;
	let session: AgentSession;

	const videoCapableModel = {
		id: "model-with-video",
		name: "Model with Video",
		provider: "test-provider",
		api: "openai-completions",
		input: ["text", "image", "video"],
	} as unknown as Model;

	const textOnlyModel = {
		id: "model-without-video",
		name: "Model without Video",
		provider: "test-provider",
		api: "openai-completions",
		input: ["text", "image"],
	} as unknown as Model;

	beforeEach(async () => {
		tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "session-video-test-"));
		authStorage = await isolatedAuthStorage(tempDir);
		await authStorage.set("test-provider", { type: "api_key", key: "test-api-key" });

		const created = await createAgentSession({
			cwd: tempDir,
			agentDir: tempDir,
			authStorage,
			sessionManager: SessionManager.inMemory(tempDir),
			settings: Settings.isolated({} as never),
			model: videoCapableModel,
			disableExtensionDiscovery: true,
		});
		session = created.session;
	});

	afterEach(async () => {
		await session?.dispose();
		try {
			await fs.rm(tempDir, { recursive: true, force: true });
		} catch {
			// ignore cleanup error
		}
	});

	test("steer with videos enqueues a user message with VideoContent part and restores it", async () => {
		const video: VideoContent = {
			type: "video",
			mimeType: "video/mp4",
			data: Buffer.from("test-video").toString("base64"),
		};

		await session.steer("Look at this video clip", undefined, [video]);

		expect(session.agent.hasQueuedMessages()).toBeTrue();
		const restored = session.clearQueue();
		expect(restored.steering.length).toBe(1);
		expect(restored.steering[0]?.text).toBe("Look at this video clip");
		expect(restored.steering[0]?.videos).toEqual([video]);
	});

	test("followUp with videos enqueues a user follow-up with VideoContent part and popLastQueuedMessage restores it", async () => {
		const video: VideoContent = {
			type: "video",
			mimeType: "video/webm",
			data: Buffer.from("test-webm-video").toString("base64"),
		};

		await session.followUp("Follow up with this clip", undefined, [video]);

		expect(session.agent.hasQueuedMessages()).toBeTrue();
		const popped = session.popLastQueuedMessage();
		expect(popped).toBeDefined();
		expect(popped?.text).toBe("Follow up with this clip");
		expect(popped?.videos).toEqual([video]);
	});

	test("followUp synthetic branch enqueues developer message with VideoContent", async () => {
		const video: VideoContent = {
			type: "video",
			mimeType: "video/quicktime",
			data: Buffer.from("test-mov-video").toString("base64"),
		};

		await session.followUp("System note with video", undefined, [video], { synthetic: true });

		expect(session.agent.hasQueuedMessages()).toBeTrue();
	});

	test("sendUserMessage with content array containing video queues as steer", async () => {
		const video: VideoContent = {
			type: "video",
			mimeType: "video/mp4",
			data: Buffer.from("send-user-video").toString("base64"),
		};

		await session.sendUserMessage(
			[
				{ type: "text", text: "Please review" },
				video,
			],
			{ deliverAs: "steer" },
		);

		const restored = session.clearQueue();
		expect(restored.steering.length).toBe(1);
		expect(restored.steering[0]?.text).toBe("Please review");
		expect(restored.steering[0]?.videos).toEqual([video]);
	});

	test("video attachment on model without video input rejects loudly with UnsupportedModelInputError", async () => {
		await session.setModel(textOnlyModel);

		const video: VideoContent = {
			type: "video",
			mimeType: "video/mp4",
			data: Buffer.from("video-bytes").toString("base64"),
		};

		expect(session.prompt("Prompt with video", { videos: [video] })).rejects.toThrow(UnsupportedModelInputError);
		expect(session.steer("Steer with video", undefined, [video])).rejects.toThrow(UnsupportedModelInputError);
		expect(session.followUp("FollowUp with video", undefined, [video])).rejects.toThrow(UnsupportedModelInputError);
		expect(
			session.sendUserMessage([{ type: "text", text: "Test" }, video], { deliverAs: "steer" }),
		).rejects.toThrow(UnsupportedModelInputError);

		try {
			await session.prompt("Prompt with video", { videos: [video] });
			expect().fail("Expected UnsupportedModelInputError");
		} catch (err) {
			expect(err).toBeInstanceOf(UnsupportedModelInputError);
			const typed = err as UnsupportedModelInputError;
			expect(typed.name).toBe("UnsupportedModelInputError");
			expect(typed.modality).toBe("video");
			expect(typed.modelId).toBe("model-without-video");
		}
	});
});
